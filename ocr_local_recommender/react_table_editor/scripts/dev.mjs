import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import esbuild from "esbuild";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 5173);

await mkdir("dist", { recursive: true });
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

const context = await esbuild.context({
  entryPoints: ["src/main.tsx"],
  bundle: true,
  outdir: "dist/assets",
  entryNames: "index",
  assetNames: "[name]",
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  sourcemap: true,
  loader: {
    ".css": "css",
  },
});

await context.watch();
await context.rebuild();

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const cleanPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requested = cleanPath === "/" ? "/index.html" : cleanPath;
  const filePath = join(process.cwd(), "dist", requested);
  const fallbackPath = join(process.cwd(), "dist", "index.html");
  const finalPath = existsSync(filePath) ? filePath : fallbackPath;
  const type = types[extname(finalPath)] ?? "application/octet-stream";

  response.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  createReadStream(finalPath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Local: http://${host}:${port}/`);
});

process.on("SIGINT", async () => {
  await context.dispose();
  server.close(() => process.exit(0));
});
