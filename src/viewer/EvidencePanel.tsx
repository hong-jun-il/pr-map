import { useMemo } from 'react';
import type { CodeError, CodeRow, Evidence, ViewerMapData } from '../shared/types';
import { fileOfEvidence, githubHref, rerunCommand, type LineEntry } from './model';
import { tokenize } from './tokenize';

const CODE_ERROR_TEXT: Record<CodeError | 'no-range', string> = {
  'not-found': '이 커밋에서 파일을 찾지 못했습니다. 다른 위치의 코드를 대신 보여주지 않습니다.',
  'too-large': '파일이 1MB를 넘어 뷰어에 넣지 않았습니다. GitHub에서 확인하세요.',
  binary: '바이너리 파일이라 코드로 표시할 수 없습니다.',
  'no-range': '이 줄 범위가 파일에 없습니다. 다른 위치의 코드를 대신 보여주지 않습니다.',
};

const CONTEXT = 2;
const CONTEXT_MORE = 8;

function CodeBlock({ rows, focusFrom, focusTo }: { rows: CodeRow[]; focusFrom: number; focusTo: number }) {
  return (
    <div className="code">
      {rows.map((r, i) => {
        const absolute = i;
        const focus = absolute >= focusFrom && absolute <= focusTo;
        return (
          <div key={i} className="code-line" style={{ background: r.d === '+' ? 'var(--add-bg)' : r.d === '-' ? 'var(--del-bg)' : 'transparent', opacity: focus ? 1 : 0.45 }}>
            <span className="code-num">{r.o || ''}</span>
            <span className="code-num">{r.n || ''}</span>
            <span className="code-sign" style={{ color: r.d === '+' ? 'var(--add)' : 'var(--del)' }}>{r.d === '+' ? '+' : r.d === '-' ? '−' : ''}</span>
            <span className="code-text">
              {tokenize(r.t).map((tk, j) => (
                <span key={j} style={{ color: tk.c, fontStyle: tk.italic ? 'italic' : 'normal' }}>{tk.t}</span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface CardProps {
  data: ViewerMapData;
  ev: Evidence;
  index: number;
  open: boolean;
  wide: boolean;
  ownerFileId: string;
  onToggle: () => void;
  onToggleWide: () => void;
  onShowOnMap: (fileId: string) => void;
}

function EvidenceCard({ data, ev, index, open, wide, ownerFileId, onToggle, onToggleWide, onShowOnMap }: CardProps) {
  const sha = ev.side === 'base' ? data.pr.base : data.pr.head;
  const target = fileOfEvidence(data, ev);
  const view = useMemo(() => {
    const entry = data.code[data.codeIndex[`${ev.side}:${ev.path}`] ?? ''];
    if (!entry) return { error: 'not-found' as const };
    if ('error' in entry) return { error: entry.error };
    const lineOf = (r: CodeRow) => (ev.side === 'base' ? r.o : r.n);
    const hits: number[] = [];
    entry.rows.forEach((r, i) => {
      const ln = lineOf(r);
      if (ln && ln >= ev.start && ln <= ev.end) hits.push(i);
    });
    if (!hits.length) return { error: 'no-range' as const };
    return { all: entry.rows, i0: hits[0]!, i1: hits[hits.length - 1]! };
  }, [data, ev]);

  const body = () => {
    if ('error' in view) return <div className="code-error">{CODE_ERROR_TEXT[view.error!]}</div>;
    const c = wide ? CONTEXT_MORE : CONTEXT;
    const lo = Math.max(0, view.i0 - c);
    const hi = Math.min(view.all.length - 1, view.i1 + c);
    return <CodeBlock rows={view.all.slice(lo, hi + 1)} focusFrom={view.i0 - lo} focusTo={view.i1 - lo} />;
  };
  const canWiden = !('error' in view) && (wide || view.i0 - CONTEXT > 0 || view.i1 + CONTEXT < view.all.length - 1);

  return (
    <div className="ev">
      <button className="ev-toggle" aria-expanded={open} style={{ background: open ? 'var(--surface-2)' : 'transparent' }} onClick={onToggle}>
        <span className="ev-n">{String(index + 1).padStart(2, '0')}</span>
        <span className="ev-title">
          <span className="ev-role">{ev.role}</span>
          <span className="ev-loc" title={ev.path}>{ev.path}  L{ev.start}{ev.end !== ev.start ? `–${ev.end}` : ''}</span>
        </span>
        <span className="ev-chev">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <>
          {body()}
          <div className="ev-foot">
            {canWiden && <button className="ev-action" onClick={onToggleWide}>{wide ? '주변 코드 줄이기' : '주변 코드 더 보기'}</button>}
            {target && target.id !== ownerFileId && <button className="ev-action" onClick={() => onShowOnMap(target.id)}>지도에서 보기</button>}
            <span className="spacer" />
            <span className="ev-side">{ev.side} {sha.slice(0, 7)}</span>
            <a className="ev-link" href={githubHref(data, ev)} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
          </div>
        </>
      )}
    </div>
  );
}

interface Props {
  data: ViewerMapData;
  line: LineEntry | null;
  pinned: boolean;
  width: number;
  openEvidence: number[];
  wideEvidence: Record<string, boolean>;
  onUnpin: () => void;
  onToggleEvidence: (i: number) => void;
  onToggleWide: (id: string) => void;
  onShowOnMap: (fileId: string) => void;
  onCopy: (text: string) => void;
  copied: boolean;
}

export function EvidencePanel({ data, line, pinned, width, openEvidence, wideEvidence, onUnpin, onToggleEvidence, onToggleWide, onShowOnMap, onCopy, copied }: Props) {
  const owner = line ? data.files.find((f) => f.id === line.fileId) : null;
  // 영향 노드는 자신의 근거 뒤에 원인이 된 변경 줄을 이어서 보여준다.
  const evidence: Evidence[] = line ? [...line.node.evidence, ...(line.node.affectedBy?.evidence ?? [])] : [];
  return (
    <aside className="panel" style={{ width: `${width}%` }}>
      <div className="panel-head">
        <span>근거 코드</span>
        <span className="spacer" />
        <span style={{ color: pinned ? 'var(--fg)' : 'var(--fg3)' }}>{!line ? '' : pinned ? '고정됨' : '미리보기'}</span>
        {pinned && <button className="unpin" onClick={onUnpin}>고정 해제 <kbd>Esc</kbd></button>}
      </div>
      <div className="panel-body">
        {!line && (
          <div className="panel-empty">
            <b>설명 줄을 고르세요</b>
            <p>지도의 설명 줄에 포인터를 올리면 연결된 원본 코드가 여기 나타납니다. 클릭하면 고정되어 다른 줄을 지나가도 바뀌지 않습니다.</p>
            <p style={{ fontSize: 12, color: 'var(--fg3)' }}>근거의 줄 위치는 커밋에서 검증했습니다. 설명의 의미는 자동 검증 대상이 아닙니다.</p>
            <div className="panel-keys"><span>Tab 이동</span><span>Enter 고정</span><span>Esc 해제</span></div>
          </div>
        )}
        {line && (
          <>
            <div className="active-info">
              <span className="active-crumb">{[owner?.name, ...line.chain].join('  ›  ')}</span>
              <span className="active-text">{line.node.text}</span>
            </div>
            {line.node.unverified && (
              <div className="notice">
                <b>근거 확인 필요</b>
                <p>이 설명과 연결할 코드 위치를 찾지 못했습니다. 코드 인용을 만들지 않았으니 확정된 동작으로 읽지 마세요.</p>
                <button className="btn-ghost" onClick={() => onCopy(rerunCommand(data.pr))}>{copied ? '복사했습니다' : `다시 분석 명령 복사: ${rerunCommand(data.pr)}`}</button>
              </div>
            )}
            {line.node.affectedBy && (
              <div className="affected-by">
                <span>◐ 영향 원인</span>
                <span>{line.node.affectedBy.text}</span>
              </div>
            )}
            {evidence.map((ev, i) => {
              const id = `${line.key}:${i}`;
              return (
                <EvidenceCard
                  key={id}
                  data={data}
                  ev={ev}
                  index={i}
                  open={openEvidence.includes(i)}
                  wide={!!wideEvidence[id]}
                  ownerFileId={line.fileId}
                  onToggle={() => onToggleEvidence(i)}
                  onToggleWide={() => onToggleWide(id)}
                  onShowOnMap={onShowOnMap}
                />
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}
