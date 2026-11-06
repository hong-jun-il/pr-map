import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 시안의 예시 PR(acme/api #482)을 실제 git 저장소로 재현한다.
// 형식: 줄 앞 '+'는 head에만, '-'는 base에만, ' '는 양쪽에 있는 줄.
const A = `
+ import { acquireRefreshLock, waitForRefresh } from './refresh-lock'
  import { sessionStore } from '../store/session-store'
  import { tokenClient } from './token-client'

+ const WAIT_LIMIT_MS = 8_000
+
  export async function getFreshSession(id: string) {
    const session = await sessionStore.get(id)
    if (!session || !isExpiring(session)) return session

-   const tokens = await tokenClient.refresh(session.refreshToken)
-   await sessionStore.set(id, { ...session, ...tokens })
-   return sessionStore.get(id)
+   const lock = await acquireRefreshLock(id)
+   if (lock.alreadyRefreshed) return lock.session
+   if (!lock.acquired) {
+     const result = await waitForRefresh(id, WAIT_LIMIT_MS)
+     if (result.timedOut) {
+       await sessionStore.deleteIfVersion(id, session.version)
+       throw new ReauthRequired(id)
+     }
+     return result.session
+   }
+
+   let tokens
+   try {
+     tokens = await tokenClient.refresh(session.refreshToken)
+   } catch (err) {
+     await sessionStore.deleteIfVersion(id, session.version)
+     throw new ReauthRequired(id, err)
+   }
+
+   const next = { ...session, ...tokens, version: session.version + 1 }
+   const saved = await sessionStore.compareAndSet(id, session.version, next)
+   if (!saved) {
+     await tokenClient.revoke(tokens.refreshToken)
+     throw new ReauthRequired(id)
+   }
+   await lock.release(next)
+   return next
  }
`;
const B = `
+ import { redis } from '../infra/redis'
+
+ const LOCK_TTL_MS = 30_000
+
+ export async function acquireRefreshLock(id: string) {
+   const ok = await redis.set('refresh:' + id, 'pending', { nx: true, px: LOCK_TTL_MS })
+   if (ok) return { acquired: true, release: (s) => publish(id, s) }
+
+   const done = await redis.get('refreshed:' + id)
+   if (done) return { alreadyRefreshed: true, session: JSON.parse(done) }
+   return { acquired: false }
+ }
+
+ export async function waitForRefresh(id: string, limitMs: number) {
+   const msg = await redis.subscribeOnce('refreshed:' + id, limitMs)
+   if (!msg) return { timedOut: true }
+   return { timedOut: false, session: JSON.parse(msg) }
+ }
`;
const C = `
  import { db } from '../infra/db'
+ import { log } from '../infra/log'

  export const sessionStore = {
    get: (id: string) => db.session.findUnique({ where: { id } }),

-   set: (id, s) => db.session.update({ where: { id }, data: s }),
+   async compareAndSet(id: string, version: number, next: Session) {
+     const r = await db.session.updateMany({ where: { id, version }, data: next })
+     return r.count === 1
+   },
+
+   async deleteIfVersion(id: string, version: number) {
+     try {
+       await db.session.deleteMany({ where: { id, version } })
+     } catch (e) {
+       log.warn('session delete failed', { id, e })
+     }
+   },
  }
`;
const D = `
  import { http } from '../infra/http'

  export const tokenClient = {
    async refresh(refreshToken: string) {
      const res = await http.post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken })
      if (res.status === 401) throw new RefreshRejected()
      return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token }
    },

    async revoke(token: string) {
      await http.post('/oauth/revoke', { token }).catch(() => {})
    },
  }
`;
const E = `
- import { sessionStore } from '../store/session-store'
- import { tokenClient } from './token-client'
-
- export async function legacyRefresh(id: string) {
-   const session = await sessionStore.get(id)
-   const tokens = await tokenClient.refresh(session.refreshToken)
-   await sessionStore.set(id, { ...session, ...tokens })
-   return sessionStore.get(id)
- }
-
- export function scheduleRefresh(id: string) {
-   setTimeout(() => legacyRefresh(id).catch(() => {}), 60_000)
- }
`;
const F = `
- import { getReport } from './get-report'
- import { toCsv } from '../lib/csv'
-
- export async function exportCsv(req, res) {
-   const report = await getReport(req.params.id)
-   if (!report) return res.status(404).end()
-   res.setHeader('Content-Type', 'text/csv')
-   res.send(toCsv(report.rows))
- }
`;
const R = `
  import { Router } from './http'
- import { exportCsv } from './reports/csv-export'
  import { getReport } from './reports/get-report'

  export const routes = new Router()
  routes.get('/reports/:id', getReport)
- routes.get('/reports/:id/csv', exportCsv)
`;
const G = `
  export const tokenCache = new Map<string, CachedToken>()

- export function getToken(key: string) {
+ export function readToken(key: string) {
    const hit = tokenCache.get(key)
    if (!hit || hit.expiresAt < Date.now()) return null
    return hit.token
  }
`;

const T = `
  import { describe, it, expect } from 'vitest'
  import { getFreshSession } from '../session-refresh'

  describe('getFreshSession', () => {
    it('만료 전이면 그대로 반환', async () => {
      expect(await getFreshSession('fresh')).toBeTruthy()
    })
+
+   it('동시 요청 → 갱신 한 번', async () => {
+     await Promise.all([getFreshSession('a'), getFreshSession('a')])
+     expect(refreshCount()).toBe(1)
+   })
+
+   it('갱신 거부 → 세션 삭제', async () => {
+     await expect(getFreshSession('rejected')).rejects.toThrow()
+   })
  })
`;

function split(src: string): { base: string | null; head: string | null } {
  const lines = src.replace(/^\n|\n$/g, "").split("\n");
  const pick = (skip: string) =>
    lines
      .filter((l) => l[0] !== skip)
      .map((l) => l.slice(2))
      .join("\n") + "\n";
  return {
    base: lines.some((l) => l[0] !== "+") ? pick("+") : null,
    head: lines.some((l) => l[0] !== "-") ? pick("-") : null,
  };
}

const FILES: Record<string, string> = {
  "src/auth/session-refresh.ts": A,
  "src/auth/refresh-lock.ts": B,
  "src/store/session-store.ts": C,
  "src/auth/token-client.ts": D,
  "src/auth/legacy-refresh.ts": E,
  "src/reports/csv-export.ts": F,
  "src/routes.ts": R,
  "src/auth/__tests__/session-refresh.test.ts": T,
};

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_GH_MISSING) process.exit(127);
const isSecretSet = args[0] === 'secret' && args[1] === 'set';
const stdin = args.includes('--input') || isSecretSet ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\\n');
const head = process.env.FAKE_GH_LATEST || process.env.FAKE_GH_HEAD;
const secrets = process.env.FAKE_GH_LOG + '.secrets';
if (args[0] === '--version') {
  console.log('gh version 0.0.0');
} else if (args[0] === 'auth') {
  process.exit(process.env.FAKE_GH_NO_AUTH ? 1 : 0);
} else if (isSecretSet) {
  fs.appendFileSync(secrets, args[2] + '\\n');
} else if (args[0] === 'secret' && args[1] === 'list') {
  if (fs.existsSync(secrets)) process.stdout.write(fs.readFileSync(secrets, 'utf8'));
} else if (args[0] === 'pr' && args[1] === 'list') {
  if (process.env.FAKE_GH_OPEN_PR) console.log(process.env.FAKE_GH_OPEN_PR);
} else if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.FAKE_GH_PR_CREATE_FAILS) { console.error('pull request create failed'); process.exit(1); }
  console.log('https://github.com/acme/api/pull/500');
} else if (args[0] === 'pr' && args[1] === 'view') {
  const repoIndex = args.indexOf('--repo');
  if (repoIndex !== -1 && (!args[2] || args[2].startsWith('-'))) process.exit(1);
  const repo = repoIndex === -1 ? (process.env.FAKE_GH_DEFAULT_REPO || 'acme/api') : args[repoIndex + 1];
  if (repo !== 'acme/api') {
    if (args.includes('--jq')) { console.log('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'); process.exit(0); }
    console.log(JSON.stringify({ number: 482, url: 'https://github.com/' + repo + '/pull/482', baseRefName: 'main', headRefName: 'other-branch', headRefOid: process.env.FAKE_GH_BASE }));
    process.exit(0);
  }
  if (args.includes('--jq')) { console.log(head); process.exit(0); }
  console.log(JSON.stringify({ number: 482, title: '세션 갱신 경합 처리와 실패 시 정리', url: 'https://github.com/acme/api/pull/482', baseRefName: 'main', headRefName: 'feat/refresh-lock', headRefOid: process.env.FAKE_GH_HEAD }));
} else if (args[0] === 'api' && args.includes('--method')) {
  console.log(JSON.stringify({ html_url: 'https://github.com/acme/api/pull/482#issuecomment-1' }));
} else if (args[0] === 'api') {
  if (process.env.FAKE_GH_EXISTING) console.log(process.env.FAKE_GH_EXISTING);
} else { process.exit(1); }
`;

export interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  base: string;
  head: string;
  log: string;
  cleanup: () => void;
}

function commit(root: string, message: string): string {
  const g = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  g("add", "-A");
  g(
    "-c",
    "user.name=PR Map Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  );
  return g("rev-parse", "HEAD");
}

export function makeFixture(dir?: string): Fixture {
  const tmp = dir ?? mkdtempSync(path.join(tmpdir(), "pr-map-"));
  const root = path.join(tmp, "repo");
  mkdirSync(root, { recursive: true });
  const g = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  const write = (rel: string, text: string | Buffer) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", "https://github.com/acme/api.git");

  const parts = Object.entries(FILES).map(
    ([p, src]) => [p, split(src)] as const,
  );
  const gParts = split(G);
  for (const [p, s] of parts) if (s.base !== null) write(p, s.base);
  write("src/auth/token-store.ts", gParts.base!);
  write(
    "src/auth/__tests__/old-unrelated.test.ts",
    "it('예전 테스트', () => {})\n",
  );
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("docs/auth/session.md", "# 세션\n");
  write("infra/redis.conf", "maxmemory 1gb\n");
  write(
    "public/og-image.png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  );
  const base = commit(root, "base");

  g("switch", "-q", "-c", "feat/refresh-lock");
  for (const [p, s] of parts) {
    if (s.head === null) rmSync(path.join(root, p));
    else write(p, s.head);
  }
  renameSync(
    path.join(root, "src/auth/token-store.ts"),
    path.join(root, "src/auth/token-cache.ts"),
  );
  write("src/auth/token-cache.ts", gParts.head!);
  write("pnpm-lock.yaml", "lockfileVersion: 9\npackages: {}\n");
  write("docs/auth/session.md", "# 세션\n\n잠금을 씁니다.\n");
  write("infra/redis.conf", "maxmemory 2gb\n");
  write(
    "public/og-image.png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]),
  );
  const head = commit(root, "세션 갱신 경합 처리와 실패 시 정리");

  const bin = path.join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "gh"), FAKE_GH);
  chmodSync(path.join(bin, "gh"), 0o755);
  // origin의 GitHub 이름은 유지하면서 fetch는 로컬 fixture만 사용한다.
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
if [ "$1" = fetch ] && [ "$2" = --quiet ] && [ "$3" = origin ]; then
  shift 3
  exec "$FAKE_GIT_BIN" fetch --quiet "$FAKE_GIT_ORIGIN" "$@"
fi
exec "$FAKE_GIT_BIN" "$@"
`,
  );
  chmodSync(path.join(bin, "git"), 0o755);
  // 테스트가 실제 브라우저를 띄우지 않게 한다.
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(tmp, "gh.log");
  writeFileSync(log, "");
  return {
    root,
    base,
    head,
    log,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_GIT_BIN: realGit,
      FAKE_GIT_ORIGIN: root,
      FAKE_GH_LOG: log,
      FAKE_GH_HEAD: head,
      FAKE_GH_BASE: base,
      PR_MAP_NO_UPDATE_CHECK: "1",
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
