// 저장된 결과를 지금 정답지로 다시 채점하고, 라벨별로 평균과 표준편차를 낸다.
//   node --import tsx eval/score.ts             모든 라벨
//   node --import tsx eval/score.ts old current 두 라벨만 비교
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrMap } from "../src/shared/types";
import type { EvidenceFile } from "./evidence";
import { summarize, type JudgeResult, type JudgeSummary } from "./judge-lib";
import { loadCase, RESULTS_DIR, scoreMap } from "./lib";

interface Metrics {
  case: string;
  agent: {
    turns: number | null;
    durationSec: number;
    costUsd: number | null;
    tokens: {
      input: number;
      cacheWrite: number;
      cacheRead: number;
      output: number;
    };
  };
  validate: { passed: boolean; fixes: number | null };
  coverage: { covered: number; total: number } | null;
  evidenceCheck?: EvidenceFile["check"] | null;
  score?: {
    mustRecall: number;
    recall: number;
    changeAccuracy: number | null;
    nodes: number;
    unverified: number;
    extraNodes: string[];
  } | null;
}

export interface Row {
  label: string;
  case: string;
  passed: boolean;
  fixes: number | null;
  mustRecall: number | null;
  recall: number | null;
  changeAccuracy: number | null;
  unverifiedRate: number | null;
  extraNodes: number | null;
  coverage: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number | null;
  durationSec: number;
  invalidRefRate: number | null;
  changeMismatchRate: number | null;
  judge: JudgeSummary | null;
  judgeCostUsd: number | null;
}

const dirs = (p: string) =>
  existsSync(p)
    ? readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

function readRows(label: string): Row[] {
  const rows: Row[] = [];
  for (const name of dirs(path.join(RESULTS_DIR, label))) {
    let answer;
    try {
      answer = loadCase(name).answer;
    } catch (err) {
      console.error(`건너뜀 ${label}/${name}: ${(err as Error).message}`);
      continue;
    }
    for (const run of dirs(path.join(RESULTS_DIR, label, name))) {
      const dir = path.join(RESULTS_DIR, label, name, run);
      const mFile = path.join(dir, "metrics.json");
      if (!existsSync(mFile)) continue;
      const m = JSON.parse(readFileSync(mFile, "utf8")) as Metrics;
      const mapFile = path.join(dir, "pr-map.json");
      // 지도가 있으면 지금 정답지로 다시 채점하고, 스킬 없는 실행은 저장된 점수를 쓴다.
      const s =
        m.validate.passed && existsSync(mapFile)
          ? scoreMap(JSON.parse(readFileSync(mapFile, "utf8")) as PrMap, answer)
          : m.validate.passed
            ? (m.score ?? null)
            : null;
      const judgeFile = path.join(dir, "judge.json");
      const judged = existsSync(judgeFile)
        ? (JSON.parse(readFileSync(judgeFile, "utf8")) as JudgeResult)
        : null;
      const ec = m.evidenceCheck ?? null;
      const t = m.agent.tokens;
      rows.push({
        label,
        case: name,
        passed: m.validate.passed,
        fixes: m.validate.fixes,
        mustRecall: s?.mustRecall ?? null,
        recall: s?.recall ?? null,
        changeAccuracy: s?.changeAccuracy ?? null,
        unverifiedRate: s ? (s.nodes ? s.unverified / s.nodes : 0) : null,
        extraNodes: s?.extraNodes.length ?? null,
        coverage: m.coverage?.total
          ? m.coverage.covered / m.coverage.total
          : null,
        inputTokens: t.input + t.cacheWrite + t.cacheRead,
        outputTokens: t.output,
        costUsd: m.agent.costUsd,
        turns: m.agent.turns,
        durationSec: m.agent.durationSec,
        invalidRefRate: ec?.refs ? ec.invalidRefs / ec.refs : null,
        changeMismatchRate: ec?.nodes ? ec.changeMismatch / ec.nodes : null,
        judge: judged ? summarize(judged) : null,
        judgeCostUsd: judged?.costUsd ?? null,
      });
    }
  }
  return rows;
}

export function meanSd(
  xs: (number | null)[],
): { mean: number; sd: number; n: number } | null {
  const v = xs.filter((x): x is number => typeof x === "number");
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd =
    v.length > 1
      ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
      : 0;
  return { mean, sd, n: v.length };
}

const pct = (x: ReturnType<typeof meanSd>) =>
  x ? `${Math.round(x.mean * 100)}% ± ${Math.round(x.sd * 100)}` : "-";
const num = (x: ReturnType<typeof meanSd>, digits = 0) =>
  x
    ? `${x.mean.toLocaleString("en-US", { maximumFractionDigits: digits })} ± ${x.sd.toLocaleString("en-US", { maximumFractionDigits: digits })}`
    : "-";

