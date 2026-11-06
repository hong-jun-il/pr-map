import { useState, type MouseEvent, type RefObject } from 'react';
import type { CodeError, CodeRow, ViewerFile, ViewerMapData } from '../shared/types';
import { isDashed, MARK, replacementNote, STATUS } from './FileBox';
import { flattenTree, type TreeRow } from './lanes';
import { baseName, evidenceSummary, evidenceWhere, fileOfEvidence, githubHref, nodeEvidence, nodeTests, rerunCommand, type PanelEvidence } from './model';
import { tokenize } from './tokenize';

export interface Draft {
  id: number;
  lineKey: string;
  where: string;
  text: string;
}

const CODE_ERROR_TEXT: Record<CodeError | 'no-range', string> = {
  'not-found': '이 커밋에서 파일을 찾지 못했습니다. 다른 위치의 코드를 대신 보여주지 않습니다.',
  'too-large': '파일이 1MB를 넘어 뷰어에 넣지 않았습니다. GitHub에서 확인하세요.',
  binary: '바이너리 파일이라 코드로 표시할 수 없습니다.',
  'no-range': '이 줄 범위가 파일에 없습니다. 다른 위치의 코드를 대신 보여주지 않습니다.',
};

const FONT_SIZE = [15, 13.5, 12.5];
const CONTEXT = 2;
const CONTEXT_MORE = 8;
/** 근거가 이만큼 많으면 앞쪽만 먼저 보여준다. */
const MANY_EVIDENCE = 6;
const FIRST_EVIDENCE = 4;

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

type EvidenceCode = { error: CodeError | 'no-range' } | { rows: CodeRow[]; from: number; to: number; canWiden: boolean };

function evidenceCode(data: ViewerMapData, ev: PanelEvidence, wide: boolean): EvidenceCode {
  const entry = data.code[data.codeIndex[`${ev.side}:${ev.path}`] ?? ''];
  if (!entry) return { error: 'not-found' };
  if ('error' in entry) return { error: entry.error };
  const hits: number[] = [];
  entry.rows.forEach((r, i) => {
    const ln = ev.side === 'base' ? r.o : r.n;
    if (ln && ln >= ev.start && ln <= ev.end) hits.push(i);
  });
  if (!hits.length) return { error: 'no-range' };
  const i0 = hits[0]!, i1 = hits[hits.length - 1]!, c = wide ? CONTEXT_MORE : CONTEXT;
  const lo = Math.max(0, i0 - c), hi = Math.min(entry.rows.length - 1, i1 + c);
  return {
    rows: entry.rows.slice(lo, hi + 1),
    from: i0 - lo,
    to: i1 - lo,
    canWiden: wide || i0 - CONTEXT > 0 || i1 + CONTEXT < entry.rows.length - 1,
  };
}

interface CommentProps {
  drafts: Draft[];
  composer: { key: string; text: string } | null;
  onCompose: (key: string) => void;
  onComposerText: (text: string) => void;
  onComposerCancel: () => void;
  onDraftSave: (lineKey: string, where: string) => void;
  onDraftDelete: (id: number) => void;
}

function CodeLine({ row, focus, ev, cardKey, comments }: { row: CodeRow; focus: boolean; ev: PanelEvidence; cardKey: string; comments: CommentProps }) {
  const removed = row.d === '-';
  const line = removed ? row.o : row.n;
  const lk = `${ev.path}:${removed ? 'L' : 'R'}${line}`;
  const key = `${cardKey}|${lk}`;
  const where = `${baseName(ev.path)} ${removed ? '이전 ' : ''}L${line}`;
  const composing = comments.composer?.key === key;
  return (
    <>
      <div className="code-line" style={{ background: row.d === '+' ? 'var(--add-bg)' : removed ? 'var(--del-bg)' : 'transparent', opacity: focus ? 1 : 0.45 }}>
        <span className="code-comment">
          <button title="이 줄에 리뷰 코멘트" aria-label={`${where}에 리뷰 코멘트`} onClick={stop(() => comments.onCompose(key))}>+</button>
        </span>
        <span className="code-num">{row.o || ''}</span>
        <span className="code-num">{row.n || ''}</span>
        <span className="code-sign" style={{ color: row.d === '+' ? 'var(--add)' : 'var(--del)' }}>{row.d === '+' ? '+' : removed ? '−' : ''}</span>
        <span className="code-text">
          {tokenize(row.t).map((tk, j) => (
            <span key={j} style={{ color: tk.c, fontStyle: tk.italic ? 'italic' : 'normal' }}>{tk.t}</span>
          ))}
        </span>
      </div>
      {comments.drafts.filter((d) => d.lineKey === lk).map((d) => (
        <div key={d.id} className="draft">
          <span className="draft-tag">초안</span>
          <span className="draft-text">{d.text}</span>
          <button onClick={stop(() => comments.onDraftDelete(d.id))}>삭제</button>
        </div>
      ))}
      {composing && (
        <div className="composer" onClick={(e) => e.stopPropagation()}>
          <span className="composer-where">{where} · 리뷰 코멘트</span>
          <textarea
            autoFocus
            rows={3}
            value={comments.composer!.text}
            placeholder="코멘트 · ⌘Enter 저장 · Esc 취소"
            onChange={(e) => comments.onComposerText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') comments.onComposerCancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) comments.onDraftSave(lk, where);
            }}
          />
          <div className="composer-actions">
            <button onClick={comments.onComposerCancel}>취소</button>
            <button className="composer-save" onClick={() => comments.onDraftSave(lk, where)}>초안 저장</button>
          </div>
        </div>
      )}
    </>
  );
}

