// Async mutex for pool.json read-modify-write cycles.
// Combines in-process serialization (promise chain) with cross-process file locking
// to prevent lost updates when multiple Electron instances share the same pool.
// NOT reentrant — calling withPoolLock from inside withPoolLock will deadlock.

const fs = require("fs");

module.exports = { createPoolLock };

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
      if (err.code === "EEXIST") {
        // Check for stale lock (owner PID dead)
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
        return false;
      }
      throw err;
    }
  }

  // Acquire the cross-process file lock, retrying until timeout.
  async function acquireFileLock(maxWait = 10000) {
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
