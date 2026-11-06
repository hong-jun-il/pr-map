import type {
  MapEdge,
  TreeNode,
  UnclassifiedCategory,
  UnclassifiedFile,
  ViewerFile,
} from "../shared/types";
import { lineKey } from "./model";

export type LaneLayout = "status" | "role";

interface LaneDef {
  title: string;
  sub: string;
  match: (f: ViewerFile) => boolean;
}

const LANE_DEFS: Record<LaneLayout, LaneDef[]> = {
  status: [
    { title: "추가", sub: "새 파일", match: (f) => f.status === "added" },
    {
      title: "수정",
      sub: "이름 변경 포함",
      match: (f) => f.status === "modified" || f.status === "renamed",
    },
    {
      title: "삭제",
      sub: "대체 · 기능 제거",
      match: (f) => f.status === "deleted",
    },
    {
      title: "영향 · 참고",
      sub: "코드 변경 없음",
      match: (f) => f.status === "reference",
    },
  ],
  role: [
    {
      title: "진입점",
      sub: "라우트 · 미들웨어 · 작업",
      match: (f) => f.layer === "entry",
    },
    { title: "핵심 로직", sub: "", match: (f) => f.layer === "core" },
    { title: "저장소 · 인프라", sub: "", match: (f) => f.layer === "store" },
    {
      title: "공통 · 외부",
      sub: "설정 · 지표 · 외부 API",
      match: (f) => f.layer === "ext",
    },
  ],
};

export interface Lane {
  title: string;
  sub: string;
  files: ViewerFile[];
}

/** 연결이 많은 파일을 레인 위쪽에 둔다. */
export function buildLanes(
  files: ViewerFile[],
  edges: MapEdge[],
  layout: LaneLayout,
): Lane[] {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return LANE_DEFS[layout].map(({ title, sub, match }) => ({
    title,
    sub,
    files: files
      .filter(match)
      .sort(
        (a, b) =>
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          a.name.localeCompare(b.name),
      ),
  }));
}

const UNCLASSIFIED_GROUPS: { key: UnclassifiedCategory; label: string }[] = [
  { key: "test", label: "테스트 코드" },
  { key: "fixture", label: "테스트 데이터" },
  { key: "doc", label: "문서" },
  { key: "generated", label: "자동 생성" },
  { key: "excluded", label: ".pr-map.yml 제외" },
  { key: "other", label: "지원하지 않는 형식" },
];

export interface UnclassifiedGroup {
  key: UnclassifiedCategory;
  label: string;
  items: UnclassifiedFile[];
}

/** 어느 묶음에도 속하지 않는 파일은 놓치지 않도록 직접 확인 목록에 둔다. */
export function groupUnclassified(files: UnclassifiedFile[]): {
  attention: UnclassifiedFile[];
  groups: UnclassifiedGroup[];
} {
  const known = new Set(UNCLASSIFIED_GROUPS.map((g) => g.key));
  return {
    attention: files.filter((f) => !known.has(f.category)),
    groups: UNCLASSIFIED_GROUPS.map((g) => ({
      ...g,
      items: files.filter((f) => f.category === g.key),
    })).filter((g) => g.items.length),
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeGeo {
  d: string;
  lx: number;
  ly: number;
}

/** 파일 사이 연결선을 그린다. 같은 면에 닿는 선은 상대 위치 순서로 나눠 겹치지 않게 한다. */
export function edgeGeometry(
  edges: Pick<MapEdge, "from" | "to">[],
  rects: Record<string, Rect>,
): (EdgeGeo | null)[] {
  const ports = new Map<string, { i: number; j: 0 | 1; oy: number }[]>();
  const addPort = (
    file: string,
    side: "l" | "r",
    i: number,
    j: 0 | 1,
    other: Rect,
  ) => {
    const key = `${file}\0${side}`;
    const list = ports.get(key) ?? [];
    list.push({ i, j, oy: other.y + other.h / 2 });
    ports.set(key, list);
  };
  const sides = edges.map((e, i) => {
    const a = rects[e.from],
      b = rects[e.to];
    if (!a || !b) return null;
    const ax = a.x + a.w / 2,
      bx = b.x + b.w / 2;
    // 같은 레인이면 오른쪽으로 돌아 나간다.
    const [sa, sb]: ["l" | "r", "l" | "r"] =
      Math.abs(ax - bx) < 40 ? ["r", "r"] : ax < bx ? ["r", "l"] : ["l", "r"];
    addPort(e.from, sa, i, 0, b);
    addPort(e.to, sb, i, 1, a);
    return { sa, sb };
  });

  const points = new Map<string, { x: number; y: number }>();
  for (const [key, list] of ports) {
    const [file, side] = key.split("\0") as [string, "l" | "r"];
    const r = rects[file]!;
    list.sort((p, q) => p.oy - q.oy);
    list.forEach((p, n) => {
      points.set(`${p.i}:${p.j}`, {
        x: side === "r" ? r.x + r.w : r.x,
        y: r.y + 14 + (r.h - 28) * ((n + 1) / (list.length + 1)),
      });
    });
  }

  return sides.map((sd, i) => {
    if (!sd) return null;
    const s = points.get(`${i}:0`)!,
      t = points.get(`${i}:1`)!;
    const ds = sd.sa === "r" ? 1 : -1,
      dt = sd.sb === "r" ? 1 : -1;
    const k =
      sd.sa === sd.sb
        ? 30 + Math.min(26, Math.abs(t.y - s.y) * 0.06)
        : Math.max(24, Math.abs(t.x - s.x) * 0.5);
    const c1 = { x: s.x + ds * k, y: s.y },
      c2 = { x: t.x + dt * k, y: t.y };
    return {
      d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
      lx: 0.125 * s.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * t.x,
      ly: 0.125 * s.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * t.y,
    };
  });
}

export interface TreeRow {
  key: string;
  node: TreeNode;
  depth: number;
  first: boolean;
  hasKids: boolean;
  /** 줄 앞의 트리 선 */
  prefix: string;
  /** 하위 줄로 이어지는 트리 선 */
  cont: string;
}

export function flattenTree(fileId: string, nodes: TreeNode[]): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: TreeNode[], ancestors: string, depth: number) => {
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      const kids = node.children ?? [];
      const cont = depth === 0 ? "" : ancestors + (last ? "   " : "│  ");
      out.push({
        key: lineKey(fileId, node.id),
        node,
        depth,
        first: i === 0,
        hasKids: kids.length > 0,
        prefix: depth === 0 ? "" : ancestors + (last ? "└─ " : "├─ "),
        cont,
      });
      walk(kids, cont, depth + 1);
    });
  };
  walk(nodes, "", 0);
  return out;
}

export function countChanges(
  f: ViewerFile,
): Record<"added" | "deleted" | "modified" | "affected", number> {
  const out = { added: 0, deleted: 0, modified: 0, affected: 0 };
  for (const r of flattenTree(f.id, f.tree))
    if (r.node.change !== "unchanged") out[r.node.change]++;
  return out;
}
