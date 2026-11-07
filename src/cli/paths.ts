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