interface EvidenceCardProps {
  data: ViewerMapData;
  ev: PanelEvidence;
  label: string;
  cardKey: string;
  ownerId: string;
  open: boolean;
  onToggle: () => void;
  onShowOnMap: (fileId: string) => void;
  comments: CommentProps;
}

function EvidenceCard({ data, ev, label, cardKey, ownerId, open, onToggle, onShowOnMap, comments }: EvidenceCardProps) {
  const [wide, setWide] = useState(false);
  const target = ev.test ? undefined : fileOfEvidence(data, ev);
  const view = open ? evidenceCode(data, ev, wide) : null;
  const sha = ev.side === 'base' ? data.pr.base : data.pr.head;
  return (
    <div className="ev">
      <div className="ev-head">
        <button className="ev-toggle" aria-expanded={open} onClick={stop(onToggle)}>
          <span className="ev-n">{label}</span>
          {ev.test && <span className="ev-test">테스트</span>}
          <span className="ev-role">{ev.role}</span>
          <span className="ev-loc" title={ev.path}>{evidenceWhere(ev)}</span>
          <span className="ev-chev">{open ? '▼' : '▶'}</span>
        </button>
        {target && target.id !== ownerId && <button className="ev-map" onClick={stop(() => onShowOnMap(target.id))}>지도에서 보기</button>}
      </div>
      {view && 'error' in view && <div className="code-error">{CODE_ERROR_TEXT[view.error]}</div>}
      {view && 'rows' in view && (
        <>
          <div className="code">
            {view.rows.map((r, i) => (
              <CodeLine key={i} row={r} focus={i >= view.from && i <= view.to} ev={ev} cardKey={cardKey} comments={comments} />
            ))}
          </div>
          <div className="ev-foot">
            {view.canWiden && <button className="ev-action" onClick={stop(() => setWide(!wide))}>{wide ? '주변 코드 줄이기' : '주변 코드 더 보기'}</button>}
            <span className="spacer" />
            <span className="ev-side">{ev.side} {sha.slice(0, 7)}</span>
            <a className="ev-link" href={githubHref(data, ev)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>GitHub ↗</a>
          </div>
        </>
      )}
    </div>
  );
}

interface TreeRowViewProps {
  data: ViewerMapData;
  file: ViewerFile;
  row: TreeRow;
  open: boolean;
  current: boolean;
  openEvidence: number[];
  onToggleRow: () => void;
  onToggleEvidence: (i: number) => void;
  onShowOnMap: (fileId: string) => void;
  onCopy: (text: string) => void;
  copied: boolean;
  comments: CommentProps;
}

function TreeRowView({ data, file, row, open, current, openEvidence, onToggleRow, onToggleEvidence, onShowOnMap, onCopy, copied, comments }: TreeRowViewProps) {
  const [showAll, setShowAll] = useState(false);
  const n = row.node;
  const arrow = n.text.indexOf(' → ');
  const unchanged = n.change === 'unchanged';
  const strong = row.depth < 2 && !unchanged;
  const mark = n.change !== 'unchanged' ? MARK[n.change] : null;
  const evidence = nodeEvidence(n);
  const tests = nodeTests(n);
  const limit = evidence.length >= MANY_EVIDENCE && !showAll ? FIRST_EVIDENCE : evidence.length;
  const items = [
    ...evidence.slice(0, limit).map((ev, i) => ({ ev: ev as PanelEvidence, i, label: String(i + 1).padStart(2, '0') })),
    ...tests.map((ev, j) => ({ ev, i: 100 + j, label: `T${j + 1}` })),
  ];
  const textStyle = {
    textDecoration: n.unverified ? 'underline dashed' : n.change === 'deleted' && file.status !== 'deleted' ? 'line-through' : 'none',
    textDecorationColor: n.unverified ? 'var(--fg3)' : 'var(--del)',
  };
  const guides = open ? [...[...row.cont].flatMap((ch, i) => (ch === '│' ? [i] : [])), ...(row.hasKids ? [row.cont.length] : [])] : [];
  return (
    <div className="tree-group" data-row={row.key} style={{ marginTop: row.depth === 0 && !row.first ? 8 : 0, background: open ? 'var(--accent-bg)' : 'transparent', paddingBottom: open ? 10 : 0 }}>
      <div
        className={`tree-row${open ? ' tree-row-open' : ''}`}
        role="button"
        aria-expanded={open}
        style={{ boxShadow: current ? 'inset 0 0 0 1.5px var(--accent)' : 'none' }}
        onClick={stop(onToggleRow)}
      >
        <span className="tree-prefix">{row.prefix}</span>
        <span className="tree-mark" title={mark?.title ?? '변경 없음'} style={{ color: mark?.color ?? 'var(--fg3)' }}>{mark?.mark ?? ''}</span>
        <span className="tree-text" style={{ fontSize: FONT_SIZE[Math.min(row.depth, 2)], fontWeight: row.depth === 0 ? 600 : 400, ...textStyle }}>
          {arrow >= 0 && <span style={{ color: strong ? 'var(--fg2)' : 'var(--fg3)' }}>{n.text.slice(0, arrow)}</span>}
          {arrow >= 0 && <span style={{ color: 'var(--fg3)' }}> → </span>}
          <span style={{ color: strong ? 'var(--fg)' : 'var(--fg2)' }}>{arrow >= 0 ? n.text.slice(arrow + 3) : n.text}</span>
        </span>
        {tests.length > 0 && <span className="tree-tests">테스트 {tests.length}</span>}
        <span className="tree-loc" title={evidence.map((ev) => `${evidenceWhere(ev)} · ${ev.role}`).join('  /  ')}>{evidenceSummary(data, file, n)}</span>
      </div>
      {open && (
        <div className="tree-detail" style={{ paddingLeft: `calc(${row.prefix.length}ch + 20px)` }}>
          {guides.map((c) => <span key={c} className="tree-guide" style={{ left: `calc(${c + 0.5}ch + 4px)` }} />)}
          <div className="tree-items">
            {n.unverified && (
              <div className="notice">
                <b>근거 확인 필요</b>
                <p>이 설명과 연결할 코드 위치를 찾지 못했습니다. 확정된 동작으로 읽지 말고 직접 확인하세요.</p>
                <button className="btn-ghost" onClick={stop(() => onCopy(rerunCommand(data.pr)))}>{copied ? '복사했습니다' : `다시 분석 명령 복사: ${rerunCommand(data.pr)}`}</button>
              </div>
            )}
            {n.affectedBy && (
              <div className="affected-by">
                <span>◐ 영향 원인</span>
                <span>{n.affectedBy.text}</span>
              </div>
            )}
            {items.map(({ ev, i, label }) => (
              <EvidenceCard
                key={i}
                data={data}
                ev={ev}
                label={label}
                cardKey={`${row.key}:${i}`}
                ownerId={file.id}
                open={openEvidence.includes(i)}
                onToggle={() => onToggleEvidence(i)}
                onShowOnMap={onShowOnMap}
                comments={comments}
              />
            ))}
            {limit < evidence.length && <button className="tree-more" onClick={stop(() => setShowAll(true))}>나머지 {evidence.length - limit}개 더 보기</button>}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props extends CommentProps {
  data: ViewerMapData;
  file: ViewerFile | null;
  width: number;
  panelRef: RefObject<HTMLDivElement>;
  reviewed: boolean;
  openRows: string[];
  currentRow: string | null;
  openEvidence: Record<string, number[]>;
  order: { file: ViewerFile; why: string }[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onToggleReviewed: () => void;
  onToggleRow: (key: string) => void;
  onToggleEvidence: (key: string, i: number) => void;
  onShowOnMap: (fileId: string) => void;
  onCopy: (text: string) => void;
  copied: boolean;
}

export function FilePanel(p: Props) {
  const { data, file: f } = p;
  const comments: CommentProps = {
    drafts: p.drafts,
    composer: p.composer,
    onCompose: p.onCompose,
    onComposerText: p.onComposerText,
    onComposerCancel: p.onComposerCancel,
    onDraftSave: p.onDraftSave,
    onDraftDelete: p.onDraftDelete,
  };
  return (
    <aside className="panel" style={{ width: p.width }}>
      <div ref={p.panelRef} className="panel-body">
        {!f && (
          <>
            <div className="panel-empty">
              <b>파일을 고르세요</b>
              <p>박스를 누르면 연결된 파일만 남고, 여기서 동작 트리를 봅니다. 포인터만 올리면 연결선을 잠깐 보여줍니다.</p>
              <p className="panel-hint">근거의 줄 위치는 커밋에서 검증했습니다. 설명의 의미는 자동 검증 대상이 아닙니다.</p>
            </div>
            <div className="order">
              <span className="section-label">읽는 순서</span>
              {p.order.map(({ file, why }, i) => (
                <button key={file.id} className="order-item" onClick={stop(() => p.onSelect(file.id))}>
                  <span className="order-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="order-name">{file.name}</span>
                  <span />
                  <span className="order-why">{why}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {f && <SelectedFile {...p} file={f} comments={comments} />}
      </div>
    </aside>
  );
}

function SelectedFile(p: Props & { file: ViewerFile; comments: CommentProps }) {
  const { data, file: f, comments } = p;
  const rows = flattenTree(f.id, f.tree);
  const status = STATUS[f.status];
  const borderStyle = isDashed(f) ? 'dashed' : 'solid';
  const tested = rows.filter((r) => r.node.tests?.length).length;
  const changed = rows.filter((r) => r.node.change !== 'unchanged').length;
  const name = (id: string) => data.files.find((x) => x.id === id)?.name ?? id;
  const links = [
    ...data.edges.filter((e) => e.from === f.id).map((e) => ({ dir: '→', id: e.to, edge: e })),
    ...data.edges.filter((e) => e.to === f.id).map((e) => ({ dir: '←', id: e.from, edge: e })),
  ];
  const note = replacementNote(f);
  return (
    <>
      <div className="file-info">
        <div className="file-actions">
          <span className="box-tag" style={{ borderStyle, borderColor: status.color, color: status.color }}>{status.label}</span>
          {f.additions > 0 && <span className="file-stat" style={{ color: 'var(--add)' }}>+{f.additions}</span>}
          {f.deletions > 0 && <span className="file-stat" style={{ color: 'var(--del)' }}>−{f.deletions}</span>}
          <span className="spacer" />
          <button className="file-btn" style={{ background: p.reviewed ? 'var(--accent-bg-2)' : 'transparent', borderColor: p.reviewed ? 'var(--accent)' : 'var(--line)' }} onClick={stop(p.onToggleReviewed)}>
            {p.reviewed ? '✓ 확인함' : '확인함으로 표시'} <kbd>x</kbd>
          </button>
          <button className="file-btn" onClick={stop(p.onClose)}>닫기 <kbd>Esc</kbd></button>
        </div>
        <span className="file-name" style={{ textDecoration: f.status === 'deleted' ? 'line-through' : 'none' }}>{f.name}</span>
        <span className="file-path">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
        <span className="file-role">{f.role}</span>
        {note && <span className="file-note">{note}</span>}
        {f.status === 'deleted' && <span className="file-note">{f.callers} · base {data.pr.base.slice(0, 7)} 기준</span>}
        {tested > 0 && <span className="file-note">테스트로 확인된 분기 {tested} / 변경 분기 {changed}</span>}
      </div>
      <div className="links">
        <span className="section-label">연결 {links.length}</span>
        {links.map(({ dir, id, edge }, i) => (
          <button key={i} className="link" onClick={stop(() => p.onSelect(id))}>
            <span className="link-dir">{dir}</span>
            <span className="link-name">{name(id)}</span>
            <span />
            <span className="link-label">{edge.label}{edge.unverified ? ' · 확인 필요' : ''}</span>
          </button>
        ))}
        {!links.length && <span className="links-empty">연결된 파일 없음</span>}
      </div>
      <div className="tree">
        <div className="tree-head">
          <span>동작 트리</span>
          <span className="spacer" />
          <span>j k 이동</span><span>Enter 근거</span><span>n p 파일</span><span>x 확인함</span><span>u 확인 필요</span>
        </div>
        {!rows.length && <div className="tree-empty">{f.status === 'renamed' ? '동작 변경 없음 · 이름만 바뀜' : '설명할 동작 없음'}</div>}
        {rows.map((r) => (
          <TreeRowView
            key={r.key}
            data={data}
            file={f}
            row={r}
            open={p.openRows.includes(r.key)}
            current={p.currentRow === r.key}
            openEvidence={p.openEvidence[r.key] ?? [0]}
            onToggleRow={() => p.onToggleRow(r.key)}
            onToggleEvidence={(i) => p.onToggleEvidence(r.key, i)}
            onShowOnMap={p.onShowOnMap}
            onCopy={p.onCopy}
            copied={p.copied}
            comments={comments}
          />
        ))}
      </div>
    </>
  );
}
