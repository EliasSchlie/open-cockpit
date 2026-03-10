/**
 * Test environment helper — creates isolated temp directories for testing.
 *
 * Sets OPEN_COCKPIT_TEST_DIR so all path constants point to a temp dir.
 * Provides requireFresh() to force module re-import after env change.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const SUBDIRS = [
  "session-pids",
  "idle-signals",
  "intentions",
  "offloaded",
  "setup-scripts",
  "layouts",
];

/**
 * Create an isolated test environment.
 * Call in beforeAll/beforeEach. Call cleanup() in afterAll/afterEach.
 */
export function createTestEnv(prefix = "open-cockpit-test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  const origEnv = process.env.OPEN_COCKPIT_TEST_DIR;
  process.env.OPEN_COCKPIT_TEST_DIR = dir;

  // Track modules loaded via requireFresh so we can clean them up
  const loadedModules = new Set();

  return {
    dir,

    /** Absolute path within the test dir */
    resolve(...segments) {
      return path.join(dir, ...segments);
    },

    /**
     * Import a module with a fresh module cache so it picks up the test env var.
     * Pass absolute path or relative from project root.
     */
    requireFresh(modulePath) {
      // Resolve relative paths from the project src dir
      const abs = path.isAbsolute(modulePath)
        ? modulePath
        : path.resolve(
            path.dirname(new URL(import.meta.url).pathname),
            "../../src",
            modulePath,
          );

      // Clear this module and all src/ modules from cache
      // (they import paths.js which caches the old value)
      for (const key of Object.keys(require.cache)) {
        if (key.includes("/src/") || key.includes("/test/")) {
          delete require.cache[key];
          loadedModules.add(key);
        }
      }

      return require(abs);
    },

    /** Write a JSON file in the test dir */
    writeJson(relativePath, data) {
      const fullPath = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
    },

    /** Write a text file in the test dir */
    writeFile(relativePath, content) {
      const fullPath = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    },

    /** Read a JSON file from the test dir */
    readJson(relativePath) {
      return JSON.parse(fs.readFileSync(path.join(dir, relativePath), "utf-8"));
    },

    /** Clean up temp dir and restore env */
    cleanup() {
      // Restore env
      if (origEnv === undefined) {
        delete process.env.OPEN_COCKPIT_TEST_DIR;
      } else {
        process.env.OPEN_COCKPIT_TEST_DIR = origEnv;
      }

      // Clear cached modules so next test gets fresh imports
      for (const key of loadedModules) {
        delete require.cache[key];
      }
      for (const key of Object.keys(require.cache)) {
        if (key.includes("/src/") || key.includes("/test/")) {
          delete require.cache[key];
        }
      }

      // Remove temp dir
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort — may fail on Windows with open handles
      }
    },
  };
}
