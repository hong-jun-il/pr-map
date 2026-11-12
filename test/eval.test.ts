import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CollectInput, PrMap, TreeNode } from "../src/shared/types";
import {
  changedLineCoverage,
  checkAnswer,
  listCases,
  loadCase,
  overlaps,
  parseRef,
  prepareRepo,
  scoreMap,
  type Answer,
} from "../eval/lib";

const CLI = path.resolve("skill/pr-map/scripts/pr-map.js");

const node = (
  id: string,
  change: TreeNode["change"],
  refs: string[],
  extra: Partial<TreeNode> = {},
): TreeNode => ({
  id,
  text: id,
  change,
  evidence: refs.map((r) => ({ ...parseRef(r), role: "근거" })),
  ...extra,
});

const mapOf = (tree: TreeNode[], filePath = "src/retry.ts"): PrMap => ({
  version: 2,
  pr: {
    repo: "o/r",
    number: null,
    base: "a".repeat(7),
    head: "b".repeat(7),
    summary: "s",
  },
  readingOrder: [],
  edges: [],
  files: [
    {
      id: "f",
      path: filePath,
      status: "modified",
      layer: "core",
      role: "r",
      tree,
    },
  ],
});

describe("parseRef", () => {
  it("경로와 줄 범위를 읽는다", () => {
    expect(parseRef("h:src/a.ts:10-12")).toEqual({
      side: "head",
      path: "src/a.ts",
      start: 10,
      end: 12,
    });
    expect(parseRef("b:src/a.ts:3")).toMatchObject({
      side: "base",
      start: 3,
      end: 3,
    });
  });

  it("경로가 없거나 범위가 뒤집히면 실패한다", () => {
    expect(() => parseRef("h:10")).toThrow();
    expect(() => parseRef("h:src/a.ts:5-2")).toThrow();
  });

  it("같은 커밋, 같은 파일에서 줄이 겹칠 때만 겹친다고 본다", () => {
    const a = parseRef("h:src/a.ts:10-12");
    expect(overlaps(a, parseRef("h:src/a.ts:12-20"))).toBe(true);
    expect(overlaps(a, parseRef("h:src/a.ts:13"))).toBe(false);
    expect(overlaps(a, parseRef("b:src/a.ts:10"))).toBe(false);
    expect(overlaps(a, parseRef("h:src/b.ts:10"))).toBe(false);
  });
});

describe("scoreMap", () => {
  const answer: Answer = {
    description: "d",
    behaviors: [
      {
        id: "a",
        text: "a",
        change: "modified",
        evidence: ["h:src/retry.ts:3"],
        must: true,
      },
      {
        id: "b",
        text: "b",
        change: "added",
        evidence: ["h:src/retry.ts:16"],
        must: true,
      },
      {
        id: "c",
        text: "c",
        change: "added",
        evidence: ["h:src/sleep.ts:1-3"],
        must: false,
      },
    ],
  };

  it("근거 줄이 겹치는 노드를 정답과 짝짓고, 상태가 맞는지 센다", () => {
    const s = scoreMap(
      mapOf([
        node("limit", "modified", ["h:src/retry.ts:3"]),
        node("abort", "modified", ["h:src/retry.ts:15-16"]),
        node("other", "added", ["h:src/retry.ts:30"]),
      ]),
      answer,
    );
    expect(s.behaviors.map((b) => [b.id, b.found, b.changeOk])).toEqual([
      ["a", true, true],
      ["b", true, false],
      ["c", false, false],
    ]);
    expect(s.mustRecall).toBe(1);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.changeAccuracy).toBe(0.5);
    expect(s.extraNodes).toEqual(["src/retry.ts#other"]);
  });

  it("강등된 노드와 하위 노드도 센다", () => {
    const s = scoreMap(
      mapOf([
        node("parent", "unchanged", ["h:src/retry.ts:10"], {
          children: [node("limit", "modified", ["h:src/retry.ts:3"])],
        }),
        { ...node("lost", "added", []), unverified: true },
      ]),
      answer,
    );
    expect(s.nodes).toBe(3);
    expect(s.unverified).toBe(1);
    expect(s.behaviors[0]?.nodes).toEqual(["src/retry.ts#limit"]);
    expect(s.mustRecall).toBe(0.5);
  });

  it("affectedBy 근거로도 짝짓는다", () => {
    const s = scoreMap(
      mapOf(
        [
          node("total", "affected", ["h:src/cart.ts:5"], {
            affectedBy: {
              text: "t",
              evidence: [{ ...parseRef("h:src/format.ts:2"), role: "r" }],
            },
          }),
        ],
        "src/cart.ts",
      ),
      {
        description: "d",
        behaviors: [
          {
            id: "x",
            text: "x",
            change: "added",
            evidence: ["h:src/format.ts:2"],
            must: true,
          },
        ],
      },
    );
    expect(s.behaviors[0]?.found).toBe(true);
  });
});

describe("평가 케이스", () => {
  it("모든 케이스의 정답지 형식이 맞다", () => {
    const names = listCases();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(() => loadCase(n)).not.toThrow();
  });

  let root: string;
  let input: CollectInput;
  beforeAll(() => {
    root = prepareRepo(loadCase("retry-backoff"));
    execFileSync("node", [CLI, "collect", "--base", "main"], {
      cwd: root,
      stdio: "pipe",
    });
    input = JSON.parse(
      readFileSync(path.join(root, ".pr-map/input.json"), "utf8"),
    ) as CollectInput;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("임시 저장소에서 수집하면 케이스의 변경 파일이 나온다", () => {
    expect(input.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ["src/retry.ts", "modified"],
      ["src/sleep.ts", "added"],
    ]);
  });

  it("정답지의 줄 번호나 상태가 틀리면 잡아낸다", () => {
    const wrong: Answer = {
      description: "d",
      behaviors: [
        {
          id: "far",
          text: "t",
          change: "added",
          evidence: ["h:src/retry.ts:90"],
          must: true,
        },
        {
          id: "same",
          text: "t",
          change: "added",
          evidence: ["h:src/retry.ts:14"],
          must: true,
        },
        {
          id: "gone",
          text: "t",
          change: "deleted",
          evidence: ["h:src/retry.ts:3"],
          must: true,
        },
        {
          id: "nofile",
          text: "t",
          change: "modified",
          evidence: ["h:src/none.ts:1"],
          must: true,
        },
      ],
    };
    const problems = checkAnswer(root, input, wrong).join("\n");
    expect(problems).toMatch(/far: .*24줄인데 90줄/);
    expect(problems).toMatch(/same: added인데/);
    expect(problems).toMatch(/gone: deleted는/);
    expect(problems).toMatch(/nofile: .*없습니다/);
    expect(checkAnswer(root, input, loadCase("retry-backoff").answer)).toEqual(
      [],
    );
  });

  it("바뀐 줄 중 근거가 덮은 줄의 비율을 센다", () => {
    const full = changedLineCoverage(root, input, mapOf([]));
    expect(full.covered).toBe(0);
    expect(full.total).toBeGreaterThan(0);
    const some = changedLineCoverage(
      root,
      input,
      mapOf([
        node("limit", "modified", ["h:src/retry.ts:3", "b:src/retry.ts:1"]),
      ]),
    );
    expect(some.covered).toBe(2);
  });
});
