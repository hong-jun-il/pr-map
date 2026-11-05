import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../spec/pr-map.schema.json';
import type { ChangedFile, CollectInput, Evidence, MapFile, PrMap, TreeNode } from '../shared/types';
import { CodeIndex } from './code';

export interface Problem {
  path: string;
  reason: string;
  /** 3회 실패 뒤 강등할 노드. 없으면 강등으로 해결되지 않는 오류다. */
  node?: { file: string; id: string };
}

const MAX_DEPTH = 4;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

function formatPointer(ptr: string): string {
  return ptr
    .split('/')
    .filter(Boolean)
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), '');
}

export function checkSchema(map: unknown): Problem[] {
  if (validateSchema(map)) return [];
  return (validateSchema.errors ?? [])
    .filter((e) => e.keyword !== 'if')
    .map((e) => ({ path: formatPointer(e.instancePath) || '(최상위)', reason: `스키마: ${e.message}` }));
}

/** AI가 쓸 필요 없는 값은 수집 결과로 맞춘다. */
export function normalize(map: PrMap, input: CollectInput): void {
  map.pr.repo = input.pr.repo;
  map.pr.number = input.pr.number;
  map.pr.base = input.pr.base;
  map.pr.head = input.pr.head;
}

function overlaps(ev: Evidence, lines: Set<number>): boolean {
  for (let i = ev.start; i <= ev.end; i++) if (lines.has(i)) return true;
  return false;
}

interface Located {
  ev: Evidence;
  changed: boolean;
}

function locate(evidence: Evidence[], path: string, code: CodeIndex, renamed: Map<string, string>, out: Problem[], node: Problem['node']): Located[] | null {
  let ok = true;
  const located: Located[] = [];
  evidence.forEach((ev, i) => {
    const p = `${path}[${i}]`;
    if (ev.start > ev.end) {
      out.push({ path: p, reason: `start(${ev.start})가 end(${ev.end})보다 큽니다.`, node });
      ok = false;
      return;
    }
    if (ev.side === 'base' && renamed.has(ev.path)) {
      out.push({ path: p, reason: `이름 변경 파일의 base 근거는 oldPath(${renamed.get(ev.path)})를 써야 합니다.`, node });
      ok = false;
      return;
    }
    const info = code.lines(ev.side, ev.path);
    if (!info) {
      out.push({ path: p, reason: `${ev.side} 커밋에서 ${ev.path}를 읽을 수 없습니다.`, node });
      ok = false;
      return;
    }
    if (ev.end > info.lineCount) {
      out.push({ path: p, reason: `end(${ev.end})가 ${ev.side}의 ${ev.path} 줄 수(${info.lineCount})를 넘습니다.`, node });
      ok = false;
      return;
    }
    located.push({ ev, changed: overlaps(ev, info.changed) });
  });
  return ok ? located : null;
}

function checkNode(n: TreeNode, path: string, depth: number, file: MapFile, code: CodeIndex, renamed: Map<string, string>, ids: Set<string>, out: Problem[]): void {
  const node = { file: file.id, id: n.id };
  if (ids.has(n.id)) out.push({ path, reason: `노드 id "${n.id}"가 파일 안에서 중복됩니다.` });
  ids.add(n.id);
  if (depth > MAX_DEPTH) out.push({ path, reason: `트리 깊이가 ${MAX_DEPTH}단계를 넘습니다. 묶어서 줄이세요.` });

  if (file.status === 'added' && n.change !== 'added') out.push({ path, reason: '추가된 파일의 노드는 모두 added여야 합니다.', node });
  if (file.status === 'deleted' && n.change !== 'deleted') out.push({ path, reason: '삭제된 파일의 노드는 모두 deleted여야 합니다.', node });

  if (!n.unverified) {
    const located = locate(n.evidence, `${path}.evidence`, code, renamed, out, node);
    if (located) {
      const anyChanged = located.some((l) => l.changed);
      const anyBase = located.some((l) => l.ev.side === 'base');
      if (n.change === 'added') {
        if (anyBase) out.push({ path, reason: 'added 노드에는 base 근거를 쓸 수 없습니다.', node });
        if (!located.some((l) => l.changed && l.ev.side === 'head')) out.push({ path, reason: 'added 노드의 근거가 head의 + 줄과 겹치지 않습니다.', node });
      } else if (n.change === 'deleted') {
        if (located.some((l) => l.ev.side !== 'base')) out.push({ path, reason: 'deleted 노드의 근거는 모두 base여야 합니다.', node });
        if (!located.some((l) => l.changed && l.ev.side === 'base')) out.push({ path, reason: 'deleted 노드의 근거가 base의 − 줄과 겹치지 않습니다.', node });
      } else if (n.change === 'modified') {
        if (!anyChanged) out.push({ path, reason: 'modified 노드의 근거가 + 또는 − 줄과 겹치지 않습니다. 자신의 코드가 그대로면 unchanged로 쓰세요.', node });
      } else if (anyChanged) {
        out.push({ path, reason: `${n.change} 노드의 근거가 변경 줄과 겹칩니다.`, node });
      }
    }
    if (n.change === 'affected' && n.affectedBy) {
      const cause = locate(n.affectedBy.evidence, `${path}.affectedBy.evidence`, code, renamed, out, node);
      if (cause && !cause.some((l) => l.changed)) out.push({ path, reason: 'affectedBy 근거가 변경 줄과 겹치지 않습니다. 원인을 특정하지 못하면 affected로 쓰지 마세요.', node });
    }
  }

  n.children?.forEach((c, i) => checkNode(c, `${path}.children[${i}]`, depth + 1, file, code, renamed, ids, out));
}

