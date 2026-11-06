import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CliError, git } from "./git";
import { outDir } from "./paths";

const EXCLUDE_LINE = ".pr-map/";

function removeOutput(root: string): boolean {
  const dir = outDir(root);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return false;
  // 저장소에 커밋된 파일은 생성물이 아니므로 지우지 않는다.
  if (git(root, "ls-files", "--", EXCLUDE_LINE).trim()) {
    throw new CliError(
      ".pr-map/에 git이 추적하는 파일이 있어 지우지 않았습니다. 먼저 git rm으로 정리하세요.",
    );
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function removeExcludeLine(root: string): boolean {
  const rel = git(root, "rev-parse", "--git-path", "info/exclude").trim();
  const file = path.resolve(root, rel);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((line) => line !== EXCLUDE_LINE);
  if (kept.length === lines.length) return false;
  writeFileSync(file, kept.join("\n"));
  return true;
}

/** collect가 이 클론에 남긴 분석 결과와 exclude 줄을 지운다. */
export function cmdClean(root: string): void {
  const output = removeOutput(root);
  const exclude = removeExcludeLine(root);
  console.log(output ? ".pr-map/을 지웠습니다." : ".pr-map/이 없습니다.");
  console.log(
    exclude
      ? ".git/info/exclude에서 .pr-map/ 줄을 지웠습니다."
      : ".git/info/exclude에 지울 줄이 없습니다.",
  );
  console.log(
    "스킬, 자동 실행 워크플로, PR 댓글은 그대로 있습니다. 지우는 방법은 README의 제거 절차를 보세요.",
  );
}
