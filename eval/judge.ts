// 저장된 분석 결과를 다른 모델로 채점한다. 분석을 다시 돌리지 않는다.
//   node --import tsx eval/judge.ts                 채점하지 않은 실행을 모두 채점
//   node --import tsx eval/judge.ts current --case free-price --force
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { EvidenceFile } from "./evidence";
import { judgeRun, summarize, type Judge } from "./judge-lib";
import { loadCase, RESULTS_DIR } from "./lib";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string", multiple: true },
    model: { type: "string", default: "opus" },
    votes: { type: "string", default: "3" },
    "chunk-size": { type: "string", default: "12" },
    concurrency: { type: "string", default: "4" },
    force: { type: "boolean", default: false },
  },
});

const dirs = (p: string) =>
  existsSync(p)
    ? readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

/** 도구 없이, 준 문장과 코드만 보고 정해진 형식으로 답하게 한다. */
const claudeJudge: Judge = (rubric, prompt, schema) =>
  new Promise((resolve) => {
    const child = execFile(
      "claude",
      [
        "-p",
        "--model",
        values.model,
        "--system-prompt",
        rubric,
        "--tools",
        "",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
      (_err, stdout) => {
        try {
          const r = JSON.parse(stdout) as {
            is_error?: boolean;
            structured_output?: unknown;
            total_cost_usd?: number;
          };
          if (r.is_error || !r.structured_output) return resolve(null);
          resolve({
            output: r.structured_output,
            costUsd: r.total_cost_usd ?? 0,
          });
        } catch {
          resolve(null);
        }
      },
    );
    child.stdin?.end(prompt);
  });

async function main(): Promise<void> {
  const labels = positionals.length ? positionals : dirs(RESULTS_DIR);
  let total = 0;
  for (const label of labels) {
    for (const name of dirs(path.join(RESULTS_DIR, label))) {
      if (values.case?.length && !values.case.includes(name)) continue;
      for (const run of dirs(path.join(RESULTS_DIR, label, name))) {
        const dir = path.join(RESULTS_DIR, label, name, run);
        const file = path.join(dir, "evidence.json");
        const out = path.join(dir, "judge.json");
        if (!existsSync(file)) continue;
        if (existsSync(out) && !values.force) continue;
        const evidence = JSON.parse(readFileSync(file, "utf8")) as EvidenceFile;
        const result = await judgeRun(
          evidence,
          loadCase(name).answer,
          claudeJudge,
          {
            model: values.model,
            votes: Number(values.votes),
            chunkSize: Number(values["chunk-size"]),
            concurrency: Number(values.concurrency),
          },
        );
        writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
        total += result.costUsd;
        const s = summarize(result);
        const pct = (x: number | null) =>
          x === null ? "-" : `${Math.round(x * 100)}%`;
        console.log(
          `${label}/${name}/${run}: 노드 ${s.judged}개 · 맞음 ${s.correct} · 일부 ${s.partial} · 틀림 ${s.wrong} · 근거 불일치 ${s.unsupported}` +
            ` · 필수 동작(뜻까지) ${pct(s.strictMustRecall)} · 틀린 주장 ${s.forbiddenViolations}` +
            ` · 채점 $${result.costUsd.toFixed(3)}` +
            (result.failedCalls ? ` · 실패한 호출 ${result.failedCalls}` : ""),
        );
      }
    }
  }
  console.log(
    `\n채점 추정 비용 합계 $${total.toFixed(3)} (모델 ${values.model})`,
  );
}

void main();
