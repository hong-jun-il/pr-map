import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { CollectInput, PrMap, ViewerData, ViewerMapData } from '../shared/types';
import { build, writeViewer } from './build';
import { CodeIndex } from './code';
import { collect } from './collect';
import { COMMENT_MARKER } from './comment';
import { CliError, repoRoot, run, tryGit } from './git';
import { commentPath, inputPath, mapPath, readJson, readJsonIfExists, statePath, viewerDataPath, viewerHtmlPath, writeJson } from './paths';
import { cmdSetup } from './setup';
import { checkRules, checkSchema, countUnverified, demote, normalize, stabilizeIds, type Problem } from './validate';

const MAX_ATTEMPTS = 3;

interface ValidateState {
  head: string;
  attempts: number;
  errors: Problem[];
}

function requireInput(root: string): CollectInput {
  const input = readJsonIfExists<CollectInput>(inputPath(root));
  if (!input) throw new CliError('.pr-map/input.json이 없습니다. 먼저 collect를 실행하세요.');
  return input;
}

function codeIndexFor(root: string, input: CollectInput): CodeIndex {
  return new CodeIndex(root, input.pr.base, input.pr.head, [...input.files, ...input.unclassified]);
}

function printProblems(problems: Problem[]): void {
  for (const p of problems) console.log(`- ${p.path}: ${p.reason}`);
}

function cmdCollect(root: string, opts: { pr?: number; base?: string }): void {
  const input = collect(root, opts);
  const { pr } = input;
  console.log(`분석 대상: ${pr.repo}${pr.number ? ` #${pr.number}` : ''} (${pr.baseRef} ← ${pr.headRef})`);
  console.log(`base ${pr.base.slice(0, 7)} · head ${pr.head.slice(0, 7)}`);
  console.log(`지도 대상 ${input.files.length}개 · 미분류 ${input.unclassified.length}개 · 관계 후보 ${input.candidates.length}개`);
  if (!input.checkout.matchesHead) {
    console.log(`주의: 체크아웃이 head와 다릅니다. 코드는 파일이 아니라 git show ${pr.head.slice(0, 7)}:<경로>로 읽으세요.`);
  } else if (input.checkout.dirty) {
    console.log('주의: 커밋되지 않은 변경이 있습니다. 분석에는 커밋된 내용만 씁니다. 줄 번호는 git show로 확인하세요.');
  }
}

/** 통과하면 0, 고쳐야 하면 1을 돌려준다. */
function cmdValidate(root: string): number {
  const input = requireInput(root);
  const file = mapPath(root);
  if (!existsSync(file)) throw new CliError('.pr-map/pr-map.json이 없습니다. 분석 결과를 먼저 작성하세요.');
  let map: PrMap;
  try {
    map = JSON.parse(readFileSync(file, 'utf8')) as PrMap;
  } catch (err) {
    throw new CliError(`pr-map.json을 JSON으로 읽지 못했습니다: ${(err as Error).message}`);
  }
  const state = readJsonIfExists<ValidateState>(statePath(root)) ?? { head: input.pr.head, attempts: 0, errors: [] };

  const fail = (problems: Problem[]): number => {
    writeJson(statePath(root), { ...state, errors: problems });
    return 1;
  };

  if (map && typeof map === 'object' && map.pr && typeof map.pr === 'object') normalize(map, input);
  const schemaProblems = checkSchema(map);
  if (schemaProblems.length) {
    state.attempts += 1;
    console.log(`검증 실패 ${schemaProblems.length}건 (시도 ${state.attempts}):`);
    printProblems(schemaProblems);
    return fail(schemaProblems);
  }

  const code = codeIndexFor(root, input);
  const remapped = stabilizeIds(map, input.previous);
  remapped.forEach((l) => console.log(`id 보정: ${l}`));

  let problems = checkRules(map, input, code);
  if (problems.length) {
    state.attempts += 1;
    if (state.attempts < MAX_ATTEMPTS) {
      console.log(`검증 실패 ${problems.length}건 (시도 ${state.attempts}/${MAX_ATTEMPTS}). 아래 항목만 고치고 다시 실행하세요:`);
      printProblems(problems);
      return fail(problems);
    }
    const demoted = demote(map, problems);
    demoted.forEach((l) => console.log(`확인 필요로 강등: ${l}`));
    problems = checkRules(map, input, code);
    if (problems.length) {
      console.log(`강등으로 해결되지 않는 오류 ${problems.length}건:`);
      printProblems(problems);
      return fail(problems);
    }
  }
  writeJson(file, map);
  writeJson(statePath(root), { ...state, errors: [] });
  const missing = input.files.filter((f) => !map.files.some((m) => m.path === f.path));
  if (missing.length) console.log(`주의: 지도에 없는 변경 파일 ${missing.length}개는 미분류로 표시합니다: ${missing.map((f) => f.path).join(', ')}`);
  console.log(`검증 통과 · 확인 필요 ${countUnverified(map)}건`);
  return 0;
}

function cmdBuild(root: string): void {
  const input = requireInput(root);
  if (cmdValidate(root) !== 0) throw new CliError('검증을 통과하지 못해 빌드하지 않았습니다.');
  const map = readJson<PrMap>(mapPath(root));
  const data = build(root, map, input, codeIndexFor(root, input));
  console.log(`뷰어: ${viewerHtmlPath(root)}`);
  console.log(`댓글: ${commentPath(root)}`);
  console.log(`확인 필요 ${data.counts.unverified}건`);
}

function latestHead(root: string, input: CollectInput): string | null {
  try {
    if (input.pr.number) {
      const out = run('gh', ['pr', 'view', String(input.pr.number), '--json', 'headRefOid', '--jq', '.headRefOid'], root);
      return out.trim() || null;
    }
    return tryGit(root, 'rev-parse', 'HEAD')?.trim() ?? null;
  } catch {
    return null;
  }
}

function statusData(root: string): ViewerData {
  const input = readJsonIfExists<CollectInput>(inputPath(root));
  if (!input) return { status: 'empty' };
  const state = readJsonIfExists<ValidateState>(statePath(root));
  if (state?.errors?.length) return { status: 'failed', pr: input.pr, errors: state.errors.map(({ path, reason }) => ({ path, reason })) };
  return { status: 'analyzing', pr: input.pr, changed: input.files.length };
}

function openInBrowser(file: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log('브라우저를 열지 못했습니다. 위 경로를 직접 여세요.'));
  child.unref();
}

