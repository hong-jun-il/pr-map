import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type {
  UnclassifiedFile,
  ViewerData,
  ViewerMapData,
} from "../shared/types";
import { FileBox } from "./FileBox";
import { FilePanel, type Draft } from "./FilePanel";
import {
  buildLanes,
  edgeGeometry,
  flattenTree,
  groupUnclassified,
  type LaneLayout,
  type Rect,
} from "./lanes";
import {
  draftsText,
  fileOfEvidence,
  keepsAcrossTabs,
  nodeEvidence,
  rerunCommand,
  storageKey,
} from "./model";

const browserStore = () =>
  keepsAcrossTabs(location.protocol) ? localStorage : sessionStorage;

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (
      (JSON.parse(browserStore().getItem(key) ?? "null") as T | null) ??
      fallback
    );
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    browserStore().setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 못 쓰는 환경에서는 이번 세션에서만 유지한다.
  }
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    };
    const fallback = () => {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
        done();
      } finally {
        el.remove();
      }
    };
    if (navigator.clipboard)
      navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }, []);
  return { copied, copy };
}

const LINKED_TEST = "분기에 연결됨";

const diffText = (u: UnclassifiedFile) =>
  u.binary
    ? "변경"
    : [
        u.additions ? `+${u.additions}` : "",
        u.deletions ? `−${u.deletions}` : "",
      ]
        .filter(Boolean)
        .join(" ");

const joinNote = (...parts: string[]) => parts.filter(Boolean).join(" · ");

