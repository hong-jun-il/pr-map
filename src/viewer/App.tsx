import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ViewerData, ViewerMapData } from '../shared/types';
import { EvidencePanel } from './EvidencePanel';
import { FileBox } from './FileBox';
import { autoLayout, edgeLine, type Positions } from './layout';
import { fileOfEvidence, indexLines, rerunCommand, storageKey } from './model';

interface View {
  x: number;
  y: number;
  z: number;
}

type Drag =
  | { type: 'box'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { type: 'split' };

interface Saved {
  pos?: Positions;
  toggled?: string[];
}

function loadSaved(key: string): Saved {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as Saved | null) ?? {};
  } catch {
    return {};
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
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
        done();
      } finally {
        el.remove();
      }
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }, []);
  return { copied, copy };
}

// 파일이 많은 PR도 전체 보기에 다 들어오도록 낮게 잡는다.
const MIN_ZOOM = 0.12;
// 이보다 작으면 글자를 읽을 수 없어 강조된 연결의 라벨만 남긴다.
const LABEL_MIN_ZOOM = 0.3;

const estimateHeight = (rows: number) => 70 + rows * 26;

function MapScreen({ data }: { data: ViewerMapData }) {
  const key = storageKey(data);
  const saved = useMemo(() => loadSaved(key), [key]);
  const { lines, defaultCollapsed } = useMemo(() => indexLines(data.files), [data]);
  const fileById = useMemo(() => new Map(data.files.map((f) => [f.id, f])), [data]);
  const stale = !!data.latestHead && data.latestHead !== data.pr.head;

  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [pos, setPos] = useState<Positions>(() => {
    const estimated = Object.fromEntries(data.files.map((f) => [f.id, estimateHeight(Object.keys(lines).filter((k) => lines[k]!.fileId === f.id).length)]));
    return { ...autoLayout(data.files, data.edges, estimated), ...(saved.pos ?? {}) };
  });
  const [toggled, setToggled] = useState<string[]>(saved.toggled ?? []);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [openEv, setOpenEv] = useState<Record<string, number[]>>({});
  const [wideEv, setWideEv] = useState<Record<string, boolean>>({});
  const [panelPct, setPanelPct] = useState(36);
  const [selected, setSelected] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [uncOpen, setUncOpen] = useState(false);
  const [showRefs, setShowRefs] = useState(true);
  const { copied, copy } = useCopy();

  const canvasRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hoverTimer = useRef<number>();
  const flashTimer = useRef<number>();
  const interacted = useRef(false);
  const arranged = useRef(!!saved.pos && data.files.every((f) => saved.pos![f.id]));

  // 최신 값을 전역 이벤트에서 읽기 위한 참조
  const latest = useRef({ view, pos, toggled, sizes });
  latest.current = { view, pos, toggled, sizes };

  const visibleFiles = useMemo(() => (showRefs ? data.files : data.files.filter((f) => f.status !== 'reference')), [data, showRefs]);
  const visibleRef = useRef(visibleFiles);
  visibleRef.current = visibleFiles;

  const save = useCallback(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ pos: latest.current.pos, toggled: latest.current.toggled }));
    } catch {
      // 저장소를 못 쓰는 환경에서는 이번 세션에서만 유지한다.
    }
  }, [key]);

  const fit = useCallback((target?: Positions) => {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 150) return;
    const p = target ?? latest.current.pos;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of visibleRef.current) {
      const at = p[f.id];
      if (!at) continue;
      x0 = Math.min(x0, at.x);
      y0 = Math.min(y0, at.y);
      x1 = Math.max(x1, at.x + f.width);
      y1 = Math.max(y1, at.y + (latest.current.sizes[f.id] ?? 220));
    }
    if (!isFinite(x0)) return;
    // 위쪽은 범례와 미분류 패널, 아래쪽은 도구 막대 자리다.
    const pad = 48, top = 88, bot = 64;
    const availH = r.height - top - bot;
    const z = Math.max(MIN_ZOOM, Math.min(1.1, (r.width - pad * 2) / (x1 - x0), availH / (y1 - y0)));
    setView({ z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: top + (availH - (y1 - y0) * z) / 2 - y0 * z });
  }, []);

  const zoomAt = useCallback((z: number, cx: number, cy: number) => {
    const v = latest.current.view;
    const next = Math.min(2, Math.max(MIN_ZOOM, z));
    setView({ z: next, x: cx - ((cx - v.x) * next) / v.z, y: cy - ((cy - v.y) * next) / v.z });
  }, []);

  const zoomBy = (f: number) => {
    interacted.current = true;
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    zoomAt(view.z * f, r.width / 2, r.height / 2);
  };

  const arrange = () => {
    const next = { ...latest.current.pos, ...autoLayout(visibleFiles, data.edges, sizes) };
    latest.current.pos = next;
    setPos(next);
    save();
    fit(next);
  };

  // 박스 높이를 재서 연결선과 전체 보기에 쓴다.
  useLayoutEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    let changed = false;
    const next = { ...sizes };
    w.querySelectorAll<HTMLElement>('[data-box]').forEach((el) => {
      const id = el.dataset.box!;
      if (next[id] !== el.offsetHeight) {
        next[id] = el.offsetHeight;
        changed = true;
      }
    });
    if (!changed) return;
    latest.current.sizes = next;
    setSizes(next);
    if (!arranged.current) {
      // 저장된 위치는 그대로 두고 새 파일만 실제 높이로 배치한다.
      const auto = autoLayout(data.files, data.edges, next);
      const merged = { ...auto, ...(saved.pos ?? {}) };
      latest.current.pos = merged;
      setPos(merged);
    }
    if (!interacted.current) requestAnimationFrame(() => fit());
  });

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.type === 'box') {
        const z = latest.current.view.z;
        setPos((p) => ({ ...p, [d.id]: { x: d.ox + (e.clientX - d.sx) / z, y: d.oy + (e.clientY - d.sy) / z } }));
      } else if (d.type === 'pan') {
        setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
      } else {
        const W = window.innerWidth;
        setPanelPct(Math.min(60, Math.max(24, ((W - e.clientX) / W) * 100)));
      }
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.type === 'box') save();
      if (d?.type === 'pan') setPanning(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
    };
    const c = canvasRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      interacted.current = true;
      const v = latest.current.view;
      if (e.ctrlKey || e.metaKey) {
        const r = c!.getBoundingClientRect();
        zoomAt(v.z * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    c?.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      if (!interacted.current) fit();
    });
    if (c) ro.observe(c);
    const settle = window.setTimeout(() => {
      // 첫 배치가 끝나면 이후 높이 변화로 배치를 다시 흔들지 않는다.
      arranged.current = true;
    }, 2500);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      c?.removeEventListener('wheel', onWheel);
      ro.disconnect();
      clearTimeout(settle);
    };
  }, [fit, save, zoomAt]);

  const toggledSet = useMemo(() => new Set(toggled), [toggled]);
  const collapsed = useMemo(() => {
    const out = new Set<string>();
    defaultCollapsed.forEach((k) => {
      if (!toggledSet.has(k)) out.add(k);
    });
    toggled.forEach((k) => {
      if (!defaultCollapsed.has(k)) out.add(k);
    });
    return out;
  }, [defaultCollapsed, toggled, toggledSet]);

  const toggleLine = (k: string) => {
    const next = toggled.includes(k) ? toggled.filter((x) => x !== k) : [...toggled, k];
    latest.current.toggled = next;
    setToggled(next);
    save();
  };

  const enterLine = (k: string) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(k), 110);
  };
  const pinLine = (k: string) => {
    clearTimeout(hoverTimer.current);
    setPinned((p) => (p === k ? null : k));
    setHover(k);
  };

  const showOnMap = (id: string) => {
    const c = canvasRef.current;
    const p = pos[id];
    const f = fileById.get(id);
    if (!c || !p || !f) return;
    interacted.current = true;
    if (f.status === 'reference') setShowRefs(true);
    const r = c.getBoundingClientRect();
    setView((v) => ({ ...v, x: r.width / 2 - (p.x + f.width / 2) * v.z, y: r.height / 2 - (p.y + (sizes[id] ?? 200) / 2) * v.z }));
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1200);
  };

  const activeKey = pinned ?? hover;
  const line = activeKey ? (lines[activeKey] ?? null) : null;
  const related = useMemo(() => {
    const set = new Set<string>();
    if (!line) return set;
    set.add(line.fileId);
    for (const ev of [...line.node.evidence, ...(line.node.affectedBy?.evidence ?? [])]) {
      const f = fileOfEvidence(data, ev);
      if (f) set.add(f.id);
    }
    return set;
  }, [line, data]);

  const visibleIds = new Set(visibleFiles.map((f) => f.id));
  const edges = data.edges
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
    .map((e, i) => {
      const a = pos[e.from], b = pos[e.to];
      const fa = fileById.get(e.from), fb = fileById.get(e.to);
      const geo = a && b && fa && fb
        ? edgeLine({ ...a, w: fa.width, h: sizes[e.from] ?? 200 }, { ...b, w: fb.width, h: sizes[e.to] ?? 200 })
        : null;
      const on =
        (!!line && related.has(e.from) && related.has(e.to) && (e.from === line.fileId || e.to === line.fileId)) ||
        (!!selected && (e.from === selected || e.to === selected));
      return { key: `${e.from}>${e.to}:${i}`, edge: e, geo, on };
    });
  const focusing = !!line || !!selected;

  const { pr, counts } = data;
  const statusText = stale ? '업데이트 필요' : data.latestHead ? '분석 최신' : '분석 커밋';
  const statusDot = stale ? 'var(--accent)' : data.latestHead ? 'var(--add)' : 'var(--line-strong)';
  const refCount = data.files.length - data.files.filter((f) => f.status !== 'reference').length;
  const cmd = rerunCommand(pr);

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <div className="header-title">
            <span className="header-repo">{pr.repo}{pr.number ? ` #${pr.number}` : ''}</span>
            <span className="header-name" title={pr.title}>{pr.title}</span>
          </div>
          <div className="header-meta">
            <span>{pr.baseRef} ← {pr.headRef}</span>
            <span>파일 {counts.changed} · 지도 {counts.mapped} · 미분류 {counts.unclassified}{counts.unverified ? ` · 확인 필요 ${counts.unverified}` : ''}</span>
          </div>
        </div>
        <div className="status-pill">
          <span className="status-dot" style={{ background: statusDot }} />
          <span>{statusText}</span>
          <span style={{ color: 'var(--fg3)' }}>{pr.head.slice(0, 7)}</span>
        </div>
        <a className="github-link" href={pr.url} target="_blank" rel="noopener noreferrer">GitHub에서 보기 ↗</a>
      </header>

      {stale && (
        <div className="stale-bar">
          <b>{data.newCommits ? `새 커밋 ${data.newCommits}개` : '새 커밋 있음'}</b>
          <span>지금 보이는 설명과 코드는 {pr.head.slice(0, 7)} 기준입니다. 최신 head는 {data.latestHead!.slice(0, 7)}입니다.</span>
          <span className="spacer" />
          <button className="btn-solid" onClick={() => copy(cmd)}>{copied ? '복사했습니다' : `다시 분석 명령 복사: ${cmd}`}</button>
        </div>
      )}

      <div className="body">
        <div
          ref={canvasRef}
          className="canvas"
          data-testid="canvas"
          onScroll={(e) => {
            // 화면 밖 줄에 포커스가 가면 브라우저가 캔버스를 스크롤한다.
            // 범례와 도구 막대가 밀리지 않게 스크롤을 지도 이동으로 바꾼다.
            const el = e.currentTarget;
            const { scrollLeft: dx, scrollTop: dy } = el;
            if (!dx && !dy) return;
            el.scrollLeft = 0;
            el.scrollTop = 0;
            interacted.current = true;
            setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            interacted.current = true;
            drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
            setPanning(true);
            setSelected(null);
          }}
          style={{
            cursor: panning ? 'grabbing' : 'default',
            backgroundSize: `${20 * view.z}px ${20 * view.z}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        >
          <div ref={worldRef} className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            <svg className="edges" width={1} height={1} aria-hidden="true">
              <defs>
                {(['n', 'a'] as const).map((t) => (
                  <marker key={t} id={`pm-arrow-${t}`} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto">
                    <path d="M1,1 L8,5 L1,9" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: t === 'a' ? 'var(--accent)' : 'var(--line-strong)' }} />
                  </marker>
                ))}
              </defs>
              {edges.map(({ key: k, edge, geo, on }) =>
                geo ? (
                  <path
                    key={k}
                    d={geo.d}
                    fill="none"
                    strokeWidth={on ? 1.75 : 1.25}
                    strokeDasharray={edge.kind === 'replacedBy' || edge.unverified ? '5 4' : undefined}
                    markerEnd={`url(#pm-arrow-${on ? 'a' : 'n'})`}
                    style={{ stroke: on ? 'var(--accent)' : 'var(--line-strong)', opacity: focusing && !on ? 0.2 : 1, transition: 'stroke .2s, opacity .2s' }}
                  />
                ) : null,
              )}
            </svg>
            {edges.map(({ key: k, edge, geo, on }) =>
              geo && (on || view.z >= LABEL_MIN_ZOOM) ? (
                <div key={k} className="edge-label" style={{ left: geo.lx, top: geo.ly, borderColor: on ? 'var(--accent)' : 'var(--line)', borderStyle: edge.unverified ? 'dashed' : 'solid', color: on ? 'var(--fg)' : 'var(--fg3)' }}>
                  {edge.label}{edge.unverified ? ' · 확인 필요' : ''}
                </div>
              ) : null,
            )}
            {visibleFiles.map((f) => {
              const p = pos[f.id];
              if (!p) return null;
              const isRel = related.has(f.id);
              const isOther = isRel && !!line && f.id !== line.fileId;
              return (
                <FileBox
                  key={f.id}
                  file={f}
                  x={p.x}
                  y={p.y}
                  z={selected === f.id ? 3 : isRel ? 2 : 1}
                  border={isOther || flash === f.id ? 'var(--accent)' : isRel ? 'var(--line-strong)' : 'var(--line)'}
                  flash={flash === f.id}
                  selected={selected === f.id}
                  baseSha={pr.base}
                  collapsed={collapsed}
                  activeKey={activeKey}
                  activePath={line?.path ?? []}
                  pinnedKey={pinned}
                  onBoxFocus={() => setSelected(f.id)}
                  onDragStart={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    interacted.current = true;
                    arranged.current = true;
                    setSelected(f.id);
                    drag.current = { type: 'box', id: f.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
                  }}
                  onEnter={enterLine}
                  onLeave={() => clearTimeout(hoverTimer.current)}
                  onLineFocus={(k, el) => {
                    setHover(k);
                    // 키보드로 화면 밖 줄에 왔을 때만 지도를 옮긴다. 마우스 클릭 때는 화면을 움직이지 않는다.
                    const c = canvasRef.current;
                    if (!c || !el.matches(':focus-visible')) return;
                    const box = c.getBoundingClientRect();
                    const r = el.getBoundingClientRect();
                    const margin = 24;
                    const dx = r.left < box.left + margin ? box.left + margin - r.left : r.right > box.right - margin ? box.right - margin - r.right : 0;
                    const dy = r.top < box.top + margin ? box.top + margin - r.top : r.bottom > box.bottom - margin ? box.bottom - margin - r.bottom : 0;
                    if (dx || dy) {
                      interacted.current = true;
                      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
                    }
                  }}
                  onPin={pinLine}
                  onToggle={toggleLine}
                />
              );
            })}
          </div>

          <div className="legend">
            <span><span style={{ color: 'var(--add)' }}>+</span> 추가</span>
            <span><span style={{ color: 'var(--del)' }}>−</span> 삭제</span>
            <span><span style={{ color: 'var(--chg)' }}>●</span> 수정</span>
            <span><span style={{ color: 'var(--aff)' }}>◐</span> 영향</span>
            <span>표시 없음 = 변경 없음</span>
          </div>

          {data.unclassified.length > 0 && (
            <div className="unc" onMouseDown={(e) => e.stopPropagation()}>
              <button className="unc-toggle" aria-expanded={uncOpen} onClick={() => setUncOpen(!uncOpen)}>
                <span style={{ fontWeight: 600 }}>미분류</span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg3)' }}>{data.unclassified.length}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--fg3)' }}>지도에 넣지 않은 변경 파일</span>
                <span style={{ fontSize: 9, color: 'var(--fg3)' }}>{uncOpen ? '▼' : '▶'}</span>
              </button>
              {uncOpen && (
                <div className="unc-list">
                  {data.unclassified.map((u) => {
                    const sha = u.status === 'deleted' ? pr.base : pr.head;
                    const stat = u.binary ? '변경' : `${u.additions ? `+${u.additions}` : ''}${u.additions && u.deletions ? ' ' : ''}${u.deletions ? `−${u.deletions}` : ''}`;
                    return (
                      <a key={u.path} className="unc-item" href={`https://github.com/${pr.repo}/blob/${sha}/${u.path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noopener noreferrer">
                        <span className="unc-path" title={u.path}>{u.path}</span>
                        <span className="unc-diff">{stat}</span>
                        <span className="unc-reason">{u.reason}</span>
                      </a>
                    );
                  })}
                  <span className="unc-note">분석 범위는 .pr-map.yml에서 바꿀 수 있습니다.</span>
                </div>
              )}
            </div>
          )}

          <div className="toolbar" onMouseDown={(e) => e.stopPropagation()}>
            <button className="tool tool-icon" aria-label="축소" onClick={() => zoomBy(1 / 1.2)}>−</button>
            <span className="tool-zoom">{Math.round(view.z * 100)}%</span>
            <button className="tool tool-icon" aria-label="확대" onClick={() => zoomBy(1.2)}>+</button>
            <span className="tool-sep" />
            <button className="tool" onClick={() => fit()}>전체 보기</button>
            <button className="tool" onClick={arrange}>자동 정렬</button>
            {refCount > 0 && <button className="tool" aria-pressed={showRefs} onClick={() => setShowRefs(!showRefs)}>참고 파일 {refCount} {showRefs ? '숨기기' : '보기'}</button>}
          </div>
        </div>

        <div
          className="splitter"
          onMouseDown={(e) => {
            e.preventDefault();
            drag.current = { type: 'split' };
          }}
        />
        <EvidencePanel
          data={data}
          line={line}
          pinned={!!pinned}
          width={panelPct}
          openEvidence={activeKey ? (openEv[activeKey] ?? [0]) : []}
          wideEvidence={wideEv}
          onUnpin={() => setPinned(null)}
          onToggleEvidence={(i) => {
            if (!activeKey) return;
            const cur = openEv[activeKey] ?? [0];
            setOpenEv({ ...openEv, [activeKey]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i] });
          }}
          onToggleWide={(id) => setWideEv((w) => ({ ...w, [id]: !w[id] }))}
          onShowOnMap={showOnMap}
          onCopy={copy}
          copied={copied}
        />
      </div>
    </div>
  );
}

function StateScreen({ title, children }: { title: string; children: React.ReactNode }) {
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
  if (!data || data.status === 'empty') {
    return (
      <StateScreen title="분석할 PR을 고르세요">
        <p>저장소에서 <code className="mono">/pr-map</code> 또는 <code className="mono">/pr-map &lt;PR 번호&gt;</code>를 실행하면 파일 지도가 만들어집니다.</p>
      </StateScreen>
    );
  }
  if (data.status === 'analyzing') {
    return (
      <StateScreen title="분석 중입니다">
        <p>{data.pr.repo}{data.pr.number ? ` #${data.pr.number}` : ''} · 변경 파일 {data.changed}개를 {data.pr.head.slice(0, 7)} 기준으로 분석하고 있습니다. 아직 완료된 결과가 없습니다. 분석이 끝나면 <code className="mono">/pr-map view</code>로 다시 여세요.</p>
      </StateScreen>
    );
  }
  if (data.status === 'failed') {
    const cmd = rerunCommand(data.pr);
    return (
      <StateScreen title="분석 결과를 검증하지 못했습니다">
        <p>{data.pr.repo}{data.pr.number ? ` #${data.pr.number}` : ''} · 아래 항목이 검증을 통과하지 못해 지도를 만들지 않았습니다.</p>
        <ul className="state-errors">
          {data.errors.map((e, i) => (
            <li key={i}><code>{e.path}</code><span>{e.reason}</span></li>
          ))}
        </ul>
        <button className="btn-ghost" onClick={() => copy(cmd)}>{copied ? '복사했습니다' : `재시도 명령 복사: ${cmd}`}</button>
      </StateScreen>
    );
  }
  return <MapScreen data={data} />;
}
