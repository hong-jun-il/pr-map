import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandCompactRefs } from "../src/cli/compact";
import type {
  Evidence,
  MapFile,
  PrMap,
  TestEvidence,
  TreeNode,
} from "../src/shared/types";
import { makeFixture, type Fixture } from "./fixture";

const CLI = path.resolve("skill/pr-map/scripts/pr-map.js");
const SAMPLE = path.resolve("test/fixtures/pr-map.json");

const sample = (): PrMap => JSON.parse(readFileSync(SAMPLE, "utf8"));

const range = (start: number, end: number) =>
  start === end ? `${start}` : `${start}-${end}`;

function shortEvidence(ev: Evidence, file: MapFile): string {
  const own = ev.side === "head" ? file.path : (file.oldPath ?? file.path);
  const where = ev.path === own ? "" : `${ev.path}:`;
  return `${ev.side === "head" ? "h" : "b"}:${where}${range(ev.start, ev.end)} ${ev.role}`;
}
const shortTest = (t: TestEvidence) =>
  `t:${t.path}:${range(t.start, t.end)} ${t.role}`;

function shortenNodes(nodes: TreeNode[], file: MapFile): unknown[] {
  return nodes.map((node) => ({
    ...node,
    evidence: node.evidence.map((ev) => shortEvidence(ev, file)),
    ...(node.affectedBy && {
      affectedBy: {
        ...node.affectedBy,
        evidence: node.affectedBy.evidence.map((ev) => shortEvidence(ev, file)),
      },
    }),
    ...(node.tests && { tests: node.tests.map(shortTest) }),
    ...(node.children && { children: shortenNodes(node.children, file) }),
  }));
}

const shorten = (map: PrMap) => ({
  ...map,
  files: map.files.map((file) => ({
    ...file,
    tree: shortenNodes(file.tree, file),
  })),
});

/** 노드 하나에 근거를 넣어 펼친 결과와 오류를 돌려준다. */
function expand(
  fields: Record<string, unknown>,
  file: Record<string, unknown> = { path: "src/a.ts" },
) {
  const node = { id: "n", ...fields };
  const problems = expandCompactRefs({ files: [{ ...file, tree: [node] }] });
  return { node: node as Record<string, unknown>, problems };
}

describe("짧은 근거 펼치기", () => {
  it.each([
    [
      "현재 파일의 head 한 줄",
      "h:276 기본값",
      { side: "head", path: "src/a.ts", start: 276, end: 276, role: "기본값" },
    ],
    [
      "현재 파일의 base 범위",
      "b:10-12 이전 구현",
      { side: "base", path: "src/a.ts", start: 10, end: 12, role: "이전 구현" },
    ],
    [
      "다른 파일",
      "h:src/lib/b.ts:7-9 처리",
      { side: "head", path: "src/lib/b.ts", start: 7, end: 9, role: "처리" },
    ],
    [
      "역할 안의 콜론과 숫자",
      "h:12 비율 a:3 b",
      {
        side: "head",
        path: "src/a.ts",
        start: 12,
        end: 12,
        role: "비율 a:3 b",
      },
    ],
    [
      "다른 파일 근거의 역할 안 콜론",
      "h:src/b.ts:12 비율 a:3 b",
      {
        side: "head",
        path: "src/b.ts",
        start: 12,
        end: 12,
        role: "비율 a:3 b",
      },
    ],
    [
      "콜론이나 공백이 있는 경로",
      "b:src/my dir/a:b.ts:5 근거",
      {
        side: "base",
        path: "src/my dir/a:b.ts",
        start: 5,
        end: 5,
        role: "근거",
      },
    ],
  ])("%s", (_name, text, expected) => {
    const { node, problems } = expand({ evidence: [text] });
    expect(problems).toEqual([]);
    expect(node.evidence).toEqual([expected]);
  });

  it("이름 변경 파일은 b만 이전 경로를 기본값으로 쓴다", () => {
    const { node } = expand(
      { evidence: ["h:1 새 코드", "b:2 이전 코드"] },
      { path: "src/new.ts", oldPath: "src/old.ts" },
    );
    expect(node.evidence).toEqual([
      { side: "head", path: "src/new.ts", start: 1, end: 1, role: "새 코드" },
      { side: "base", path: "src/old.ts", start: 2, end: 2, role: "이전 코드" },
    ]);
  });

  it("affectedBy, tests, 하위 노드도 펼친다", () => {
    const child = { id: "c", evidence: ["h:3 하위"] };
    const { node, problems } = expand({
      evidence: ["h:1 노드"],
      affectedBy: { text: "원인", evidence: ["h:src/b.ts:2 원인"] },
      tests: ["t:tests/a.test.ts:4-6 확인"],
      children: [child],
    });
    expect(problems).toEqual([]);
    expect((node.affectedBy as { evidence: unknown }).evidence).toEqual([
      { side: "head", path: "src/b.ts", start: 2, end: 2, role: "원인" },
    ]);
    expect(node.tests).toEqual([
      { path: "tests/a.test.ts", start: 4, end: 6, role: "확인" },
    ]);
    expect(child.evidence).toEqual([
      { side: "head", path: "src/a.ts", start: 3, end: 3, role: "하위" },
    ]);
  });

  it("이미 객체인 항목은 건드리지 않는다", () => {
    const full = { side: "base", path: "x.ts", start: 1, end: 2, role: "r" };
    const { node, problems } = expand({ evidence: [full, "h:3 짧은 근거"] });
    expect(problems).toEqual([]);
    expect((node.evidence as unknown[])[0]).toBe(full);
  });

  it.each([
    ["역할 없음", { evidence: ["h:12"] }, "evidence[0]"],
    ["줄 번호 없음", { evidence: ["h:역할만"] }, "evidence[0]"],
    ["접두사 틀림", { evidence: ["x:12 역할"] }, "evidence[0]"],
    ["근거에 테스트 형식", { evidence: ["t:a.ts:1 역할"] }, "evidence[0]"],
    ["테스트에 근거 형식", { tests: ["h:a.ts:1 역할"] }, "tests[0]"],
    ["테스트에 경로 없음", { tests: ["t:12 역할"] }, "tests[0]"],
  ])("%s → 위치와 함께 오류를 낸다", (_name, fields, where) => {
    const { problems } = expand(fields);
    expect(problems.map((p) => p.path)).toEqual([`files[0].tree[0].${where}`]);
  });

  it("지도 형태가 아니면 펼치지 않고 스키마 검사에 맡긴다", () => {
    expect(expandCompactRefs(null)).toEqual([]);
    expect(expandCompactRefs({ files: "x" })).toEqual([]);
    expect(expandCompactRefs({ files: [{ tree: [{ evidence: 1 }] }] })).toEqual(
      [],
    );
  });
});

