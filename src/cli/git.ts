import { execFileSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;

export class CliError extends Error {}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  input?: string,
): string {
  return execFileSync(cmd, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function git(cwd: string, ...args: string[]): string {
  return run("git", args, cwd);
}

export function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  const root = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (!root)
    throw new CliError("Git 저장소가 아닙니다. 저장소 안에서 실행하세요.");
  return root.trim();
}

export function parseGithubRemote(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

export function originRepo(root: string): string {
  const url = tryGit(root, "remote", "get-url", "origin");
  if (!url)
    throw new CliError(
      "origin 원격이 없습니다. GitHub 저장소를 origin으로 연결하세요.",
    );
  const repo = parseGithubRemote(url);
  if (!repo)
    throw new CliError(`origin이 GitHub 저장소가 아닙니다: ${url.trim()}`);
  return repo;
}
