import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

const url = "http://127.0.0.1:5173/";
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function openBrowser() {
  const system = platform();
  if (system === "darwin") return spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  if (system === "win32") return spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  return spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

try {
  if (!existsSync("node_modules")) {
    console.log("Installing dependencies...");
    await run(npmCommand, ["install"]);
  }

  console.log(`Starting table editor at ${url}`);
  setTimeout(openBrowser, 900);
  await run(npmCommand, ["run", "dev"]);
} catch (error) {
  console.error("");
  console.error("Setup failed.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error("Please install Node.js first, then run: npm install && npm run dev");
  process.exit(1);
}
