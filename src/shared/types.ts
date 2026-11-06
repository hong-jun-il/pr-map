export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'reference';
export type NodeChange = 'added' | 'deleted' | 'modified' | 'affected' | 'unchanged';
export type Side = 'base' | 'head';

export interface Evidence {
  side: Side;
  path: string;
  start: number;
  end: number;
  role: string;
}

/** head 커밋의 테스트 코드 위치 */
export interface TestEvidence {
  path: string;
  start: number;
  end: number;
  role: string;
}

export interface TreeNode {
  id: string;
  text: string;
  change: NodeChange;
  affectedBy?: { text: string; evidence: Evidence[] };
  unverified?: true;
  evidence: Evidence[];
  tests?: TestEvidence[];
  children?: TreeNode[];
}

export type FileLayer = 'entry' | 'core' | 'store' | 'ext';

export interface MapFile {
  id: string;
  path: string;
  status: FileStatus;
  layer: FileLayer;
  role: string;
  oldPath?: string;
  replacedBy?: string[];
  tree: TreeNode[];
}

export interface MapEdge {
  from: string;
  to: string;
  label: string;
  unverified?: true;
}

export interface ViewerEdge extends MapEdge {
  /** replacedBy는 files[].replacedBy에서 빌드할 때 만든다. */
  kind: 'calls' | 'replacedBy';
}

export interface ReadingStep {
  file: string;
  why: string;
}

export interface PrMap {
  version: 2;
  pr: { repo: string; number: number | null; base: string; head: string; summary: string };
  readingOrder: ReadingStep[];
  files: MapFile[];
  edges: MapEdge[];
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: Exclude<FileStatus, 'reference'>;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** attention은 분석했어야 하는데 못 한 파일이라 리뷰어가 직접 봐야 한다. */
export type UnclassifiedCategory = 'attention' | 'test' | 'fixture' | 'doc' | 'generated' | 'excluded' | 'other';

export interface UnclassifiedFile extends ChangedFile {
  reason: string;
  category: UnclassifiedCategory;
}

export interface RelationCandidate {
  from: string;
  to: string;
  symbols: string[];
}

export interface PrInfo {
  repo: string;
  number: number | null;
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  /** merge-base */
  base: string;
  head: string;
}

export interface CollectInput {
  version: 1;
  pr: PrInfo;
  checkout: { matchesHead: boolean; dirty: boolean };
  /** 지도에 넣을 변경 파일 */
  files: ChangedFile[];
  unclassified: UnclassifiedFile[];
  candidates: RelationCandidate[];
  previous: PrMap | null;
}

export interface CodeRow {
  /** ' ' | '+' | '-' */
  d: string;
  t: string;
  /** base 줄 번호. 추가 줄은 0 */
  o: number;
  /** head 줄 번호. 삭제 줄은 0 */
  n: number;
}

export type CodeError = 'not-found' | 'too-large' | 'binary';
export type CodeEntry = { rows: CodeRow[] } | { error: CodeError };

export interface ViewerFile extends MapFile {
  name: string;
  dir: string;
  additions: number;
  deletions: number;
  replacedByNames: string[];
  /** 삭제 파일: head에 남은 호출 설명 */
  callers: string;
}

export interface ViewerMapData {
  status: 'ready';
  pr: PrInfo & { summary: string };
  counts: { changed: number; mapped: number; unclassified: number; unverified: number };
  readingOrder: ReadingStep[];
  files: ViewerFile[];
  edges: ViewerEdge[];
  unclassified: UnclassifiedFile[];
  /** "side:path" → code 키 */
  codeIndex: Record<string, string>;
  code: Record<string, CodeEntry>;
  /** view가 확인한 최신 head. 확인하지 못했으면 null */
  latestHead: string | null;
  newCommits: number | null;
}

export type ViewerData =
  | ViewerMapData
  | { status: 'empty' }
  | { status: 'analyzing'; pr: PrInfo; changed: number }
  | { status: 'failed'; pr: PrInfo; errors: { path: string; reason: string }[] };
