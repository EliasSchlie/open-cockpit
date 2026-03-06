// Async mutex for pool.json read-modify-write cycles.
// Serializes all concurrent access to prevent lost updates.
// NOT reentrant — calling withPoolLock from inside withPoolLock will deadlock.

export function createPoolLock() {
  let _poolLock = Promise.resolve();
  let _poolLockHeld = false;

  function withPoolLock(fn) {
    const p = _poolLock.then(async () => {
      if (_poolLockHeld) {
        throw new Error(
          "withPoolLock called while lock is held — nested calls deadlock. " +
            "Restructure to avoid nesting (see withFreshSlot pattern).",
        );
      }
      _poolLockHeld = true;
      try {
        return await fn();
      } finally {
        _poolLockHeld = false;
      }
    });
    _poolLock = p.catch(() => {}); // keep chain alive on errors
    return p;
  }

  return { withPoolLock };
}