function Unclassified({ data }: { data: ViewerMapData }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { pr } = data;
  const { attention, groups } = useMemo(
    () => groupUnclassified(data.unclassified),
    [data],
  );
  const linkedNodes = useMemo(
    () =>
      data.files.reduce(
        (a, f) =>
          a +
          flattenTree(f.id, f.tree).filter((r) => r.node.tests?.length).length,
        0,
      ),
    [data],
  );
  const href = (u: UnclassifiedFile) =>
    `https://github.com/${pr.repo}/blob/${u.status === "deleted" ? pr.base : pr.head}/${u.path.split("/").map(encodeURIComponent).join("/")}`;
  const link = {
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  };
  return (
    <div className="lane lane-unc">
      <div className="lane-head">
        <span className="lane-title">미분류</span>
        <span className="lane-count">{data.unclassified.length}</span>
        <span className="lane-sub">지도 밖</span>
      </div>
      {attention.length > 0 && (
        <div className="unc-attention">
          <span className="unc-attention-title">
            직접 확인 필요 {attention.length}
          </span>
          {attention.map((u) => (
            <a
              key={u.path}
              className="unc-attention-item"
              href={href(u)}
              title={u.path}
              {...link}
            >
              <span className="unc-path">
                <bdi>{u.path}</bdi>
              </span>
              <span className="unc-reason">
                {joinNote(u.reason, diffText(u))}
              </span>
            </a>
          ))}
        </div>
      )}
      {groups.map((g) => {
        const isOpen = !!open[g.key];
        const linkedFiles =
          g.key === "test"
            ? g.items.filter((u) => u.reason === LINKED_TEST).length
            : 0;
        return (
          <div key={g.key} className="unc-group">
            <button
              className="unc-group-toggle"
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => ({ ...o, [g.key]: !o[g.key] }));
              }}
            >
              <span className="unc-group-chev">{isOpen ? "▼" : "▶"}</span>
              <span className="unc-group-label">{g.label}</span>
              <span className="unc-group-count">{g.items.length}</span>
            </button>
            {linkedFiles > 0 && (
              <span className="unc-group-sub">
                {linkedFiles}개가 분기 {linkedNodes}개에 연결됨
              </span>
            )}
            {isOpen && (
              <div className="unc-group-items">
                {g.items.map((u) => (
                  <a
                    key={u.path}
                    className="unc-item"
                    href={href(u)}
                    title={u.path}
                    {...link}
                  >
                    <span className="unc-item-name">
                      {u.path.slice(u.path.lastIndexOf("/") + 1)}
                    </span>
                    <span className="unc-item-note">
                      {joinNote(
                        diffText(u),
                        g.key === "test" || g.key === "other" ? u.reason : "",
                      )}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const MIN_FIT = 0.45;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;
const DEFAULT_PANEL = 440;
const KEY_CODES: Record<string, string> = {
  KeyJ: "j",
  KeyK: "k",
  KeyN: "n",
  KeyP: "p",
  KeyX: "x",
  KeyU: "u",
};

type Drag =
  | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { type: "split" };

function MapScreen({ data }: { data: ViewerMapData }) {
  const { pr, counts } = data;
  const reviewedKey = storageKey("reviewed", data);
  const draftsKey = storageKey("drafts", data);
  const fileById = useMemo(
    () => new Map(data.files.map((f) => [f.id, f])),
    [data],
  );
  const stale = !!data.latestHead && data.latestHead !== pr.head;
  const { copied, copy } = useCopy();

  const [layout, setLayout] = useState<LaneLayout>("status");
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<string[]>([]);
  const [openEvidence, setOpenEvidence] = useState<Record<string, number[]>>(
    {},
  );
  const [showAll, setShowAll] = useState(false);
  const [scale, setScale] = useState(1);
  const [panelW, setPanelW] = useState(DEFAULT_PANEL);
  const [panning, setPanning] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [unverifiedAt, setUnverifiedAt] = useState(-1);
  const [reviewed, setReviewed] = useState<Record<string, boolean>>(() =>
    loadJson(reviewedKey, {}),
  );
  const [drafts, setDrafts] = useState<Draft[]>(() => loadJson(draftsKey, []));
  const [composer, setComposer] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [nat, setNat] = useState({ w: 1500, h: 900 });

  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const panMoved = useRef(false);
  const manual = useRef(false);
  const rectKey = useRef("");
  const flashTimer = useRef<number>();
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const natRef = useRef(nat);
  natRef.current = nat;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const lanes = useMemo(
    () => buildLanes(data.files, data.edges, layout),
    [data, layout],
  );
  const fileOrder = useMemo(
    () => lanes.flatMap((l) => l.files.map((f) => f.id)),
    [lanes],
  );
  const rowKeys = useMemo(() => {
    const f = sel ? fileById.get(sel) : null;
    return f ? flattenTree(f.id, f.tree).map((r) => r.key) : [];
  }, [sel, fileById]);
  const unverified = useMemo(() => {
    const list = data.files.flatMap((f) =>
      flattenTree(f.id, f.tree)
        .filter((r) => r.node.unverified)
        .map((r) => ({ file: f.id, key: r.key })),
    );
    return list.sort(
      (a, b) => fileOrder.indexOf(a.file) - fileOrder.indexOf(b.file),
    );
  }, [data, fileOrder]);

  const fit = useCallback(() => {
    const o = outerRef.current;
    if (!o || o.clientWidth < 100) return;
    const next = Math.max(
      MIN_FIT,
      Math.min(1, (o.clientWidth - 8) / natRef.current.w),
    );
    setScale((s) => (Math.abs(next - s) > 0.005 ? next : s));
  }, []);
  // 레인 안의 박스 위치를 재서 연결선을 그린다.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const ir = inner.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    inner.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
      const r = el.getBoundingClientRect();
      next[el.dataset.fid!] = {
        x: (r.left - ir.left) / scale,
        y: (r.top - ir.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      };
    });
    const size = { w: inner.offsetWidth, h: inner.offsetHeight };
    const key = JSON.stringify([next, size], (_k, v: unknown) =>
      typeof v === "number" ? Math.round(v) : v,
    );
    if (key !== rectKey.current) {
      rectKey.current = key;
      setRects(next);
      setNat(size);
      natRef.current = size;
      if (!manual.current) fit();
    }
    if (pendingScroll.current && outerRef.current) {
      outerRef.current.scrollLeft = pendingScroll.current.left;
      outerRef.current.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  });

  const goMap = useCallback((id: string) => {
    const o = outerRef.current,
      el = innerRef.current?.querySelector<HTMLElement>(
        `[data-fid="${CSS.escape(id)}"]`,
      );
    if (!o || !el) return;
    const ir = innerRef.current!.getBoundingClientRect(),
      r = el.getBoundingClientRect();
    o.scrollTo({
      left: Math.max(0, r.left - ir.left + r.width / 2 - o.clientWidth / 2),
      top: Math.max(0, r.top - ir.top + r.height / 2 - o.clientHeight / 2),
      behavior: "smooth",
    });
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1400);
  }, []);

  const selectFile = useCallback((id: string) => {
    setSel(id);
    setOpenRows([]);
    setCur(null);
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, []);

  const scrollRow = useCallback((key: string) => {
    // 패널이 새 파일을 그린 뒤에 찾는다.
    window.setTimeout(() => {
      const c = panelRef.current,
        el = c?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
      if (!c || !el) return;
      const cr = c.getBoundingClientRect(),
        er = el.getBoundingClientRect();
      if (er.top < cr.top + 40 || er.top > cr.bottom - 80)
        c.scrollTop += er.top - cr.top - cr.height / 3;
    }, 40);
  }, []);

  const toggleRow = useCallback((key: string) => {
    setCur(key);
    setOpenRows((rows) =>
      rows.includes(key) ? rows.filter((x) => x !== key) : [...rows, key],
    );
  }, []);

  const toggleReviewed = useCallback(
    (id: string) => {
      setReviewed((r) => {
        const next = { ...r, [id]: !r[id] };
        saveJson(reviewedKey, next);
        return next;
      });
    },
    [reviewedKey],
  );

  const stepFile = useCallback(
    (d: number) => {
      if (!fileOrder.length) return;
      const i = sel ? fileOrder.indexOf(sel) : -1;
      const id =
        fileOrder[i < 0 ? 0 : (i + d + fileOrder.length) % fileOrder.length]!;
      selectFile(id);
      goMap(id);
    },
    [fileOrder, sel, selectFile, goMap],
  );

  const moveRow = useCallback(
    (d: number) => {
      if (!sel) return stepFile(1);
      if (!rowKeys.length) return;
      const i = cur ? rowKeys.indexOf(cur) : -1;
      const next =
        rowKeys[
          i < 0
            ? d > 0
              ? 0
              : rowKeys.length - 1
            : Math.max(0, Math.min(rowKeys.length - 1, i + d))
        ]!;
      setCur(next);
      scrollRow(next);
    },
    [sel, rowKeys, cur, stepFile, scrollRow],
  );

  const nextUnverified = useCallback(() => {
    if (!unverified.length) return;
    const i = (unverifiedAt + 1) % unverified.length;
    const u = unverified[i]!;
    setSel(u.file);
    setOpenRows([u.key]);
    setCur(u.key);
    setUnverifiedAt(i);
    scrollRow(u.key);
    goMap(u.file);
  }, [unverified, unverifiedAt, scrollRow, goMap]);

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e) => {
    const target = e.target as HTMLElement | null,
      tag = target?.tagName;
    if (
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    )
      return;
    // 한글 입력 상태에서도 같은 키로 동작하도록 물리 키로 읽는다.
    const k = KEY_CODES[e.code] ?? e.key;
    if (k === "Escape") {
      if (composer) setComposer(null);
      else if (sel) {
        setSel(null);
        setCur(null);
      }
    } else if (k === "j" || k === "k") {
      e.preventDefault();
      moveRow(k === "j" ? 1 : -1);
    } else if (k === "Enter" && cur && tag !== "BUTTON" && tag !== "A") {
      e.preventDefault();
      toggleRow(cur);
    } else if (k === "n" || k === "p") {
      e.preventDefault();
      stepFile(k === "n" ? 1 : -1);
    } else if (k === "x" && sel) {
      e.preventDefault();
      toggleReviewed(sel);
    } else if (k === "u") {
      e.preventDefault();
      nextUnverified();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.type === "pan") {
        const o = outerRef.current;
        if (!o) return;
        const dx = e.clientX - d.sx,
          dy = e.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) panMoved.current = true;
        o.scrollLeft = d.ox - dx;
        o.scrollTop = d.oy - dy;
      } else {
        setPanelW(
          Math.round(
            Math.min(
              Math.max(320, window.innerWidth - e.clientX),
              Math.min(820, window.innerWidth - 360),
            ),
          ),
        );
      }
    };
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (d.type === "pan") setPanning(false);
      else setSplitting(false);
      setTimeout(() => {
        panMoved.current = false;
      }, 0);
    };
    const o = outerRef.current;
    const onWheel = (e: WheelEvent) => {
      if (!o) return;
      e.preventDefault();
      const r = o.getBoundingClientRect(),
        s0 = scaleRef.current;
      const s1 = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, s0 * Math.exp(-e.deltaY * 0.0015)),
      );
      if (Math.abs(s1 - s0) < 0.0005) return;
      const cx = e.clientX - r.left,
        cy = e.clientY - r.top;
      manual.current = true;
      pendingScroll.current = {
        left: ((o.scrollLeft + cx) / s0) * s1 - cx,
        top: ((o.scrollTop + cy) / s0) * s1 - cy,
      };
      setScale(s1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    o?.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      if (!manual.current) fit();
    });
    if (o) ro.observe(o);
    // 글꼴이 들어와 크기가 정해지면 그 뒤로는 배율을 흔들지 않는다.
    const lock = () =>
      window.setTimeout(() => {
        manual.current = true;
      }, 400);
    void document.fonts.ready.then(() => {
      fit();
      lock();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      o?.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [fit]);

  const zoom = (f: number) => {
    manual.current = true;
    setScale((s) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s * f)));
  };

  const resetView = () => {
    manual.current = false;
    setPanelW(DEFAULT_PANEL);
    const o = outerRef.current;
    if (o) {
      o.scrollLeft = 0;
      o.scrollTop = 0;
    }
    window.setTimeout(() => {
      fit();
      window.setTimeout(() => {
        manual.current = true;
      }, 300);
    }, 0);
  };

  const startPan = (e: ReactMouseEvent) => {
    if (
      e.button !== 0 ||
      (e.target as HTMLElement).closest("[data-fid], a, button")
    )
      return;
    const o = outerRef.current;
    if (!o) return;
    e.preventDefault();
    panMoved.current = false;
    drag.current = {
      type: "pan",
      sx: e.clientX,
      sy: e.clientY,
      ox: o.scrollLeft,
      oy: o.scrollTop,
    };
    setPanning(true);
  };

  const saveDrafts = (next: Draft[]) => {
    setDrafts(next);
    saveJson(draftsKey, next);
  };

  // 선택한 파일의 이웃과, 펼친 분기의 근거가 있는 파일을 강조한다.
  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (sel)
      for (const e of data.edges) {
        if (e.from === sel) set.add(e.to);
        if (e.to === sel) set.add(e.from);
      }
    return set;
  }, [sel, data]);
  const evidenceFiles = useMemo(() => {
    const set = new Set<string>();
    const f = sel ? fileById.get(sel) : null;
    if (!f) return set;
    for (const r of flattenTree(f.id, f.tree)) {
      if (!openRows.includes(r.key)) continue;
      for (const ev of nodeEvidence(r.node)) {
        const t = fileOfEvidence(data, ev);
        if (t && t.id !== sel) set.add(t.id);
      }
    }
    return set;
  }, [sel, openRows, data, fileById]);

  const geos = useMemo(() => edgeGeometry(data.edges, rects), [data, rects]);
  const focus = sel ?? hover;
  const visibleEdges = data.edges
    .map((edge, i) => ({
      edge,
      geo: geos[i],
      on: !!focus && (edge.from === focus || edge.to === focus),
      i,
    }))
    .filter((x) => x.geo && (x.on || showAll));

  const statusText = stale
    ? "업데이트 필요"
    : data.latestHead
      ? "분석 최신"
      : "분석 커밋";
  const statusDot = stale
    ? "var(--accent)"
    : data.latestHead
      ? "var(--add)"
      : "var(--line-strong)";
  const cmd = rerunCommand(pr);
  const refCount = data.files.filter((f) => f.status === "reference").length;
  const prAdd = [...data.files, ...data.unclassified].reduce(
    (a, f) => a + f.additions,
    0,
  );
  const prDel = [...data.files, ...data.unclassified].reduce(
    (a, f) => a + f.deletions,
    0,
  );
  const reviewedCount = data.files.filter((f) => reviewed[f.id]).length;
  const order = data.readingOrder.flatMap(({ file, why }) => {
    const f = fileById.get(file);
    return f ? [{ file: f, why }] : [];
  });

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <div className="header-title">
            <span className="header-repo">
              {pr.repo}
              {pr.number ? ` #${pr.number}` : ""}
            </span>
            <span className="header-name" title={pr.title}>
              {pr.title}
            </span>
            <span
              className="header-stat"
              title="PR 전체 변경 줄 수 (미분류 포함)"
            >
              <span style={{ color: "var(--add)" }}>+{prAdd}</span>
              <span style={{ color: "var(--del)" }}>−{prDel}</span>
            </span>
          </div>
          <div className="header-meta">
            <span>
              {pr.baseRef} ← {pr.headRef}
            </span>
            <span>
              파일 {counts.changed} · 지도 {counts.mapped - refCount}
              {refCount ? ` · 참고 ${refCount}` : ""} · 미분류{" "}
              {counts.unclassified}
            </span>
            <span>
              확인 {reviewedCount}/{data.files.length}
            </span>
          </div>
        </div>
        {drafts.length > 0 && (
          <a
            className="drafts-link"
            href={pr.number ? `${pr.url}/files` : pr.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            리뷰 초안 <b>{drafts.length}</b> · GitHub에서 제출 ↗
          </a>
        )}
        {drafts.length > 0 && (
          <button
            className="drafts-copy"
            title="GitHub에 붙여넣을 수 있게 초안 전체를 복사합니다"
            onClick={() => copy(draftsText(drafts))}
          >
            {copied ? "복사했습니다" : "초안 복사"}
          </button>
        )}
        <div className="status-pill">
          <span className="status-dot" style={{ background: statusDot }} />
          <span>{statusText}</span>
          <span style={{ color: "var(--fg3)" }}>{pr.head.slice(0, 7)}</span>
        </div>
        <button
          className="unverified-btn"
          title="다음 확인 필요 항목으로 이동 (u)"
          onClick={nextUnverified}
        >
          확인 필요 <b>{unverified.length}</b>
          <span className="unverified-pos">
            {unverifiedAt >= 0
              ? `${unverifiedAt + 1}/${unverified.length}`
              : ""}
          </span>
          <kbd>u</kbd>
        </button>
        <div className="segment" role="group" aria-label="레인 기준">
          <button
            aria-pressed={layout === "status"}
            onClick={() => setLayout("status")}
          >
            A · 상태별 레인
          </button>
          <button
            aria-pressed={layout === "role"}
            onClick={() => setLayout("role")}
          >
            B · 역할별 레인
          </button>
        </div>
        <button
          className="all-links"
          aria-pressed={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          <span
            className="all-links-box"
            style={{ background: showAll ? "var(--accent)" : "transparent" }}
          />
          모든 연결 표시
        </button>
      </header>

      {stale && (
        <div className="stale-bar">
          <b>
            {data.newCommits ? `새 커밋 ${data.newCommits}개` : "새 커밋 있음"}
          </b>
          <span>
            지금 보이는 설명과 코드는 {pr.head.slice(0, 7)} 기준입니다. 최신
            head는 {data.latestHead!.slice(0, 7)}입니다.
          </span>
          <span className="spacer" />
          <button className="btn-solid" onClick={() => copy(cmd)}>
            {copied ? "복사했습니다" : `다시 분석 명령 복사: ${cmd}`}
          </button>
        </div>
      )}

      <div className="body">
        <div className="map">
          <div
            ref={outerRef}
            className="map-scroll"
            data-testid="map"
            style={{
              cursor: panning ? "grabbing" : "grab",
              userSelect: panning || splitting ? "none" : "auto",
            }}
            onMouseDown={startPan}
            onClick={() => {
              if (!panMoved.current && sel) setSel(null);
            }}
          >
            <div
              style={{
                position: "relative",
                width: Math.ceil(nat.w * scale),
                height: Math.ceil(nat.h * scale),
              }}
            >
              <div
                ref={innerRef}
                className="lanes"
                style={{ transform: `scale(${scale})` }}
              >
                <svg className="edges" width={1} height={1} aria-hidden="true">
                  <defs>
                    {(["n", "a"] as const).map((t) => (
                      <marker
                        key={t}
                        id={`pm-arrow-${t}`}
                        viewBox="0 0 10 10"
                        refX={8}
                        refY={5}
                        markerWidth={7}
                        markerHeight={7}
                        orient="auto"
                      >
                        <path
                          d="M1,1 L8,5 L1,9"
                          fill="none"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{
                            stroke:
                              t === "a"
                                ? "var(--accent)"
                                : "var(--line-strong)",
                          }}
                        />
                      </marker>
                    ))}
                  </defs>
                  {visibleEdges.map(({ edge, geo, on, i }) => (
                    <path
                      key={i}
                      d={geo!.d}
                      fill="none"
                      strokeWidth={on ? 1.6 : 1}
                      strokeDasharray={
                        edge.kind === "replacedBy" || edge.unverified
                          ? "5 4"
                          : undefined
                      }
                      markerEnd={`url(#pm-arrow-${on ? "a" : "n"})`}
                      style={{
                        stroke: on ? "var(--accent)" : "var(--line-strong)",
                        opacity: on ? 1 : 0.7,
                      }}
                    />
                  ))}
                </svg>
                {lanes.map((lane) => (
                  <div key={lane.title} className="lane">
                    <div className="lane-head">
                      <span className="lane-title">{lane.title}</span>
                      <span className="lane-count">{lane.files.length}</span>
                      <span className="lane-sub">{lane.sub}</span>
                    </div>
                    {lane.files.map((f) => (
                      <FileBox
                        key={f.id}
                        file={f}
                        selected={sel === f.id}
                        dimmed={
                          !!sel &&
                          sel !== f.id &&
                          !neighbors.has(f.id) &&
                          !evidenceFiles.has(f.id)
                        }
                        neighbor={neighbors.has(f.id)}
                        evidence={evidenceFiles.has(f.id)}
                        flash={flash === f.id}
                        reviewed={!!reviewed[f.id]}
                        onClick={() => {
                          if (sel === f.id) setSel(null);
                          else selectFile(f.id);
                        }}
                        onEnter={() => setHover(f.id)}
                        onLeave={() => setHover(null)}
                      />
                    ))}
                  </div>
                ))}
                <Unclassified data={data} />
                {visibleEdges
                  .filter((x) => x.on)
                  .map(({ edge, geo, i }) => (
                    <div
                      key={i}
                      className="edge-label"
                      style={{
                        left: geo!.lx,
                        top: geo!.ly,
                        borderStyle: edge.unverified ? "dashed" : "solid",
                      }}
                    >
                      {edge.label}
                      {edge.unverified ? " · 확인 필요" : ""}
                    </div>
                  ))}
              </div>
            </div>
          </div>
          <div className="map-tools">
            <div className="toolbar">
              <button
                className="tool tool-icon"
                aria-label="축소"
                onClick={() => zoom(1 / 1.15)}
              >
                −
              </button>
              <span className="tool-zoom">{Math.round(scale * 100)}%</span>
              <button
                className="tool tool-icon"
                aria-label="확대"
                onClick={() => zoom(1.15)}
              >
                +
              </button>
              <span className="tool-sep" />
              <button className="tool" onClick={resetView}>
                초기화
              </button>
            </div>
            <div className="legend">
              <span>분기</span>
              <span>
                <b style={{ color: "var(--add)" }}>+</b> 추가
              </span>
              <span>
                <b style={{ color: "var(--del)" }}>−</b> 삭제
              </span>
              <span>
                <b style={{ color: "var(--chg)" }}>●</b> 수정
              </span>
              <span>
                <b style={{ color: "var(--aff)" }}>◐</b> 영향
              </span>
            </div>
          </div>
        </div>
        <div
          className="splitter"
          title="드래그해서 패널 폭 조절"
          onMouseDown={(e) => {
            e.preventDefault();
            manual.current = true;
            drag.current = { type: "split" };
            setSplitting(true);
          }}
        />
        <FilePanel
          data={data}
          file={sel ? (fileById.get(sel) ?? null) : null}
          width={panelW}
          panelRef={panelRef}
          reviewed={!!(sel && reviewed[sel])}
          openRows={openRows}
          currentRow={cur}
          openEvidence={openEvidence}
          order={order}
          drafts={drafts}
          composer={composer}
          onSelect={(id) => {
            selectFile(id);
            goMap(id);
          }}
          onClose={() => setSel(null)}
          onToggleReviewed={() => sel && toggleReviewed(sel)}
          onToggleRow={toggleRow}
          onToggleEvidence={(key, i) => {
            const open = openEvidence[key] ?? [0];
            setOpenEvidence({
              ...openEvidence,
              [key]: open.includes(i)
                ? open.filter((x) => x !== i)
                : [...open, i],
            });
          }}
          onShowOnMap={goMap}
          onCopy={copy}
          copied={copied}
          onCompose={(key) => setComposer({ key, text: "" })}
          onComposerText={(text) =>
            setComposer((c) => (c ? { ...c, text } : c))
          }
          onComposerCancel={() => setComposer(null)}
          onDraftSave={(lk, where) => {
            const text = composer?.text.trim();
            if (text)
              saveDrafts([
                ...drafts,
                { id: Date.now(), lineKey: lk, where, text },
              ]);
            setComposer(null);
          }}
          onDraftDelete={(id) => saveDrafts(drafts.filter((d) => d.id !== id))}
        />
      </div>
    </div>
  );
}

