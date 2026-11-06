import type {
  Evidence,
  TreeNode,
  ViewerFile,
  ViewerMapData,
} from "../shared/types";

export const lineKey = (fileId: string, nodeId: string) =>
  `${fileId}:${nodeId}`;

/** 패널에 보여주는 근거. 테스트는 head 코드라 같은 형식으로 다룬다. */
export type PanelEvidence = Evidence & { test?: true };

/** 영향 노드는 자신의 근거 뒤에 원인이 된 변경 줄을 잇는다. */
export const nodeEvidence = (n: TreeNode): Evidence[] => [
  ...n.evidence,
  ...(n.affectedBy?.evidence ?? []),
];

export const nodeTests = (n: TreeNode): PanelEvidence[] =>
  (n.tests ?? []).map((t) => ({ ...t, side: "head", test: true }));

/** 근거 경로로 지도의 파일을 찾는다. 이름 변경 파일은 base 근거가 이전 경로를 쓴다. */
export function fileOfEvidence(
  data: ViewerMapData,
  ev: Evidence,
): ViewerFile | undefined {
  return data.files.find((f) => f.path === ev.path || f.oldPath === ev.path);
}

export function githubHref(data: ViewerMapData, ev: Evidence): string {
  const sha = ev.side === "base" ? data.pr.base : data.pr.head;
  const path = ev.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${data.pr.repo}/blob/${sha}/${path}#L${ev.start}${ev.end !== ev.start ? `-L${ev.end}` : ""}`;
}

export const lineRange = (ev: Pick<Evidence, "start" | "end">) =>
  `L${ev.start}${ev.end !== ev.start ? `–${ev.end}` : ""}`;

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export const evidenceWhere = (ev: Evidence) =>
  `${baseName(ev.path)} ${lineRange(ev)}${ev.side === "base" ? " · base" : ""}`;

export function evidenceSummary(
  data: ViewerMapData,
  owner: ViewerFile,
  n: TreeNode,
): string {
  const evs = nodeEvidence(n);
  if (!evs.length) return "확인 필요";
  if (evs.length === 1) {
    const ev = evs[0]!;
    const target = fileOfEvidence(data, ev);
    return target?.id === owner.id
      ? lineRange(ev)
      : `↗ ${baseName(ev.path).replace(/\.[a-z]+$/, "")} ${lineRange(ev)}`;
  }
  const files = new Set(evs.map((v) => v.path)).size;
  return `근거 ${evs.length}${files > 1 ? ` · 파일 ${files}` : ""}`;
}

export function rerunCommand(pr: { number: number | null }): string {
  return pr.number ? `/pr-map ${pr.number}` : "/pr-map";
}

/**
 * 로컬 파일로 열면 내 PC에 오래 남겨도 된다. 웹에서는 artifact가 다른 저장소의 HTML과
 * 같은 주소를 공유할 수 있어, 다른 페이지가 읽지 못하는 탭 단위 저장소만 쓴다.
 */
export const keepsAcrossTabs = (protocol: string) => protocol === "file:";

export function draftsText(drafts: { where: string; text: string }[]): string {
  return drafts.map((d) => `${d.where}: ${d.text}`).join("\n\n");
}

export function storageKey(
  kind: "reviewed" | "drafts",
  data: ViewerMapData,
): string {
  return `prmap.${kind}.v1:${data.pr.repo}#${data.pr.number ?? data.pr.headRef}`;
}
