import type { ChangedFile, CodeRow } from "../shared/types";
import { parseUnifiedDiff } from "./code";
import { tryGit } from "./git";

/** 큰 파일 하나가 분석 입력을 차지하지 않게 파일당 줄 수와 줄 길이를 제한한다. */
const MAX_ROWS_PER_FILE = 400;
const MAX_LINE_CHARS = 240;

const HEADER = `# 변경 내용. 열 순서: head 줄 번호, base 줄 번호, 변경 기호, 코드.
# +는 head에만, -는 base에만 있는 줄이다. 없는 쪽 줄 번호는 . 으로 표시한다. …는 사이 코드를 생략한 자리다.
# 테스트 파일은 본문 대신 테스트 선언과 그 안에서 추가된 줄 범위(head 줄 번호)만 싣는다. 선언 줄 번호 뒤의 +는 이번에 새로 생긴 테스트다. 본문이 필요하면 git show <head>:<경로>로 그 범위만 읽는다.
`;

/** 테스트 선언으로 보이는 줄. 테스트 연결은 이름과 줄 범위만 있으면 대부분 지을 수 있다. */
const TEST_DECL =
  /\b(?:it|test|describe|context|specify)(?:\.\w+)*\s*\(|\bdef\s+test_?\w*|\bfunc\s+Test\w*|@(?:Test|ParameterizedTest)\b|#\[(?:\w+::)?test\]/;

const clip = (text: string) =>
  text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;

/**
 * 바뀐 테스트 파일을 "테스트 선언 + 그 안에서 추가된 줄 범위" 목록으로 줄인다.
 * 테스트 본문은 지도에 넣지 않고 분기에 연결만 하므로, 전체 diff를 실으면 입력만 커진다.
 * rows는 파일 전체가 담긴 diff여야 한다. 그래야 바뀐 줄을 감싼 선언을 찾을 수 있다.
 */
export function formatTestOutline(rows: CodeRow[]): string {
  interface Group {
    decl: CodeRow | null;
    ranges: [number, number][];
  }
  const groups: Group[] = [];
  let current: Group = { decl: null, ranges: [] };
  groups.push(current);
  const kept = rows.filter((r) => r.d !== "-");
  for (const [i, row] of kept.entries()) {
    if (TEST_DECL.test(row.t)) {
      // `test(` 다음 줄에 이름을 쓴 선언은 이름 줄까지 붙여 보여 준다.
      const next = /\(\s*$/.test(row.t) ? kept[i + 1] : undefined;
      const decl = next
        ? { ...row, t: `${row.t.trim()} ${next.t.trim()}` }
        : row;
      current = { decl, ranges: [] };
      groups.push(current);
    }
    if (row.d !== "+") continue;
    const last = current.ranges[current.ranges.length - 1];
    if (last && last[1] === row.n - 1) last[1] = row.n;
    else current.ranges.push([row.n, row.n]);
  }
  const lines = groups
    .filter((g) => g.ranges.length)
    .map((g) => {
      const ranges = g.ranges
        .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
        .join(", ");
      const head = g.decl
        ? `${g.decl.n} ${g.decl.d === "+" ? "+" : " "} ${clip(g.decl.t.trim())}`
        : "(테스트 선언 밖)";
      return `${head}\n  추가된 줄: ${ranges}`;
    });
  if (!lines.length) return "추가된 줄이 없다. 연결할 테스트가 없다.";
  const omitted = lines.length - MAX_ROWS_PER_FILE;
  return omitted > 0
    ? `${lines.slice(0, MAX_ROWS_PER_FILE).join("\n")}\n… ${omitted}개 생략.`
    : lines.join("\n");
}

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
  outline: boolean,
): string {
  const title = `## ${file.path}${file.oldPath ? ` (이전 경로 ${file.oldPath})` : ""} · ${file.status} +${file.additions} -${file.deletions}`;
  if (file.binary) return `${title}\n바이너리 파일이라 내용을 싣지 않았다.`;
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  // 테스트는 바뀐 줄을 감싼 선언을 찾아야 해서 파일 전체를 문맥으로 받는다.
  const context = outline ? "--unified=1000000" : "-U3";
  const diff = tryGit(root, "diff", "-M", context, base, head, "--", ...paths);
  if (diff === null)
    return `${title}\n변경 내용을 읽지 못했다. git diff로 읽는다.`;
  const rows = parseUnifiedDiff(diff);
  return `${title}\n${outline ? formatTestOutline(rows) : formatDiffRows(rows)}`;
}

export function buildDiffText(
  root: string,
  base: string,
  head: string,
  files: ChangedFile[],
  tests: ChangedFile[] = [],
): string {
  const parts = [
    ...files.map((f) => fileDiff(root, base, head, f, false)),
    ...tests.map((f) => fileDiff(root, base, head, f, true)),
  ];
  return `${HEADER}\n${parts.join("\n\n")}\n`;
}
