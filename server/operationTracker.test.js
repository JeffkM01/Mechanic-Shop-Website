import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createOperationTracker } from "./operationTracker.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("draining closes admission immediately and waits for every admitted handler promise", async () => {
  const tracker = createOperationTracker();
  const first = deferred();
  const second = deferred();
  const one = tracker.wrap(() => first.promise)();
  const two = tracker.wrap(() => second.promise)();
  let drained = false;
  const stopping = tracker.stop();
  stopping.then(() => { drained = true; });
  assert.equal(tracker.isAccepting(), false);
  assert.equal(tracker.stop(), stopping);
  first.resolve();
  await one;
  await setImmediate();
  assert.equal(drained, false);
  second.resolve();
  await two;
  await stopping;
  assert.equal(drained, true);

  let called = false;
  const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await tracker.wrap(() => { called = true; })(null, response);
  assert.equal(called, false);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "SERVICE_DRAINING");
});

for (const failure of ["synchronous throw", "promise rejection"]) {
  test(`${failure} settles the handler count and preserves the original error`, async () => {
    const tracker = createOperationTracker();
    const error = new Error("synthetic failure");
    const handler = failure === "synchronous throw" ? () => { throw error; } : async () => { throw error; };
    await assert.rejects(tracker.wrap(handler)(), actual => actual === error);
    await tracker.stop();
  });
}

test("ending a response does not finish an asynchronously pending handler", async () => {
  const tracker = createOperationTracker();
  const work = deferred();
  let responseEnded = false;
  let drained = false;
  const operation = tracker.wrap(async (_req, res) => {
    res.end();
    await work.promise;
  })(null, { end() { responseEnded = true; } });
  const stopping = tracker.stop();
  stopping.then(() => { drained = true; });
  assert.equal(responseEnded, true);
  await setImmediate();
  assert.equal(drained, false);
  work.resolve();
  await operation;
  await stopping;
  assert.equal(drained, true);
});
