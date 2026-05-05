import { mkdir, rm, writeFile } from "node:fs/promises";
import esbuild from "esbuild";

const production = process.env.NODE_ENV !== "development";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/main.tsx"],
  bundle: true,
  outdir: "dist/assets",
  entryNames: "index",
  assetNames: "[name]",
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  sourcemap: !production,
  minify: production,
  loader: {
    ".css": "css",
  },
});

await writeFile(
  "dist/index.html",
  `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Table Editor</title>
    <link rel="stylesheet" href="./assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/index.js"></script>
  </body>
</html>
`,
);
