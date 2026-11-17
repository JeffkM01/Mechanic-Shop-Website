import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { createApp } from "./app.js";
import { createOperationTracker } from "./operationTracker.js";
import { createServerRuntime, listen } from "./serverRuntime.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const events = [];
  const logger = { error: message => events.push(message) };
  const processRef = new EventEmitter();
  processRef.exit = code => { events.push(`exit:${code}`); };
  const server = { close(done) { events.push("http-close"); done(); }, closeIdleConnections() { events.push("idle-close"); }, closeAllConnections() { events.push("force-close"); } };
  const runtime = createServerRuntime({ server, logger, processRef,
    stopNotifications: () => { events.push("mail-stop"); },
    disconnectDatabase: () => { events.push("database-close"); },
    markNotReady: () => { events.push("not-ready"); },
    ...overrides,
  });
  return { runtime, server, processRef, events };
}

test("shutdown marks readiness false immediately, stops admission, and disconnects only after HTTP and mail drain", async () => {
  const http = deferred();
  const mail = deferred();
  let closeHttp;
  const f = fixture({ server: { close(done) { closeHttp = done; }, closeIdleConnections() {} }, stopNotifications: () => mail.promise });
  const one = f.runtime.shutdown();
  const two = f.runtime.shutdown();
  assert.equal(one, two);
  assert.deepEqual(f.events, ["not-ready"]);
  await Promise.resolve();
  assert.equal(f.events.includes("database-close"), false);
  mail.resolve();
  await Promise.resolve();
  assert.equal(f.events.includes("database-close"), false);
  closeHttp(); http.resolve();
  assert.deepEqual(await one, { ok: true, timedOut: false });
  assert.deepEqual(f.events, ["not-ready", "database-close"]);
});

test("SIGTERM and SIGINT handlers install once and share one drain without resetting success or closing the database twice", async () => {
  const f = fixture();
  f.runtime.installSignalHandlers();
  f.runtime.installSignalHandlers();
  assert.equal(f.processRef.listenerCount("SIGTERM"), 1);
  assert.equal(f.processRef.listenerCount("SIGINT"), 1);
  f.processRef.emit("SIGTERM");
  f.processRef.emit("SIGINT");
  await f.runtime.shutdown();
  await Promise.resolve();
  assert.equal(f.events.filter(event => event === "database-close").length, 1);
  assert.equal(f.events.filter(event => event === "mail-stop").length, 1);
  assert.equal(f.events.filter(event => event === "not-ready").length, 1);
  assert.equal(f.processRef.exitCode, 0);
  assert.equal(f.processRef.listenerCount("SIGTERM"), 0);
  assert.equal(f.processRef.listenerCount("SIGINT"), 0);
});

test("resource failures still close the database and use redacted fixed log messages", async () => {
  const f = fixture({ stopNotifications: async () => { throw new Error("smtp-password and private customer body"); } });
  assert.deepEqual(await f.runtime.shutdown(), { ok: false, timedOut: false });
  assert.equal(f.events.includes("database-close"), true);
  assert.equal(f.events.join(" ").includes("smtp-password"), false);
  assert.equal(f.events.some(event => event.includes("did not close all resources")), true);
});

test("a shutdown deadline force-closes HTTP without prematurely disconnecting a still-writing request", async () => {
  const never = new Promise(() => {});
  const f = fixture({ graceMs: 15, server: { close() {}, closeIdleConnections() {}, closeAllConnections() { f.events.push("force-close"); } }, stopNotifications: () => never });
  assert.deepEqual(await f.runtime.shutdown(), { ok: false, timedOut: true });
  assert.equal(f.events.includes("force-close"), true);
  assert.equal(f.events.includes("database-close"), false);
});

test("signal-triggered shutdown exits at its deadline when a dependency will not drain", async () => {
  const f = fixture({ graceMs: 15, stopNotifications: () => new Promise(() => {}) });
  f.runtime.installSignalHandlers(); f.processRef.emit("SIGTERM");
  await f.runtime.shutdown(); await Promise.resolve();
  assert.equal(f.processRef.exitCode, 1);
  assert.equal(f.events.includes("exit:1"), true);
});

test("an unfinished application handler retains the deadline and nonzero signal exit after HTTP has closed", async () => {
  const application = deferred();
  const f = fixture({ graceMs: 15, stopApplicationWork: () => application.promise });
  f.runtime.installSignalHandlers();
  f.processRef.emit("SIGTERM");
  assert.deepEqual(await f.runtime.shutdown(), { ok: false, timedOut: true });
  await Promise.resolve();
  assert.equal(f.events.includes("database-close"), false);
  assert.equal(f.processRef.exitCode, 1);
  assert.equal(f.events.includes("exit:1"), true);
  application.resolve();
});

