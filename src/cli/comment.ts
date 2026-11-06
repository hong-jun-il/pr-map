import type {
  Evidence,
  TreeNode,
  ViewerFile,
  ViewerMapData,
} from "../shared/types";

export const COMMENT_MARKER = "<!-- pr-map -->";
/** GitHub 댓글 본문 한도(65,536자)보다 여유 있게 잡는다. */
const MAX_COMMENT = 60000;

const STATUS_LABEL: Record<ViewerFile["status"], string> = {
  added: "추가",
  modified: "수정",
  deleted: "삭제",
  renamed: "이름 변경",
  reference: "참고",
};

/** AI가 쓴 글이 HTML·멘션·이슈 링크로 해석되지 않게 막는다. */
export function escapeMd(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/#(?=\d)/g, "&#35;")
    .replace(/([\\`*_[\]~|])/g, "\\$1");
}

export function mermaidLabel(text: string): string {
  return text
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\n/g, " ");
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function permalink(
  repo: string,
  sha: string,
  ev: Pick<Evidence, "path" | "start" | "end">,
): string {
  const range =
    ev.end !== ev.start ? `#L${ev.start}-L${ev.end}` : `#L${ev.start}`;
  return `https://github.com/${repo}/blob/${sha}/${encodePath(ev.path)}${range}`;
}

function counts(f: ViewerFile): string {
  const parts = [
    f.additions ? `+${f.additions}` : "",
    f.deletions ? `−${f.deletions}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "변경 없음";
}

export function buildMermaid(data: ViewerMapData): string {
  const ids = new Map(data.files.map((f, i) => [f.id, `n${i}`]));
  const lines = ["flowchart LR"];
  for (const f of data.files) {
    lines.push(
      `  ${ids.get(f.id)}["${mermaidLabel(f.name)}<br/>${STATUS_LABEL[f.status]} ${mermaidLabel(counts(f))}"]`,
    );
  }
  for (const e of data.edges) {
    const to = data.files.find((f) => f.id === e.to);
    const dashed =
      e.kind === "replacedBy" || e.unverified || to?.status === "reference";
    const label = mermaidLabel(
      e.unverified ? `${e.label} (확인 필요)` : e.label,
    );
    lines.push(
      `  ${ids.get(e.from)} ${dashed ? "-.->" : "-->"}|"${label}"| ${ids.get(e.to)}`,
    );
  }
  const dashedFiles = data.files.filter(
    (f) => f.status === "reference" || f.status === "deleted",
  );
  if (dashedFiles.length) {
    lines.push("  classDef dashed stroke-dasharray: 4 3");
    lines.push(
      `  class ${dashedFiles.map((f) => ids.get(f.id)).join(",")} dashed`,
    );
  }
  return lines.join("\n");
}

function shortName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
}

function nodeLines(
  n: TreeNode,
  depth: number,
  file: ViewerFile,
  data: ViewerMapData,
  out: string[],
): void {
  const text =
    n.change === "deleted" && file.status !== "deleted"
      ? `~~${escapeMd(n.text)}~~`
      : escapeMd(n.text);
  const links = n.evidence.map((ev) => {
    const sha = ev.side === "base" ? data.pr.base : data.pr.head;
    const range =
      ev.end !== ev.start ? `L${ev.start}–${ev.end}` : `L${ev.start}`;
    const label =
      ev.path === file.path ? range : `${shortName(ev.path)} ${range}`;
    return `[${ev.side === "base" ? "base " : ""}${label}](${permalink(data.pr.repo, sha, ev)})`;
  });
  const parts = [depth === 0 ? `**${text}**` : text, ...links];
  if (n.unverified) parts.push("_근거 확인 필요_");
  out.push(`${"  ".repeat(depth)}- ${parts.join(" ")}`);
  n.children?.forEach((c) => nodeLines(c, depth + 1, file, data, out));
}

function fileSection(
  f: ViewerFile,
  open: boolean,
  data: ViewerMapData,
  withTree: boolean,
): string {
  const lines: string[] = [];
  const name = f.name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  lines.push(`<details${open ? " open" : ""}>`);
  lines.push(
    `<summary><code>${name}</code> · ${STATUS_LABEL[f.status]} ${counts(f)}</summary>`,
    "",
  );
  if (f.status === "deleted") {
    lines.push(
      f.replacedByNames.length
        ? `대체 → ${f.replacedByNames.map(escapeMd).join(", ")}`
        : "대체 없음 · 기능 제거",
      "",
    );
  }
  if (withTree) f.tree.forEach((n) => nodeLines(n, 0, f, data, lines));
  else
    lines.push("_댓글 길이 제한으로 생략했습니다. 전체 지도에서 확인하세요._");
  lines.push("", "</details>");
  return lines.join("\n");
}

/** 전체 지도를 여는 방법. Actions 실행이면 결과가 리뷰어의 PC에 없으므로 artifact로 안내한다. */
function viewerHint(runUrl?: string): string {
  return runUrl
    ? `전체 지도는 [실행 페이지](${runUrl})에서 \`pr-map-viewer\` artifact를 받아 압축을 풀고 \`index.html\`로 엽니다. artifact는 14일 동안 보관됩니다.`
    : "전체 지도는 체크아웃 후 `/pr-map view`로 엽니다.";
}

export function buildComment(data: ViewerMapData, runUrl?: string): string {
  const { pr, counts: c } = data;
  const changed = data.files.filter((f) => f.status !== "reference").length;
  const refs = data.files.length - changed;
  const head = pr.head.slice(0, 7);
  const firstWithTree = data.files.findIndex((f) => f.tree.length > 0);

  const compose = (treeCount: number): string => {
    let shown = 0;
    const sections = data.files.map((f, i) => {
      const withTree = shown < treeCount;
      if (withTree) shown++;
      return fileSection(f, i === firstWithTree, data, withTree);
    });
    const footer = [
      `근거 확인 필요 ${c.unverified}건 · 분석 커밋 \`${head}\` · 미분류 ${c.unclassified}개`,
      "",
      `<sub>${viewerHint(runUrl)} 근거 줄 위치는 커밋에서 검증했지만, 설명의 의미는 자동 검증 대상이 아닙니다. 이 댓글은 분석을 다시 게시할 때 갱신됩니다.</sub>`,
    ];
    return [
      COMMENT_MARKER,
      "## PR Map",
      "",
      `${escapeMd(pr.summary)} 변경 파일 ${changed}개와 참고 파일 ${refs}개가 아래처럼 연결됩니다.`,
      "",
      "```mermaid",
      buildMermaid(data),
      "```",
      "",
      ...sections,
      "",
      ...footer,
      "",
    ].join("\n");
  };

  // 길면 뒤쪽 파일부터 트리를 생략한다.
  for (let n = data.files.length; n >= 0; n--) {
    const body = compose(n);
    if (body.length <= MAX_COMMENT) return body;
  }
  return [
    COMMENT_MARKER,
    "## PR Map",
    "",
    escapeMd(pr.summary),
    "",
    `분석 커밋 \`${head}\`. 결과가 너무 길어 전체 지도에서만 볼 수 있습니다. ${viewerHint(runUrl)}`,
    "",
  ].join("\n");
}
