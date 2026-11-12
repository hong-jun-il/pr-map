// 평가 실행(run.ts)과 집계(score.ts)가 함께 쓰는 정답지 읽기, 채점, 지표 계산.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CodeIndex } from "../src/cli/code";
import type {
  CollectInput,
  NodeChange,
  PrMap,
  Side,
  TreeNode,
} from "../src/shared/types";
import answerSchema from "./answer.schema.json";

export const EVAL_DIR = path.dirname(new URL(import.meta.url).pathname);
export const CASES_DIR = path.join(EVAL_DIR, "cases");
export const RESULTS_DIR = path.join(EVAL_DIR, "results");

export interface Ref {
  side: Side;
  path: string;
  start: number;
  end: number;
}

export interface AnswerBehavior {
  id: string;
  text: string;
  change: NodeChange;
  evidence: string[];
  must: boolean;
}

export interface Answer {
  description: string;
  /** 실제 GitHub PR을 쓰는 케이스. 없으면 케이스 폴더의 base/·head/로 저장소를 만든다. */
  github?: { repo: string; pr: number; head: string };
  behaviors: AnswerBehavior[];
  /** 쓰면 틀리는 주장. 지금은 기록만 하고, 의미 채점 단계에서 쓴다. */
  forbidden?: string[];
}

export interface EvalCase {
  name: string;
  dir: string;
  answer: Answer;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateAnswer = ajv.compile(answerSchema);

/** 정답지 근거 `h:src/a.ts:10-12`를 읽는다. 정답지에서는 경로를 꼭 쓴다. */
export function parseRef(text: string): Ref {
  const m = /^([hb]):(.+):(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`근거 형식을 읽지 못했습니다: ${text}`);
  const start = Number(m[3]);
  const end = m[4] ? Number(m[4]) : start;
  if (start < 1 || end < start)
    throw new Error(`줄 범위가 잘못되었습니다: ${text}`);
  return { side: m[1] === "h" ? "head" : "base", path: m[2], start, end };
}

export function overlaps(a: Ref, b: Ref): boolean {
  return (
    a.side === b.side &&
    a.path === b.path &&
    a.start <= b.end &&
    b.start <= a.end
  );
}

export function loadCase(name: string): EvalCase {
  const dir = path.join(CASES_DIR, name);
  const file = path.join(dir, "answer.json");
  if (!existsSync(file))
    throw new Error(`${name}: answer.json이 없습니다 (${file})`);
  const answer = JSON.parse(readFileSync(file, "utf8")) as Answer;
  if (!validateAnswer(answer)) {
    const why = (validateAnswer.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join(", ");
    throw new Error(`${name}: answer.json 형식 오류: ${why}`);
  }
  const ids = new Set<string>();
  for (const b of answer.behaviors) {
    if (ids.has(b.id)) throw new Error(`${name}: 동작 id가 겹칩니다: ${b.id}`);
    ids.add(b.id);
    b.evidence.forEach(parseRef);
  }
  const local =
    existsSync(path.join(dir, "base")) && existsSync(path.join(dir, "head"));
  if (!local && !answer.github)
    throw new Error(
      `${name}: base/·head/ 폴더나 answer.json의 github가 필요합니다.`,
    );
  return { name, dir, answer };
}

export function listCases(): string[] {
  return readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 케이스를 분석할 임시 저장소를 만들고 경로를 돌려준다. */
export function prepareRepo(c: EvalCase): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-map-eval-")));
  if (c.answer.github) {
    const { repo, pr, head } = c.answer.github;
    git(
      tmpdir(),
      "clone",
      "--quiet",
      "--filter=blob:none",
      `https://github.com/${repo}.git`,
      root,
    );
    // 작업 트리가 분석 커밋과 같아야 줄 번호가 파일과 맞는다.
    git(root, "fetch", "--quiet", "origin", `refs/pull/${pr}/head`);
    git(root, "checkout", "--quiet", "--detach", head);
    return root;
  }
  const env = [
    "-c",
    "user.name=pr-map-eval",
    "-c",
    "user.email=eval@localhost",
  ];
  git(root, "init", "--quiet", "-b", "main");
  // collect는 origin에서 저장소 이름만 읽는다. --base로 실행하므로 접속하지 않는다.
  git(
    root,
    "remote",
    "add",
    "origin",
    `https://github.com/pr-map-eval/${c.name}.git`,
  );
  cpSync(path.join(c.dir, "base"), root, { recursive: true });
  git(root, "add", "-A");
  git(root, ...env, "commit", "--quiet", "-m", "base");
  git(root, "checkout", "--quiet", "-b", "change");
  git(root, "rm", "-r", "--quiet", ".");
  cpSync(path.join(c.dir, "head"), root, { recursive: true });
  git(root, "add", "-A");
  git(root, ...env, "commit", "--quiet", "-m", c.answer.description);
  return root;
}

export interface FlatNode {
  file: string;
  id: string;
  text: string;
  change: NodeChange;
  unverified: boolean;
  /** 정답과 짝지을 때 쓰는 근거. affectedBy 근거를 포함한다. */
  refs: Ref[];
  /** 노드 자신의 근거 */
  ownRefs: Ref[];
  affectedBy?: string;
  /** 읽지 못한 근거 문자열 수 (스킬 없는 실행에서만 생긴다) */
  badRefs?: number;
}

const toRef = ({ side, path: p, start, end }: Ref): Ref => ({
  side,
  path: p,
  start,
  end,
});

export function flattenNodes(map: PrMap): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (file: string, nodes: TreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      // validate를 통과한 지도만 근거가 객체로 펼쳐져 있다.
      const isRef = (e: unknown) => typeof e === "object" && e !== null;
      const ownRefs = (n.evidence ?? []).filter(isRef).map(toRef);
      const cause = (n.affectedBy?.evidence ?? []).filter(isRef).map(toRef);
      out.push({
        file,
        id: n.id,
        text: n.text,
        change: n.change,
        unverified: !!n.unverified,
        refs: [...ownRefs, ...cause],
        ownRefs,
        affectedBy: n.affectedBy?.text,
      });
      walk(file, n.children);
    }
  };
  for (const f of map.files ?? []) walk(f.path, f.tree);
  return out;
}

