import type { ChangedFile, CodeEntry, CodeError, CodeRow, Side } from '../shared/types';
import { git, tryGit } from './git';

export const MAX_FILE_BYTES = 1024 * 1024;

/** `git diff -U<큰 값>` 출력을 뷰어의 줄 목록으로 바꾼다. */
export function parseUnifiedDiff(diff: string): CodeRow[] {
  const rows: CodeRow[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue;
    const d = raw[0];
    const t = raw.slice(1).replace(/\r$/, '');
    if (d === '+') rows.push({ d: '+', t, o: 0, n: n++ });
    else if (d === '-') rows.push({ d: '-', t, o: o++, n: 0 });
    else if (d === ' ') rows.push({ d: ' ', t, o: o++, n: n++ });
  }
  return rows;
}

function plainRows(text: string): CodeRow[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => ({ d: ' ', t: l.replace(/\r$/, ''), o: i + 1, n: i + 1 }));
}

export interface LineInfo {
  lineCount: number;
  changed: Set<number>;
}

/** 커밋에 고정된 원본 코드를 읽는다. AI가 쓴 코드는 절대 쓰지 않는다. */
export class CodeIndex {
  private byHead = new Map<string, ChangedFile>();
  private byBase = new Map<string, ChangedFile>();
  private cache = new Map<string, CodeEntry>();
  private lineCache = new Map<string, LineInfo | null>();
  private existsCache = new Map<string, boolean>();

  constructor(
    private root: string,
    private base: string,
    private head: string,
    changes: ChangedFile[],
  ) {
    for (const c of changes) {
      if (c.status !== 'deleted') this.byHead.set(c.path, c);
      if (c.status !== 'added') this.byBase.set(c.oldPath ?? c.path, c);
    }
  }

  private sha(side: Side): string {
    return side === 'base' ? this.base : this.head;
  }

  exists(side: Side, path: string): boolean {
    const key = `${side}:${path}`;
    let hit = this.existsCache.get(key);
    if (hit === undefined) {
      hit = tryGit(this.root, 'cat-file', '-e', `${this.sha(side)}:${path}`) !== null;
      this.existsCache.set(key, hit);
    }
    return hit;
  }

  private problem(side: Side, path: string): CodeError | null {
    const size = tryGit(this.root, 'cat-file', '-s', `${this.sha(side)}:${path}`);
    if (size === null) return 'not-found';
    if (Number(size.trim()) > MAX_FILE_BYTES) return 'too-large';
    return null;
  }

  private read(side: Side, path: string): CodeEntry {
    const problem = this.problem(side, path);
    if (problem) return { error: problem };
    const text = git(this.root, 'show', `${this.sha(side)}:${path}`);
    if (text.includes('\0')) return { error: 'binary' };
    return { rows: plainRows(text) };
  }

  private diffEntry(change: ChangedFile): CodeEntry {
    const headSide: Side = change.status === 'deleted' ? 'base' : 'head';
    const headPath = change.status === 'deleted' ? (change.oldPath ?? change.path) : change.path;
    const problem = this.problem(headSide, headPath);
    if (problem) return { error: problem };
    if (change.binary) return { error: 'binary' };
    const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const diff = git(this.root, 'diff', '-M', '--no-color', '--no-ext-diff', '--unified=1000000', this.base, this.head, '--', ...paths);
    const rows = parseUnifiedDiff(diff);
    // 100% 이름 변경이나 모드만 바뀐 파일은 hunk가 없다.
    return rows.length ? { rows } : this.read(headSide, headPath);
  }

  /** code 맵에서 쓰는 키. 이름 변경 파일은 base·head가 같은 키를 공유한다. */
  key(side: Side, path: string): string {
    const change = side === 'head' ? this.byHead.get(path) : this.byBase.get(path);
    return change ? `change:${change.path}` : `${side}:${path}`;
  }

  entry(side: Side, path: string): CodeEntry {
    const key = this.key(side, path);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const change = side === 'head' ? this.byHead.get(path) : this.byBase.get(path);
    const entry = change ? this.diffEntry(change) : this.read(side, path);
    this.cache.set(key, entry);
    return entry;
  }

  lines(side: Side, path: string): LineInfo | null {
    const key = `${side}:${path}`;
    const hit = this.lineCache.get(key);
    if (hit !== undefined) return hit;
    const info = this.computeLines(side, path);
    this.lineCache.set(key, info);
    return info;
  }

  private computeLines(side: Side, path: string): LineInfo | null {
    if (!this.exists(side, path)) return null;
    const entry = this.entry(side, path);
    if (!('rows' in entry)) return null;
    const changed = new Set<number>();
    let lineCount = 0;
    for (const r of entry.rows) {
      const ln = side === 'base' ? r.o : r.n;
      if (!ln) continue;
      lineCount = Math.max(lineCount, ln);
      if (r.d === (side === 'base' ? '-' : '+')) changed.add(ln);
    }
    return { lineCount, changed };
  }
}
