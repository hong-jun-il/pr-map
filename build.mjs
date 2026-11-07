// 뷰어를 단일 HTML 템플릿으로, CLI를 의존성 없는 파일 하나로 번들한다.
// `npx skills add`는 의존성을 설치하지 않으므로 스킬 폴더만으로 실행되어야 한다.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const skill = "skill/pr-map";
for (const d of ["scripts", "assets", "spec"])
  mkdirSync(`${skill}/${d}`, { recursive: true });

await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: `${skill}/scripts/pr-map.js`,
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __PR_MAP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync("package.json", "utf8")).version,
    ),
  },
  logLevel: "warning",
});
// 설치된 저장소가 "type": "module"이어도 CommonJS 번들로 읽히게 한다.
writeFileSync(`${skill}/scripts/package.json`, '{ "type": "commonjs" }\n');

const viewer = await build({
  entryPoints: ["src/viewer/main.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outdir: "out",
  write: false,
  logLevel: "warning",
});
const js = viewer.outputFiles
  .find((f) => f.path.endsWith(".js"))
  .text.replace(/<\/script/g, "<\\/script");
const css = viewer.outputFiles.find((f) => f.path.endsWith(".css")).text;
const template = readFileSync("src/viewer/template.html", "utf8")
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js);
writeFileSync(`${skill}/assets/viewer.html`, template);

copyFileSync("spec/pr-map.schema.json", `${skill}/spec/pr-map.schema.json`);
copyFileSync("spec/validate-rules.md", `${skill}/spec/validate-rules.md`);
console.log("skill/pr-map 빌드 완료");
