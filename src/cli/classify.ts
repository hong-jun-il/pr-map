import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ChangedFile,
  UnclassifiedCategory,
  UnclassifiedFile,
} from "../shared/types";

export const DEFAULT_MAX_FILES = 50;

export interface PrMapConfig {
  exclude: string[];
  maxFiles: number;
  includeTests?: boolean;
}

const CODE_EXT = new Set(
  "ts tsx mts cts js jsx mjs cjs vue svelte py go java kt kts rb rs c h cc cpp hpp cs php swift scala sh bash sql".split(
    " ",
  ),
);
const DOC_EXT = new Set("md mdx rst txt adoc".split(" "));
const GENERATED_NAME = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
]);
const GENERATED_PATH =
  /(^|\/)(dist|build|vendor|node_modules|__generated__|\.next)\/|\.min\.(js|css)$|\.(snap|map)$|\.generated\./;
// 테스트 코드와 그 지원 파일(스토리, 러너 설정). 제품 동작 지도를 복잡하게 만들므로 기본으로 뺀다.
const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|e2e|cypress|\.storybook)\/|\.(test|spec|cy|e2e|stories|story)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$|(^|\/)(playwright|vitest|jest|cypress)(\.[^/]+)?\.config\.[^/]+$/;

export const isTestPath = (file: string): boolean => TEST_PATH.test(file);

export function readConfig(root: string): PrMapConfig {
  const file = path.join(root, ".pr-map.yml");
  const config: PrMapConfig = { exclude: [], maxFiles: DEFAULT_MAX_FILES };
  if (!existsSync(file)) return config;
  const raw = parseYaml(
    readFileSync(file, "utf8"),
  ) as Partial<PrMapConfig> | null;
  if (Array.isArray(raw?.exclude)) config.exclude = raw.exclude.map(String);
  if (typeof raw?.maxFiles === "number" && raw.maxFiles > 0)
    config.maxFiles = raw.maxFiles;
  if (raw?.includeTests === true) config.includeTests = true;
  return config;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // 슬래시로 끝나는 패턴은 디렉터리 전체를 뜻한다.
  if (glob.endsWith("/")) re += ".*";
  return new RegExp("^" + re + "$");
}

function reasonFor(
  file: ChangedFile,
  excludes: RegExp[],
  includeTests: boolean,
): { reason: string; category: UnclassifiedCategory } | null {
  const name = path.posix.basename(file.path);
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (file.binary) return { reason: "바이너리", category: "other" };
  if (excludes.some((re) => re.test(file.path)))
    return { reason: ".pr-map.yml 제외", category: "excluded" };
  if (!includeTests && TEST_PATH.test(file.path))
    return {
      reason: "테스트 · 기본 제외",
      category: CODE_EXT.has(ext) ? "test" : "fixture",
    };
  if (GENERATED_NAME.has(name) || GENERATED_PATH.test(file.path))
    return { reason: "자동 생성 · 제외 규칙", category: "generated" };
  if (DOC_EXT.has(ext)) return { reason: "문서", category: "doc" };
  if (!CODE_EXT.has(ext))
    return { reason: "지원하지 않는 형식", category: "other" };
  return null;
}

/** 지도에 넣을 파일과 미분류 파일을 나눈다. 상한을 넘으면 변경량이 큰 파일을 남긴다. */
export function classify(
  files: ChangedFile[],
  config: PrMapConfig,
): { files: ChangedFile[]; unclassified: UnclassifiedFile[] } {
  const excludes = config.exclude.map(globToRegExp);
  const kept: ChangedFile[] = [];
  const unclassified: UnclassifiedFile[] = [];
  for (const f of files) {
    const found = reasonFor(f, excludes, config.includeTests === true);
    if (found) unclassified.push({ ...f, ...found });
    else kept.push(f);
  }
  const ranked = [...kept].sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path),
  );
  const allowed = new Set(ranked.slice(0, config.maxFiles).map((f) => f.path));
  const mapped = kept.filter((f) => allowed.has(f.path));
  for (const f of kept) {
    if (!allowed.has(f.path))
      unclassified.push({
        ...f,
        reason: `분석 상한 ${config.maxFiles}개 초과`,
        category: "attention",
      });
  }
  return { files: mapped, unclassified };
}
