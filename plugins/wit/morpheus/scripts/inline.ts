/**
 * Inlines the dashboard's ES modules (web/src/*.js) into its page as one classic script that
 * defines `W`, the modules' exports. Imports between the modules are dropped: they share a scope.
 */
export const MODULES = ["format.js", "charts.js", "views.js"];

export function bundle(read: (file: string) => string, modules = MODULES): string {
  const names: string[] = [];
  const body = modules
    .map((f) => {
      const src = read(f).replace(/^import\s[^;]*;\s*$/gm, "");
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm)) names.push(m[1]!);
      return `// ${f}\n${src.replace(/^export\s+/gm, "")}`;
    })
    .join("\n");
  return `const W = (() => {\n"use strict";\n${body}\nreturn { ${names.join(", ")} };\n})();`;
}

export function inlinePage(shell: string, read: (file: string) => string): string {
  if (!shell.includes("<!-- @inline lib -->")) throw new Error("shell.html has no <!-- @inline lib --> marker");
  const js = bundle(read).replace(/<\/script/gi, "<\\/script");
  return shell.replace("<!-- @inline lib -->", () => `<script>\n${js}\n</script>`);
}