export function checkRules(map: PrMap, input: CollectInput, code: CodeIndex): Problem[] {
  const out: Problem[] = [];
  const changed = new Map<string, ChangedFile>(input.files.map((f) => [f.path, f]));
  const allChanged = new Set([...input.files, ...input.unclassified].map((f) => f.path));
  const unclassified = new Set(input.unclassified.map((f) => f.path));
  const renamed = new Map(input.files.filter((f) => f.oldPath).map((f) => [f.path, f.oldPath!]));
  const fileIds = new Map<string, MapFile>();

  map.files.forEach((f, i) => {
    const path = `files[${i}]`;
    if (fileIds.has(f.id)) out.push({ path, reason: `파일 id "${f.id}"가 중복됩니다.` });
    fileIds.set(f.id, f);
    if (unclassified.has(f.path)) out.push({ path, reason: `미분류 파일 ${f.path}는 files에 넣지 않습니다.` });
    const c = changed.get(f.path);
    if (f.status === 'reference') {
      if (allChanged.has(f.path)) out.push({ path, reason: `${f.path}는 변경된 파일이라 reference로 쓸 수 없습니다.` });
      else if (!code.exists('head', f.path)) out.push({ path, reason: `참고 파일 ${f.path}가 head에 없습니다.` });
    } else if (!c) {
      if (!unclassified.has(f.path)) out.push({ path, reason: `${f.path}는 input.json의 변경 파일이 아닙니다. 변경 없는 파일은 reference로 쓰세요.` });
    } else {
      if (c.status !== f.status) out.push({ path, reason: `status는 input.json 값(${c.status})과 같아야 합니다.` });
      if (c.oldPath !== f.oldPath) out.push({ path, reason: `oldPath는 input.json 값(${c.oldPath ?? '없음'})과 같아야 합니다.` });
    }
    const ids = new Set<string>();
    f.tree.forEach((n, j) => checkNode(n, `${path}.tree[${j}]`, 1, f, code, renamed, ids, out));
  });

  map.files.forEach((f, i) => {
    f.replacedBy?.forEach((id, j) => {
      if (!fileIds.has(id)) out.push({ path: `files[${i}].replacedBy[${j}]`, reason: `없는 파일 id "${id}"입니다.` });
    });
  });
  map.edges.forEach((e, i) => {
    const path = `edges[${i}]`;
    if (!fileIds.has(e.from)) out.push({ path, reason: `from "${e.from}"는 없는 파일 id입니다.` });
    if (!fileIds.has(e.to)) out.push({ path, reason: `to "${e.to}"는 없는 파일 id입니다.` });
    if (e.kind === 'replacedBy') {
      const from = fileIds.get(e.from);
      if (from && (from.status !== 'deleted' || !from.replacedBy?.includes(e.to))) {
        out.push({ path, reason: 'replacedBy 엣지의 from은 삭제 파일이고 replacedBy에 to가 있어야 합니다.' });
      }
    }
  });
  return out;
}

function evidenceLines(n: TreeNode): Set<string> {
  const set = new Set<string>();
  for (const ev of n.evidence) for (let i = ev.start; i <= ev.end; i++) set.add(`${ev.side}:${ev.path}:${i}`);
  return set;
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.max(a.size, b.size);
}

/** 이전 분석과 근거가 80% 이상 겹치는 같은 위치의 새 노드는 이전 id로 되돌린다(배치·접힘 보존). */
export function stabilizeIds(map: PrMap, previous: PrMap | null): string[] {
  if (!previous) return [];
  const log: string[] = [];
  for (const file of map.files) {
    const prevFile = previous.files.find((p) => p.id === file.id);
    if (!prevFile) continue;
    const walk = (nodes: TreeNode[], prevSiblings: TreeNode[]) => {
      const taken = new Set(nodes.map((n) => n.id));
      for (const n of nodes) {
        let match = prevSiblings.find((p) => p.id === n.id);
        if (!match) {
          const lines = evidenceLines(n);
          match = prevSiblings.find((p) => !taken.has(p.id) && overlapRatio(lines, evidenceLines(p)) >= 0.8);
          if (match) {
            log.push(`${file.path}: ${n.id} → ${match.id}`);
            taken.add(match.id);
            n.id = match.id;
          }
        }
        if (n.children) walk(n.children, match?.children ?? []);
      }
    };
    walk(file.tree, prevFile.tree);
  }
  return log;
}

/** 근거 위치·상태 규칙을 어긴 노드를 unverified로 내린다. */
export function demote(map: PrMap, problems: Problem[]): string[] {
  const targets = new Set(problems.filter((p) => p.node).map((p) => `${p.node!.file}\0${p.node!.id}`));
  const demoted: string[] = [];
  for (const file of map.files) {
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (targets.has(`${file.id}\0${n.id}`)) {
          n.evidence = [];
          n.unverified = true;
          if (n.change === 'affected') {
            n.change = 'unchanged';
            delete n.affectedBy;
          }
          demoted.push(`${file.path}: ${n.id}`);
        }
        if (n.children) walk(n.children);
      }
    };
    walk(file.tree);
  }
  return demoted;
}

export function countUnverified(map: PrMap): number {
  let total = map.edges.filter((e) => e.unverified).length;
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.unverified) total++;
      if (n.children) walk(n.children);
    }
  };
  map.files.forEach((f) => walk(f.tree));
  return total;
}
