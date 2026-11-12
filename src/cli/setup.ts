import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetsDir } from "./build";
import { CliError, git, originRepo, run, tryGit } from "./git";

const ACTION_REPO = "hong-jun-il/pr-map";
const ACTION_TAG = "v1";
const WORKFLOW_PATH = ".github/workflows/pr-map.yml";
const SETUP_BRANCH = "pr-map/setup";

export const PROVIDERS = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
} as const;
export type Provider = keyof typeof PROVIDERS;

type GhState = "ready" | "unauthenticated" | "missing";
type ActionState = "published" | "missing" | "unknown";
type WorkflowState = "current" | "different" | "missing";
type SecretState = "registered" | "missing" | "unknown";

export interface SetupOptions {
  install: boolean;
  force: boolean;
  secretFromEnv: boolean;
  provider: Provider;
}

function stderrOf(err: unknown): string {
  return (err as { stderr?: string }).stderr?.trim() ?? "";
}

function ghState(root: string): GhState {
  try {
    run("gh", ["--version"], root);
  } catch {
    return "missing";
  }
  try {
    run("gh", ["auth", "status", "--hostname", "github.com"], root);
    return "ready";
  } catch {
    return "unauthenticated";
  }
}

function actionState(root: string): ActionState {
  const out = tryGit(
    root,
    "ls-remote",
    "--tags",
    `https://github.com/${ACTION_REPO}.git`,
    `refs/tags/${ACTION_TAG}`,
  );
  if (out === null) return "unknown";
  return out.trim() ? "published" : "missing";
}

function defaultBranch(root: string): string {
  const out = tryGit(root, "ls-remote", "--symref", "origin", "HEAD");
  const branch = out && /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1];
  if (!branch)
    throw new CliError(
      "origin의 기본 브랜치를 확인하지 못했습니다. 저장소 접근 권한과 첫 커밋 여부를 확인하세요.",
    );
  return branch;
}

function fetchBranch(root: string, branch: string): string {
  try {
    git(root, "fetch", "-q", "--no-tags", "origin", `refs/heads/${branch}`);
  } catch (err) {
    throw new CliError(
      `origin/${branch}을(를) 가져오지 못했습니다.\n${stderrOf(err)}`.trim(),
    );
  }
  return git(root, "rev-parse", "FETCH_HEAD").trim();
}

function workflowTemplate(provider: Provider): string {
  return readFileSync(path.join(assetsDir(), "pr-map.yml"), "utf8")
    .replace("provider: claude", `provider: ${provider}`)
    .replace("secrets.ANTHROPIC_API_KEY", `secrets.${PROVIDERS[provider]}`);
}

function workflowState(
  root: string,
  commit: string,
  provider: Provider,
): WorkflowState {
  const existing = tryGit(root, "show", `${commit}:${WORKFLOW_PATH}`);
  if (existing === null) return "missing";
  return existing === workflowTemplate(provider) ? "current" : "different";
}

function secretState(
  root: string,
  repo: string,
  gh: GhState,
  secretName: string,
): SecretState {
  if (gh !== "ready") return "unknown";
  try {
    const names = run(
      "gh",
      ["secret", "list", "--repo", repo, "--json", "name", "--jq", ".[].name"],
      root,
    );
    return names.split("\n").includes(secretName) ? "registered" : "missing";
  } catch {
    return "unknown";
  }
}

function secretUrl(repo: string): string {
  return `https://github.com/${repo}/settings/secrets/actions/new`;
}

function compareUrl(repo: string, base: string): string {
  return `https://github.com/${repo}/compare/${base}...${SETUP_BRANCH}?expand=1`;
}

function actionProblem(state: ActionState): string | null {
  if (state === "published") return null;
  const action = `${ACTION_REPO}@${ACTION_TAG}`;
  if (state === "missing")
    return `${action} 태그가 아직 없습니다. 지금 설치하면 PR마다 워크플로가 실패합니다.`;
  return `${action}을(를) 확인하지 못했습니다. 저장소가 비공개이거나 네트워크 문제일 수 있습니다.`;
}

