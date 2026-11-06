// 시안의 예시 PR을 임시 저장소로 만들어 전체 파이프라인을 돌리고 뷰어를 연다.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeFixture } from "./fixture";

const fx = makeFixture();
const cli = path.resolve("skill/pr-map/scripts/pr-map.js");
const run = (...args: string[]) =>
  console.log(
    execFileSync("node", [cli, ...args], {
      cwd: fx.root,
      env: fx.env,
      encoding: "utf8",
    }),
  );

run("collect");
writeFileSync(
  path.join(fx.root, ".pr-map/pr-map.json"),
  readFileSync("test/fixtures/pr-map.json"),
);
run("build");
if (process.argv.includes("--stale"))
  fx.env.FAKE_GH_LATEST = "e81d0b2e81d0b2e81d0b2e81d0b2e81d0b2e81d0";
run("view", ...(process.argv.includes("--no-open") ? ["--no-open"] : []));
console.log(`임시 저장소: ${fx.root}`);
