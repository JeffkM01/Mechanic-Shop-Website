import test from "node:test";
import assert from "node:assert/strict";
import { DECLINE_REASONS, DECLINE_EXPLANATION_MAX, DECLINE_MESSAGE_MAX, getDeclinePreview, validateDeclineReason } from "../shared/declineReasons.js";

test("decline categories describe service refusals and never imply a scheduling change", () => {
  assert.deepEqual(DECLINE_REASONS.map(reason => reason.id), ["service_not_offered", "outside_capabilities", "unable_to_accommodate", "parts_unavailable", "other"]);
  for (const reason of DECLINE_REASONS) assert.doesNotMatch(reason.id + reason.label, /time.*unavailable|reschedul|cancel/i);
  assert.equal(getDeclinePreview("unknown", "A valid explanation"), "");
});

test("preset declines use a meaningful standard explanation with optional additional text", () => {
  for (const reason of DECLINE_REASONS.filter(reason => reason.id !== "other")) {
    assert.deepEqual(validateDeclineReason({ category: reason.id }).value, { category: reason.id, explanation: reason.explanation });
    const extra = "Please call to discuss the specific repair.";
    assert.equal(validateDeclineReason({ category: reason.id, explanation: ` ${extra} ` }).value.explanation, `${reason.explanation} ${extra}`);
  }
});

test("Other requires a bounded explanation, and all categories reject malformed or forged input", () => {
  const details = "This repair requires specialist equipment we do not have.";
  assert.deepEqual(validateDeclineReason({ category: "other", explanation: details }).value, { category: "other", explanation: details });
  for (const input of [undefined, null, [], "other", {}, { category: "time_unavailable" }, { category: "other" }, { category: "other", explanation: "short" }, { category: "other", explanation: "x".repeat(1001) }, { category: "other", explanation: 25 }, { category: "other", explanation: "Customer text\u0000invalid" }, { category: "other", explanation: details, source: "customer" }, { category: "other", explanation: details, declinedAt: "2030-01-01" }]) {
    assert.ok(validateDeclineReason(input).error, JSON.stringify(input));
  }
});

test("explanation limits bound saved messages while preserving plain text and line breaks", () => {
  const extra = "x".repeat(DECLINE_EXPLANATION_MAX);
  for (const reason of DECLINE_REASONS) {
    const normalized = validateDeclineReason({ category: reason.id, explanation: extra });
    assert.ok(!normalized.error, reason.id);
    assert.ok(normalized.value.explanation.length <= DECLINE_MESSAGE_MAX);
  }
  const plainText = "Parts unavailable.\n<script>This remains plain text.</script>";
  assert.equal(validateDeclineReason({ category: "other", explanation: plainText }).value.explanation, plainText);
});
