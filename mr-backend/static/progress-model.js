(function initialiseProgressModel(scope) {
  const EXPECTED_DURATION_MS = 90_000;
  const START_PERCENT = 2;
  const EXPECTED_PERCENT = 95;
  const WAITING_CEILING_PERCENT = 98;

  function estimateProgress(elapsedMs) {
    const safeElapsed = Math.max(0, Number(elapsedMs) || 0);
    if (safeElapsed <= EXPECTED_DURATION_MS) {
      const ratio = safeElapsed / EXPECTED_DURATION_MS;
      return START_PERCENT + (EXPECTED_PERCENT - START_PERCENT) * ratio;
    }

    const overrun = safeElapsed - EXPECTED_DURATION_MS;
    const tail = 1 - Math.exp(-overrun / 60_000);
    return Math.min(
      WAITING_CEILING_PERCENT,
      EXPECTED_PERCENT + (WAITING_CEILING_PERCENT - EXPECTED_PERCENT) * tail,
    );
  }

  function advanceProgress(current, target, elapsedSinceFrameMs) {
    const safeCurrent = Math.max(0, Math.min(WAITING_CEILING_PERCENT, Number(current) || 0));
    const safeTarget = Math.max(safeCurrent, Math.min(WAITING_CEILING_PERCENT, Number(target) || 0));
    const frameMs = Math.max(0, Number(elapsedSinceFrameMs) || 0);
    const maximumStep = Math.max(0.08, Math.min(frameMs, 1_000) * 0.008);
    return Math.min(safeTarget, safeCurrent + maximumStep);
  }

  scope.MRRemovalProgress = Object.freeze({
    EXPECTED_DURATION_MS,
    WAITING_CEILING_PERCENT,
    estimateProgress,
    advanceProgress,
  });
}(globalThis));
