import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeFixture, type Fixture } from './fixture';

const ACTION_ROOT = path.resolve('.');
const SAMPLE = path.resolve('samples/acme-482/pr-map.json');

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}
const action = parse(readFileSync('action.yml', 'utf8'));
const steps: Step[] = action.runs.steps;
const step = (id: string) => steps.find((s) => s.id === id)!;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
  args,
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  skill: fs.existsSync('.pr-map/skill/SKILL.md'),
  schema: fs.existsSync('.pr-map/skill/spec/pr-map.schema.json'),
}));
if (process.env.FAKE_CLAUDE_CRASH) process.exit(2);
if (!process.env.FAKE_CLAUDE_ERROR) fs.copyFileSync(process.env.FAKE_SAMPLE, '.pr-map/pr-map.json');
console.log(JSON.stringify({ subtype: process.env.FAKE_CLAUDE_ERROR ? 'error_max_budget_usd' : 'success', is_error: !!process.env.FAKE_CLAUDE_ERROR, num_turns: 7, total_cost_usd: 0.42, permission_denials: [], result: '::error::PR에서 온 문자열' }));
`;

describe('action.yml 권한 경계', () => {
  it('PR 코드를 읽는 분석 단계에는 GitHub 토큰을 넘기지 않는다', () => {
    const env = Object.keys(step('analyze').env!);
    expect(env).toContain('ANTHROPIC_API_KEY');
    expect(env.filter((k) => /GH_|GITHUB|TOKEN/.test(k))).toEqual([]);
    expect(JSON.stringify(step('analyze').env)).not.toContain('github-token');
  });

  it('API 키는 키 확인과 분석 단계에만 넘긴다', () => {
    const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('anthropic-api-key')).map((s) => s.id);
    expect(holders).toEqual(['check-key', 'analyze']);
  });

  it('입력값을 셸 스크립트에 직접 끼워 넣지 않는다', () => {
    for (const s of steps) expect(s.run ?? '').not.toContain('${{');
  });

  it('분석할 파일이 없으면 수집 뒤 단계를 건너뛴다', () => {
    const ids = ['install-claude', 'analyze', 'build', 'publish'];
    for (const id of ids) expect(step(id).if).toBe("steps.collect.outputs.skip != 'true'");
  });

  it('워크플로 템플릿은 토큰을 체크아웃에 남기지 않고 PR 커밋을 받는다', () => {
    const workflow = parse(readFileSync('skill/pr-map/assets/pr-map.yml', 'utf8'));
    const checkout = workflow.jobs['pr-map'].steps[0].with;
    expect(checkout['persist-credentials']).toBe(false);
    expect(checkout.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(checkout['fetch-depth']).toBe(0);
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });
});

describe('액션 단계 실행', () => {
  let fx: Fixture;
  let output: string;
  let claudeLog: string;

  beforeEach(() => {
    fx = makeFixture();
    const tmp = path.dirname(fx.root);
    output = path.join(tmp, 'github-output');
    claudeLog = path.join(tmp, 'claude.json');
    writeFileSync(output, '');
    const fake = path.join(tmp, 'bin', 'claude');
    writeFileSync(fake, FAKE_CLAUDE);
    chmodSync(fake, 0o755);
  });
  afterEach(() => fx.cleanup());

  function runStep(id: string, env: NodeJS.ProcessEnv = {}) {
    const r = spawnSync('bash', ['-c', step(id).run!], {
      cwd: fx.root,
      encoding: 'utf8',
      env: {
        ...fx.env,
        GIT_TERMINAL_PROMPT: '0',
        GITHUB_ACTION_PATH: ACTION_ROOT,
        GITHUB_OUTPUT: output,
        FAKE_CLAUDE_LOG: claudeLog,
        FAKE_SAMPLE: SAMPLE,
        PR_NUMBER: '482',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        PR_MAP_MODEL: 'sonnet',
        PR_MAP_MAX_TURNS: '80',
        PR_MAP_MAX_BUDGET_USD: '5',
        ...env,
      },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it('수집부터 게시까지 이어서 실행한다', () => {
    expect(runStep('check-key').code).toBe(0);
    expect(runStep('collect').code).toBe(0);
    expect(readFileSync(output, 'utf8')).not.toContain('skip=true');

    const analyzed = runStep('analyze');
    expect(analyzed.code).toBe(0);
    expect(analyzed.out).toContain('분석 종료: success · 턴 7');

    const build = runStep('build');
    expect(build.code, build.out).toBe(0);
    expect(existsSync(path.join(fx.root, '.pr-map/viewer/index.html'))).toBe(true);

    const published = runStep('publish');
    expect(published.code, published.out).toBe(0);
    expect(published.out).toContain('댓글 게시');
  });

  it('detached HEAD에서도 gh 기본 저장소와 무관하게 origin의 PR을 수집한다', () => {
    execFileSync('git', ['checkout', '--detach', fx.head], { cwd: fx.root, stdio: 'ignore' });
    const collected = runStep('collect', { FAKE_GH_DEFAULT_REPO: 'upstream/api' });
    expect(collected.code, collected.out).toBe(0);
    const input = JSON.parse(readFileSync(path.join(fx.root, '.pr-map/input.json'), 'utf8'));
    expect(input.pr).toMatchObject({ repo: 'acme/api', number: 482, head: fx.head, url: 'https://github.com/acme/api/pull/482' });
  });

  it('자동 실행 댓글은 전체 지도를 실행 페이지의 artifact로 안내한다', () => {
    const runUrl = 'https://github.com/acme/api/actions/runs/123';
    expect(step('build').env!.PR_MAP_RUN_URL).toBe('${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}');
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))! as Step & { with: { name: string } };
    expect(upload.with.name).toBe('pr-map-viewer');

    runStep('collect');
    runStep('analyze');
    const built = runStep('build', { PR_MAP_RUN_URL: runUrl });
    expect(built.code, built.out).toBe(0);
    const comment = readFileSync(path.join(fx.root, '.pr-map/comment.md'), 'utf8');
    expect(comment).toContain(`[실행 페이지](${runUrl})`);
    expect(comment).toContain('`pr-map-viewer`');
    expect(comment).not.toContain('/pr-map view');
  });

  it('로컬 빌드 댓글은 /pr-map view 안내를 유지한다', () => {
    runStep('collect');
    runStep('analyze');
    expect(runStep('build').code).toBe(0);
    const comment = readFileSync(path.join(fx.root, '.pr-map/comment.md'), 'utf8');
    expect(comment).toContain('`/pr-map view`');
    expect(comment).not.toContain('pr-map-viewer');
  });

  it('에이전트를 제한된 권한으로 실행하고 지시문을 작업 폴더에 둔다', () => {
    runStep('collect');
    runStep('analyze');
    const call = JSON.parse(readFileSync(claudeLog, 'utf8'));
    expect(call.skill).toBe(true);
    expect(call.schema).toBe(true);
    expect(call.scrub).toBe('1');
    expect(call.args).toEqual(expect.arrayContaining(['--bare', '--no-session-persistence']));
    const value = (flag: string) => call.args[call.args.indexOf(flag) + 1];
    expect(value('--permission-prompts')).toBe('none');
    // 환경변수 정리를 켜면 CLI가 권한 모드를 default로 강제하므로 넘기지 않는다.
    expect(call.args).not.toContain('--permission-mode');
    expect(value('--tools')).toBe('Read,Grep,Glob,Edit,Write,Bash');
    expect(call.args).toContain('Edit(.pr-map/**)');
    expect(call.args).toContain(`Bash(node ${ACTION_ROOT}/skill/pr-map/scripts/pr-map.js validate)`);
    expect(call.args.some((a: string) => /Bash\((curl|gh|\*)/.test(a) || a === 'Bash' || a === 'Edit')).toBe(false);
    expect(call.args[1]).toContain(`node ${ACTION_ROOT}/skill/pr-map/scripts/pr-map.js validate`);
  });

  it('시크릿이 없으면 등록 방법을 알려주고 실패한다', () => {
    const { code, out } = runStep('check-key', { ANTHROPIC_API_KEY: '' });
    expect(code).toBe(1);
    expect(out).toContain('::error::ANTHROPIC_API_KEY 시크릿이 없습니다');
  });

  it('PR 번호가 없으면 수집하지 않는다', () => {
    const { code, out } = runStep('collect', { PR_NUMBER: '' });
    expect(code).toBe(1);
    expect(out).toContain('pull_request 이벤트');
  });

  it('분석할 파일이 없으면 뒤 단계를 건너뛰게 한다', () => {
    writeFileSync(path.join(fx.root, '.pr-map.yml'), 'exclude:\n  - "**"\n');
    const { code } = runStep('collect');
    expect(code).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('skip=true');
  });

  it('비용 상한 등으로 분석이 끝나지 않으면 실패하고 결과 문자열을 로그에 쓰지 않는다', () => {
    runStep('collect');
    const { code, out } = runStep('analyze', { FAKE_CLAUDE_ERROR: '1' });
    expect(code).toBe(1);
    expect(out).toContain('분석 실패: error_max_budget_usd');
    expect(out).toContain('::error::PR 분석이 끝나지 않았습니다');
    expect(out).not.toContain('PR에서 온 문자열');
  });

  it('claude가 비정상 종료하면 실패한다', () => {
    runStep('collect');
    const { code, out } = runStep('analyze', { FAKE_CLAUDE_CRASH: '1' });
    expect(code).toBe(1);
    expect(out).toContain('분석 결과를 읽지 못했습니다');
  });
});
