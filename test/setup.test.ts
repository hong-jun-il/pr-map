import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeFixture, type Fixture } from './fixture';

const CLI = path.resolve('skill/pr-map/scripts/pr-map.js');
const TEMPLATE = path.resolve('skill/pr-map/assets/pr-map.yml');
const WORKFLOW = '.github/workflows/pr-map.yml';
const KEY = 'sk-ant-test-value';

interface Remote {
  fx: Fixture;
  bare: string;
  env: NodeJS.ProcessEnv;
}

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** origin과 액션 저장소를 로컬 bare 저장소로 대신해 실제 fetch·push를 태운다. */
function makeRemote(opts: { tagged?: boolean } = {}): Remote {
  const fx = makeFixture();
  const tmp = path.dirname(fx.root);

  // 경로에 github.com을 넣어 originRepo가 acme/api로 읽게 한다.
  const bare = path.join(tmp, 'remote/github.com/acme/api.git');
  mkdirSync(bare, { recursive: true });
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  g(fx.root, 'remote', 'set-url', 'origin', bare);
  g(fx.root, 'push', '-q', 'origin', 'main');

  const action = path.join(tmp, 'action.git');
  mkdirSync(action);
  g(action, 'init', '-q', '--bare', '-b', 'main');
  if (opts.tagged !== false) g(fx.root, 'push', '-q', action, 'main:refs/tags/v1');

  const gitconfig = path.join(tmp, 'gitconfig');
  writeFileSync(gitconfig, `[url "${action}"]\n\tinsteadOf = https://github.com/hong-jun-il/pr-map.git\n`);
  const env: NodeJS.ProcessEnv = {
    ...fx.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_NAME: 'PR Map Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'PR Map Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  delete env.ANTHROPIC_API_KEY;
  return { fx, bare, env };
}

function setup(r: Remote, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, 'setup', ...args], { cwd: r.fx.root, env: { ...r.env, ...env }, encoding: 'utf8' });
  return { code: res.status, out: res.stdout + res.stderr };
}

