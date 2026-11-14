import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiffRows, formatTestOutline } from "../src/cli/diff";
import { makeFixture, type Fixture } from "./fixture";

const CLI = path.resolve("skill/pr-map/scripts/pr-map.js");

describe("formatDiffRows", () => {
  it("head·base 줄 번호와 변경 기호를 쓰고, 건너뛴 자리를 표시한다", () => {
    expect(
      formatDiffRows([
        { d: " ", t: "keep", o: 1, n: 1 },
        { d: "-", t: "old", o: 2, n: 0 },
        { d: "+", t: "new", o: 0, n: 2 },
        { d: " ", t: "far", o: 20, n: 20 },
      ]),
    ).toBe("1 1   keep\n. 2 - old\n2 . + new\n…\n20 20   far");
  });

  it("긴 줄과 큰 파일은 잘라서 생략을 알린다", () => {
    const long = formatDiffRows([{ d: "+", t: "x".repeat(500), o: 0, n: 1 }]);
    expect(long.length).toBeLessThan(260);
    expect(long.endsWith("…")).toBe(true);

    const rows = Array.from({ length: 450 }, (_, i) => ({
      d: "+",
      t: "y",
      o: 0,
      n: i + 1,
    }));
    const big = formatDiffRows(rows).split("\n");
    expect(big).toHaveLength(401);
    expect(big[400]).toContain("50줄 생략");
  });
});

describe("collect의 diff.txt", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  const collect = () =>
    spawnSync("node", [CLI, "collect"], {
      cwd: fx.root,
      env: fx.env,
      encoding: "utf8",
    });
  const show = (ref: string, file: string) =>
    execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: fx.root,
      encoding: "utf8",
    }).split("\n");

  it("줄 번호가 커밋의 실제 줄과 일치하고, 이름 변경과 삭제 파일도 싣는다", () => {
    expect(collect().status).toBe(0);
    const text = readFileSync(path.join(fx.root, ".pr-map/diff.txt"), "utf8");

    const section = text
      .split(/^## /m)
      .find((s) => s.startsWith("src/auth/session-refresh.ts"))!;
    const rows = section
      .split("\n")
      .slice(1)
      .filter((l) => /^(\d+|\.) (\d+|\.) /.test(l));
    expect(rows.length).toBeGreaterThan(10);
    const head = show(fx.head, "src/auth/session-refresh.ts");
    const base = show(fx.base, "src/auth/session-refresh.ts");
    for (const row of rows) {
      const [, n, o, code] = /^(\d+|\.) (\d+|\.) [ +-] ?(.*)$/.exec(row)!;
      if (n !== ".") expect(head[Number(n) - 1]).toBe(code);
      if (o !== ".") expect(base[Number(o) - 1]).toBe(code);
    }

    expect(text).toContain(
      "## src/auth/token-cache.ts (이전 경로 src/auth/token-store.ts)",
    );
    expect(text).toContain("## src/auth/legacy-refresh.ts · deleted");
    expect(text).not.toContain("## pnpm-lock.yaml");
  });
});

describe("formatTestOutline", () => {
  const row = (d: string, n: number, t: string) => ({
    d,
    t,
    o: d === "+" ? 0 : n,
    n,
  });

  it("테스트 선언마다 그 안에서 추가된 줄 범위만 남긴다", () => {
    const text = formatTestOutline([
      row("+", 1, 'import { x } from "./x";'),
      row(" ", 2, ""),
      row(" ", 3, 'test("원래 있던 테스트", () => {'),
      row("+", 4, "  expect(x(1)).toBe(2);"),
      row("+", 5, "  expect(x(2)).toBe(3);"),
      row(" ", 6, "});"),
      { d: "-", t: 'test("지운 테스트", () => {});', o: 7, n: 0 },
      row("+", 7, "test("),
      row("+", 8, '  "새 테스트",'),
      row("+", 9, "  () => {},"),
      row("+", 10, ");"),
      row(" ", 11, 'test("안 바뀐 테스트", () => {});'),
    ]);
    expect(text).toBe(
      [
        "(테스트 선언 밖)",
        "  추가된 줄: 1",
        '3   test("원래 있던 테스트", () => {',
        "  추가된 줄: 4-5",
        '7 + test( "새 테스트",',
        "  추가된 줄: 7-10",
      ].join("\n"),
    );
  });

  it("추가된 줄이 없으면 연결할 테스트가 없다고 알린다", () => {
    expect(formatTestOutline([row(" ", 1, "test('a', () => {});")])).toMatch(
      /연결할 테스트가 없다/,
    );
  });
});
