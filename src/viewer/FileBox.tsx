import type { FileStatus, NodeChange, ViewerFile } from '../shared/types';
import { countChanges, flattenTree } from './lanes';

export const STATUS: Record<FileStatus, { label: string; color: string }> = {
  added: { label: '추가', color: 'var(--add)' },
  modified: { label: '수정', color: 'var(--fg2)' },
  deleted: { label: '삭제', color: 'var(--del)' },
  renamed: { label: '이름 변경', color: 'var(--fg2)' },
  reference: { label: '참고', color: 'var(--fg3)' },
};

export const MARK: Record<Exclude<NodeChange, 'unchanged'>, { mark: string; color: string; title: string }> = {
  added: { mark: '+', color: 'var(--add)', title: '추가된 분기' },
  deleted: { mark: '−', color: 'var(--del)', title: '삭제된 분기' },
  modified: { mark: '●', color: 'var(--chg)', title: '수정된 분기' },
  affected: { mark: '◐', color: 'var(--aff)', title: '영향받는 분기' },
};

export const isDashed = (f: ViewerFile) => f.status === 'reference' || f.status === 'deleted';

export const replacementNote = (f: ViewerFile) => (f.status !== 'deleted' ? '' : f.replacedByNames.length ? `대체 → ${f.replacedByNames.join(', ')}` : '대체 없음 · 기능 제거');

interface Props {
  file: ViewerFile;
  selected: boolean;
  dimmed: boolean;
  neighbor: boolean;
  evidence: boolean;
  flash: boolean;
  reviewed: boolean;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

export function FileBox({ file: f, selected, dimmed, neighbor, evidence, flash, reviewed, onClick, onEnter, onLeave }: Props) {
  const status = STATUS[f.status];
  const borderStyle = isDashed(f) ? 'dashed' : 'solid';
  const changes = countChanges(f);
  const chips = (['added', 'deleted', 'modified', 'affected'] as const).filter((c) => changes[c]);
  const unverified = flattenTree(f.id, f.tree).filter((r) => r.node.unverified).length;
  const note = replacementNote(f);
  const dir = f.oldPath ? `${f.dir} · 이전 ${f.oldPath.slice(f.oldPath.lastIndexOf('/') + 1)}` : f.dir;
  return (
    <div
      className="box"
      data-fid={f.id}
      title={f.path}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        borderStyle,
        borderColor: selected || evidence ? 'var(--accent)' : neighbor ? 'var(--line-strong)' : 'var(--line)',
        opacity: dimmed ? 0.32 : reviewed && !selected ? 0.6 : 1,
        boxShadow: flash ? '0 0 0 5px var(--accent-bg-2), var(--shadow)' : evidence ? '0 0 0 3px var(--accent-bg), var(--shadow)' : 'var(--shadow)',
      }}
    >
      {selected && (
        <svg className="box-ring" aria-hidden="true">
          <rect x={0.75} y={0.75} width="calc(100% - 1.5px)" height="calc(100% - 1.5px)" rx={12} fill="none" strokeWidth={1.5} strokeDasharray="6 5" style={{ stroke: 'var(--accent)' }}>
            <animate attributeName="stroke-dashoffset" from={0} to={-22} dur="0.7s" repeatCount="indefinite" />
          </rect>
        </svg>
      )}
      <div className="box-head">
        <span className="box-tag" style={{ borderStyle, borderColor: status.color, color: status.color }}>{status.label}</span>
        <span className="box-name" style={{ textDecoration: f.status === 'deleted' ? 'line-through' : 'none' }}>{f.name}</span>
        {evidence && <span className="box-badge">근거</span>}
        {reviewed && <span className="box-reviewed">✓ 확인함</span>}
        <span className="box-stat">
          {f.additions > 0 && <span style={{ color: 'var(--add)' }}>+{f.additions}</span>}
          {f.deletions > 0 && <span style={{ color: 'var(--del)' }}>−{f.deletions}</span>}
        </span>
      </div>
      <span className="box-dir"><bdi>{dir}</bdi></span>
      <span className="box-role">{f.role}</span>
      {note && <span className="box-note">{note}</span>}
      <div className="box-chips">
        <span>분기</span>
        {chips.map((c) => (
          <span key={c} title={MARK[c].title} style={{ color: MARK[c].color, fontWeight: 600 }}>{MARK[c].mark}{changes[c]}</span>
        ))}
        {!chips.length && <span>변경 없음</span>}
        {unverified > 0 && <span className="box-unverified">확인 필요 {unverified}</span>}
      </div>
    </div>
  );
}
