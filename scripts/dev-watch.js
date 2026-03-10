#!/usr/bin/env node
/**
 * File watcher for dev workflow — watches src/ and rebuilds on change.
 *
 * The app polls dist/renderer.js mtime and relaunches itself when it
 * changes (app.relaunch spawns a new independent process). This watcher
 * just keeps rebuilding — it doesn't track Electron's lifecycle after
 * the initial spawn.
 *
 * Usage:
 *   node scripts/dev-watch.js [-- electron args...]
 *   npm run dev:watch
 *   npm run dev:watch -- --instance my-feature
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DEBOUNCE_MS = 300;

let debounceTimer = null;
let building = false;
let pendingBuild = false;

function build() {
  if (building) {
    pendingBuild = true;
    return;
  }
  building = true;
  console.log("[watch] Building...");
  try {
    execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
    console.log("[watch] Build complete.");
  } catch {
    console.error("[watch] Build failed.");
  }
  building = false;
  if (pendingBuild) {
    pendingBuild = false;
    build();
  }
}

// Watch src/ for changes
const watcher = fs.watch(SRC, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  // Ignore dotfiles, temp files, and non-source files
  if (filename.startsWith(".")) return;
  if (filename.endsWith("~")) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    build();
  }, DEBOUNCE_MS);
});

// Parse args after "--" as electron args
const dashIdx = process.argv.indexOf("--");
const electronArgs = dashIdx !== -1 ? process.argv.slice(dashIdx + 1) : [];

// Ensure --dev flag is present (Electron auto-detects instance name from worktree)
if (!electronArgs.includes("--dev") && !electronArgs.includes("--instance")) {
  electronArgs.push("--dev");
}

// Initial build + launch Electron
build();
console.log("[watch] Starting Electron with args:", electronArgs.join(" "));
const electron = require("electron");
const child = spawn(electron, [ROOT, ...electronArgs], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});

// Don't exit when Electron exits — app.relaunch() spawns a new independent
// process, so our child dying is expected. Keep watching and rebuilding.
child.on("exit", () => {
  console.log(
    "[watch] Electron exited. Still watching for changes... (Ctrl+C to stop)",
  );
});

// Only exit on explicit signal
function shutdown() {
  watcher.close();
  // Kill Electron child if still alive
  try {
    child.kill();
  } catch {
    /* already dead */
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, shutdown);
}
