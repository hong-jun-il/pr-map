import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import type { FileStatus, NodeChange, ViewerFile } from '../shared/types';
import { countDescendants, flatten } from './model';

const STATUS: Record<FileStatus, { label: string; color: string; border: string }> = {
  modified: { label: '수정', color: 'var(--fg2)', border: 'var(--line-strong)' },
  added: { label: '추가', color: 'var(--add)', border: 'var(--add)' },
  reference: { label: '참고', color: 'var(--fg3)', border: 'var(--line-strong)' },
  deleted: { label: '삭제', color: 'var(--del)', border: 'var(--del)' },
  renamed: { label: '이름 변경', color: 'var(--fg2)', border: 'var(--line-strong)' },
};

const MARK: Record<Exclude<NodeChange, 'unchanged'>, { mark: string; color: string; title: string }> = {
  added: { mark: '+', color: 'var(--add)', title: '추가: 이 PR에서 새로 생긴 분기' },
  deleted: { mark: '−', color: 'var(--del)', title: '삭제: 이 PR에서 없어진 분기 (base 기준)' },
  modified: { mark: '●', color: 'var(--chg)', title: '수정: 분기는 있고 동작이 바뀜' },
  affected: { mark: '◐', color: 'var(--aff)', title: '영향: 직접 바뀌지 않았지만 동작이 달라질 수 있음' },
};

const FONT_SIZE = [16, 14, 12.5, 11.5];

interface Props {
  file: ViewerFile;
  x: number;
  y: number;
  z: number;
  border: string;
  flash: boolean;
  selected: boolean;
  baseSha: string;
  collapsed: Set<string>;
  activeKey: string | null;
  activePath: string[];
  pinnedKey: string | null;
  onBoxFocus: () => void;
  onDragStart: (e: MouseEvent) => void;
  onEnter: (key: string) => void;
  onLeave: () => void;
  onLineFocus: (key: string, el: HTMLElement) => void;
  onPin: (key: string) => void;
  onToggle: (key: string) => void;
}

