import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, latestFromTags } from "../src/cli/update";

const SKILL = path.resolve("skill/pr-map");
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const NEXT = "99.0.0";

describe("버전 비교", () => {
  it("숫자로 비교한다", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("가장 높은 vX.Y.Z만 고르고 v1, 프리릴리스, 역참조는 건너뛴다", () => {
    const out = [
      "a\trefs/tags/v1",
      "b\trefs/tags/v0.9.0",
      "c\trefs/tags/v0.10.0",
      "d\trefs/tags/v0.10.0^{}",
      "e\trefs/tags/v2.0.0-rc.1",
    ].join("\n");
    expect(latestFromTags(out)).toBe("0.10.0");
    expect(latestFromTags("a\trefs/tags/v1\n")).toBeNull();
  });
});

describe("update 명령", () => {
  let tmp: string;
  let installed: string;
  let remote: string;
  let env: NodeJS.ProcessEnv;

  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(installed, "scripts/pr-map.js"), ...args], {
      cwd: tmp,
      env,
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const publishTag = (version: string, withScript = true) => {
    const work = path.join(tmp, `work-${version}`);
    mkdirSync(path.join(work, "skill/pr-map/scripts"), { recursive: true });
    writeFileSync(path.join(work, "skill/pr-map/SKILL.md"), `new ${version}\n`);
    if (withScript) writeFileSync(path.join(work, "skill/pr-map/scripts/pr-map.js"), "// new\n");
    g(work, "init", "-q", "-b", "main");
    g(work, "add", "-A");
    g(work, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "release");
    g(work, "tag", `v${version}`);
    g(work, "push", "-q", "--force", remote, `refs/tags/v${version}`);
  };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "pr-map-update-test-"));
    installed = path.join(tmp, "skills/pr-map");
    cpSync(SKILL, installed, { recursive: true });
    remote = path.join(tmp, "remote.git");
    mkdirSync(remote);
    const gitconfig = path.join(tmp, "gitconfig");
    writeFileSync(gitconfig, `[url "${remote}"]\n\tinsteadOf = https://github.com/hong-jun-il/pr-map.git\n`);
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitconfig,
      XDG_CACHE_HOME: path.join(tmp, "cache"),
    };
    delete env.CI;
    delete env.PR_MAP_NO_UPDATE_CHECK;
    g(remote, "init", "-q", "--bare", "-b", "main");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("태그가 없으면 배포된 버전이 없다고 알린다", () => {
    const { code, out } = cli("update");
    expect(code).toBe(0);
    expect(out).toContain(`설치 버전: ${VERSION}`);
    expect(out).toContain("배포된 버전이 아직 없습니다");
  });

  it("--apply 없이는 파일을 바꾸지 않는다", () => {
    publishTag(NEXT);
    const before = readFileSync(path.join(installed, "SKILL.md"), "utf8");
    const { code, out } = cli("update");
    expect(code).toBe(0);
    expect(out).toContain(`최신 버전: ${NEXT}`);
    expect(out).toContain("update --apply");
    expect(readFileSync(path.join(installed, "SKILL.md"), "utf8")).toBe(before);
  });

  it("--apply는 스킬 폴더를 교체하고 임시 폴더를 남기지 않는다", () => {
    publishTag(NEXT);
    const { code, out } = cli("update", "--apply");
    expect(code, out).toBe(0);
    expect(out).toContain("새 세션부터 적용됩니다");
    expect(readFileSync(path.join(installed, "SKILL.md"), "utf8")).toBe(`new ${NEXT}\n`);
    expect(readdirSync(path.dirname(installed))).toEqual(["pr-map"]);
  });

  it("태그 내용이 불완전하면 교체하지 않는다", () => {
    publishTag(NEXT, false);
    const before = readFileSync(path.join(installed, "SKILL.md"), "utf8");
    const { code, out } = cli("update", "--apply");
    expect(code).toBe(1);
    expect(out).toContain("교체하지 않았습니다");
    expect(readFileSync(path.join(installed, "SKILL.md"), "utf8")).toBe(before);
    expect(readdirSync(path.dirname(installed))).toEqual(["pr-map"]);
  });

  it("Git으로 관리되는 스킬 폴더는 교체하지 않는다", () => {
    publishTag(NEXT);
    g(tmp, "init", "-q");
    g(tmp, "add", "skills/pr-map/SKILL.md");
    const { code, out } = cli("update", "--apply");
    expect(code).toBe(1);
    expect(out).toContain("Git으로 관리되는 폴더");
    expect(existsSync(path.join(installed, "scripts/pr-map.js"))).toBe(true);
  });

  it("이미 최신이면 교체하지 않는다", () => {
    publishTag(VERSION);
    const { code, out } = cli("update", "--apply");
    expect(code).toBe(0);
    expect(out).toContain("이미 최신 버전입니다");
  });

  describe("하루 한 번 확인과 알림", () => {
    let repo: string;
    const inRepo = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(installed, "scripts/pr-map.js"), ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
      return { code: r.status, out: r.stdout + r.stderr };
    };
    const cacheFile = () => path.join(tmp, "cache/pr-map/update-check.json");

    beforeEach(() => {
      repo = path.join(tmp, "repo");
      mkdirSync(repo);
      g(repo, "init", "-q", "-b", "main");
      g(repo, "remote", "add", "origin", "https://github.com/acme/api.git");
      writeFileSync(path.join(repo, "a.ts"), "export const a = 1\n");
      g(repo, "add", "-A");
      g(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
    });

    it("collect가 결과를 저장하고 view가 새 버전을 알린다", () => {
      publishTag(NEXT);
      expect(inRepo("collect", "--base", "main").code).toBe(0);
      expect(JSON.parse(readFileSync(cacheFile(), "utf8")).latest).toBe(NEXT);
      const { out } = inRepo("view", "--no-open");
      expect(out).toContain(`새 버전이 있습니다: ${VERSION} → ${NEXT}`);
    });

    it("하루 안에는 다시 확인하지 않는다", () => {
      inRepo("collect", "--base", "main");
      const first = readFileSync(cacheFile(), "utf8");
      publishTag(NEXT);
      inRepo("collect", "--base", "main");
      expect(readFileSync(cacheFile(), "utf8")).toBe(first);
    });

    it("확인에 실패해도 collect는 성공한다", () => {
      writeFileSync(env.GIT_CONFIG_GLOBAL!, `[url "${path.join(tmp, "없는곳.git")}"]\n\tinsteadOf = https://github.com/hong-jun-il/pr-map.git\n`);
      const { code } = inRepo("collect", "--base", "main");
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(cacheFile(), "utf8")).latest).toBeNull();
    });

    it("CI와 끄기 설정에서는 확인하지 않고 알리지도 않는다", () => {
      publishTag(NEXT);
      for (const off of [{ CI: "true" }, { PR_MAP_NO_UPDATE_CHECK: "1" }]) {
        Object.assign(env, off);
        inRepo("collect", "--base", "main");
        expect(existsSync(cacheFile())).toBe(false);
        for (const k of Object.keys(off)) delete env[k];
      }
    });
  });
});
