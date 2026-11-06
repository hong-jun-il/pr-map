import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "./git";

declare const __PR_MAP_VERSION__: string;

const REPO = "hong-jun-il/pr-map";
const REPO_URL = `https://github.com/${REPO}.git`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 5000;

interface UpdateCache {
  checkedAt: number;
  latest: string | null;
}

/** 번들 위치: <skill>/scripts/pr-map.js */
const skillDir = () => path.join(__dirname, "..");

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "pr-map", "update-check.json");
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** `git ls-remote --tags` 출력에서 가장 높은 vX.Y.Z를 고른다. 액션용 v1 같은 태그는 건너뛴다. */
export function latestFromTags(output: string): string | null {
  let latest: string | null = null;
  for (const line of output.split("\n")) {
    const version = /\trefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line)?.[1];
    if (version && (!latest || compareVersions(version, latest) > 0))
      latest = version;
  }
  return latest;
}

function fetchLatest(): string | null {
  const output = execFileSync("git", ["ls-remote", "--tags", REPO_URL], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return latestFromTags(output);
}

/** 하루 한 번 새 버전을 확인한다. 어떤 실패도 분석을 막지 않는다. */
export function refreshUpdateCache(now = Date.now()): void {
  if (process.env.CI || process.env.PR_MAP_NO_UPDATE_CHECK) return;
  const cache = readCache();
  if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) return;
  let latest = cache?.latest ?? null;
  try {
    latest = fetchLatest();
  } catch {
    // 오프라인이면 이전 결과를 유지하고 다음 날 다시 확인한다.
  }
  try {
    const file = cachePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ checkedAt: now, latest }));
  } catch {
    // 저장하지 못해도 분석에는 영향이 없다.
  }
}

export function printUpdateNotice(): void {
  if (process.env.CI || process.env.PR_MAP_NO_UPDATE_CHECK) return;
  const latest = readCache()?.latest;
  if (latest && compareVersions(latest, __PR_MAP_VERSION__) > 0) {
    console.log(
      `새 버전이 있습니다: ${__PR_MAP_VERSION__} → ${latest}. 업데이트하려면 /pr-map update를 실행하세요.`,
    );
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function isTrackedByGit(dir: string): boolean {
  try {
    git(dir, "ls-files", "--error-unmatch", "SKILL.md");
    return true;
  } catch {
    return false;
  }
}

/** 태그의 스킬 폴더로 교체한다. 내려받은 코드는 실행하지 않고, 실패하면 원래 폴더를 되돌린다. */
function apply(version: string): void {
  const target = skillDir();
  if (isTrackedByGit(target)) {
    throw new CliError(
      `${target}은 Git으로 관리되는 폴더라 교체하지 않았습니다. 그 저장소에서 변경해 커밋하세요.`,
    );
  }
  const temp = mkdtempSync(path.join(tmpdir(), "pr-map-update-"));
  const parent = path.dirname(target);
  const incoming = `${target}.new-${process.pid}`;
  const backup = `${target}.old-${process.pid}`;
  try {
    try {
      git(temp, "clone", "-q", "--depth", "1", "--branch", `v${version}`, REPO_URL, "src");
    } catch (err) {
      throw new CliError(
        `v${version}을 내려받지 못했습니다.\n${(err as { stderr?: Buffer }).stderr?.toString().trim() ?? ""}`.trim(),
      );
    }
    const source = path.join(temp, "src", "skill", "pr-map");
    for (const file of ["SKILL.md", "scripts/pr-map.js"]) {
      if (!existsSync(path.join(source, file)))
        throw new CliError(`v${version}에 ${file}이 없어 교체하지 않았습니다.`);
    }
    cpSync(source, incoming, { recursive: true });
    renameSync(target, backup);
    try {
      renameSync(incoming, target);
    } catch (err) {
      renameSync(backup, target);
      throw new CliError(`${parent}에 설치하지 못해 원래 버전을 유지합니다: ${(err as Error).message}`);
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(incoming, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`${version}으로 업데이트했습니다: ${target}`);
  console.log("새 세션부터 적용됩니다.");
}

export function cmdUpdate(opts: { apply: boolean }): number {
  let latest: string | null;
  try {
    latest = fetchLatest();
  } catch {
    throw new CliError("최신 버전을 확인하지 못했습니다. 네트워크를 확인하세요.");
  }
  console.log(`설치 버전: ${__PR_MAP_VERSION__}`);
  console.log(`설치 위치: ${skillDir()}`);
  if (!latest) {
    console.log("배포된 버전이 아직 없습니다.");
    return 0;
  }
  console.log(`최신 버전: ${latest}`);
  if (compareVersions(latest, __PR_MAP_VERSION__) <= 0) {
    console.log("이미 최신 버전입니다.");
    return 0;
  }
  if (!opts.apply) {
    console.log(`변경 내용: https://github.com/${REPO}/tree/v${latest}`);
    console.log("적용하려면 update --apply를 실행하세요.");
    return 0;
  }
  apply(latest);
  return 0;
}
