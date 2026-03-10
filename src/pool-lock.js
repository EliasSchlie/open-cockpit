// Async mutex for pool.json read-modify-write cycles.
// Combines in-process serialization (promise chain) with cross-process file locking
// to prevent lost updates when multiple Electron instances share the same pool.
// NOT reentrant — calling withPoolLock from inside withPoolLock will deadlock.

const fs = require("fs");
const { isPidAlive } = require("./paths");

module.exports = { createPoolLock };

function createPoolLock(poolFilePath) {
  const lockFile = poolFilePath + ".lock";
  let _poolLock = Promise.resolve();
  let _poolLockHeld = false;

  // Try to acquire the cross-process file lock (non-blocking).
  // Returns true on success, false if another process holds it.
  function tryAcquireFileLock() {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  }

  // Check if the current lockfile is stale (owner PID dead) and clean it up.
  function tryCleanStaleLock() {
    try {
      const content = fs.readFileSync(lockFile, "utf-8").trim();
      const ownerPid = parseInt(content.split("\n")[0], 10);
      if (ownerPid && !isPidAlive(ownerPid)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* race — another process cleaned it */
        }
      }
    } catch {
      /* race — file disappeared */
    }
  }

  // Acquire the cross-process file lock, retrying until timeout.
  async function acquireFileLock(maxWait = 10000) {
    if (tryAcquireFileLock()) return;

    // Lock is held — check once for stale lock before entering retry loop
    tryCleanStaleLock();

    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (tryAcquireFileLock()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Force-steal after timeout (safety valve — prevents permanent deadlock
    // if a process crashed between acquire and release)
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ok */
    }
    if (!tryAcquireFileLock()) {
      throw new Error("Pool file lock timeout");
    }
  }

  function releaseFileLock() {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ENOENT — already released */
    }
  }

  function withPoolLock(fn) {
    const p = _poolLock.then(async () => {
      if (_poolLockHeld) {
        throw new Error(
          "withPoolLock called while lock is held — nested calls deadlock. " +
            "Restructure to avoid nesting (see withFreshSlot pattern).",
        );
      }
      _poolLockHeld = true;
      await acquireFileLock();
      try {
        return await fn();
      } finally {
        releaseFileLock();
        _poolLockHeld = false;
      }
    });
    _poolLock = p.then(
      () => {},
      () => {},
    ); // keep chain alive, don't retain resolved values
    return p;
  }

  return { withPoolLock };
}
