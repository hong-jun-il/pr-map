import path from "node:path";
import type { ChangedFile, RelationCandidate } from "../shared/types";
import { git, tryGit } from "./git";

const TSJS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_SCANNED_PER_FILE = 200;

export interface ImportRef {
  spec: string;
  symbols: string[];
}

/** TS/JS의 정적 import·re-export·require·동적 import를 찾는다. 후보이므로 완벽할 필요는 없다. */
export function parseImports(source: string): ImportRef[] {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const out: ImportRef[] = [];
  const fromRe =
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?([^'"`;]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text))) {
    const named = /\{([^}]*)\}/.exec(m[1]!);
    const symbols = named
      ? named[1]!
          .split(",")
          .map((s) =>
            s
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0]!
              .trim(),
          )
          .filter(Boolean)
      : [];
    const def = /^([A-Za-z_$][\w$]*)/.exec(m[1]!);
    if (def) symbols.unshift(def[1]!);
    out.push({ spec: m[2]!, symbols });
  }
  const bareRe =
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = bareRe.exec(text)))
    out.push({ spec: (m[1] ?? m[2] ?? m[3])!, symbols: [] });
  return out;
}

interface Alias {
  prefix: string;
  suffix: string;
  targets: string[];
}

/** 주석과 후행 쉼표가 있는 tsconfig를 문자열을 해치지 않고 읽는다. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readAliases(root: string, head: string): Alias[] {
  const raw = tryGit(root, "show", `${head}:tsconfig.json`);
  if (!raw) return [];
  try {
    const cfg = parseJsonc(raw) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const baseUrl = cfg.compilerOptions?.baseUrl ?? ".";
    return Object.entries(cfg.compilerOptions?.paths ?? {}).map(
      ([pattern, targets]) => {
        const [prefix = "", suffix = ""] = pattern.split("*");
        return {
          prefix,
          suffix,
          targets: targets.map((t) => path.posix.join(baseUrl, t)),
        };
      },
    );
  } catch {
    return [];
  }
}

export function resolveSpec(
  spec: string,
  from: string,
  tree: Set<string>,
  aliases: Alias[],
): string | null {
  const bases: string[] = [];
  if (spec.startsWith("."))
    bases.push(path.posix.join(path.posix.dirname(from), spec));
  else {
    for (const a of aliases) {
      if (
        spec.startsWith(a.prefix) &&
        spec.endsWith(a.suffix) &&
        spec.length >= a.prefix.length + a.suffix.length
      ) {
        const mid = spec.slice(a.prefix.length, spec.length - a.suffix.length);
        for (const t of a.targets) bases.push(t.replace("*", mid));
      }
    }
  }
  for (const b of bases) {
    if (tree.has(b)) return b;
    for (const e of EXTS) if (tree.has(b + e)) return b + e;
    // ESM TS는 './x.js'로 적고 x.ts를 가리킨다.
    const noJs = b.replace(/\.(js|jsx|mjs|cjs)$/, "");
    if (noJs !== b)
      for (const e of EXTS) if (tree.has(noJs + e)) return noJs + e;
    for (const e of EXTS)
      if (tree.has(`${b}/index${e}`)) return `${b}/index${e}`;
  }
  return null;
}

/** 변경 파일이 쓰는 파일과 변경 파일을 쓰는 파일을 관계 후보로 모은다. */
export function collectCandidates(
  root: string,
  base: string,
  head: string,
  files: ChangedFile[],
): RelationCandidate[] {
  const targets = files.filter((f) => TSJS.test(f.path));
  if (!targets.length) return [];
  const aliases = readAliases(root, head);
  const headTree = new Set(
    git(root, "ls-tree", "-r", "--name-only", head).split("\n").filter(Boolean),
  );
  const deleted = targets
    .filter((f) => f.status === "deleted")
    .map((f) => f.path);
  const resolveTree = new Set([...headTree, ...deleted]);
  const baseTree = deleted.length
    ? new Set(
        git(root, "ls-tree", "-r", "--name-only", base)
          .split("\n")
          .filter(Boolean),
      )
    : headTree;
  const seen = new Map<string, RelationCandidate>();
  const add = (from: string, to: string, symbols: string[]) => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    const hit = seen.get(key);
    if (hit) hit.symbols = [...new Set([...hit.symbols, ...symbols])];
    else seen.set(key, { from, to, symbols: [...new Set(symbols)] });
  };

  for (const f of targets) {
    const side = f.status === "deleted" ? base : head;
    const src = tryGit(root, "show", `${side}:${f.path}`);
    if (src === null) continue;
    for (const imp of parseImports(src)) {
      const to = resolveSpec(
        imp.spec,
        f.path,
        f.status === "deleted" ? baseTree : headTree,
        aliases,
      );
      if (to) add(f.path, to, imp.symbols);
    }
  }

  // 역방향: 변경 파일을 import하는 파일(직접 호출자 후보)
  const targetSet = new Set(targets.map((f) => f.path));
  for (const f of targets) {
    const name = path.posix.basename(f.path).replace(TSJS, "");
    const stem =
      name === "index" ? path.posix.basename(path.posix.dirname(f.path)) : name;
    const grep = tryGit(
      root,
      "grep",
      "-l",
      "-F",
      "-e",
      stem,
      head,
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.js",
      "*.jsx",
      "*.mjs",
      "*.cjs",
    );
    if (!grep) continue;
    const hits = grep
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf(":") + 1))
      .slice(0, MAX_SCANNED_PER_FILE);
    for (const importer of hits) {
      if (targetSet.has(importer)) continue; // 이미 정방향에서 처리했다.
      const src = tryGit(root, "show", `${head}:${importer}`);
      if (src === null) continue;
      for (const imp of parseImports(src)) {
        if (resolveSpec(imp.spec, importer, resolveTree, aliases) === f.path)
          add(importer, f.path, imp.symbols);
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}
