import test from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOMER_CANCELLATION_REASONS, MECHANIC_CANCELLATION_REASONS,
  CANCELLATION_MESSAGE_MAX, getCancellationPreview, validateCancellation,
} from "../../shared/cancellations.js";

test("customer cancellation reasons and messages are optional, including Other", () => {
  assert.deepEqual(validateCancellation("customer").value, { category: "prefer_not_to_say" });
  for (const { id } of CUSTOMER_CANCELLATION_REASONS) {
    assert.deepEqual(validateCancellation("customer", { category: id }).value, { category: id });
  }
  assert.deepEqual(validateCancellation("customer", { category: "plans_changed", message: "  Please let Edward know.  " }).value, {
    category: "plans_changed", message: "Please let Edward know.",
  });
});

test("mechanic cancellation requires a meaningful customer-facing reason", () => {
  assert.ok(validateCancellation("mechanic").error);
  for (const reason of MECHANIC_CANCELLATION_REASONS.filter(item => item.id !== "other")) {
    assert.deepEqual(validateCancellation("mechanic", { category: reason.id }).value, { category: reason.id, explanation: reason.explanation });
    assert.equal(getCancellationPreview(reason.id, "Please contact us."), `${reason.explanation} Please contact us.`);
  }
  assert.ok(validateCancellation("mechanic", { category: "other", explanation: "short" }).fields["cancellation.explanation"]);
  assert.equal(validateCancellation("mechanic", { category: "other", explanation: "The vehicle lift needs repair." }).value.explanation, "The vehicle lift needs repair.");
});

test("cancellation validation rejects unknown fields, categories, controls and unbounded raw text", () => {
  for (const input of [null, [], "text", { category: "invented" }, { category: "other", status: "confirmed" }, { message: 4 }, { message: "hidden\u0000value" }, { message: " ".repeat(CANCELLATION_MESSAGE_MAX + 1) }]) {
    assert.ok(validateCancellation("customer", input).error, JSON.stringify(input));
  }
  for (const explanation of [4, "hidden\u007fvalue", "x".repeat(CANCELLATION_MESSAGE_MAX + 1)]) {
    assert.ok(validateCancellation("mechanic", { category: "shop_closed", explanation }).error);
  }
  assert.ok(validateCancellation("admin", {}).error);
  assert.equal(validateCancellation("customer", { message: "First line\nSecond line" }).value.message, "First line\nSecond line");
  assert.equal(validateCancellation("customer", { message: "x".repeat(CANCELLATION_MESSAGE_MAX) }).value.message.length, CANCELLATION_MESSAGE_MAX);
});
