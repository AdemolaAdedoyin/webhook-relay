/** Serializes maintenance and drains its active pass before shared resources close. */
export function startMaintenanceLoop(
  run: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void
) {
  let stopped = false;
  let active: Promise<void> | undefined;

  function tick() {
    if (stopped || active) return;
    active = Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => { active = undefined; });
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();

  return async function stop() {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