const ghCalls = (r: Remote): { args: string[]; stdin: string }[] =>
  readFileSync(r.fx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('워크플로 템플릿', () => {
  it('액션을 v1로 호출하고 시크릿을 넘긴다', () => {
    const steps = parse(readFileSync(TEMPLATE, 'utf8')).jobs['pr-map'].steps;
    expect(steps[1].uses).toBe('hong-jun-il/pr-map@v1');
    expect(steps[1].with['anthropic-api-key']).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
  });
});

describe('setup', () => {
  let r: Remote;
  beforeEach(() => {
    r = makeRemote();
  });
  afterEach(() => r.fx.cleanup());

  it('상태 확인은 원격을 바꾸지 않고 키 값을 출력하지 않는다', () => {
    const { code, out } = setup(r, [], { ANTHROPIC_API_KEY: KEY });
    expect(code).toBe(0);
    expect(out).toContain('저장소: acme/api (기본 브랜치 main)');
    expect(out).toContain('setup --install');
    expect(out).toContain('setup --secret-from-env');
    expect(out).not.toContain(KEY);
    expect(g(r.bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('gh가 없으면 시크릿 등록 웹 링크를 안내한다', () => {
    const { code, out } = setup(r, [], { FAKE_GH_MISSING: '1', ANTHROPIC_API_KEY: KEY });
    expect(code).toBe(0);
    expect(out).toContain('gh: 설치 안 됨');
    expect(out).toContain('https://github.com/acme/api/settings/secrets/actions/new');
    expect(out).not.toContain('setup --secret-from-env');
  });

  it('환경변수 키가 없으면 사용자 터미널 명령을 안내한다', () => {
    const { out } = setup(r);
    expect(out).toContain('gh secret set ANTHROPIC_API_KEY --repo acme/api');
    expect(out).not.toContain('setup --secret-from-env');
  });

  it('--install: 작업 중인 브랜치와 변경을 건드리지 않고 기본 브랜치 기준으로 PR을 만든다', () => {
    writeFileSync(path.join(r.fx.root, 'dirty.txt'), '작업 중');
    const branch = g(r.fx.root, 'branch', '--show-current');
    const mainSha = g(r.bare, 'rev-parse', 'main');

    const { code, out } = setup(r, ['--install']);
    expect(code).toBe(0);
    expect(out).toContain('설치 PR: https://github.com/acme/api/pull/500');

    expect(g(r.bare, 'show', `pr-map/setup:${WORKFLOW}`) + '\n').toBe(readFileSync(TEMPLATE, 'utf8'));
    expect(g(r.bare, 'rev-parse', 'pr-map/setup~1')).toBe(mainSha);
    expect(g(r.bare, 'diff', '--name-only', 'main', 'pr-map/setup')).toBe(WORKFLOW);
    expect(g(r.bare, 'rev-parse', 'main')).toBe(mainSha);

    expect(g(r.fx.root, 'branch', '--show-current')).toBe(branch);
    expect(existsSync(path.join(r.fx.root, 'dirty.txt'))).toBe(true);
    expect(existsSync(path.join(r.fx.root, WORKFLOW))).toBe(false);
    expect(g(r.fx.root, 'worktree', 'list').split('\n')).toHaveLength(1);

    const create = ghCalls(r).find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
    expect(create.args).toEqual(expect.arrayContaining(['--base', 'main', '--head', 'pr-map/setup']));
  });

  it('--install: gh가 없어도 git으로 올리고 PR 링크를 준다', () => {
    const { code, out } = setup(r, ['--install'], { FAKE_GH_MISSING: '1' });
    expect(code).toBe(0);
    expect(out).toContain('https://github.com/acme/api/compare/main...pr-map/setup?expand=1');
    expect(g(r.bare, 'diff', '--name-only', 'main', 'pr-map/setup')).toBe(WORKFLOW);
  });

  it('--install: gh PR 생성이 실패하면 링크로 넘어간다', () => {
    const { code, out } = setup(r, ['--install'], { FAKE_GH_PR_CREATE_FAILS: '1' });
    expect(code).toBe(0);
    expect(out).toContain('pull request create failed');
    expect(out).toContain('compare/main...pr-map/setup?expand=1');
  });

  it('--install을 다시 실행하면 올린 브랜치를 쓰고 열린 PR을 알려준다', () => {
    setup(r, ['--install']);
    const before = g(r.bare, 'rev-parse', 'pr-map/setup');
    const { code, out } = setup(r, ['--install'], { FAKE_GH_OPEN_PR: 'https://github.com/acme/api/pull/500' });
    expect(code).toBe(0);
    expect(out).toContain('설치 PR이 이미 있습니다: https://github.com/acme/api/pull/500');
    expect(g(r.bare, 'rev-parse', 'pr-map/setup')).toBe(before);
  });

  describe('기본 브랜치에 워크플로가 있을 때', () => {
    const commitWorkflow = (text: string) => {
      g(r.fx.root, 'switch', '-q', 'main');
      const file = path.join(r.fx.root, WORKFLOW);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      g(r.fx.root, 'add', '-A');
      g(r.fx.root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'workflow');
      g(r.fx.root, 'push', '-q', 'origin', 'main');
    };

    it('내용이 같으면 아무것도 올리지 않는다', () => {
      commitWorkflow(readFileSync(TEMPLATE, 'utf8'));
      const { code, out } = setup(r, ['--install']);
      expect(code).toBe(0);
      expect(out).toContain('이미 설치되어 있습니다');
      expect(g(r.bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    });

    it('내용이 다르면 --force 없이는 덮어쓰지 않는다', () => {
      commitWorkflow('name: custom\n');
      const refused = setup(r, ['--install']);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('--force');
      expect(g(r.bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');

      const forced = setup(r, ['--install', '--force']);
      expect(forced.code).toBe(0);
      expect(g(r.bare, 'show', `pr-map/setup:${WORKFLOW}`) + '\n').toBe(readFileSync(TEMPLATE, 'utf8'));
    });
  });

  it('--secret-from-env: 키를 표준 입력으로만 넘기고 등록을 확인한다', () => {
    const { code, out } = setup(r, ['--secret-from-env'], { ANTHROPIC_API_KEY: KEY });
    expect(code).toBe(0);
    expect(out).toContain('시크릿 ANTHROPIC_API_KEY 등록 완료: acme/api');
    expect(out).not.toContain(KEY);

    const calls = ghCalls(r);
    const set = calls.find((c) => c.args[0] === 'secret' && c.args[1] === 'set')!;
    expect(set.stdin).toBe(KEY);
    expect(set.args).toEqual(['secret', 'set', 'ANTHROPIC_API_KEY', '--repo', 'acme/api']);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(KEY);
    expect(setup(r).out).toContain('시크릿 ANTHROPIC_API_KEY: 등록됨');
  });

  it('--secret-from-env: 키가 없거나 gh를 쓸 수 없으면 대안을 알려주고 실패한다', () => {
    const noKey = setup(r, ['--secret-from-env']);
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('gh secret set ANTHROPIC_API_KEY --repo acme/api');

    const noAuth = setup(r, ['--secret-from-env'], { ANTHROPIC_API_KEY: KEY, FAKE_GH_NO_AUTH: '1' });
    expect(noAuth.code).toBe(1);
    expect(noAuth.out).toContain('로그인 필요');
    expect(noAuth.out).toContain('settings/secrets/actions/new');
    expect(ghCalls(r).some((c) => c.args[1] === 'set')).toBe(false);
  });

  it('옵션을 잘못 조합하면 거부한다', () => {
    expect(setup(r, ['--install', '--secret-from-env']).code).toBe(1);
    expect(setup(r, ['--force']).code).toBe(1);
  });
});

describe('액션이 게시되지 않았을 때', () => {
  let r: Remote;
  beforeEach(() => {
    r = makeRemote({ tagged: false });
  });
  afterEach(() => r.fx.cleanup());

  it('--install은 아무것도 올리지 않고 이유를 말한다', () => {
    const { code, out } = setup(r, ['--install']);
    expect(code).toBe(1);
    expect(out).toContain('hong-jun-il/pr-map@v1 태그가 아직 없습니다');
    expect(g(r.bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('상태 확인은 설치 불가로 표시한다', () => {
    const { code, out } = setup(r);
    expect(code).toBe(0);
    expect(out).toContain('설치 불가');
    expect(out).not.toContain('워크플로 설치 PR 만들기');
  });
});
