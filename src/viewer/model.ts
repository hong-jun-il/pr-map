import type { Evidence, TreeNode, ViewerFile, ViewerMapData } from '../shared/types';

export interface LineEntry {
  key: string;
  fileId: string;
  node: TreeNode;
  /** 조상 설명 */
  chain: string[];
  /** 조상과 자신의 키 */
  path: string[];
}

export interface FlatRow {
  key: string;
  node: TreeNode;
  depth: number;
  first: boolean;
  hasKids: boolean;
  open: boolean;
  prefix: string;
}

export const lineKey = (fileId: string, nodeId: string) => `${fileId}:${nodeId}`;

const hasChange = (n: TreeNode): boolean => n.change !== 'unchanged' || (n.children ?? []).some(hasChange);

export function indexLines(files: ViewerFile[]): { lines: Record<string, LineEntry>; defaultCollapsed: Set<string> } {
  const lines: Record<string, LineEntry> = {};
  const defaultCollapsed = new Set<string>();
  for (const f of files) {
    const walk = (nodes: TreeNode[], chain: string[], path: string[]) => {
      for (const n of nodes) {
        const key = lineKey(f.id, n.id);
        const nextPath = [...path, key];
        lines[key] = { key, fileId: f.id, node: n, chain, path: nextPath };
        const kids = n.children ?? [];
        // 하위에 변경이 없는 맥락 분기는 접어 둔다.
        if (kids.length && !hasChange(n)) defaultCollapsed.add(key);
        walk(kids, [...chain, n.text], nextPath);
      }
    };
    walk(f.tree, [], []);
  }
  return { lines, defaultCollapsed };
}

export function flatten(fileId: string, nodes: TreeNode[], collapsed: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TreeNode[], ancestors: string, depth: number) => {
    list.forEach((n, i) => {
      const key = lineKey(fileId, n.id);
      const last = i === list.length - 1;
      const kids = n.children ?? [];
      const open = !collapsed.has(key);
      out.push({ key, node: n, depth, first: i === 0, hasKids: kids.length > 0, open, prefix: depth === 0 ? '' : ancestors + (last ? '└─ ' : '├─ ') });
      if (kids.length && open) walk(kids, depth === 0 ? '' : ancestors + (last ? '   ' : '│  '), depth + 1);
    });
  };
  walk(nodes, '', 0);
  return out;
}

export const countDescendants = (n: TreeNode): number => (n.children ?? []).reduce((a, c) => a + 1 + countDescendants(c), 0);

/** 근거 경로로 지도의 파일을 찾는다. 이름 변경 파일은 base 근거가 이전 경로를 쓴다. */
export function fileOfEvidence(data: ViewerMapData, ev: Evidence): ViewerFile | undefined {
  return data.files.find((f) => f.path === ev.path || f.oldPath === ev.path);
}

export function githubHref(data: ViewerMapData, ev: Evidence): string {
  const sha = ev.side === 'base' ? data.pr.base : data.pr.head;
  const path = ev.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${data.pr.repo}/blob/${sha}/${path}#L${ev.start}${ev.end !== ev.start ? `-L${ev.end}` : ''}`;
}

export function rerunCommand(pr: { number: number | null }): string {
  return pr.number ? `/pr-map ${pr.number}` : '/pr-map';
}

export function storageKey(data: ViewerMapData): string {
  return `prmap.layout.v1:${data.pr.repo}#${data.pr.number ?? data.pr.headRef}`;
}
