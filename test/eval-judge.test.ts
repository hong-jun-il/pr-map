import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence, type EvidenceFile } from "../eval/evidence";
import {
  behaviorPrompt,
  chunk,
  judgeRun,
  majority,
  nodePrompt,
  summarize,
  type Judge,
  type NodeVerdict,
} from "../eval/judge-lib";
import {
  baselineNodes,
  loadCase,
  prepareRepo,
  scoreNodes,
  type Answer,
} from "../eval/lib";
import type { CollectInput } from "../src/shared/types";

const CLI = path.resolve("skill/pr-map/scripts/pr-map.js");

describe("baselineNodes", () => {
  it("스킬 없는 결과를 노드로 바꾸고, 읽지 못한 근거를 센다", () => {
    const nodes = baselineNodes({
      behaviors: [
        {
          text: "한도가 5회로 늘어난다",
          change: "modified",
          evidence: ["h:src/retry.ts:3 한도", "src/retry.ts:1", 7],
        },
        { text: "상태가 이상하다", change: "이상함", evidence: [] },
      ],
    });
    expect(nodes[0]).toMatchObject({
      id: "b01",
      file: "src/retry.ts",
      change: "modified",
      badRefs: 2,
    });
    expect(nodes[0].refs).toEqual([
      { side: "head", path: "src/retry.ts", start: 3, end: 3 },
    ]);
    expect(nodes[1]).toMatchObject({ change: "modified", file: "(근거 없음)" });
  });
});

describe("buildEvidence", () => {
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
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("근거 줄의 실제 코드를 붙이고, 없는 줄과 상태 불일치를 센다", () => {
    const nodes = baselineNodes({
      behaviors: [
        { text: "한도", change: "modified", evidence: ["h:src/retry.ts:3"] },
        { text: "없는 줄", change: "added", evidence: ["h:src/retry.ts:999"] },
        {
          text: "그대로인 줄",
          change: "added",
          evidence: ["h:src/retry.ts:14"],
        },
      ],
    });
    const e = buildEvidence(root, input, nodes, "요약");
    expect(e.nodes[0].refs[0]).toMatchObject({
      valid: true,
      touchesChange: true,
    });
    expect(e.nodes[0].refs[0].lines).toContain(
      "> 3 + export const MAX_ATTEMPTS = 5;",
    );
    expect(e.nodes[1].refs[0]).toMatchObject({ valid: false, lines: [] });
    expect(e.check).toEqual({
      refs: 3,
      invalidRefs: 1,
      nodes: 3,
      nodesWithoutEvidence: 1,
      changeMismatch: 2,
    });
    expect(scoreNodes(nodes, loadCase("retry-backoff").answer).mustRecall).toBe(
      1 / 3,
    );
  });
});

const evidence: EvidenceFile = {
  summary: "요약 문장",
  check: {
    refs: 3,
    invalidRefs: 1,
    nodes: 4,
    nodesWithoutEvidence: 1,
    changeMismatch: 0,
  },
  nodes: [
    {
      key: "n001",
      file: "src/a.ts",
      id: "one",
      text: "첫 번째 설명",
      change: "added",
      unverified: false,
      refs: [
        {
          ref: "h:src/a.ts:2",
          valid: true,
          touchesChange: true,
          lines: ["> 2 + x"],
        },
      ],
    },
    {
      key: "n002",
      file: "src/a.ts",
      id: "two",
      text: "두 번째 설명",
      change: "modified",
      unverified: false,
      affectedBy: "원인 문장",
      refs: [
        {
          ref: "h:src/a.ts:9",
          valid: true,
          touchesChange: true,
          lines: ["> 9 + y"],
        },
      ],
    },
    {
      key: "n003",
      file: "src/a.ts",
      id: "bad",
      text: "근거가 없는 설명",
      change: "added",
      unverified: false,
      refs: [
        { ref: "h:src/a.ts:99", valid: false, touchesChange: false, lines: [] },
      ],
    },
    {
      key: "n004",
      file: "src/a.ts",
      id: "demoted",
      text: "강등된 설명",
      change: "added",
      unverified: true,
      refs: [],
    },
  ],
};

const answer: Answer = {
  description: "d",
  behaviors: [
    {
      id: "first",
      text: "정답 하나",
      change: "added",
      evidence: ["h:src/a.ts:2"],
      must: true,
    },
    {
      id: "second",
      text: "정답 둘",
      change: "added",
      evidence: ["h:src/b.ts:1"],
      must: true,
    },
  ],
  forbidden: ["틀린 주장"],
};