describe("validate의 짧은 근거 처리", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  const mapFile = () => path.join(fx.root, ".pr-map/pr-map.json");
  const cli = (...args: string[]) => {
    const r = spawnSync("node", [CLI, ...args], {
      cwd: fx.root,
      env: fx.env,
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const validateMap = (map: unknown) => {
    writeFileSync(mapFile(), JSON.stringify(map));
    return cli("validate");
  };
  const saved = () => JSON.parse(readFileSync(mapFile(), "utf8"));

  it("전체 형식과 같은 결과로 저장하고 다시 검증해도 그대로다", () => {
    cli("collect");
    const full = validateMap(sample());
    expect(full.code).toBe(0);
    const expected = saved();

    const compact = validateMap(shorten(sample()));
    expect(compact.code).toBe(0);
    expect(saved()).toEqual(expected);

    expect(cli("validate").code).toBe(0);
    expect(saved()).toEqual(expected);
  });

  it("형식 오류는 위치를 알려주고 파일을 그대로 둔다", () => {
    cli("collect");
    const map = shorten(sample()) as unknown as {
      files: { tree: { evidence: string[] }[] }[];
    };
    map.files[0]!.tree[0]!.evidence[0] = "h:역할만";
    const r = validateMap(map);
    expect(r.code).toBe(1);
    expect(r.out).toContain("files[0].tree[0].evidence[0]");
    expect(r.out).toContain("근거 형식이 아닙니다");
    expect(saved().files[0].tree[0].evidence[0]).toBe("h:역할만");
  });

  it("규칙 위반의 위치는 짧은 형식의 순서와 같다", () => {
    cli("collect");
    const map = shorten(sample()) as unknown as {
      files: { tree: { evidence: string[] }[] }[];
    };
    map.files[6]!.tree[0]!.evidence[0] = "h:999999 범위 초과";
    const r = validateMap(map);
    expect(r.code).toBe(1);
    expect(r.out).toContain("files[6].tree[0].evidence[0]");
    expect(saved().files[6].tree[0].evidence[0]).toBe("h:999999 범위 초과");
  });

  it("역할 길이 제한은 펼친 뒤 스키마가 검사한다", () => {
    cli("collect");
    const map = shorten(sample()) as unknown as {
      files: { tree: { evidence: string[] }[] }[];
    };
    map.files[0]!.tree[0]!.evidence[0] = `h:1 ${"가".repeat(41)}`;
    const r = validateMap(map);
    expect(r.code).toBe(1);
    expect(r.out).toContain("files[0].tree[0].evidence[0].role");
  });
});
