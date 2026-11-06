import type { ChangedFile, CodeRow } from "../shared/types";
import { parseUnifiedDiff } from "./code";
import { tryGit } from "./git";

/** 큰 파일 하나가 분석 입력을 차지하지 않게 파일당 줄 수와 줄 길이를 제한한다. */
const MAX_ROWS_PER_FILE = 400;
const MAX_LINE_CHARS = 240;

const HEADER = `# 변경 내용. 열 순서: head 줄 번호, base 줄 번호, 변경 기호, 코드.
# +는 head에만, -는 base에만 있는 줄이다. 없는 쪽 줄 번호는 . 으로 표시한다. …는 사이 코드를 생략한 자리다.
`;

/** 줄 번호를 붙인 diff 행을 근거로 바로 쓸 수 있는 텍스트로 만든다. */
export function formatDiffRows(rows: CodeRow[]): string {
  const lines: string[] = [];
  let lastHead = 0;
  let lastBase = 0;
  for (const row of rows.slice(0, MAX_ROWS_PER_FILE)) {
    const jumped =
      (row.n > 0 && lastHead > 0 && row.n !== lastHead + 1) ||
      (row.o > 0 && lastBase > 0 && row.o !== lastBase + 1);
    if (jumped) lines.push("…");
    if (row.n > 0) lastHead = row.n;
    if (row.o > 0) lastBase = row.o;
    const text =
      row.t.length > MAX_LINE_CHARS
        ? `${row.t.slice(0, MAX_LINE_CHARS)}…`
        : row.t;
    lines.push(`${row.n || "."} ${row.o || "."} ${row.d} ${text}`.trimEnd());
  }
  const omitted = rows.length - MAX_ROWS_PER_FILE;
  if (omitted > 0)
    lines.push(`… ${omitted}줄 생략. 필요하면 git diff로 이 파일만 읽는다.`);
  return lines.join("\n");
}

function fileDiff(
  root: string,
  base: string,
  head: string,
  file: ChangedFile,
): string {
  const title = `## ${file.path}${file.oldPath ? ` (이전 경로 ${file.oldPath})` : ""} · ${file.status} +${file.additions} -${file.deletions}`;
  if (file.binary) return `${title}\n바이너리 파일이라 내용을 싣지 않았다.`;
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const diff = tryGit(root, "diff", "-M", "-U3", base, head, "--", ...paths);
  if (diff === null) return `${title}\n변경 내용을 읽지 못했다. git diff로 읽는다.`;
  return `${title}\n${formatDiffRows(parseUnifiedDiff(diff))}`;
}

export function buildDiffText(
  root: string,
  base: string,
  head: string,
  files: ChangedFile[],
): string {
  return `${HEADER}\n${files.map((f) => fileDiff(root, base, head, f)).join("\n\n")}\n`;
}
