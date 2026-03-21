#!/usr/bin/env node
/**
 * MCP 开发态热更新：子进程跑 `tsx src/index.ts`，stdout 仅承载 JSON-RPC。
 * 本脚本只在 stderr 打日志，避免污染 Cursor / MCP 的 stdio 通道。
 *
 * Cursor mcp.json 建议：
 *   "command": "node",
 *   "args": ["<repo>/scripts/mcp-dev-watch.mjs"],
 *   "cwd": "<repo>"
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const tsxBin = join(root, "node_modules", ".bin", "tsx");

let child = null;
let debounce = null;

function start() {
  if (child) {
    child.kill("SIGTERM");
    child = null;
  }

  child = spawn(tsxBin, ["src/index.ts"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env },
    shell: false
  });

  child.on("exit", (code, sig) => {
    if (sig === "SIGTERM") return;
    console.error(`[mcp-watch] child exited code=${code ?? "null"}`);
  });
}

function scheduleRestart() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.error("[mcp-watch] code changed, restarting...");
    start();
  }, 150);
}

start();

const srcDir = join(root, "src");
try {
  watch(
    srcDir,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      const s = filename.toString();
      if (!/\.(ts|tsx|mts|cts)$/.test(s)) return;
      scheduleRestart();
    }
  );
} catch (e) {
  console.error("[mcp-watch] fs.watch failed:", e);
  process.exit(1);
}

function shutdown() {
  if (debounce) clearTimeout(debounce);
  if (child) child.kill("SIGTERM");
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
