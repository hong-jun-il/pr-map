import type { MapEdge } from '../shared/types';

export interface Point {
  x: number;
  y: number;
}
export type Positions = Record<string, Point>;
export interface LayoutFile {
  id: string;
  width: number;
}

const GAP_X = 140;
const GAP_Y = 70;
const MAX_COLUMN_HEIGHT = 900;

/**
 * 관계를 따라 왼쪽에서 오른쪽으로 쌓는 계층 배치.
 * 호출하는 파일이 왼쪽, 호출받는 파일이 오른쪽에 온다. 관계가 없는 파일은 맨 뒤 열로 보낸다.
 */
export function autoLayout(files: LayoutFile[], edges: MapEdge[], heights: Record<string, number>): Positions {
  const ids = new Set(files.map((f) => f.id));
  const links = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const connected = new Set(links.flatMap((e) => [e.from, e.to]));
  const rank: Record<string, number> = {};
  files.forEach((f) => (rank[f.id] = 0));
  // 순환이 있어도 끝나도록 반복 횟수를 파일 수로 제한한다.
  for (let i = 0; i < files.length; i++) {
    let moved = false;
    for (const e of links) {
      if (rank[e.to]! < rank[e.from]! + 1 && rank[e.from]! + 1 < files.length) {
        rank[e.to] = rank[e.from]! + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const lastRank = Math.max(0, ...files.filter((f) => connected.has(f.id)).map((f) => rank[f.id]!));
  const columns: LayoutFile[][] = Array.from({ length: lastRank + 1 }, () => []);
  for (const f of files) if (connected.has(f.id)) columns[rank[f.id]!]!.push(f);

  // 앞 열의 연결 위치 평균으로 정렬해 선 겹침을 줄인다. 관계 없는 파일은 뒤로 보낸다.
  const order: Record<string, number> = {};
  columns.forEach((col, c) => {
    if (c > 0) {
      const score = (f: LayoutFile) => {
        const from = links.filter((e) => e.to === f.id).map((e) => order[e.from] ?? 0);
        return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => score(a) - score(b));
    }
    col.forEach((f, i) => (order[f.id] = i));
  });

  const heightOf = (id: string) => heights[id] ?? 200;
  // 한 열이 너무 길면 전체 보기가 지나치게 축소되므로 옆 열로 나눈다. 관계 없는 파일은 맨 뒤로 보낸다.
  const wrap = (col: LayoutFile[]): LayoutFile[][] => {
    const out: LayoutFile[][] = [];
    let cur: LayoutFile[] = [];
    let h = 0;
    for (const f of col) {
      if (cur.length && h + heightOf(f.id) > MAX_COLUMN_HEIGHT) {
        out.push(cur);
        cur = [];
        h = 0;
      }
      cur.push(f);
      h += heightOf(f.id) + GAP_Y;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const placed = [...columns, files.filter((f) => !connected.has(f.id))].flatMap(wrap);
  const total = (col: LayoutFile[]) => col.reduce((sum, f) => sum + heightOf(f.id), 0) + GAP_Y * Math.max(0, col.length - 1);
  const tallest = Math.max(0, ...placed.map(total));
  const pos: Positions = {};
  let x = 0;
  for (const col of placed) {
    let y = (tallest - total(col)) / 2;
    for (const f of col) {
      pos[f.id] = { x, y };
      y += heightOf(f.id) + GAP_Y;
    }
    x += Math.max(0, ...col.map((f) => f.width)) + GAP_X;
  }
  return pos;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

/** 두 박스 중심을 잇는 직선을 박스 경계에서 자른다. 박스가 겹치면 그리지 않는다. */
export function edgeLine(A: Rect, B: Rect): { d: string; lx: number; ly: number } | null {
  const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 };
  const cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const hit = (b: Rect, gap: number) =>
    Math.min(Math.abs(ux) > 1e-6 ? b.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? b.h / 2 / Math.abs(uy) : Infinity) + gap;
  const ta = hit(A, 2);
  const tb = hit(B, 4);
  if (ta + tb >= len - 12) return null;
  const s = { x: ca.x + ux * ta, y: ca.y + uy * ta };
  const t = { x: cb.x - ux * tb, y: cb.y - uy * tb };
  return { d: `M${s.x},${s.y} L${t.x},${t.y}`, lx: (s.x + t.x) / 2, ly: (s.y + t.y) / 2 };
}