function cmdView(root: string, opts: { open: boolean }): void {
  const ready = readJsonIfExists<ViewerMapData>(viewerDataPath(root));
  const input = readJsonIfExists<CollectInput>(inputPath(root));
  const current = !!ready && !!input && ready.pr.head === input.pr.head;
  let data: ViewerData;
  if (current) {
    const latest = latestHead(root, input!);
    const newer = latest && latest !== ready!.pr.head ? tryGit(root, 'rev-list', '--count', `${ready!.pr.head}..${latest}`)?.trim() : null;
    data = { ...ready!, latestHead: latest, newCommits: newer ? Number(newer) : null };
    if (latest && latest !== ready!.pr.head) console.log(`새 커밋이 있습니다: 분석 ${ready!.pr.head.slice(0, 7)} · 최신 ${latest.slice(0, 7)}`);
  } else {
    data = statusData(root);
  }
  const file = writeViewer(root, data);
  console.log(`뷰어: ${file}`);
  if (opts.open) openInBrowser(file);
}

function cmdPublish(root: string): void {
  const input = requireInput(root);
  if (!input.pr.number) {
    console.log('이 브랜치에는 PR이 없어 게시하지 않고 로컬 뷰어를 엽니다.');
    cmdView(root, { open: true });
    return;
  }
  const file = commentPath(root);
  if (!existsSync(file)) throw new CliError('comment.md가 없습니다. 먼저 build를 실행하세요.');
  const body = readFileSync(file, 'utf8');
  const { repo, number, head } = input.pr;
  const latest = latestHead(root, input);
  if (latest && latest !== head) console.log(`주의: PR head가 분석 뒤 바뀌었습니다(최신 ${latest.slice(0, 7)}). 분석 커밋 ${head.slice(0, 7)} 기준으로 게시합니다.`);

  let existing: string | undefined;
  try {
    const jq = `.[] | select(.body | startswith("${COMMENT_MARKER}")) | .id`;
    existing = run('gh', ['api', `repos/${repo}/issues/${number}/comments`, '--paginate', '--jq', jq], root).split('\n')[0]?.trim();
  } catch (err) {
    throw new CliError(`기존 댓글을 확인하지 못했습니다. gh 인증과 저장소 권한을 확인하세요.\n${(err as { stderr?: string }).stderr ?? ''}`.trim());
  }
  const payload = JSON.stringify({ body });
  const args = existing
    ? ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '--input', '-']
    : ['api', '--method', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'];
  let out: string;
  try {
    out = run('gh', args, root, payload);
  } catch (err) {
    throw new CliError(`댓글을 게시하지 못했습니다.\n${(err as { stderr?: string }).stderr ?? ''}`.trim());
  }
  const url = (JSON.parse(out) as { html_url?: string }).html_url ?? '';
  console.log(`${existing ? '댓글 갱신' : '댓글 게시'}: ${url}`);
}

const USAGE = `사용법: pr-map <명령>
  collect [--pr <번호>] [--base <ref>]  변경 내용을 수집해 .pr-map/input.json을 만듭니다
  validate                              .pr-map/pr-map.json을 검증합니다
  build                                 뷰어와 PR 댓글을 만듭니다
  publish                               PR 댓글을 게시하거나 갱신합니다
  view [--no-open]                      뷰어를 엽니다
  setup                                 자동 실행 설치 상태와 다음 단계를 보여줍니다
  setup --install [--force]             워크플로 설치 브랜치를 올리고 PR을 만듭니다
  setup --secret-from-env               환경변수의 API 키를 저장소 시크릿으로 등록합니다`;

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      pr: { type: 'string' },
      base: { type: 'string' },
      'no-open': { type: 'boolean' },
      install: { type: 'boolean' },
      force: { type: 'boolean' },
      'secret-from-env': { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const root = repoRoot(process.cwd());
  switch (command) {
    case 'collect': {
      const pr = values.pr === undefined ? undefined : Number(values.pr);
      if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) throw new CliError('--pr에는 PR 번호를 쓰세요.');
      cmdCollect(root, { pr, base: values.base });
      return 0;
    }
    case 'validate':
      return cmdValidate(root);
    case 'build':
      cmdBuild(root);
      return 0;
    case 'publish':
      cmdPublish(root);
      return 0;
    case 'view':
      cmdView(root, { open: !values['no-open'] });
      return 0;
    case 'setup':
      return cmdSetup(root, { install: !!values.install, force: !!values.force, secretFromEnv: !!values['secret-from-env'] });
    default:
      console.error(USAGE);
      return 1;
  }
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exitCode = 1;
  } else throw err;
}
