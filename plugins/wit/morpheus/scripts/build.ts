/**
 * Builds dist/: each src/*.ts with its types stripped (Node's own stripper, no bundler), imports
 * renamed to .js. dist/ is committed so `npx github:niiashikwei/wit` runs without a build:
 * Node won't strip types inside node_modules.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
  const js = stripTypeScriptTypes(readFileSync(join(src, f), "utf8"), { mode: "strip" })
    .replace(/(from\s+["']\.\/[\w.-]+)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\s*\(\s*["']\.\/[\w.-]+)\.ts(["'])/g, "$1.js$2");
  const dest = join(out, f.replace(/\.ts$/, ".js"));
  writeFileSync(dest, js);
  if (f === "cli.ts") chmodSync(dest, 0o755);
}
console.log(`Built ${readdirSync(out).length} files into dist/`);