export function FileBox(p: Props) {
  const { file: f } = p;
  const status = STATUS[f.status];
  const dashed = f.status === 'reference' || f.status === 'deleted';
  const borderStyle = dashed ? 'dashed' : 'solid';
  const rows = flatten(f.id, f.tree, p.collapsed);
  const contextFile = f.status === 'modified' || f.status === 'renamed' || f.status === 'reference';
  const dir = f.status === 'renamed' && f.oldPath ? `${f.dir} · 이전 ${f.oldPath.slice(f.oldPath.lastIndexOf('/') + 1)}` : f.dir;

  const style: CSSProperties = {
    left: p.x,
    top: p.y,
    width: f.width,
    zIndex: p.z,
    borderStyle,
    borderColor: p.border,
    boxShadow: p.flash ? '0 0 0 4px var(--accent-bg-2), var(--shadow)' : 'var(--shadow)',
  };

  return (
    <div
      className="box"
      data-box={f.id}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseDownCapture={p.onBoxFocus}
      onFocusCapture={p.onBoxFocus}
    >
      {p.selected && (
        <svg className="box-ring" aria-hidden="true">
          <rect x={0.75} y={0.75} width="calc(100% - 1.5px)" height="calc(100% - 1.5px)" rx={12} fill="none" strokeWidth={1.5} strokeDasharray="6 5" style={{ stroke: 'var(--accent)' }}>
            <animate attributeName="stroke-dashoffset" from={0} to={-22} dur="0.7s" repeatCount="indefinite" />
          </rect>
        </svg>
      )}
      <div className="box-head" onMouseDown={p.onDragStart}>
        <span className="box-tag" style={{ borderStyle, borderColor: status.border, color: status.color }}>{status.label}</span>
        <div className="box-names">
          <span className="box-name" style={{ textDecoration: f.status === 'deleted' ? 'line-through' : 'none', textDecorationColor: 'var(--del)' }}>{f.name}</span>
          <span className="box-dir" title={f.path}>{dir}</span>
        </div>
        <span className="box-stat">
          {f.additions > 0 && <span style={{ color: 'var(--add)' }}>+{f.additions}</span>}
          {f.deletions > 0 && <span style={{ color: 'var(--del)' }}>−{f.deletions}</span>}
          {!f.additions && !f.deletions && <span style={{ color: 'var(--fg3)' }}>변경 없음</span>}
        </span>
      </div>
      {f.status === 'deleted' && (
        <div className="box-del-info">
          <span>{f.replacedByNames.length ? <>대체 → <code>{f.replacedByNames.join(', ')}</code></> : '대체 없음 · 기능 제거'}</span>
          <span>{f.callers} · base {p.baseSha.slice(0, 7)} 기준</span>
        </div>
      )}
      <div className="box-body" style={{ opacity: f.status === 'deleted' ? 0.85 : 1 }}>
        {rows.length === 0 && <div className="box-empty">{f.status === 'renamed' ? '동작 변경 없음 · 이름만 바뀜' : '설명할 동작 없음'}</div>}
        {rows.map((r) => {
          const n = r.node;
          const isPin = p.pinnedKey === r.key;
          const isAct = p.activeKey === r.key;
          const inPath = p.activePath.includes(r.key);
          const unchanged = contextFile && n.change === 'unchanged';
          const strong = inPath || (r.depth < 2 && !unchanged);
          const arrow = n.text.indexOf(' → ');
          const mark = n.change !== 'unchanged' ? MARK[n.change] : null;
          const showStrike = contextFile && n.change === 'deleted';
          const deco = n.unverified ? 'underline dashed' : showStrike ? 'line-through' : 'none';
          const decoColor = n.change === 'deleted' ? 'var(--del)' : 'var(--fg3)';
          const textStyle = { textDecoration: deco, textDecorationColor: decoColor };
          const meta = isPin
            ? '고정'
            : n.unverified
              ? '확인 필요'
              : unchanged && r.hasKids && !r.open
                ? `변경 없음 · ${countDescendants(n)}`
                : n.evidence.length > 1
                  ? `근거 ${n.evidence.length}`
                  : '';
          return (
            <div
              key={r.key}
              className="row"
              role="button"
              tabIndex={0}
              aria-pressed={isPin}
              aria-expanded={r.hasKids ? r.open : undefined}
              data-line={r.key}
              style={{ marginTop: r.depth === 0 && !r.first ? 8 : 0, background: isPin ? 'var(--accent-bg-2)' : isAct ? 'var(--accent-bg)' : 'transparent' }}
              onMouseEnter={() => p.onEnter(r.key)}
              onMouseLeave={p.onLeave}
              onClick={() => {
                // 텍스트를 드래그로 선택해 복사할 때는 고정하지 않는다(U03).
                if (!window.getSelection()?.isCollapsed) return;
                p.onPin(r.key);
              }}
              onFocus={(e) => p.onLineFocus(r.key, e.currentTarget)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  p.onPin(r.key);
                } else if (r.hasKids && ((e.key === 'ArrowLeft' && r.open) || (e.key === 'ArrowRight' && !r.open))) {
                  e.preventDefault();
                  p.onToggle(r.key);
                }
              }}
            >
              <span className="row-prefix">{r.prefix}</span>
              <span
                className="row-caret"
                onClick={(e) => {
                  if (!r.hasKids) return;
                  e.stopPropagation();
                  p.onToggle(r.key);
                }}
              >
                {r.hasKids ? (r.open ? '▼' : '▶') : ''}
              </span>
              <span className="row-mark" title={mark?.title} style={{ color: mark?.color ?? 'var(--fg3)' }}>{mark?.mark ?? ''}</span>
              <span className="row-text" style={{ fontWeight: r.depth === 0 ? 600 : 400, fontSize: FONT_SIZE[Math.min(r.depth, 3)] }}>
                {arrow >= 0 && <span style={{ color: strong ? 'var(--fg2)' : 'var(--fg3)', ...textStyle }}>{n.text.slice(0, arrow)}</span>}
                {arrow >= 0 && <span className="row-arrow"> → </span>}
                <span className="row-res" style={{ color: n.unverified ? 'var(--fg2)' : strong ? 'var(--fg)' : 'var(--fg2)', ...textStyle }}>{arrow >= 0 ? n.text.slice(arrow + 3) : n.text}</span>
              </span>
              <span className="row-meta" style={{ color: isPin ? 'var(--fg)' : 'var(--fg3)' }}>{meta}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
