// 채점기에 넘길 재료를 만든다. 노드 문장과, 근거 줄 번호로 git에서 읽은 실제 코드를 묶는다.
import type { CodeIndex } from "../src/cli/code";
import type { CollectInput, NodeChange } from "../src/shared/types";
import { codeIndex, type FlatNode, type Ref } from "./lib";

const CONTEXT = 3;
const MAX_LINES = 60;

export interface EvidenceRef {
  ref: string;
  /** 그 커밋에 파일이 있고 줄 범위가 파일 안에 있다 */
  valid: boolean;
  /** 이번 PR에서 바뀐 줄과 겹친다 */
  touchesChange: boolean;
  /** `줄번호 기호 코드`. 근거 범위 안의 줄은 앞에 >를 붙인다 */
  lines: string[];
}

export interface EvidenceNode {
  /** 채점기에 보여 주는 익명 번호 */
  key: string;
  file: string;
  id: string;
  text: string;
  change: NodeChange;
  unverified: boolean;
  affectedBy?: string;
  refs: EvidenceRef[];
}

export interface EvidenceFile {
  summary: string;
  nodes: EvidenceNode[];
  check: {
    refs: number;
    /** 읽지 못했거나, 파일이 없거나, 줄 범위가 파일을 벗어난 근거 */
    invalidRefs: number;
    nodes: number;
    /** 근거가 하나도 유효하지 않은 노드 */
    nodesWithoutEvidence: number;
    /** 분기 상태(added 등)와 근거가 맞지 않는 노드 */
    changeMismatch: number;
  };
}

export const refText = (r: Ref) =>
  `${r.side === "head" ? "h" : "b"}:${r.path}:${r.start}${r.end === r.start ? "" : `-${r.end}`}`;

function readRef(code: CodeIndex, r: Ref): EvidenceRef {
  const info = code.lines(r.side, r.path);
  const out: EvidenceRef = {
    ref: refText(r),
    valid: false,
    touchesChange: false,
    lines: [],
  };
  if (!info || r.end > info.lineCount) return out;
  out.valid = true;
  for (let ln = r.start; ln <= r.end; ln++)
    if (info.changed.has(ln)) out.touchesChange = true;
  const entry = code.entry(r.side, r.path);
  if (!("rows" in entry)) return out;
  for (const row of entry.rows) {
    const ln = r.side === "head" ? row.n : row.o;
    if (!ln || ln < r.start - CONTEXT || ln > r.end + CONTEXT) continue;
    const inside = ln >= r.start && ln <= r.end;
    out.lines.push(`${inside ? ">" : " "} ${ln} ${row.d} ${row.t}`.trimEnd());
    if (out.lines.length >= MAX_LINES) {
      out.lines.push("  … (생략)");
      break;
    }
  }
  return out;
}

/** validate의 상태 일치 규칙을 스킬 없는 실행에도 같은 잣대로 적용한다. */
function changeMatches(n: FlatNode, own: EvidenceRef[]): boolean {
  if (n.unverified) return true;
  const valid = own.filter((r) => r.valid);
  const touched = valid.filter((r) => r.touchesChange);
  switch (n.change) {
    case "added":
      return touched.some((r) => r.ref.startsWith("h:"));
    case "deleted":
      return valid.every((r) => r.ref.startsWith("b:")) && touched.length > 0;
    case "modified":
      return touched.length > 0;
    case "affected":
    case "unchanged":
      return valid.length > 0 && touched.length === 0;
  }
}

export function buildEvidence(
  root: string,
  input: CollectInput,
  nodes: FlatNode[],
  summary: string,
): EvidenceFile {
  const code = codeIndex(root, input);
  let refs = 0;
  let invalidRefs = 0;
  let nodesWithoutEvidence = 0;
  let changeMismatch = 0;
  const out = nodes.map((n, i) => {
    const all = n.refs.map((r) => readRef(code, r));
    const own = all.slice(0, n.ownRefs.length);
    refs += all.length + (n.badRefs ?? 0);
    invalidRefs += all.filter((r) => !r.valid).length + (n.badRefs ?? 0);
    if (!n.unverified && !all.some((r) => r.valid)) nodesWithoutEvidence++;
    if (!changeMatches(n, own)) changeMismatch++;
    return {
      key: `n${String(i + 1).padStart(3, "0")}`,
      file: n.file,
      id: n.id,
      text: n.text,
      change: n.change,
      unverified: n.unverified,
      affectedBy: n.affectedBy,
      refs: all,
    };
  });
  return {
    summary,
    nodes: out,
    check: {
      refs,
      invalidRefs,
      nodes: nodes.length,
      nodesWithoutEvidence,
      changeMismatch,
    },
  };
}