for (const operation of ["booking", "review", "customer cancellation"]) {
  test(`shutdown waits for an aborted ${operation} handler and email acknowledgement before disconnecting`, { timeout: 5000 }, async t => {
    const entered = deferred();
    const mutation = deferred();
    const mail = deferred();
    const tracker = createOperationTracker();
    const events = [];
    const id = "123456789012345678901234";
    let connected = true;
    let handlerEntered = false;
    const saved = { id, _id: id, status: "pending", service: "Oil Change", scheduling: {} };
    const mutate = async () => {
      handlerEntered = true;
      events.push("reservation-written");
      entered.resolve();
      await mutation.promise;
      assert.equal(connected, true, "MongoDB must remain available for the second mutation write");
      events.push("appointment-written");
      return saved;
    };
    const pass = (_req, _res, next) => next();
    const app = createApp({ Appointment: { db: { readyState: 1 } }, operationTracker: tracker,
      scheduling: { createAppointment: mutate, reviewAppointment: mutate, cancelAppointment: mutate,
        getCancellationEligibility: () => ({ canCancel: true, message: "Synthetic eligibility" }) },
      auth: { login: pass, requireAuth: pass, requireCsrf: pass, session: pass, activity: pass, logout: pass },
      management: { requireOrigin() {}, requireCsrf() {}, authorize: async () => ({ id, appointment: saved }) },
      notifications: { enabled: false, kick() {} },
    });
    const server = createServer(app);
    let socketClosed;
    server.once("connection", socket => { socketClosed = once(socket, "close"); });
    const runtime = createServerRuntime({ server, graceMs: 1000,
      stopApplicationWork: tracker.stop,
      stopNotifications: () => mail.promise,
      disconnectDatabase: () => { connected = false; events.push("database-close"); },
    });
    t.after(async () => {
      mutation.resolve();
      mail.resolve();
      await runtime.shutdown();
    });
    await listen(server, { host: "127.0.0.1", port: 0 });
    const path = operation === "booking" ? "/api/appointments" : operation === "review" ? `/api/mechanic/appointments/${id}` : `/api/customer/appointments/${id}/cancel`;
    const body = operation === "booking" ? { name: "Synthetic Customer", email: "synthetic@example.invalid", phone: "(555) 555-1234", vehicle: "2018 Honda Civic", service: "Oil Change", date: "2030-01-08", time: "10:30", notes: "" } : operation === "review" ? { status: "confirmed" } : {};
    const client = request({ host: "127.0.0.1", port: server.address().port, path,
      method: operation === "review" ? "PATCH" : "POST", headers: { "Content-Type": "application/json" } });
    t.after(() => client.destroy());
    client.on("error", () => {});
    client.once("response", res => {
      res.resume();
      assert.equal(handlerEntered, true, `synthetic request reached its handler (HTTP ${res.statusCode})`);
    });
    client.end(JSON.stringify(body));
    await entered.promise;
    client.destroy();
    await socketClosed;
    let completed = false;
    const stopping = runtime.shutdown();
    stopping.then(() => { completed = true; });
    assert.equal(tracker.isAccepting(), false);
    await setImmediate();
    assert.equal(connected, true);
    assert.equal(completed, false);
    mutation.resolve();
    await tracker.stop();
    assert.deepEqual(events, ["reservation-written", "appointment-written"]);
    assert.equal(connected, true, "email acknowledgement must also settle before disconnect");
    mail.resolve();
    assert.deepEqual(await stopping, { ok: true, timedOut: false });
    assert.deepEqual(events, ["reservation-written", "appointment-written", "database-close"]);
  });
}

test("the HTTP listener supports an explicit bind and resolves after a socket is listening", async t => {
  const server = createServer((_req, res) => res.end("synthetic listener"));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal(await listen(server, { host: "127.0.0.1", port: 0 }), server);
  assert.equal(server.listening, true);
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), "synthetic listener");
  assert.equal(server.listenerCount("error"), 0);
});

test("a listener failure rejects startup instead of reporting a ready service", async t => {
  const first = createServer();
  await listen(first, { host: "127.0.0.1", port: 0 });
  t.after(() => new Promise(resolve => first.close(resolve)));
  const second = createServer();
  const originalListeners = second.listeners("listening");
  await assert.rejects(listen(second, { host: "127.0.0.1", port: first.address().port }), error => error.code === "EADDRINUSE");
  assert.equal(second.listening, false);
  assert.deepEqual(second.listeners("listening"), originalListeners);
  assert.equal(second.listenerCount("error"), 0);
});
