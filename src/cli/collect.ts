import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChangedFile, CollectInput, PrInfo, PrMap } from '../shared/types';
import { collectCandidates } from './candidates';
import { classify, readConfig } from './classify';
import { CliError, git, originRepo, repoRoot, run, tryGit } from './git';
import { inputPath, mapPath, readJsonIfExists, statePath, writeJson } from './paths';

export function parseChanges(nameStatusZ: string, numstatZ: string): ChangedFile[] {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const num = numstatZ.split('\0');
  for (let i = 0; i < num.length; i++) {
    const row = num[i];
    if (!row) continue;
    const [a, d, p] = row.split('\t');
    let file = p;
    // 이름 변경은 `a\td\t\0old\0new\0` 형태다.
    if (p === '') {
      i += 2;
      file = num[i];
    }
    if (file === undefined) continue;
    const binary = a === '-';
    stats.set(file, { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary });
  }
  const out: ChangedFile[] = [];
  const parts = nameStatusZ.split('\0');
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const kind = code[0]!;
    const first = parts[i++]!;
    const second = kind === 'R' || kind === 'C' ? parts[i++]! : undefined;
    const filePath = second ?? first;
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    if (kind === 'R') out.push({ path: filePath, oldPath: first, status: 'renamed', ...stat });
    else if (kind === 'A' || kind === 'C') out.push({ path: filePath, status: 'added', ...stat });
    else if (kind === 'D') out.push({ path: filePath, status: 'deleted', ...stat });
    else out.push({ path: filePath, status: 'modified', ...stat });
  }
  return out;
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
}

function ghPr(root: string, repo: string, number?: number): GhPr | null {
  try {
    // --repo를 지정하면 PR 번호 또는 브랜치도 명시해야 한다.
    const selector = number ? String(number) : tryGit(root, 'symbolic-ref', '--quiet', '--short', 'HEAD')?.trim();
    if (!selector) return null;
    const args = ['pr', 'view', selector, '--repo', repo, '--json', 'number,title,url,baseRefName,headRefName,headRefOid'];
    return JSON.parse(run('gh', args, root)) as GhPr;
  } catch (err) {
    if (number) {
      throw new CliError(`${repo} PR #${number} 정보를 가져오지 못했습니다. gh 설치·인증과 저장소 권한을 확인하세요.\n${(err as { stderr?: string }).stderr ?? ''}`.trim());
    }
    return null;
  }
}

function defaultBranch(root: string): string {
  const ref = tryGit(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (ref) return ref.trim().replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (tryGit(root, 'rev-parse', '--verify', '--quiet', name) !== null) return name;
  }
  throw new CliError('기본 브랜치를 찾지 못했습니다. --base <ref>로 비교 대상을 지정하세요.');
}

function resolveCommit(root: string, ref: string): string | null {
  return tryGit(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)?.trim() ?? null;
}

/** 분석 결과와 코드가 저장소에 커밋되지 않도록 이 클론에서만 무시한다. */
function excludeOutput(root: string): void {
  const rel = git(root, 'rev-parse', '--git-path', 'info/exclude').trim();
  const file = path.resolve(root, rel);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes('.pr-map/')) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}.pr-map/\n`);
}

export interface CollectOptions {
  pr?: number;
  base?: string;
}

export function collect(cwd: string, opts: CollectOptions): CollectInput {
  const root = repoRoot(cwd);
  const repo = originRepo(root);
  const gh = opts.base ? null : ghPr(root, repo, opts.pr);
  const baseRef = opts.base ?? gh?.baseRefName ?? defaultBranch(root);

  if (gh) {
    if (!resolveCommit(root, gh.headRefOid)) {
      if (tryGit(root, 'fetch', '--quiet', 'origin', `refs/pull/${gh.number}/head`) === null) {
        throw new CliError(`PR #${gh.number}의 head 커밋을 가져오지 못했습니다.`);
      }
    }
    tryGit(root, 'fetch', '--quiet', 'origin', baseRef);
  }

  const head = gh?.headRefOid ?? resolveCommit(root, 'HEAD');
  if (!head || !resolveCommit(root, head)) throw new CliError('head 커밋을 찾지 못했습니다.');
  const baseTip = resolveCommit(root, `origin/${baseRef}`) ?? resolveCommit(root, baseRef);
  if (!baseTip) throw new CliError(`비교 대상 ${baseRef}을(를) 찾지 못했습니다. git fetch 후 다시 실행하세요.`);
  const mergeBase = tryGit(root, 'merge-base', baseTip, head)?.trim();
  if (!mergeBase) throw new CliError(`${baseRef}와 head의 공통 커밋을 찾지 못했습니다. 얕은 클론이면 git fetch --unshallow를 실행하세요.`);

  const changes = parseChanges(
    git(root, 'diff', '-M', '--name-status', '-z', mergeBase, head),
    git(root, 'diff', '-M', '--numstat', '-z', mergeBase, head),
  );
  const { files, unclassified } = classify(changes, readConfig(root));

  const headRef = gh?.headRefName ?? (tryGit(root, 'branch', '--show-current')?.trim() || head.slice(0, 7));
  const pr: PrInfo = {
    repo,
    number: gh?.number ?? null,
    title: gh?.title ?? tryGit(root, 'log', '-1', '--format=%s', head)?.trim() ?? headRef,
    url: gh?.url ?? `https://github.com/${repo}/compare/${mergeBase}...${head}`,
    baseRef,
    headRef,
    base: mergeBase,
    head,
  };

  const input: CollectInput = {
    version: 1,
    pr,
    checkout: {
      matchesHead: resolveCommit(root, 'HEAD') === head,
      dirty: (tryGit(root, 'status', '--porcelain', '--untracked-files=no') ?? '').trim() !== '',
    },
    files,
    unclassified,
    candidates: collectCandidates(root, mergeBase, head, files),
    previous: readJsonIfExists<PrMap>(mapPath(root)),
  };

  writeJson(inputPath(root), input);
  writeJson(statePath(root), { head, attempts: 0, errors: [] });
  excludeOutput(root);
  return input;
}