/** 스킬 없이 돌린 실행이 쓴 간단한 결과 형식 */
export interface BaselineOutput {
  summary?: string;
  behaviors?: { text?: string; change?: string; evidence?: unknown[] }[];
}

const CHANGES = ["added", "deleted", "modified", "affected", "unchanged"];

export function baselineNodes(out: BaselineOutput): FlatNode[] {
  return (out.behaviors ?? []).map((b, i) => {
    const refs: Ref[] = [];
    let badRefs = 0;
    for (const e of b.evidence ?? []) {
      try {
        refs.push(parseRef(String(e).trim().split(/\s+/)[0]));
      } catch {
        badRefs++;
      }
    }
    return {
      file: refs[0]?.path ?? "(근거 없음)",
      id: `b${String(i + 1).padStart(2, "0")}`,
      text: String(b.text ?? ""),
      change: (CHANGES.includes(b.change ?? "")
        ? b.change
        : "modified") as NodeChange,
      unverified: false,
      refs,
      ownRefs: refs,
      badRefs,
    };
  });
}

export interface BehaviorScore {
  id: string;
  must: boolean;
  found: boolean;
  changeOk: boolean;
  nodes: string[];
}

export interface MapScore {
  behaviors: BehaviorScore[];
  /** 꼭 있어야 하는 동작 중 지도가 찾은 비율 */
  mustRecall: number;
  recall: number;
  /** 찾은 동작 중 분기 상태까지 맞은 비율 */
  changeAccuracy: number | null;
  nodes: number;
  unverified: number;
  /** 바뀐 노드 중 정답지의 어떤 근거와도 겹치지 않는 노드 */
  extraNodes: string[];
}

const ratio = (a: number, b: number) => (b ? a / b : 0);

/**
 * 근거 줄 범위가 겹치는 노드를 정답 동작과 짝짓는다.
 * 노드 문장이나 id가 바뀌어도 같은 정답지로 채점할 수 있다.
 */
export function scoreMap(map: PrMap, answer: Answer): MapScore {
  return scoreNodes(flattenNodes(map), answer);
}

