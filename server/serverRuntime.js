// The application is deliberately one long-running Node process. In-memory
// staff sessions and dispatcher ownership must not be split across replicas.
export function createServerRuntime({ server, disconnectDatabase, stopNotifications = () => {}, markNotReady = () => {},
  graceMs = 10000, logger = console, processRef = process }) {
  let shuttingDown;
  let installed = false;

  function closeHttp() {
    return new Promise((resolve, reject) => {
      server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
  }

  function shutdown() {
    if (shuttingDown) return shuttingDown;
    markNotReady();
    shuttingDown = (async () => {
      let failed = false;
      let timeout;
      const finish = async () => {
        const results = await Promise.allSettled([closeHttp(), Promise.resolve().then(stopNotifications)]);
        for (const result of results) if (result.status === "rejected") failed = true;
        // Do not close MongoDB while an accepted HTTP request or mail
        // acknowledgement is still writing its durable state.
        try { await disconnectDatabase(); }
        catch { failed = true; }
        return { ok: !failed, timedOut: false };
      };
      const deadline = new Promise(resolve => {
        timeout = setTimeout(() => {
          server.closeAllConnections?.();
          logger.error("Shutdown grace period elapsed; in-flight work may need reconciliation after restart.");
          resolve({ ok: false, timedOut: true });
        }, graceMs);
      });
      const result = await Promise.race([finish(), deadline]);
      clearTimeout(timeout);
      if (!result.ok && !result.timedOut) logger.error("The application did not close all resources cleanly.");
      removeSignalHandlers();
      return result;
    })();
    return shuttingDown;
  }

  function handleSignal() {
    void shutdown().then(result => {
      processRef.exitCode = result.ok ? 0 : 1;
      // A hung dependency can keep sockets alive after the bounded deadline.
      // The durable reservation/queue protocol handles interrupted work.
      if (result.timedOut) processRef.exit(1);
    });
  }

  function installSignalHandlers() {
    if (installed) return;
    installed = true;
    processRef.on("SIGTERM", handleSignal);
    processRef.on("SIGINT", handleSignal);
  }

  function removeSignalHandlers() {
    if (!installed) return;
    installed = false;
    processRef.removeListener("SIGTERM", handleSignal);
    processRef.removeListener("SIGINT", handleSignal);
  }

  return { shutdown, installSignalHandlers, removeSignalHandlers };
}

export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    function failed(error) { server.removeListener("listening", ready); reject(error); }
    function ready() { server.removeListener("error", failed); resolve(server); }
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, host);
  });
}