function StateScreen({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app">
      <div className="state">
        <div className="state-card">
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export function App({ data }: { data: ViewerData | null }) {
  const { copied, copy } = useCopy();
  if (!data || data.status === "empty") {
    return (
      <StateScreen title="분석할 PR을 고르세요">
        <p>
          저장소에서 <code className="mono">/pr-map</code> 또는{" "}
          <code className="mono">/pr-map &lt;PR 번호&gt;</code>를 실행하면 파일
          지도가 만들어집니다.
        </p>
      </StateScreen>
    );
  }
  if (data.status === "analyzing") {
    return (
      <StateScreen title="분석 중입니다">
        <p>
          {data.pr.repo}
          {data.pr.number ? ` #${data.pr.number}` : ""} · 변경 파일{" "}
          {data.changed}개를 {data.pr.head.slice(0, 7)} 기준으로 분석하고
          있습니다. 아직 완료된 결과가 없습니다. 분석이 끝나면{" "}
          <code className="mono">/pr-map view</code>로 다시 여세요.
        </p>
      </StateScreen>
    );
  }
  if (data.status === "failed") {
    const cmd = rerunCommand(data.pr);
    return (
      <StateScreen title="분석 결과를 검증하지 못했습니다">
        <p>
          {data.pr.repo}
          {data.pr.number ? ` #${data.pr.number}` : ""} · 아래 항목이 검증을
          통과하지 못해 지도를 만들지 않았습니다.
        </p>
        <ul className="state-errors">
          {data.errors.map((e, i) => (
            <li key={i}>
              <code>{e.path}</code>
              <span>{e.reason}</span>
            </li>
          ))}
        </ul>
        <button className="btn-ghost" onClick={() => copy(cmd)}>
          {copied ? "복사했습니다" : `재시도 명령 복사: ${cmd}`}
        </button>
      </StateScreen>
    );
  }
  return <MapScreen data={data} />;
}