export function scoreNodes(nodes: FlatNode[], answer: Answer): MapScore {
  const answerRefs: Ref[] = [];
  const behaviors = answer.behaviors.map((b) => {
    const refs = b.evidence.map(parseRef);
    answerRefs.push(...refs);
    const matched = nodes.filter(
      (n) =>
        !n.unverified && n.refs.some((r) => refs.some((a) => overlaps(a, r))),
    );
    return {
      id: b.id,
      must: b.must,
      found: matched.length > 0,
      changeOk: matched.some((n) => n.change === b.change),
      nodes: matched.map((n) => `${n.file}#${n.id}`),
    };
  });
  const must = behaviors.filter((b) => b.must);
  const found = behaviors.filter((b) => b.found);
  const extraNodes = nodes
    .filter((n) => n.change !== "unchanged" && !n.unverified)
    .filter((n) => !n.refs.some((r) => answerRefs.some((a) => overlaps(a, r))))
    .map((n) => `${n.file}#${n.id}`);
  return {
    behaviors,
    mustRecall: ratio(must.filter((b) => b.found).length, must.length),
    recall: ratio(found.length, behaviors.length),
    changeAccuracy: found.length
      ? found.filter((b) => b.changeOk).length / found.length
      : null,
    nodes: nodes.length,
    unverified: nodes.filter((n) => n.unverified).length,
    extraNodes,
  };
}

export function codeIndex(root: string, input: CollectInput): CodeIndex {
  return new CodeIndex(root, input.pr.base, input.pr.head, [
    ...input.files,
    ...input.unclassified,
  ]);
}

/** 지도 대상 파일의 바뀐 줄 중 어떤 노드의 근거와라도 겹치는 줄의 비율 */
export function changedLineCoverage(
  root: string,
  input: CollectInput,
  map: PrMap | FlatNode[],
): { covered: number; total: number } {
  const code = codeIndex(root, input);
  const nodes = Array.isArray(map) ? map : flattenNodes(map);
  const refs = nodes.flatMap((n) => n.refs);
  let covered = 0;
  let total = 0;
  for (const f of input.files) {
    const sides: [Side, string][] = [];
    if (f.status !== "deleted") sides.push(["head", f.path]);
    if (f.status !== "added") sides.push(["base", f.oldPath ?? f.path]);
    for (const [side, p] of sides) {
      for (const ln of code.lines(side, p)?.changed ?? []) {
        total++;
        const line = { side, path: p, start: ln, end: ln };
        if (refs.some((r) => overlaps(r, line))) covered++;
      }
    }
  }
  return { covered, total };
}

/** 정답지의 근거가 실제 코드와 맞는지 확인한다. 정답지의 실수를 먼저 잡는다. */
export function checkAnswer(
  root: string,
  input: CollectInput,
  answer: Answer,
): string[] {
  const code = codeIndex(root, input);
  const problems: string[] = [];
  for (const b of answer.behaviors) {
    const refs = b.evidence.map(parseRef);
    const touches = refs.map((r) => {
      const info = code.lines(r.side, r.path);
      if (!info) {
        problems.push(`${b.id}: ${r.side} 커밋에 ${r.path}가 없습니다.`);
        return false;
      }
      if (r.end > info.lineCount)
        problems.push(
          `${b.id}: ${r.path}는 ${info.lineCount}줄인데 ${r.end}줄을 가리킵니다.`,
        );
      for (let ln = r.start; ln <= r.end; ln++)
        if (info.changed.has(ln)) return true;
      return false;
    });
    const any = touches.some(Boolean);
    if (
      b.change === "added" &&
      !refs.some((r, i) => r.side === "head" && touches[i])
    )
      problems.push(
        `${b.id}: added인데 head의 추가 줄과 겹치는 근거가 없습니다.`,
      );
    if (b.change === "deleted" && (refs.some((r) => r.side !== "base") || !any))
      problems.push(
        `${b.id}: deleted는 base 근거만 쓰고, 지운 줄과 겹쳐야 합니다.`,
      );
    if (b.change === "modified" && !any)
      problems.push(`${b.id}: modified인데 바뀐 줄과 겹치는 근거가 없습니다.`);
    if (b.change === "affected" && any)
      problems.push(`${b.id}: affected의 근거는 바뀌지 않은 줄이어야 합니다.`);
  }
  return problems;
}
