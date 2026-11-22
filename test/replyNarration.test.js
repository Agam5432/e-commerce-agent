// The shopper reads only the answer: the model's notes about its own working ("so I'll reply in English")
// are cut, and a normal reply is left exactly as it was.
import test from "node:test";
import assert from "node:assert/strict";
import { stripReasoningLeak } from "../src/agent/factGuard.js";

test("narration about the language or the customer's message is removed", () => {
  const cases = [
    ["The customer asked in English, so I'll reply in English.\nGood news, the charger is on sale.", "Good news, the charger is on sale."],
    ["Hinglish mein jawab deti hoon: HP X1000 mouse cart mein add ho gaya hai.", "HP X1000 mouse cart mein add ho gaya hai."],
    ["This message is in English, so I'll answer in English.\nNo, it is sold out.", "No, it is sold out."],
    ["Customer's last message is \"budget 5000\", in English. So the reply is in English only. With INR 5,000 you can buy a power bank.", "With INR 5,000 you can buy a power bank."],
  ];
  for (const [input, expected] of cases) assert.equal(stripReasoningLeak(input), expected, input);
});

test("ordinary replies are untouched, including ones that talk about language or customers", () => {
  const fine = [
    "Here are two laptops:\n- **ASUS Vivobook 15** (₹55,300)\n- **Lenovo IdeaPad Slim 3** (₹52,400)",
    "I can reply in Hindi if you prefer. Which laptop would you like?",
    "Our customer support answers in English and Hindi.",
    "Aapki cart mein ek mouse hai. Total ₹2,300.",
  ];
  for (const text of fine) assert.equal(stripReasoningLeak(text), text);
  assert.equal(stripReasoningLeak(""), "");
  assert.equal(stripReasoningLeak(undefined), "");
});

test("the shop prompt (source) tells the model to answer only the latest message and never to address the shopper as female", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/industries/ecommerce/systemPrompt.js", import.meta.url), "utf8");
  assert.match(src, /Answer ONLY the customer's LATEST message/);
  assert.match(src, /never use a gendered form for THEM/);
  assert.match(src, /Never mention which language you chose/);
});

test("the shop prompt keeps jokes clean and answers in the language of the latest message", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/industries/ecommerce/systemPrompt.js", import.meta.url), "utf8");
  assert.match(src, /never targets or stereotypes any community/);
  assert.match(src, /reply in that language, judged from the script and words of that message alone/);
});

test("the shop prompt forbids invented size charts", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/industries/ecommerce/systemPrompt.js", import.meta.url), "utf8");
  assert.match(src, /SIZE HELP/);
  assert.match(src, /Never invent numbers/);
});

test("narration that mentions the live search or what the customer wants is removed", () => {
  assert.equal(stripReasoningLeak("Hinglish reply needed. The customer wants pants, gender unknown. Live search already shows two pairs.\n- **Men's Black Cotton Pant** (₹2,100)"), "- **Men's Black Cotton Pant** (₹2,100)");
  assert.equal(stripReasoningLeak("Jeans already appear in the live search results, so I can show you what is available right away.\n- **Jeans** (₹1,900)"), "- **Jeans** (₹1,900)");
  assert.equal(stripReasoningLeak("The customer wants a refund, so please share your order number."), "The customer wants a refund, so please share your order number.");
});
