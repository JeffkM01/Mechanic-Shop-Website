// HTTP sockets can close before their asynchronous handlers finish. Keep the
// actual handler promises alive until database work has settled during a drain.
export function createOperationTracker() {
  let accepting = true;
  let active = 0;
  let draining;
  let resolveDrained;

  function wrap(handler) {
    return async (req, res, next) => {
      if (!accepting) return res.status(503).json({ error: "The service is restarting. Please try again shortly.", code: "SERVICE_DRAINING" });
      active++;
      try { return await handler(req, res, next); }
      finally {
        active--;
        if (active === 0) resolveDrained?.();
      }
    };
  }

  function stop() {
    accepting = false;
    if (!draining) draining = new Promise(resolve => {
      resolveDrained = resolve;
      if (active === 0) resolve();
    });
    return draining;
  }

  return { wrap, stop, isAccepting: () => accepting };
}
