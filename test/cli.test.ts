import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseImports, parseJsonc, resolveSpec } from "../src/cli/candidates";
import { classify, globToRegExp } from "../src/cli/classify";
import { parseUnifiedDiff } from "../src/cli/code";
import { parseChanges } from "../src/cli/collect";
import {
  buildMermaid,
  escapeMd,
  mermaidLabel,
  permalink,
} from "../src/cli/comment";
import { parseGithubRemote } from "../src/cli/git";
import { renderHtml } from "../src/cli/build";
import {
  buildLanes,
  edgeGeometry,
  flattenTree,
  groupUnclassified,
} from "../src/viewer/lanes";
import type {
  CollectInput,
  FileLayer,
  FileStatus,
  PrMap,
  TreeNode,
  UnclassifiedFile,
  ViewerFile,
  ViewerMapData,
} from "../src/shared/types";
import { draftsText, keepsAcrossTabs } from "../src/viewer/model";
import { makeFixture, type Fixture } from "./fixture";

const CLI = path.resolve("skill/pr-map/scripts/pr-map.js");
const SAMPLE = path.resolve("test/fixtures/pr-map.json");

function cli(fx: Fixture, ...args: string[]) {
  const r = spawnSync("node", [CLI, ...args], {
    cwd: fx.root,
    env: fx.env,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const sample = (): PrMap => JSON.parse(readFileSync(SAMPLE, "utf8"));
const writeMap = (fx: Fixture, map: unknown) =>
  writeFileSync(path.join(fx.root, ".pr-map/pr-map.json"), JSON.stringify(map));
const readOut = <T>(fx: Fixture, name: string): T =>
  JSON.parse(readFileSync(path.join(fx.root, ".pr-map", name), "utf8"));

// spawnSync가 이벤트 루프를 막아 vitest 내부 통신이 시간 초과되지 않도록 테스트 사이에 차례를 넘긴다.
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("순수 함수", () => {
  it("diff를 양쪽 줄 번호로 풀어낸다", () => {
    const rows = parseUnifiedDiff(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n",
    );
    expect(rows).toEqual([
      { d: " ", t: "keep", o: 1, n: 1 },
      { d: "-", t: "old", o: 2, n: 0 },
      { d: "+", t: "new", o: 0, n: 2 },
    ]);
  });

  it("이름 변경과 바이너리가 섞인 -z 출력을 읽는다", () => {
    const changes = parseChanges(
      "M\0a.ts\0R090\0old.ts\0new.ts\0D\0gone.ts\0M\0i.png\0",
      "1\t2\ta.ts\0" +
        "3\t1\t\0old.ts\0new.ts\0" +
        "0\t5\tgone.ts\0" +
        "-\t-\ti.png\0",
    );
    expect(changes).toEqual([
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 2,
        binary: false,
      },
      {
        path: "new.ts",
        oldPath: "old.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
        binary: false,
      },
      {
        path: "gone.ts",
        status: "deleted",
        additions: 0,
        deletions: 5,
        binary: false,
      },
      {
        path: "i.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ]);
  });

  it("import 형식을 찾고 주석은 건너뛴다", () => {
    const refs = parseImports(`import a, { b, c as d, type E } from './x'
// import nope from './commented'
/* import nope2 from './block' */
export * from './y'
import './side'
const z = require('./z')
const l = await import('./lazy')`);
    expect(refs.map((r) => r.spec).sort()).toEqual([
      "./lazy",
      "./side",
      "./x",
      "./y",
      "./z",
    ]);
    expect(refs.find((r) => r.spec === "./x")!.symbols).toEqual([
      "a",
      "b",
      "c",
      "E",
    ]);
  });

  it("상대 경로, .js 표기, index, tsconfig 별칭을 해석한다", () => {
    const tree = new Set(["src/a/b.ts", "src/c/index.tsx", "src/d.ts"]);
    const alias = [{ prefix: "@/", suffix: "", targets: ["src/*"] }];
    expect(resolveSpec("./b", "src/a/x.ts", tree, [])).toBe("src/a/b.ts");
    expect(resolveSpec("./b.js", "src/a/x.ts", tree, [])).toBe("src/a/b.ts");
    expect(resolveSpec("../c", "src/a/x.ts", tree, [])).toBe("src/c/index.tsx");
    expect(resolveSpec("@/d", "src/a/x.ts", tree, alias)).toBe("src/d.ts");
    expect(resolveSpec("react", "src/a/x.ts", tree, alias)).toBeNull();
  });

  it("문자열 안의 //는 그대로 두고 tsconfig 주석을 지운다", () => {
    expect(
      parseJsonc('{ // c\n "a": "http://x", /* y */ "b": [1,], }'),
    ).toEqual({ a: "http://x", b: [1] });
  });

  describe("레인", () => {
    const file = (id: string, status: FileStatus, layer: FileLayer) =>
      ({ id, name: `${id}.ts`, status, layer }) as ViewerFile;
    const files = [
      file("a", "added", "core"),
      file("m", "modified", "entry"),
      file("r", "renamed", "store"),
      file("d", "deleted", "core"),
      file("x", "reference", "ext"),
    ];
    const ids = (
      layout: "status" | "role",
      edges: { from: string; to: string; label: string }[] = [],
    ) => buildLanes(files, edges, layout).map((l) => l.files.map((f) => f.id));

    it("상태별 레인은 이름 변경을 수정에 넣고, 참고 파일을 따로 둔다", () => {
      expect(ids("status")).toEqual([["a"], ["m", "r"], ["d"], ["x"]]);
    });

    it("역할별 레인은 layer로 나눈다", () => {
      expect(ids("role")).toEqual([["m"], ["a", "d"], ["r"], ["x"]]);
    });

    it("레인 안에서는 연결이 많은 파일을 위에 둔다", () => {
      expect(ids("status", [{ from: "r", to: "a", label: "x" }])[1]).toEqual([
        "r",
        "m",
      ]);
    });

    it("연결선은 상대 위치에 따라 면을 고르고 같은 레인은 오른쪽으로 돌아 나간다", () => {
      const rects = {
        a: { x: 0, y: 0, w: 100, h: 100 },
        b: { x: 300, y: 0, w: 100, h: 100 },
        c: { x: 0, y: 200, w: 100, h: 100 },
      };
      const [ab, ba, ac, ghost] = edgeGeometry(
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
          { from: "a", to: "c" },
          { from: "a", to: "ghost" },
        ],
        rects,
      );
      expect(ab!.d).toMatch(/^M100,/);
      expect(ba!.d).toMatch(/^M300,/);
      expect(ac!.d).toMatch(/^M100,.* 100,\d/);
      expect(ghost).toBeNull();
    });

    it("미분류를 종류별로 묶고, 분석하지 못한 파일은 직접 확인 목록에 둔다", () => {
      const u = (path: string, category: string) =>
        ({ path, category }) as UnclassifiedFile;
      const { attention, groups } = groupUnclassified([
        u("big.ts", "attention"),
        u("a.md", "doc"),
        u("a.test.ts", "test"),
        u("b.md", "doc"),
        u("old.ts", "unknown"),
      ]);
      expect(attention.map((f) => f.path)).toEqual(["big.ts", "old.ts"]);
      expect(groups.map((g) => [g.label, g.items.length])).toEqual([
        ["테스트 코드", 1],
        ["문서", 2],
      ]);
    });

    it("트리를 줄 목록과 트리 선으로 펼친다", () => {
      const n = (id: string, children?: TreeNode[]) =>
        ({ id, text: id, change: "added", evidence: [], children }) as TreeNode;
      const rows = flattenTree("f", [n("a", [n("b", [n("c")]), n("d")])]);
      expect(rows.map((r) => [r.key, r.prefix, r.cont])).toEqual([
        ["f:a", "", ""],
        ["f:b", "├─ ", "│  "],
        ["f:c", "│  └─ ", "│     "],
        ["f:d", "└─ ", "   "],
      ]);
    });
  });

  it("초안은 로컬 파일에서만 오래 남기고, 붙여넣기 좋게 복사한다", () => {
    expect(keepsAcrossTabs("file:")).toBe(true);
    expect(keepsAcrossTabs("https:")).toBe(false);
    expect(
      draftsText([
        { where: "a.ts L3", text: "확인" },
        { where: "b.ts 이전 L9", text: "왜 삭제?" },
      ]),
    ).toBe("- a.ts L3: 확인\n- b.ts 이전 L9: 왜 삭제?");
  });

  it("GitHub 원격 주소를 해석한다", () => {
    expect(parseGithubRemote("git@github.com:acme/api.git")).toBe("acme/api");
    expect(parseGithubRemote("https://github.com/acme/api")).toBe("acme/api");
    expect(parseGithubRemote("https://gitlab.com/acme/api.git")).toBeNull();
  });

  it("글롭을 경로 규칙대로 처리한다", () => {
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("**/*.gen.ts").test("src/x.gen.ts")).toBe(true);
    expect(globToRegExp("**/*.gen.ts").test("x.gen.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/x.ts")).toBe(false);
    expect(globToRegExp("vendor/").test("vendor/a.js")).toBe(true);
  });

  it("상한을 넘으면 변경량이 작은 파일부터 미분류로 보낸다", () => {
    const f = (p: string, additions: number) => ({
      path: p,
      status: "modified" as const,
      additions,
      deletions: 0,
      binary: false,
    });
    const { files, unclassified } = classify(
      [f("a.ts", 1), f("b.ts", 9), f("c.ts", 5), f("README.md", 99)],
      { exclude: [], maxFiles: 2 },
    );
    expect(files.map((x) => x.path)).toEqual(["b.ts", "c.ts"]);
    expect(
      Object.fromEntries(unclassified.map((u) => [u.path, u.reason])),
    ).toEqual({ "README.md": "문서", "a.ts": "분석 상한 2개 초과" });
  });

  it("테스트와 지원 파일은 기본으로 빼고, includeTests로 되돌린다", () => {
    const f = (p: string) => ({
      path: p,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      binary: false,
    });
    const tests = [
      "tests/e2e/a.ts",
      "src/test/setup.ts",
      "src/__tests__/a.tsx",
      "src/__mocks__/api.ts",
      "src/a.test.tsx",
      "src/a.spec.ts",
      "src/a.stories.tsx",
      ".storybook/preview.tsx",
      "playwright.config.ts",
      "playwright.ct.config.ts",
      "vitest.config.ts",
      "pkg/a_test.go",
      "app/test_a.py",
    ];
    const sources = [
      "src/latest.ts",
      "src/contest/a.ts",
      "src/test-utils.ts",
      "src/protest.ts",
      "vite.config.ts",
    ];
    const all = [...tests, ...sources].map(f);

    const byDefault = classify(all, { exclude: [], maxFiles: 50 });
    expect(byDefault.files.map((x) => x.path)).toEqual(sources);
    expect(byDefault.unclassified.map((u) => u.path)).toEqual(tests);
    expect(new Set(byDefault.unclassified.map((u) => u.reason))).toEqual(
      new Set(["테스트 · 기본 제외"]),
    );

    const kinds = classify(
      [
        f("src/a.test.ts"),
        f("test/fixtures/a.jsonl"),
        f("docs/a.md"),
        f("pnpm-lock.yaml"),
        f("a.conf"),
        f("secret.ts"),
      ],
      { exclude: ["secret.ts"], maxFiles: 50 },
    );
    expect(
      Object.fromEntries(kinds.unclassified.map((u) => [u.path, u.category])),
    ).toEqual({
      "src/a.test.ts": "test",
      "test/fixtures/a.jsonl": "fixture",
      "docs/a.md": "doc",
      "pnpm-lock.yaml": "generated",
      "a.conf": "other",
      "secret.ts": "excluded",
    });
    expect(
      classify([f("a.ts"), f("b.ts")], { exclude: [], maxFiles: 1 })
        .unclassified[0]!.category,
    ).toBe("attention");

    const included = classify(all, {
      exclude: [],
      maxFiles: 50,
      includeTests: true,
    });
    expect(included.files).toHaveLength(all.length);
  });

  it("댓글에서 HTML·멘션·이슈 링크를 무력화한다", () => {
    const out = escapeMd("<img src=x> @octocat #12 `a`");
    expect(out).not.toMatch(/<img|@octocat|#12/);
    expect(mermaidLabel('a"b<c>')).toBe("a#quot;b#lt;c#gt;");
  });

  it("데이터의 </script>가 HTML을 탈출하지 못한다", () => {
    const html = renderHtml(
      { status: "empty", x: "</script><script>alert(1)</script>" } as never,
      "<script>window.__PR_MAP__ = /*__PR_MAP_DATA__*/null;</script>",
    );
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>alert");
  });
});

describe("시안의 예시 PR로 전체 흐름", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it("collect: 커밋, 파일 상태, 미분류, 관계 후보를 기록한다 (F01·F02·F13)", () => {
    const r = cli(fx, "collect");
    expect(r.code).toBe(0);
    const input = readOut<CollectInput>(fx, "input.json");
    expect(input.pr).toMatchObject({
      repo: "acme/api",
      number: 482,
      base: fx.base,
      head: fx.head,
      baseRef: "main",
      headRef: "feat/refresh-lock",
    });
    expect(
      Object.fromEntries(input.files.map((f) => [f.path, f.status])),
    ).toEqual({
      "src/auth/legacy-refresh.ts": "deleted",
      "src/auth/refresh-lock.ts": "added",
      "src/auth/session-refresh.ts": "modified",
      "src/auth/token-cache.ts": "renamed",
      "src/reports/csv-export.ts": "deleted",
      "src/routes.ts": "modified",
      "src/store/session-store.ts": "modified",
    });
    expect(input.files.find((f) => f.status === "renamed")!.oldPath).toBe(
      "src/auth/token-store.ts",
    );
    expect(
      Object.fromEntries(input.unclassified.map((u) => [u.path, u.reason])),
    ).toEqual({
      "src/auth/__tests__/session-refresh.test.ts": "테스트 · 기본 제외",
      "pnpm-lock.yaml": "자동 생성 · 제외 규칙",
      "docs/auth/session.md": "문서",
      "infra/redis.conf": "지원하지 않는 형식",
      "public/og-image.png": "바이너리",
    });
    const pairs = input.candidates.map((c) => `${c.from} -> ${c.to}`);
    expect(pairs).toContain(
      "src/auth/session-refresh.ts -> src/auth/refresh-lock.ts",
    );
    expect(pairs).toContain(
      "src/auth/session-refresh.ts -> src/auth/token-client.ts",
    );
    expect(
      input.candidates.find((c) => c.to === "src/auth/refresh-lock.ts")!
        .symbols,
    ).toEqual(["acquireRefreshLock", "waitForRefresh"]);
  });

  it("collect: 결과 폴더를 저장소에 올라가지 않게 제외한다 (F17)", () => {
    cli(fx, "collect");
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: fx.root,
        encoding: "utf8",
      }),
    ).toBe("");
  });

  it.each([[], ["--pr", "482"]])(
    "collect: gh 기본 저장소가 달라도 origin의 PR을 조회한다 (%j)",
    (...args) => {
      fx.env.FAKE_GH_DEFAULT_REPO = "upstream/api";
      execFileSync(
        "git",
        ["remote", "add", "upstream", "https://github.com/upstream/api.git"],
        { cwd: fx.root },
      );
      const result = cli(fx, "collect", ...args);
      expect(result.code, result.out).toBe(0);
      expect(readOut<CollectInput>(fx, "input.json").pr).toMatchObject({
        repo: "acme/api",
        url: "https://github.com/acme/api/pull/482",
        head: fx.head,
      });
      const calls = readFileSync(fx.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[] });
      expect(calls[0]!.args.slice(0, 5)).toEqual([
        "pr",
        "view",
        args.length ? "482" : "feat/refresh-lock",
        "--repo",
        "acme/api",
      ]);
    },
  );

  it("PR 없는 브랜치도 --base로 분석한다", () => {
    const r = cli(fx, "collect", "--base", "main");
    expect(r.code).toBe(0);
    expect(readOut<CollectInput>(fx, "input.json").pr.number).toBeNull();
  });

  it("8개 파일 샘플이 실제 커밋 기준으로 검증을 통과한다", () => {
    cli(fx, "collect");
    writeMap(fx, sample());
    const r = cli(fx, "validate");
    expect(r.out).toContain("검증 통과");
    expect(r.code).toBe(0);
    expect(readOut<PrMap>(fx, "pr-map.json").pr.head).toBe(fx.head);
  });

  it.each<[string, (m: PrMap) => void, string]>([
    [
      "줄 범위 초과",
      (m) => {
        m.files[6]!.tree[0]!.evidence[0]!.end = 6;
      },
      "files[6].tree[0].evidence[0]: end(6)",
    ],
    [
      "added인데 base 근거만 있음",
      (m) => {
        m.files[0]!.tree[0]!.children![0]!.evidence = [
          {
            side: "base",
            path: "src/auth/session-refresh.ts",
            start: 8,
            end: 10,
            role: "이전",
          },
        ];
      },
      "added 노드의 근거가 head",
    ],
    [
      "modified인데 변경 줄 없음",
      (m) => {
        m.files[0]!.tree[0]!.change = "modified";
      },
      "modified 노드의 근거가",
    ],
    [
      "unchanged인데 변경 줄과 겹침",
      (m) => {
        m.files[2]!.tree[0]!.evidence[0]!.start = 2;
      },
      "unchanged 노드의 근거가 변경 줄과 겹칩니다",
    ],
    [
      "deleted에 head 근거",
      (m) => {
        m.files[0]!.tree[0]!.children![3]!.evidence[0]!.side = "head";
      },
      "deleted 노드의 근거는 모두 base",
    ],
    [
      "없는 파일 경로",
      (m) => {
        m.files[0]!.tree[0]!.evidence[0]!.path = "src/nope.ts";
      },
      "읽을 수 없습니다",
    ],
    [
      "이름 변경의 base 근거에 새 경로",
      (m) => {
        m.files[7]!.tree[1]!.evidence[1]!.path = "src/auth/token-cache.ts";
      },
      "oldPath",
    ],
    [
      "파일 status 변조",
      (m) => {
        m.files[1]!.status = "modified";
      },
      "status는 input.json 값",
    ],
    [
      "없는 파일을 가리키는 엣지",
      (m) => {
        m.edges[0]!.to = "ghost";
      },
      "없는 파일 id",
    ],
    [
      "중복 노드 id",
      (m) => {
        m.files[1]!.tree[1]!.id = "acquire";
      },
      "중복됩니다",
    ],
    [
      "미분류 파일을 지도에 넣음",
      (m) => {
        m.files.push({
          id: "lock",
          path: "pnpm-lock.yaml",
          status: "modified",
          layer: "ext",
          role: "잠금 파일",
          tree: [],
        });
      },
      "미분류 파일",
    ],
    [
      "읽는 순서가 없는 파일을 가리킴",
      (m) => {
        m.readingOrder[0]!.file = "ghost";
      },
      "readingOrder[0]: 없는 파일 id",
    ],
    [
      "읽는 순서에 참고 파일",
      (m) => {
        m.readingOrder[0]!.file = "token-client";
      },
      "참고 파일",
    ],
    [
      "읽는 순서 중복",
      (m) => {
        m.readingOrder[1]!.file = m.readingOrder[0]!.file;
      },
      "readingOrder[1]: 파일 id",
    ],
    [
      "깊이 초과",
      (m) => {
        const leaf = (id: string): never =>
          ({
            id,
            text: id,
            change: "added",
            evidence: [
              {
                side: "head",
                path: "src/auth/refresh-lock.ts",
                start: 5,
                end: 5,
                role: "x",
              },
            ],
          }) as never;
        m.files[1]!.tree[0]!.children![0]!.children = [
          {
            ...(leaf("d3") as object),
            children: [{ ...(leaf("d4") as object), children: [leaf("d5")] }],
          } as never,
        ];
      },
      "깊이",
    ],
  ])("규칙 위반을 경로와 이유로 알려준다: %s", (_n, mutate, expected) => {
    cli(fx, "collect");
    const m = sample();
    mutate(m);
    writeMap(fx, m);
    const r = cli(fx, "validate");
    expect(r.code).toBe(1);
    expect(r.out).toContain(expected);
  });

  it("스키마 위반을 알려준다", () => {
    cli(fx, "collect");
    const m = sample();
    (m.files[0]!.tree[0] as { text: string }).text = "x".repeat(81);
    writeMap(fx, m);
    const r = cli(fx, "validate");
    expect(r.code).toBe(1);
    expect(r.out).toContain("files[0].tree[0].text");
  });

  it.each<[string, (m: Record<string, unknown> & PrMap) => void, string]>([
    [
      "이전 버전",
      (m) => {
        (m as { version: number }).version = 1;
      },
      "version",
    ],
    [
      "layer 없음",
      (m) => {
        delete (m.files[0] as Partial<PrMap["files"][number]>).layer;
      },
      "files[0]",
    ],
    [
      "role 없음",
      (m) => {
        delete (m.files[0] as Partial<PrMap["files"][number]>).role;
      },
      "files[0]",
    ],
    [
      "읽는 순서 없음",
      (m) => {
        delete (m as Partial<PrMap>).readingOrder;
      },
      "readingOrder",
    ],
    [
      "엣지에 kind",
      (m) => {
        (m.edges[0] as unknown as { kind: string }).kind = "calls";
      },
      "edges[0]",
    ],
    [
      "테스트 근거에 side",
      (m) => {
        (
          m.files[0]!.tree[0]!.children![0]!.tests![0] as unknown as {
            side: string;
          }
        ).side = "head";
      },
      "tests[0]",
    ],
  ])("v2 형식을 어기면 알려준다: %s", (_n, mutate, expected) => {
    cli(fx, "collect");
    const m = sample() as Record<string, unknown> & PrMap;
    mutate(m);
    writeMap(fx, m);
    const r = cli(fx, "validate");
    expect(r.code).toBe(1);
    expect(r.out).toContain(expected);
  });

  it("added 노드에 이전 구현을 base 보조 근거로 붙일 수 있다", () => {
    cli(fx, "collect");
    const m = sample();
    m.files[0]!.tree[0]!.children![0]!.evidence.push({
      side: "base",
      path: "src/auth/session-refresh.ts",
      start: 8,
      end: 10,
      role: "이전 구현",
    });
    writeMap(fx, m);
    expect(cli(fx, "validate").code).toBe(0);
  });

  describe("테스트 연결", () => {
    const TEST = "src/auth/__tests__/session-refresh.test.ts";
    const validated = (
      mutate: (node: PrMap["files"][number]["tree"][number], m: PrMap) => void,
    ) => {
      cli(fx, "collect");
      const m = sample();
      mutate(m.files[0]!.tree[0]!.children![0]!, m);
      writeMap(fx, m);
      const r = cli(fx, "validate");
      expect(r.code).toBe(0);
      return { out: r.out, map: readOut<PrMap>(fx, "pr-map.json") };
    };

    it("이번 PR에서 바뀐 줄을 가리키는 테스트는 남긴다", () => {
      const { out, map } = validated(() => {});
      expect(out).not.toContain("테스트 연결 제거");
      expect(map.files[0]!.tree[0]!.children![0]!.tests).toEqual([
        { path: TEST, start: 9, end: 12, role: "동시 요청 → 갱신 한 번" },
      ]);
    });

    it.each<[string, { path: string; start: number; end: number }, string]>([
      [
        "같은 파일의 건드리지 않은 테스트",
        { path: TEST, start: 5, end: 7 },
        "바뀐 줄이 아닙니다",
      ],
      [
        "바뀌지 않은 테스트 파일",
        { path: "src/auth/__tests__/old-unrelated.test.ts", start: 1, end: 1 },
        "바뀐 테스트 파일이 아닙니다",
      ],
      [
        "테스트가 아닌 변경 파일",
        { path: "src/auth/session-refresh.ts", start: 13, end: 14 },
        "바뀐 테스트 파일이 아닙니다",
      ],
      ["줄 수 초과", { path: TEST, start: 9, end: 99 }, "줄 수"],
    ])("연결을 지우고 분기 설명은 유지한다: %s", (_n, ref, reason) => {
      const { out, map } = validated((node) => {
        node.tests = [{ ...ref, role: "x" }];
      });
      expect(out).toContain("테스트 연결 제거");
      expect(out).toContain(reason);
      const node = map.files[0]!.tree[0]!.children![0]!;
      expect(node.tests).toBeUndefined();
      expect(node.unverified).toBeUndefined();
    });

    it("바뀌지 않은 분기와 삭제된 분기에는 연결하지 않는다", () => {
      const ref = { path: TEST, start: 9, end: 12, role: "x" };
      const { out, map } = validated((_node, m) => {
        m.files[0]!.tree[0]!.tests = [ref];
        m.files[0]!.tree[0]!.children![3]!.tests = [ref];
      });
      expect(out.match(/바뀐 분기가 아닙니다/g)).toHaveLength(2);
      expect(map.files[0]!.tree[0]!.tests).toBeUndefined();
      expect(map.files[0]!.tree[0]!.children![3]!.tests).toBeUndefined();
    });
  });

  it("3번째 실패에서 해당 노드만 확인 필요로 강등하고 코드를 지어내지 않는다 (F06·F11)", () => {
    cli(fx, "collect");
    const m = sample();
    m.files[6]!.tree[0]!.evidence[0]!.end = 99;
    for (let i = 0; i < 2; i++) {
      writeMap(fx, m);
      expect(cli(fx, "validate").code).toBe(1);
    }
    writeMap(fx, m);
    const r = cli(fx, "validate");
    expect(r.out).toContain("확인 필요로 강등: src/routes.ts: report-routes");
    expect(r.code).toBe(0);
    const saved = readOut<PrMap>(fx, "pr-map.json");
    expect(saved.files[6]!.tree[0]).toMatchObject({
      unverified: true,
      evidence: [],
    });
    expect(saved.files[0]!.tree[0]!.evidence).toHaveLength(1);
  });

  it("재분석 때 근거가 같은 노드는 이전 id를 유지한다 (F15)", () => {
    cli(fx, "collect");
    writeMap(fx, sample());
    expect(cli(fx, "validate").code).toBe(0);
    cli(fx, "collect");
    const m = sample();
    m.files[1]!.tree[0]!.id = "grab-lock";
    writeMap(fx, m);
    const r = cli(fx, "validate");
    expect(r.out).toContain(
      "id 보정: src/auth/refresh-lock.ts: grab-lock → acquire",
    );
    expect(readOut<PrMap>(fx, "pr-map.json").files[1]!.tree[0]!.id).toBe(
      "acquire",
    );
  });

  describe("build", () => {
    beforeEach(() => {
      cli(fx, "collect");
      writeMap(fx, sample());
      const r = cli(fx, "build");
      expect(r.code).toBe(0);
    });

    const data = () => readOut<ViewerMapData>(fx, "viewer-data.json");

    it("코드 패널 데이터는 커밋의 원본과 줄 번호가 일치한다 (F09, 시나리오 4)", () => {
      const d = data();
      const key = d.codeIndex["head:src/auth/session-refresh.ts"]!;
      const entry = d.code[key]!;
      if (!("rows" in entry)) throw new Error("rows 없음");
      const original = execFileSync(
        "git",
        ["show", `${fx.head}:src/auth/session-refresh.ts`],
        { cwd: fx.root, encoding: "utf8" },
      ).split("\n");
      for (const r of entry.rows) if (r.n) expect(r.t).toBe(original[r.n - 1]);
      const base = execFileSync(
        "git",
        ["show", `${fx.base}:src/auth/session-refresh.ts`],
        { cwd: fx.root, encoding: "utf8" },
      ).split("\n");
      for (const r of entry.rows) if (r.o) expect(r.t).toBe(base[r.o - 1]);
    });

    it("이름 변경 파일은 base·head 근거가 같은 코드를 공유한다", () => {
      const d = data();
      expect(d.codeIndex["base:src/auth/token-store.ts"]).toBe(
        d.codeIndex["head:src/auth/token-cache.ts"],
      );
    });

    it("변경 수, 삭제 파일의 대체·호출 정보를 채운다", () => {
      const d = data();
      const by = Object.fromEntries(d.files.map((f) => [f.id, f]));
      expect(by["session-refresh"]).toMatchObject({
        additions: 30,
        deletions: 3,
        name: "session-refresh.ts",
        dir: "src/auth/",
      });
      expect(by["legacy-refresh"]).toMatchObject({
        replacedByNames: ["session-refresh.ts"],
        callers: "head에 남은 호출 없음",
      });
      expect(d.counts).toEqual({
        changed: 12,
        mapped: 8,
        unclassified: 5,
        unverified: 1,
      });
    });

    it("v2 필드를 뷰어 데이터로 넘기고 대체 엣지를 replacedBy에서 만든다", () => {
      const d = data();
      const by = Object.fromEntries(d.files.map((f) => [f.id, f]));
      expect(by["session-store"]).toMatchObject({
        layer: "store",
        role: "세션 조회, 버전 비교 저장, 조건부 삭제",
      });
      expect(d.readingOrder[0]).toEqual({
        file: "session-refresh",
        why: "갱신 흐름의 중심 · 분기 대부분이 여기",
      });
      expect(d.edges).toContainEqual({
        from: "legacy-refresh",
        to: "session-refresh",
        label: "대체됨",
        kind: "replacedBy",
      });
      expect(d.edges.filter((e) => e.kind === "replacedBy")).toHaveLength(1);
      expect(d.edges.filter((e) => e.kind === "calls")).toHaveLength(3);
    });

    it("연결된 테스트는 코드와 미분류 표시를 함께 갖춘다", () => {
      const d = data();
      const key =
        d.codeIndex["head:src/auth/__tests__/session-refresh.test.ts"]!;
      expect(d.code[key]).toHaveProperty("rows");
      expect(
        d.unclassified.find(
          (u) => u.path === "src/auth/__tests__/session-refresh.test.ts",
        )!.reason,
      ).toBe("분기에 연결됨");
    });

    it("지도에서 빠진 변경 파일은 미분류로 드러낸다", () => {
      const m = sample();
      m.files = m.files.filter((f) => f.id !== "routes");
      m.files.forEach((f) => {
        if (f.id === "csv-export") f.tree = [];
      });
      writeMap(fx, m);
      expect(cli(fx, "build").code).toBe(0);
      expect(
        data().unclassified.find((u) => u.path === "src/routes.ts"),
      ).toMatchObject({ reason: "분석 결과 없음", category: "attention" });
    });

    it("댓글: Mermaid, 접힘 트리, 커밋 고정 링크, 확인 필요 건수를 담는다 (F16)", () => {
      const body = readFileSync(
        path.join(fx.root, ".pr-map/comment.md"),
        "utf8",
      );
      expect(body.startsWith("<!-- pr-map -->")).toBe(true);
      expect(body).toContain("```mermaid");
      expect(body).toContain("<details open>");
      expect(body).toContain(
        `https://github.com/acme/api/blob/${fx.head}/src/auth/session-refresh.ts#L8-L9`,
      );
      expect(body).toContain(
        `https://github.com/acme/api/blob/${fx.base}/src/auth/token-store.ts#L3`,
      );
      expect(body).toContain("근거 확인 필요 1건");
      expect(body).toContain(
        "~~바로 갱신 → 버전 확인 없이 저장 후 다시 조회~~",
      );
      expect(buildMermaid(data())).toContain('-.->|"대체됨"|');
    });

    it("view: 이전 형식의 결과는 그리지 않고 분석 상태로 안내한다", () => {
      const file = path.join(fx.root, ".pr-map/viewer-data.json");
      const { readingOrder: _dropped, ...old } = data();
      writeFileSync(file, JSON.stringify(old));
      expect(cli(fx, "view", "--no-open").code).toBe(0);
      expect(
        readFileSync(path.join(fx.root, ".pr-map/viewer/index.html"), "utf8"),
      ).toContain('"status":"analyzing"');
    });

    it("뷰어는 외부 호출 없이 데이터가 인라인된 단일 파일이다 (시나리오 6)", () => {
      const html = readFileSync(
        path.join(fx.root, ".pr-map/viewer/index.html"),
        "utf8",
      );
      expect(html).toContain("세션 갱신 경합 처리");
      expect(html).not.toMatch(/\bfetch\(["'`]http/);
      expect(html).toContain("default-src 'none'");
    });

    it("publish: 없으면 새로 게시하고 있으면 그 댓글을 갱신한다", () => {
      const calls = () =>
        readFileSync(fx.log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { args: string[]; stdin: string });
      writeFileSync(fx.log, "");
      let r = cli(fx, "publish");
      expect(r.out).toContain("댓글 게시");
      let post = calls().find((c) => c.args.includes("POST"))!;
      expect(post.args).toContain("repos/acme/api/issues/482/comments");
      expect(
        (JSON.parse(post.stdin) as { body: string }).body.startsWith(
          "<!-- pr-map -->",
        ),
      ).toBe(true);

      writeFileSync(fx.log, "");
      fx.env.FAKE_GH_EXISTING = "777";
      r = cli(fx, "publish");
      expect(r.out).toContain("댓글 갱신");
      post = calls().find((c) => c.args.includes("PATCH"))!;
      expect(post.args).toContain("repos/acme/api/issues/comments/777");
      expect(calls().some((c) => c.args.includes("POST"))).toBe(false);
    });

    it("view와 publish: 원격이나 gh 기본값이 바뀌어도 수집한 저장소를 유지한다", () => {
      fx.env.FAKE_GH_DEFAULT_REPO = "upstream/api";
      execFileSync(
        "git",
        ["remote", "set-url", "origin", "https://github.com/other/api.git"],
        { cwd: fx.root },
      );
      writeFileSync(fx.log, "");
      const viewed = cli(fx, "view", "--no-open");
      expect(viewed.code, viewed.out).toBe(0);
      expect(viewed.out).not.toContain("새 커밋이 있습니다");
      const published = cli(fx, "publish");
      expect(published.code, published.out).toBe(0);
      expect(published.out).not.toContain("PR head가 분석 뒤 바뀌었습니다");
      const calls = readFileSync(fx.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[] });
      const lookups = calls.filter((c) => c.args[0] === "pr");
      expect(lookups).toHaveLength(2);
      for (const call of lookups)
        expect(call.args.slice(0, 5)).toEqual([
          "pr",
          "view",
          "482",
          "--repo",
          "acme/api",
        ]);
      expect(calls.find((c) => c.args.includes("POST"))!.args).toContain(
        "repos/acme/api/issues/482/comments",
      );
    });

    it("view: 새 커밋을 감지해도 기존 결과와 커밋을 유지한다 (F14, 시나리오 7)", () => {
      fx.env.FAKE_GH_LATEST = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const r = cli(fx, "view", "--no-open");
      expect(r.code).toBe(0);
      expect(r.out).toContain("새 커밋이 있습니다");
      const html = readFileSync(
        path.join(fx.root, ".pr-map/viewer/index.html"),
        "utf8",
      );
      expect(html).toContain(
        '"latestHead":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"',
      );
      expect(html).toContain(`"head":"${fx.head}"`);
    });
  });

  describe("clean", () => {
    const output = () => path.join(fx.root, ".pr-map");
    const excludeFile = () => path.join(fx.root, ".git/info/exclude");

    it("분석 결과와 exclude 줄만 지우고 다른 내용은 남긴다", () => {
      writeFileSync(excludeFile(), "# 내 규칙\n*.log\n");
      writeFileSync(path.join(fx.root, ".pr-map.yml"), "maxFiles: 10\n");
      expect(cli(fx, "collect", "--base", "main").code).toBe(0);
      expect(existsSync(output())).toBe(true);
      expect(readFileSync(excludeFile(), "utf8")).toContain(".pr-map/");

      const r = cli(fx, "clean");
      expect(r.code).toBe(0);
      expect(r.out).toContain(".pr-map/을 지웠습니다");
      expect(existsSync(output())).toBe(false);
      expect(readFileSync(excludeFile(), "utf8")).toBe("# 내 규칙\n*.log\n");
      expect(existsSync(path.join(fx.root, ".pr-map.yml"))).toBe(true);
    });

    it("지울 것이 없어도 성공한다", () => {
      expect(cli(fx, "clean").code).toBe(0);
      const r = cli(fx, "clean");
      expect(r.code).toBe(0);
      expect(r.out).toContain(".pr-map/이 없습니다");
      expect(r.out).toContain("지울 줄이 없습니다");
    });

    it("git이 추적하는 파일이 있으면 지우지 않는다", () => {
      mkdirSync(output());
      writeFileSync(path.join(output(), "kept.json"), "{}\n");
      execFileSync("git", ["add", "-f", ".pr-map/kept.json"], { cwd: fx.root });
      const r = cli(fx, "clean");
      expect(r.code).toBe(1);
      expect(r.out).toContain("추적하는 파일");
      expect(existsSync(path.join(output(), "kept.json"))).toBe(true);
    });

    it(".pr-map이 심볼릭 링크면 링크만 지운다", () => {
      const target = path.join(fx.root, "..", "keep-me");
      mkdirSync(target);
      writeFileSync(path.join(target, "file.txt"), "남아야 함\n");
      symlinkSync(target, output());
      expect(cli(fx, "clean").code).toBe(0);
      expect(lstatSync(output(), { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(path.join(target, "file.txt"), "utf8")).toBe(
        "남아야 함\n",
      );
    });
  });

  it("PR이 없으면 publish는 댓글을 쓰지 않고 뷰어를 연다", () => {
    cli(fx, "collect", "--base", "main");
    writeMap(fx, sample());
    expect(cli(fx, "build").code).toBe(0);
    writeFileSync(fx.log, "");
    const r = cli(fx, "publish");
    expect(r.code).toBe(0);
    expect(r.out).toContain("게시하지 않고");
    expect(readFileSync(fx.log, "utf8")).not.toContain("--method");
  });

  it("view: 분석 전·분석 중·실패 상태를 구분한다 (5.5)", () => {
    const page = () =>
      readFileSync(path.join(fx.root, ".pr-map/viewer/index.html"), "utf8");
    expect(cli(fx, "view", "--no-open").code).toBe(0);
    expect(page()).toContain('{"status":"empty"}');
    cli(fx, "collect");
    cli(fx, "view", "--no-open");
    expect(page()).toContain('"status":"analyzing"');
    const m = sample();
    m.files[6]!.tree[0]!.evidence[0]!.end = 99;
    writeMap(fx, m);
    cli(fx, "validate");
    cli(fx, "view", "--no-open");
    expect(page()).toContain('"status":"failed"');
    expect(page()).toContain("files[6].tree[0].evidence[0]");
  });

  it("저장소 밖이나 GitHub 원격이 없으면 이유를 말하고 멈춘다", () => {
    execFileSync("git", ["remote", "remove", "origin"], { cwd: fx.root });
    const r = cli(fx, "collect", "--base", "main");
    expect(r.code).toBe(1);
    expect(r.out).toContain("origin");
    expect(existsSync(path.join(fx.root, ".pr-map/input.json"))).toBe(false);
  });

  it('"type": "module" 저장소의 스킬 폴더에 복사해도 전체 흐름이 돈다', () => {
    writeFileSync(path.join(fx.root, "package.json"), '{ "type": "module" }');
    const installed = path.join(fx.root, ".claude/skills/pr-map");
    cpSync(path.resolve("skill/pr-map"), installed, { recursive: true });
    const run = (...args: string[]) =>
      spawnSync("node", [path.join(installed, "scripts/pr-map.js"), ...args], {
        cwd: fx.root,
        env: fx.env,
        encoding: "utf8",
      });
    expect(run("collect").status).toBe(0);
    writeMap(fx, sample());
    const r = run("build");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(path.join(fx.root, ".pr-map/viewer/index.html"))).toBe(
      true,
    );
  });

  it("공백이 있는 경로도 링크로 인코딩한다", () => {
    expect(
      permalink("a/b", "abc", { path: "x y/z.ts", start: 1, end: 1 }),
    ).toBe("https://github.com/a/b/blob/abc/x%20y/z.ts#L1");
  });
});
