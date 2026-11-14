import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const outDir = (root: string) => path.join(root, ".pr-map");
export const inputPath = (root: string) =>
  path.join(outDir(root), "input.json");
export const diffPath = (root: string) => path.join(outDir(root), "diff.txt");
export const mapPath = (root: string) => path.join(outDir(root), "pr-map.json");
export const statePath = (root: string) =>
  path.join(outDir(root), "validate-state.json");
export const viewerDataPath = (root: string) =>
  path.join(outDir(root), "viewer-data.json");
export const viewerHtmlPath = (root: string) =>
  path.join(outDir(root), "viewer", "index.html");
export const commentPath = (root: string) =>
  path.join(outDir(root), "comment.md");

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readJsonIfExists<T>(file: string): T | null {
  return existsSync(file) ? readJson<T>(file) : null;
}

export function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

/**
 * 에이전트가 읽는 파일용. 최상위 키마다 한 줄, 배열은 항목마다 한 줄로 쓴다.
 * 들여쓴 JSON보다 훨씬 짧고, 여전히 올바른 JSON이다.
 */
export function compactJson(value: object): string {
  const lines = Object.entries(value).map(([key, v]) =>
    Array.isArray(v) && v.length
      ? `${JSON.stringify(key)}: [\n${v.map((x) => `  ${JSON.stringify(x)}`).join(",\n")}\n]`
      : `${JSON.stringify(key)}: ${JSON.stringify(v)}`,
  );
  return `{\n${lines.join(",\n")}\n}\n`;
}