function showStatus(root: string, provider: Provider): void {
  const secretName = PROVIDERS[provider];
  const repo = originRepo(root);
  const base = defaultBranch(root);
  const workflow = workflowState(root, fetchBranch(root, base), provider);
  const action = actionState(root);
  const gh = ghState(root);
  const secret = secretState(root, repo, gh, secretName);
  const hasEnvKey = !!process.env[secretName]?.trim();

  const labels = {
    action: { published: "게시됨", missing: "태그 없음", unknown: "확인 불가" },
    workflow: { current: "설치됨", different: "내용이 다름", missing: "없음" },
    gh: {
      ready: "사용 가능",
      unauthenticated: "로그인 필요",
      missing: "설치 안 됨",
    },
    secret: { registered: "등록됨", missing: "없음", unknown: "확인 불가" },
  };
  console.log(`저장소: ${repo} (기본 브랜치 ${base})`);
  console.log(`공급자: ${provider}`);
  console.log(`액션 ${ACTION_REPO}@${ACTION_TAG}: ${labels.action[action]}`);
  console.log(`워크플로 ${WORKFLOW_PATH}: ${labels.workflow[workflow]}`);
  console.log(`gh: ${labels.gh[gh]}`);
  console.log(`환경변수 ${secretName}: ${hasEnvKey ? "있음" : "없음"}`);
  console.log(`시크릿 ${secretName}: ${labels.secret[secret]}`);

  const steps: string[] = [];
  const problem = actionProblem(action);
  if (problem) steps.push(`설치 불가: ${problem}`);
  else if (workflow === "missing")
    steps.push(
      `워크플로 설치 PR 만들기: setup --install --provider ${provider}`,
    );
  else if (workflow === "different")
    steps.push(
      `기존 워크플로를 덮어쓸지 사용자에게 확인: setup --install --force --provider ${provider}`,
    );
  if (secret !== "registered") {
    if (gh === "ready" && hasEnvKey)
      steps.push(
        `시크릿 등록(사용자 동의 필요): setup --secret-from-env --provider ${provider}`,
      );
    else if (gh === "ready")
      steps.push(
        `시크릿 등록(사용자 터미널에서): gh secret set ${secretName} --repo ${repo}`,
      );
    else steps.push(`시크릿 등록(웹): ${secretUrl(repo)}`);
  }
  console.log(
    steps.length
      ? `다음 단계:\n${steps.map((s) => `- ${s}`).join("\n")}`
      : "설치가 끝났습니다.",
  );
}

/** 사용자의 체크아웃을 건드리지 않도록 임시 worktree에서 커밋해 올린다. */
function pushWorkflowBranch(
  root: string,
  commit: string,
  provider: Provider,
): void {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-map-setup-"));
  try {
    git(root, "worktree", "add", "-q", "--detach", dir, commit);
    const file = path.join(dir, WORKFLOW_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, workflowTemplate(provider));
    git(dir, "add", WORKFLOW_PATH);
    // 임시 worktree에는 node_modules가 없어 저장소의 훅이 실패할 수 있다. 내용은 PR에서 검토한다.
    git(
      dir,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      "PR Map 자동 실행 워크플로 추가",
    );
    git(
      dir,
      "push",
      "-q",
      "--no-verify",
      "origin",
      `HEAD:refs/heads/${SETUP_BRANCH}`,
    );
  } catch (err) {
    throw new CliError(
      `설치 브랜치를 올리지 못했습니다.\n${stderrOf(err)}`.trim(),
    );
  } finally {
    tryGit(root, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function openInstallPr(
  root: string,
  repo: string,
  base: string,
  secretName: string,
): void {
  const manual = () =>
    console.log(`이 링크에서 PR을 만드세요: ${compareUrl(repo, base)}`);
  if (ghState(root) !== "ready") {
    manual();
    return;
  }
  try {
    const existing = run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        SETUP_BRANCH,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        '.[0].url // ""',
      ],
      root,
    ).trim();
    if (existing) {
      console.log(`설치 PR이 이미 있습니다: ${existing}`);
      return;
    }
    const url = run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repo,
        "--base",
        base,
        "--head",
        SETUP_BRANCH,
        "--title",
        "PR Map 자동 실행 설치",
        "--body",
        `PR이 열리거나 갱신될 때 PR Map을 실행하는 워크플로를 추가합니다.\n\n머지 전에 저장소 시크릿 \`${secretName}\`을 등록해야 합니다.`,
      ],
      root,
    ).trim();
    console.log(`설치 PR: ${url}`);
  } catch (err) {
    console.log(`gh로 PR을 만들지 못했습니다. ${stderrOf(err)}`.trim());
    manual();
  }
}

