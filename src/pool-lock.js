// Async mutex for pool.json read-modify-write cycles.
// Serializes all concurrent access to prevent lost updates.
// NOT reentrant — calling withPoolLock from inside withPoolLock will deadlock.

module.exports = { createPoolLock };

function createPoolLock() {
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
    _poolLock = p.then(
      () => {},
      () => {},
    ); // keep chain alive, don't retain resolved values
    return p;
  }

  return { withPoolLock };
}