const rate = (
  j: JudgeSummary | null,
  k: "partial" | "wrong" | "unsupported",
) => (j && j.judged ? j[k] / j.judged : null);

const COLUMNS: [string, (rs: Row[]) => string][] = [
  ["실행", (rs) => String(rs.length)],
  ["검증 통과", (rs) => pct(meanSd(rs.map((r) => (r.passed ? 1 : 0))))],
  ["수정 횟수", (rs) => num(meanSd(rs.map((r) => r.fixes)), 1)],
  ["근거 줄 오류", (rs) => pct(meanSd(rs.map((r) => r.invalidRefRate)))],
  [
    "상태·근거 불일치",
    (rs) => pct(meanSd(rs.map((r) => r.changeMismatchRate))),
  ],
  [
    "정밀도 (맞음)",
    (rs) => pct(meanSd(rs.map((r) => r.judge?.precision ?? null))),
  ],
  ["일부 맞음", (rs) => pct(meanSd(rs.map((r) => rate(r.judge, "partial"))))],
  ["틀림", (rs) => pct(meanSd(rs.map((r) => rate(r.judge, "wrong"))))],
  [
    "근거 불일치",
    (rs) => pct(meanSd(rs.map((r) => rate(r.judge, "unsupported")))),
  ],
  [
    "필수 동작 재현율 (뜻까지)",
    (rs) => pct(meanSd(rs.map((r) => r.judge?.strictMustRecall ?? null))),
  ],
  [
    "틀린 주장 수",
    (rs) => num(meanSd(rs.map((r) => r.judge?.forbiddenViolations ?? null)), 1),
  ],
  [
    "필수 동작 재현율 (줄 겹침)",
    (rs) => pct(meanSd(rs.map((r) => r.mustRecall))),
  ],
  ["전체 재현율 (줄 겹침)", (rs) => pct(meanSd(rs.map((r) => r.recall)))],
  ["상태 일치", (rs) => pct(meanSd(rs.map((r) => r.changeAccuracy)))],
  ["변경 줄 커버리지", (rs) => pct(meanSd(rs.map((r) => r.coverage)))],
  ["강등 비율", (rs) => pct(meanSd(rs.map((r) => r.unverifiedRate)))],
  ["정답지 밖 노드", (rs) => num(meanSd(rs.map((r) => r.extraNodes)), 1)],
  ["입력 토큰", (rs) => num(meanSd(rs.map((r) => r.inputTokens)))],
  ["출력 토큰", (rs) => num(meanSd(rs.map((r) => r.outputTokens)))],
  ["추정 비용($)", (rs) => num(meanSd(rs.map((r) => r.costUsd)), 3)],
  ["턴", (rs) => num(meanSd(rs.map((r) => r.turns)), 1)],
  ["시간(초)", (rs) => num(meanSd(rs.map((r) => r.durationSec)))],
  ["채점 비용($)", (rs) => num(meanSd(rs.map((r) => r.judgeCostUsd)), 3)],
];

function table(title: string, groups: [string, Row[]][]): string {
  const head = ["", ...groups.map(([g]) => g)];
  const lines = [
    `### ${title}`,
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...COLUMNS.map(
      ([name, f]) =>
        `| ${name} | ${groups.map(([, rs]) => f(rs)).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

function main(): void {
  const labels = process.argv.slice(2).length
    ? process.argv.slice(2)
    : dirs(RESULTS_DIR);
  const rows = labels.flatMap(readRows);
  if (!rows.length) {
    console.log("집계할 결과가 없습니다. 먼저 eval/run.ts --yes로 실행하세요.");
    return;
  }
  const byLabel = labels.map(
    (l) => [l, rows.filter((r) => r.label === l)] as [string, Row[]],
  );
  const parts = [
    "## PR Map 평가 결과",
    "",
    "값은 평균 ± 표준편차입니다. 정밀도, 일부 맞음, 틀림, 근거 불일치, 뜻까지 본 재현율, 틀린 주장 수는 채점 모델의 판정이고, 나머지는 규칙으로 계산한 값입니다. 채점하지 않은 실행은 -로 표시합니다.",
    "",
    table("전체", byLabel),
  ];
  for (const name of [...new Set(rows.map((r) => r.case))].sort()) {
    parts.push(
      "",
      table(
        name,
        byLabel.map(
          ([l, rs]) =>
            [l, rs.filter((r) => r.case === name)] as [string, Row[]],
        ),
      ),
    );
  }
  const md = parts.join("\n") + "\n";
  writeFileSync(path.join(RESULTS_DIR, "summary.md"), md);
  console.log(md);
  console.log(`저장: ${path.join(RESULTS_DIR, "summary.md")}`);
}

main();
