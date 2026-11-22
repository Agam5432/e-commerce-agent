// A reply may only say "done" (order placed or cancelled, refund issued, complaint raised, e-mail sent) when the backend confirmed it.
import test from "node:test";
import assert from "node:assert/strict";
import { claimsDone, doneEvidence, notConfirmedReply } from "../src/agent/factGuard.js";

test("claims of something done are found; offers, questions and future wording are not claims", () => {
  const claims = {
    "I've placed your order. Thank you!": "order_placed",
    "Your order has been placed successfully.": "order_placed",
    "Aapka order place ho gaya hai.": "order_placed",
    "I have cancelled your order.": "order_cancelled",
    // a real store: the Hinglish reply said it was cancelled, but nothing had been (no tool ran)
    "Main samajh gayi hoon, aapka order cancel karne ki request process ho gayi hai aur yeh cancel ho gaya hai kyunki yeh abhi ship nahi hua tha.": "order_cancelled",
    "It has been cancelled successfully.": "order_cancelled",
    "I have already processed the cancellation for order #1027 as you requested.": "order_cancelled",
    "Aapka order #1027 pehle hi cancel kiya ja chuka hai.": "order_cancelled",
    "Your order was already cancelled.": "order_cancelled",
    "Aapka cancel request process ho gayi hai.": "order_cancelled",
    "यह कैंसिल हो गया है।": "order_cancelled",
    "Your order #1001 has been cancelled.": "order_cancelled",
    "I've issued your refund.": "refund_issued",
    "The refund has been processed.": "refund_issued",
    "I have raised a complaint for you.": "complaint_raised",
    "Your complaint has been registered.": "complaint_raised",
    "I've emailed you a confirmation.": "email_sent",
    // the wording seen on a real store: "that email" / "this mail" / "our" (not just a / the / your)
    "I have sent that email to our support team for you with your email address.": "email_sent",
    "I've sent this email to the store.": "email_sent",
    "I have sent my email to our team.": "email_sent",
    "A confirmation email has been sent to you.": "email_sent",
    "Code aapke email par bhej diya.": "email_sent",
  };
  for (const [text, kind] of Object.entries(claims)) assert.ok(claimsDone(text).includes(kind), `${kind}: ${text}`);
  for (const text of ["Shall I place the order?", "Do you want me to cancel it?", "The amount will be refunded to your card.", "I can raise a complaint if you like.", "Kya main email bhej doon?", "Your order has not been cancelled.", "Shipped orders cannot be cancelled.", "Agar order cancel ho gaya to refund milega.", "If it has been cancelled you will get a refund.", "I am not able to say it has been cancelled.", "I can process the cancellation once you confirm.", "Here are two phones under $500."]) {
    assert.deepEqual(claimsDone(text), [], text);
  }
});

test("an order Shopify itself reports as cancelled makes 'it is already cancelled' true", () => {
  assert.ok(doneEvidence({ toolLog: [{ name: "request_order_cancellation", result: { status: "not_cancellable", reason: "already_cancelled" } }] }).has("order_cancelled"));
  assert.ok(doneEvidence({ toolLog: [{ name: "get_order_details", result: { status: "ok", details: { cancelled: { on: "x" } } } }] }).has("order_cancelled"));
  assert.equal(doneEvidence({ toolLog: [{ name: "get_order_details", result: { status: "ok", details: { cancelled: null } } }] }).has("order_cancelled"), false);
});

test("only the backend's own results count as proof, and a refund needs a finished cancellation", () => {
  assert.equal(doneEvidence({}).size, 0);
  assert.deepEqual([...doneEvidence({ actions: [{ type: "order_placed" }] })], ["order_placed"]);
  assert.ok(doneEvidence({ toolLog: [{ name: "cancel_order", result: { status: "cancelled", refundWillBeIssued: true } }] }).has("refund_issued"));
  assert.equal(doneEvidence({ toolLog: [{ name: "cancel_order", result: { status: "cancellation_processing" } }] }).size, 0, "submitted is not cancelled");
  assert.equal(doneEvidence({ toolLog: [{ name: "cancel_order", result: { status: "cancel_failed" } }] }).size, 0);
  assert.equal(doneEvidence({ toolLog: [{ name: "raise_complaint", result: { status: "email_retrying", emailSent: false } }] }).has("email_sent"), false);
  assert.ok(doneEvidence({ toolLog: [{ name: "raise_complaint", result: { status: "email_sent" } }] }).has("email_sent"));
  assert.match(notConfirmedReply("en"), /cannot confirm/);
});

test("the agent never tells a shopper something was done when no tool did it", async (t) => {
  const { installRealStore, freshClientId, scriptedGemini } = await import("./helpers/agentHarness.js");
  const { runAgent, __setLLMClientsForTest } = await import("../src/agent/agent.js");
  const store = installRealStore();
  t.after(() => { __setLLMClientsForTest(null); store.restore(); });
  const ask = (steps, message) => { __setLLMClientsForTest({ gemini: scriptedGemini(steps) }); return runAgent(message, "done.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "USD", items: [] } }); };
  // the draft claims a cancellation and a refund; the rewrite is honest
  let out = await ask([() => "Done, I have cancelled your order and issued your refund.", () => "I have not cancelled anything yet. Which order would you like to cancel?"], "cancel my order 1001 and refund me");
  assert.doesNotMatch(out.answer, /have cancelled|issued your refund/i, out.answer);
  assert.match(out.answer, /not cancelled/);
  // the rewrite repeats the false claim: the plain "cannot confirm" line is used
  out = await ask([() => "Your order has been placed successfully.", () => "Your order has been placed."], "ok");
  assert.match(out.answer, /cannot confirm/i, out.answer);
  // an honest reply passes untouched
  out = await ask([() => "Would you like me to place the order for you?"], "yes please");
  assert.match(out.answer, /Would you like me to place the order/);
});