describe("채점 프롬프트", () => {
  it("노드 문장, 원인, 유효한 근거 코드만 싣는다", () => {
    const p = nodePrompt(evidence.nodes.slice(0, 2));
    expect(p).toContain("### n001");
    expect(p).toContain("설명 문장: 첫 번째 설명");
    expect(p).toContain("원인: 원인 문장");
    expect(p).toContain("[h:src/a.ts:9]\n> 9 + y");
    expect(p).not.toContain("one");
  });

  it("근거 줄이 겹치는 노드를 후보로 주고, 없으면 전체에서 찾게 한다", () => {
    const p = behaviorPrompt(evidence, answer);
    const [, first, second] = p.split("### ");
    expect(first).toContain("- n001: 첫 번째 설명");
    expect(first).not.toContain("n002");
    expect(second).toContain("같은 코드를 가리킨 설명이 없다");
    expect(p).toContain("- summary: 요약 문장");
    expect(p).toContain("0. 틀린 주장");
    expect(p).not.toContain("강등된 설명");
  });
});

describe("majority", () => {
  const order: NodeVerdict[] = ["correct", "partial", "unsupported", "wrong"];
  it("과반이 있으면 그 판정을, 없으면 가운데 판정을 고른다", () => {
    expect(majority(["wrong", "correct", "correct"], order)).toBe("correct");
    expect(majority(["wrong", "correct", "partial"], order)).toBe("partial");
    expect(majority(["wrong"], order)).toBe("wrong");
  });
  it("chunk는 순서를 지켜 나눈다", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("judgeRun", () => {
  it("판정을 다수결로 합치고, 근거 없는 노드는 묻지 않고 근거 불일치로 둔다", async () => {
    let calls = 0;
    let nodeCalls = 0;
    const seen: string[] = [];
    const judge: Judge = async (_rubric, prompt, schema) => {
      calls++;
      seen.push(prompt);
      if ("nodes" in (schema as { properties: object }).properties) {
        const vote = nodeCalls++;
        return {
          costUsd: 0.01,
          output: {
            nodes: [
              { key: "n001", verdict: "correct", reason: "맞다" },
              // 한 번은 다르게 답해도 다수결로 정해진다.
              {
                key: "n002",
                verdict: vote < 2 ? "wrong" : "partial",
                reason: "틀리다",
              },
              { key: "n999", verdict: "correct", reason: "없는 번호" },
            ],
          },
        };
      }
      return {
        costUsd: 0.02,
        output: {
          behaviors: [
            { id: "first", verdict: "same", key: "n001", reason: "같다" },
            { id: "second", verdict: "missing", key: "", reason: "없다" },
          ],
          forbidden: [{ index: 0, violated: true, key: "summary" }],
        },
      };
    };
    const r = await judgeRun(evidence, answer, judge, {
      model: "fake",
      votes: 3,
      chunkSize: 12,
      concurrency: 1,
    });
    expect(calls).toBe(6);
    expect(seen.join("\n")).not.toContain("근거가 없는 설명\n근거 코드");
    expect(r.nodes.map((n) => [n.id, n.verdict])).toEqual([
      ["one", "correct"],
      ["two", "wrong"],
      ["bad", "unsupported"],
    ]);
    expect(r.behaviors.map((b) => [b.id, b.verdict, b.key])).toEqual([
      ["first", "same", "n001"],
      ["second", "missing", ""],
    ]);
    expect(r.forbidden[0]).toMatchObject({ violated: true });
    expect(r.costUsd).toBeCloseTo(0.09);

    const s = summarize(r);
    expect(s).toMatchObject({
      judged: 3,
      correct: 1,
      wrong: 1,
      unsupported: 1,
      strictMustRecall: 0.5,
      forbiddenViolations: 1,
    });
    expect(s.precision).toBeCloseTo(1 / 3);
    expect(s.unanimous).toBe(0.5);
  });

  it("호출이 실패하면 판정 없이 실패 횟수를 남긴다", async () => {
    const r = await judgeRun(evidence, answer, async () => null, {
      model: "fake",
      votes: 1,
      chunkSize: 12,
      concurrency: 2,
    });
    expect(r.failedCalls).toBe(2);
    expect(r.nodes[0].verdict).toBeNull();
    expect(summarize(r).precision).toBe(0);
  });
});
