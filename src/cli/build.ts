import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CodeEntry,
  CollectInput,
  Evidence,
  MapFile,
  PrMap,
  RelationCandidate,
  TestEvidence,
  TreeNode,
  ViewerData,
  ViewerEdge,
  ViewerFile,
  ViewerMapData,
} from "../shared/types";
import { CodeIndex } from "./code";
import { buildComment } from "./comment";
import {
  commentPath,
  viewerDataPath,
  viewerHtmlPath,
  writeJson,
  writeText,
} from "./paths";
import { countUnverified } from "./validate";

const DATA_SLOT = "/*__PR_MAP_DATA__*/null";
const LINKED_TEST = "분기에 연결됨";

function collectEvidence(nodes: TreeNode[], out: Evidence[]): void {
  for (const n of nodes) {
    out.push(...n.evidence, ...(n.affectedBy?.evidence ?? []));
    if (n.children) collectEvidence(n.children, out);
  }
}

function collectTests(nodes: TreeNode[], out: TestEvidence[]): void {
  for (const n of nodes) {
    if (n.tests) out.push(...n.tests);
    if (n.children) collectTests(n.children, out);
  }
}

function callersText(f: MapFile, candidates: RelationCandidate[]): string {
  const callers = candidates.filter((c) => c.to === f.path).map((c) => c.from);
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f.path))
    return "남은 호출 확인 안 함";
  return callers.length
    ? `head에 남은 호출 ${callers.length}곳`
    : "head에 남은 호출 없음";
}

export function buildViewerData(
  map: PrMap,
  input: CollectInput,
  code: CodeIndex,
): ViewerMapData {
  const byId = new Map(map.files.map((f) => [f.id, f]));
  const changes = new Map(input.files.map((f) => [f.path, f]));
  const files: ViewerFile[] = map.files.map((f) => {
    const c = changes.get(f.path);
    const slash = f.path.lastIndexOf("/");
    return {
      ...f,
      name: f.path.slice(slash + 1),
      dir: f.path.slice(0, slash + 1),
      additions: c?.additions ?? 0,
      deletions: c?.deletions ?? 0,
      replacedByNames: (f.replacedBy ?? []).map((id) => {
        const target = byId.get(id);
        return target
          ? target.path.slice(target.path.lastIndexOf("/") + 1)
          : id;
      }),
      callers: f.status === "deleted" ? callersText(f, input.candidates) : "",
    };
  });

  const codeIndex: Record<string, string> = {};
  const entries: Record<string, CodeEntry> = {};
  const add = (side: Evidence["side"], p: string) => {
    const key = code.key(side, p);
    codeIndex[`${side}:${p}`] = key;
    if (!entries[key]) entries[key] = code.entry(side, p);
  };
  const evidence: Evidence[] = [];
  map.files.forEach((f) => collectEvidence(f.tree, evidence));
  evidence.forEach((ev) => add(ev.side, ev.path));
  const tests: TestEvidence[] = [];
  map.files.forEach((f) => collectTests(f.tree, tests));
  tests.forEach((t) => add("head", t.path));
  const linkedTests = new Set(tests.map((t) => t.path));

  // 변경 파일인데 AI가 지도에 넣지 않았으면 조용히 빠뜨리지 않는다.
  const mapped = new Set(map.files.map((f) => f.path));
  const unclassified = [
    ...input.unclassified.map((f) =>
      f.category === "test"
        ? {
            ...f,
            reason: linkedTests.has(f.path) ? LINKED_TEST : "연결된 분기 없음",
          }
        : f,
    ),
    ...input.files
      .filter((f) => !mapped.has(f.path))
      .map((f) => ({
        ...f,
        reason: "분석 결과 없음",
        category: "attention" as const,
      })),
  ];

  const edges: ViewerEdge[] = [
    ...map.edges.map((e) => ({ ...e, kind: "calls" as const })),
    ...map.files.flatMap((f) =>
      (f.replacedBy ?? []).map((to) => ({
        from: f.id,
        to,
        label: "대체됨",
        kind: "replacedBy" as const,
      })),
    ),
  ];

  return {
    status: "ready",
    pr: { ...input.pr, summary: map.pr.summary },
    counts: {
      changed: input.files.length + input.unclassified.length,
      mapped: map.files.length,
      unclassified: unclassified.length,
      unverified: countUnverified(map),
    },
    readingOrder: map.readingOrder,
    files,
    edges,
    unclassified,
    codeIndex,
    code: entries,
    latestHead: null,
    newCommits: null,
  };
}

export function assetsDir(): string {
  // 번들 위치: <skill>/scripts/pr-map.js → 템플릿: <skill>/assets/viewer.html
  return path.join(__dirname, "..", "assets");
}

/** 데이터를 인라인한 단일 HTML을 만든다. 코드에 </script>가 있어도 탈출하지 못하게 한다. */
export function renderHtml(
  data: ViewerData,
  template = readFileSync(path.join(assetsDir(), "viewer.html"), "utf8"),
): string {
  if (!template.includes(DATA_SLOT))
    throw new Error("viewer.html에 데이터 자리가 없습니다.");
  // U+2028/2029도 스크립트 안에서 줄바꿈으로 읽히지 않게 이스케이프한다.
  const json = JSON.stringify(data).replace(
    /[<\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return template.replace(DATA_SLOT, () => json);
}

export function writeViewer(root: string, data: ViewerData): string {
  const file = viewerHtmlPath(root);
  writeText(file, renderHtml(data));
  return file;
}

export function build(
  root: string,
  map: PrMap,
  input: CollectInput,
  code: CodeIndex,
): ViewerMapData {
  const data = buildViewerData(map, input, code);
  writeJson(viewerDataPath(root), data);
  writeViewer(root, data);
  writeText(
    commentPath(root),
    buildComment(data, process.env.PR_MAP_RUN_URL || undefined),
  );
  return data;
}