function install(root: string, force: boolean, provider: Provider): number {
  const repo = originRepo(root);
  const problem = actionProblem(actionState(root));
  if (problem) throw new CliError(`설치하지 않았습니다. ${problem}`);

  const base = defaultBranch(root);
  const commit = fetchBranch(root, base);
  const workflow = workflowState(root, commit, provider);
  if (workflow === "current") {
    console.log(`${base} 브랜치에 워크플로가 이미 설치되어 있습니다.`);
    return 0;
  }
  if (workflow === "different" && !force) {
    throw new CliError(
      `${WORKFLOW_PATH}이 이미 있고 내용이 다릅니다. 덮어쓰려면 --force를 쓰세요.`,
    );
  }

  const branchExists = !!tryGit(
    root,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${SETUP_BRANCH}`,
  )?.trim();
  if (branchExists && force) {
    throw new CliError(
      `원격에 ${SETUP_BRANCH} 브랜치가 이미 있습니다. 내용을 확인해 지운 뒤 다시 실행하세요.`,
    );
  }
  if (branchExists)
    console.log(`원격의 ${SETUP_BRANCH} 브랜치를 그대로 사용합니다.`);
  else pushWorkflowBranch(root, commit, provider);

  openInstallPr(root, repo, base, PROVIDERS[provider]);
  return 0;
}

function registerSecretFromEnv(root: string, provider: Provider): number {
  const secretName = PROVIDERS[provider];
  const repo = originRepo(root);
  const gh = ghState(root);
  if (gh !== "ready") {
    throw new CliError(
      `gh를 사용할 수 없습니다(${gh === "missing" ? "설치 안 됨" : "로그인 필요"}). 웹에서 등록하세요: ${secretUrl(repo)}`,
    );
  }
  const key = process.env[secretName]?.trim();
  if (!key)
    throw new CliError(
      `환경변수 ${secretName}이 없습니다. 터미널에서 직접 등록하세요: gh secret set ${secretName} --repo ${repo}`,
    );
  try {
    // 표준 입력으로 넘겨 값이 명령 인자나 출력에 남지 않게 한다.
    run("gh", ["secret", "set", secretName, "--repo", repo], root, key);
  } catch (err) {
    throw new CliError(
      `시크릿을 등록하지 못했습니다. 저장소 권한을 확인하세요.\n${stderrOf(err)}`.trim(),
    );
  }
  if (secretState(root, repo, gh, secretName) !== "registered") {
    throw new CliError(
      `등록 후 ${secretName}을 확인하지 못했습니다. 저장소 설정에서 확인하세요: https://github.com/${repo}/settings/secrets/actions`,
    );
  }
  console.log(`시크릿 ${secretName} 등록 완료: ${repo}`);
  return 0;
}

export function cmdSetup(root: string, opts: SetupOptions): number {
  // 자격 증명 프롬프트에서 멈추지 않고 실패로 처리한다.
  process.env.GIT_TERMINAL_PROMPT = "0";
  if (opts.install && opts.secretFromEnv)
    throw new CliError("--install과 --secret-from-env는 따로 실행하세요.");
  if (opts.force && !opts.install)
    throw new CliError("--force는 --install과 함께 쓰세요.");
  if (opts.install) return install(root, opts.force, opts.provider);
  if (opts.secretFromEnv) return registerSecretFromEnv(root, opts.provider);
  showStatus(root, opts.provider);
  return 0;
}
