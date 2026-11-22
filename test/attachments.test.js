// Photos, videos and PDFs a shopper attaches: checked by content, stored per shop, uploaded with the
// storefront token, described once for the agent, and shown to the store owner.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { detectFile, bytesOf, saveAttachments, loadAttachments, readAttachmentForOwner, toMeta, MAX_FILES } from "../src/services/attachmentService.js";
import { createUploadRouter } from "../src/routes/uploadRoutes.js";
import { createVoiceToken } from "../src/services/voiceTokenService.js";
import { visitorKey } from "../src/http/hardening.js";
import { createTokenReplayGuard } from "../src/services/tokenReplay.js";
import { chatRefFor, markChatCleared } from "../src/services/conversationLog.js";
import { createAdminRouter } from "../src/admin/routes.js";
import { buildAttachmentNote } from "../src/routes/shopifyProxyRoutes.js";
import { buildSuggestionsPrompt, parseSuggestions, generateSuggestions, describeAttachments, __setLLMClientsForTest } from "../src/agent/agent.js";
import ecommerce from "../src/industries/ecommerce.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

const SHOP = "a-store.myshopify.com";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");

// ---- what the bytes really are ----------------------------------------------------------------
test("files are recognised by content, not by the name or type the browser claims", () => {
  assert.deepEqual(detectFile(PNG), { kind: "image", mime: "image/png" });
  assert.deepEqual(detectFile(JPG), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(detectFile(PDF), { kind: "pdf", mime: "application/pdf" });
  assert.deepEqual(detectFile(MP4), { kind: "video", mime: "video/mp4" });
  assert.deepEqual(detectFile(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)])), { kind: "video", mime: "video/webm" });
  assert.equal(detectFile(HTML), null);
  assert.equal(detectFile(Buffer.from("MZ" + "\0".repeat(30))), null);
  assert.equal(detectFile(Buffer.alloc(3)), null);
  assert.equal(detectFile(null), null);
});

function fakeModel() {
  const stored = [];
  return {
    stored,
    async insertMany(docs) {
      const out = docs.map((d, i) => ({ _id: `64b0000000000000000000${String(stored.length + i).padStart(2, "0")}`, ...d }));
      stored.push(...out);
      return out;
    },
    find(filter) {
      const rows = stored.filter((d) => filter._id.$in.includes(d._id) && d.shop === filter.shop && d.chatRef === filter.chatRef);
      return { select: () => ({ lean: async () => rows }) };
    },
    findOne(filter) {
      const row = stored.find((d) => d._id === filter._id && d.shop === filter.shop);
      return { select: () => ({ lean: async () => row || null }) };
    },
  };
}

test("saving keeps real photos/PDFs/videos, drops disguised or oversized files, and sets the retention expiry", async () => {
  const model = fakeModel();
  const now = Date.UTC(2026, 9, 30);
  const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
  const { attachments, rejected } = await saveAttachments(
    { shop: SHOP, chatRef: "ref1", settings: { logging: { retentionDays: 10 } }, now, files: [
      { originalname: "shoe.png", buffer: PNG }, { originalname: "evil.png", buffer: HTML }, { originalname: "huge.png", buffer: big }, { originalname: "../../bill.pdf", buffer: PDF }, { originalname: "clip.mp4", buffer: MP4 },
    ] },
    { model }
  );
  assert.deepEqual(attachments.map((a) => a.kind), ["image", "pdf", "video"]);
  assert.deepEqual(rejected, ["evil.png", "huge.png"]);
  assert.ok(!attachments[1].name.includes("/") && attachments[1].name.endsWith("bill.pdf"));
  assert.equal(model.stored[0].expiresAt.getTime(), now + 10 * 24 * 3600 * 1000);
  assert.equal(model.stored[0].shop, SHOP);
  assert.equal(Object.keys(attachments[0]).sort().join(), "id,kind,mime,name,size"); // never the bytes
});

test("bytes come back as a Buffer from a Buffer or from a BSON Binary", () => {
  assert.deepEqual(bytesOf({ data: PNG }), PNG);
  assert.deepEqual(bytesOf({ data: { buffer: new Uint8Array([...PNG, 9, 9]), position: PNG.length } }), PNG);
  assert.equal(bytesOf({}).length, 0);
});

test("a file can only be read back for the shop and visitor it belongs to", async () => {
  const model = fakeModel();
  const { attachments } = await saveAttachments({ shop: SHOP, chatRef: "ref1", files: [{ originalname: "a.png", buffer: PNG }] }, { model });
  const id = attachments[0].id;
  assert.equal((await loadAttachments({ shop: SHOP, chatRef: "ref1", ids: [id, "not-an-id", { $ne: 1 }] }, { model })).length, 1);
  assert.equal((await loadAttachments({ shop: "b-store.myshopify.com", chatRef: "ref1", ids: [id] }, { model })).length, 0);
  assert.equal((await loadAttachments({ shop: SHOP, chatRef: "someone-else", ids: [id] }, { model })).length, 0);
  assert.deepEqual(await loadAttachments({ shop: SHOP, chatRef: "ref1", ids: [] }, { model }), []);
  assert.equal(await readAttachmentForOwner(SHOP, "zzz", { model }), null);
  assert.equal((await readAttachmentForOwner(SHOP, id, { model })).kind, "image");
  assert.equal(await readAttachmentForOwner("b-store.myshopify.com", id, { model }), null);
  assert.deepEqual(toMeta({ _id: "x", name: "n", kind: "pdf", mime: "application/pdf", size: 1, data: Buffer.alloc(1) }), { id: "x", name: "n", kind: "pdf", mime: "application/pdf", size: 1 });
});

// ---- the upload route ----------------------------------------------------------------------
async function withUploadServer(fn, overrides = {}) {
  const prev = process.env.SHOPIFY_CLIENT_SECRET;
  process.env.SHOPIFY_CLIENT_SECRET = "upload-test-secret";
  const calls = [];
  const app = express();
  app.use("/api/uploads", createUploadRouter({
    save: async (args) => { calls.push(args); return saveAttachments(args, { model: fakeModel() }); },
    settingsFor: async () => ({}),
    limiter: (req, res, next) => next(),
    shopLimit: [],
    // single use is tested on its own below; here one token is reused across requests
    replay: { consume: async () => true },
    ...overrides,
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api/uploads`;
  try {
    await fn({ url, calls, token: createVoiceToken(SHOP, { purpose: "upload", visitor: "net:203.0.113.7" }) });
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = prev;
  }
}
const form = (parts, clientId = "client-abcdefghijklmnop") => {
  const body = new FormData();
  body.append("clientId", clientId);
  for (const [name, buffer] of parts) body.append("files", new Blob([buffer]), name);
  return body;
};

test("upload: needs the storefront token; with it the files are stored for that shop and visitor only", async () => {
  await withUploadServer(async ({ url, calls, token }) => {
    assert.equal((await fetch(url, { method: "POST", body: form([["a.png", PNG]]) })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { Authorization: "Bearer forged.token" }, body: form([["a.png", PNG]]) })).status, 401);

    const ok = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form([["a.png", PNG], ["b.pdf", PDF], ["c.exe", HTML]]) });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.deepEqual(data.attachments.map((a) => a.kind), ["image", "pdf"]);
    assert.deepEqual(data.rejected, ["c.exe"]);
    assert.equal(calls[0].shop, SHOP);
    assert.equal(calls[0].chatRef, chatRefFor(SHOP, "client-abcdefghijklmnop"));

    const onlyBad = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form([["c.exe", HTML]]) });
    assert.equal(onlyBad.status, 415);
    const none = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form([]) });
    assert.equal(none.status, 400);
  });
});

test("upload: more than the allowed number of files, or a file over the size limit, is refused", async () => {
  await withUploadServer(async ({ url, token }) => {
    const many = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`f${i}.png`, PNG])) });
    assert.equal(many.status, 400);
    const tooBig = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form([["v.mp4", Buffer.concat([MP4, Buffer.alloc(26 * 1024 * 1024)])]]) });
    assert.equal(tooBig.status, 413);
  });
});

// ---- what the agent is told ---------------------------------------------------------------
test("the agent is told what the files show, or that it cannot see them", () => {
  const files = [{ kind: "image" }, { kind: "image" }, { kind: "video" }];
  const withDescription = buildAttachmentNote(files, "a red running shoe");
  assert.match(withDescription, /2 photo\(s\)/);
  assert.match(withDescription, /a red running shoe/);
  assert.match(withDescription, /1 video\(s\)/);
  assert.match(buildAttachmentNote([{ kind: "image" }], ""), /cannot view/);
  assert.match(buildAttachmentNote([{ kind: "video" }], ""), /cannot watch/);
  assert.equal(buildAttachmentNote([], ""), "");
});

// ---- suggestion chips --------------------------------------------------------------------
function fakeGemini(replyText) {
  const calls = [];
  return { calls, models: { generateContent: async (req) => { calls.push(req); return { candidates: [{ content: { role: "model", parts: [{ text: replyText }] } }] }; } } };
}

test("suggestion prompt carries the exchange, the store's range and the earlier chips to avoid", () => {
  const prompt = buildSuggestionsPrompt({ storeName: "Desi Threads", categories: ["kurtas", "sarees"], lastUser: "show kurtas", answer: "Here are three kurtas.", recent: ["Compare these"], languageChoice: "hi" });
  assert.match(prompt, /Desi Threads/);
  assert.match(prompt, /kurtas, sarees/);
  assert.match(prompt, /show kurtas/);
  assert.match(prompt, /"Compare these"/);
  assert.match(prompt, /Hindi \(Devanagari\)/);
  assert.match(buildSuggestionsPrompt({}), /chat has just opened/);
});

test("suggestions are cleaned: valid strings only, no repeats of earlier chips, at most three", () => {
  assert.deepEqual(parseSuggestions('Sure: ["Show cheaper", "show cheaper", "Compare", "Delivery time?", "Extra one"]'), ["Show cheaper", "Compare", "Delivery time?"]);
  assert.deepEqual(parseSuggestions('["Compare these", "New idea"]', ["compare these"]), ["New idea"]);
  assert.deepEqual(parseSuggestions("no json here"), []);
  assert.deepEqual(parseSuggestions('[1, null, "", "x"]'), []);
  assert.equal(parseSuggestions(`["${"w".repeat(100)}"]`)[0].length, 40);
});

test("the AI writes the suggestions: one short call with the last exchange, parsed and de-duplicated", async () => {
  const original = ecommerce.getCachedCatalogSummary;
  ecommerce.getCachedCatalogSummary = () => ({ storeName: "Desi Threads", categories: ["kurtas"] });
  const gemini = fakeGemini('["Any cheaper option?", "Does it come in blue?", "How fast is delivery?"]');
  __setLLMClientsForTest({ gemini });
  try {
    const out = await generateSuggestions(SHOP, { lastUser: "show kurtas", answer: "Here are kurtas.", recent: [] });
    assert.deepEqual(out, ["Any cheaper option?", "Does it come in blue?", "How fast is delivery?"]);
    assert.equal(gemini.calls.length, 1);
    assert.match(gemini.calls[0].contents[0].parts[0].text, /show kurtas/);
    __setLLMClientsForTest({ gemini: fakeGemini("sorry, cannot") });
    assert.deepEqual(await generateSuggestions(SHOP, {}), []);
  } finally {
    __setLLMClientsForTest(null);
    ecommerce.getCachedCatalogSummary = original;
  }
});

test("photos are described once by a provider that can read images, and sent as media", async () => {
  const gemini = fakeGemini("A red running shoe with a white sole.");
  __setLLMClientsForTest({ gemini });
  try {
    const text = await describeAttachments([{ mime: "image/png", data: PNG.toString("base64") }], "find this");
    assert.equal(text, "A red running shoe with a white sole.");
    const parts = gemini.calls[0].contents[0].parts;
    assert.equal(parts[0].inlineData.mimeType, "image/png");
    assert.match(parts.at(-1).text, /find this/);
    assert.equal(await describeAttachments([], "x"), "");
  } finally {
    __setLLMClientsForTest(null);
  }
});

test("only providers that can read images are asked to describe them", async () => {
  const groq = { chat: { completions: { create: async () => { throw new Error("groq must not be called with images"); } } } };
  __setLLMClientsForTest({ groq });
  try {
    assert.equal(await describeAttachments([{ mime: "image/png", data: "AA==" }], ""), "");
  } finally {
    __setLLMClientsForTest(null);
  }
});

// ---- clearing the chat ------------------------------------------------------------------------
test("clearing marks the shopper's open conversations, only in their shop, and nothing is deleted", async () => {
  const calls = [];
  const deps = { connected: () => true, now: () => 1000, Conversation: { updateMany: async (filter, update) => { calls.push({ filter, update }); return { modifiedCount: 2 }; } } };
  assert.equal(await markChatCleared(SHOP, "ref1", deps), 2);
  assert.deepEqual(calls[0].filter, { shop: SHOP, chatRef: "ref1", clearedAt: null });
  assert.equal(calls[0].update.$set.clearedAt.getTime(), 1000);
  assert.equal(await markChatCleared(SHOP, "ref1", { ...deps, connected: () => false }), 0);
});

// ---- the owner's dashboard ---------------------------------------------------------------
test("the owner can open a file of their own store only; it is served so it can never run as a page", async () => {
  const model = fakeModel();
  const { attachments } = await saveAttachments({ shop: SHOP, chatRef: "ref1", files: [{ originalname: "shoe.png", buffer: PNG }] }, { model });
  const app = express();
  app.use("/admin/api", createAdminRouter({
    auth: (req, res, next) => { req.shop = req.headers["x-shop"]; next(); },
    limit: (req, res, next) => next(),
    readAttachment: (shop, id) => readAttachmentForOwner(shop, id, { model }),
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/admin/api/attachments/`;
  try {
    const own = await fetch(base + attachments[0].id, { headers: { "x-shop": SHOP } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("content-type"), "image/png");
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    assert.match(own.headers.get("content-security-policy"), /sandbox/);
    assert.equal(own.headers.get("cache-control"), "private, no-store");
    assert.equal(own.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(own.headers.get("content-disposition"), /^inline; filename="[^"]+"; filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), PNG);
    assert.equal((await fetch(base + attachments[0].id, { headers: { "x-shop": "b-store.myshopify.com" } })).status, 404);
    assert.equal((await fetch(base + "nope", { headers: { "x-shop": SHOP } })).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- the proxy accepts attachments-only messages ------------------------------------------
test("app proxy: /suggestions is signed, returns the AI's chips, and /chat accepts a message made of files only", async () => {
  const { default: router } = await import("../src/routes/shopifyProxyRoutes.js");
  const prevSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const originalExists = StoreIntegration.exists;
  const originalSummary = ecommerce.getCachedCatalogSummary;
  process.env.SHOPIFY_CLIENT_SECRET = "proxy-test-secret";
  StoreIntegration.exists = async () => ({ _id: "1" });
  ecommerce.getCachedCatalogSummary = () => ({ storeName: "Desi Threads", categories: ["kurtas"] });
  const app = express();
  app.use(express.json());
  app.use("/proxy", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const signed = (path) => {
    const params = { shop: "x.myshopify.com", timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: "/apps/ai-agent" };
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
    const signature = createHmac("sha256", "proxy-test-secret").update(message).digest("hex");
    return `http://127.0.0.1:${server.address().port}/proxy${path}?${new URLSearchParams({ ...params, signature })}`;
  };
  const post = (path, body) => fetch(signed(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    __setLLMClientsForTest({ gemini: fakeGemini('["Show cheaper", "Compare them", "Delivery?"]') });
    const res = await post("/suggestions", { lastUser: "kurta", answer: "Here you go.", recent: ["Old chip"], languageChoice: "en" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).suggestions, ["Show cheaper", "Compare them", "Delivery?"]);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/proxy/suggestions`, { method: "POST" })).status, 401);
    assert.equal((await post("/chat", { message: "" })).status, 400); // nothing to answer
    assert.equal((await post("/chat", { message: "", attachments: "oops" })).status, 400);
  } finally {
    __setLLMClientsForTest(null);
    await new Promise((r) => server.close(r));
    StoreIntegration.exists = originalExists;
    ecommerce.getCachedCatalogSummary = originalSummary;
    if (prevSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = prevSecret;
  }
});

// ---- the whole chat turn with a photo ---------------------------------------------------------
test("a chat message with a photo: the photo is described, the agent gets that, and the store team's transcript keeps the file", async () => {
  const { default: Attachment } = await import("../src/models/Attachment.js");
  const { default: CheckoutSession } = await import("../src/models/CheckoutSession.js");
  const { default: router } = await import("../src/routes/shopifyProxyRoutes.js");
  const originals = { exists: StoreIntegration.exists, findOne: StoreIntegration.findOne, summary: ecommerce.getCachedCatalogSummary, attFind: Attachment.find, csFind: CheckoutSession.findOne, fetch: globalThis.fetch, secret: process.env.SHOPIFY_CLIENT_SECRET };
  process.env.SHOPIFY_CLIENT_SECRET = "proxy-test-secret";
  const clientId = "client-abcdefghijklmnop";
  const chatRef = chatRefFor("x.myshopify.com", clientId);
  const photo = { _id: "64b000000000000000000001", shop: "x.myshopify.com", chatRef, name: "shoe.png", mime: "image/png", kind: "image", size: PNG.length, data: PNG };
  const queries = [];
  StoreIntegration.exists = async () => ({ _id: "1" });
  StoreIntegration.findOne = () => ({ select: async () => null, lean: async () => null });
  ecommerce.getCachedCatalogSummary = () => ({ categories: [], currency: "USD", storeName: "Test Store" });
  CheckoutSession.findOne = () => ({ lean: async () => null });
  Attachment.find = (filter) => { queries.push(filter); return { select: () => ({ lean: async () => [photo].filter((p) => filter.shop === p.shop && filter.chatRef === p.chatRef) }) }; };
  globalThis.fetch = async (url, init) => (String(url).startsWith("http://127.0.0.1") ? originals.fetch(url, init) : Promise.reject(new Error("Network disabled for this test")));
  const seen = [];
  const gemini = { calls: [], models: { generateContent: async (req) => {
    gemini.calls.push(req);
    const parts = req.contents.at(-1)?.parts || [];
    const hasImage = parts.some((p) => p.inlineData);
    const asked = JSON.stringify(req.contents);
    seen.push({ hasImage, asked });
    const text = hasImage ? "A red running shoe with a white sole." : "Ye red running shoe jaisa dikhta hai. Kya main similar options dikhaun?";
    return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
  } } };
  __setLLMClientsForTest({ gemini });
  const app = express();
  app.use(express.json());
  app.use("/proxy", router);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const params = { shop: "x.myshopify.com", timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: "/apps/ai-agent" };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
  const signature = createHmac("sha256", "proxy-test-secret").update(message).digest("hex");
  const url = `http://127.0.0.1:${server.address().port}/proxy/chat?${new URLSearchParams({ ...params, signature })}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "", clientId, attachments: [photo._id, "64b0000000000000000000ff"], languageChoice: "hinglish" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.answer, /red running shoe/);
    assert.deepEqual(queries[0].shop, "x.myshopify.com");
    assert.equal(queries[0].chatRef, chatRef); // only this visitor's files
    assert.ok(seen.some((s) => s.hasImage), "the photo was sent to a model that can read images");
    const agentCall = seen.find((s) => !s.hasImage);
    assert.match(agentCall.asked, /A red running shoe with a white sole/); // the agent knows what the photo shows
    assert.match(agentCall.asked, /without a message/);
    // another visitor cannot use this photo
    queries.length = 0;
    const other = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "what is this?", clientId: "someone-else-abcdefghijk", attachments: [photo._id] }) });
    assert.equal(other.status, 200);
    assert.notEqual(queries[0].chatRef, chatRef);
    assert.ok(!/A red running shoe/.test(seen.at(-1).asked.split("what is this?").pop()), "no description for a file this visitor does not own");
  } finally {
    __setLLMClientsForTest(null);
    await new Promise((r) => server.close(r));
    StoreIntegration.exists = originals.exists;
    StoreIntegration.findOne = originals.findOne;
    ecommerce.getCachedCatalogSummary = originals.summary;
    Attachment.find = originals.attFind;
    CheckoutSession.findOne = originals.csFind;
    globalThis.fetch = originals.fetch;
    if (originals.secret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET; else process.env.SHOPIFY_CLIENT_SECRET = originals.secret;
  }
});

test("upload: a token works once, a voice token does not upload, and the shopper counted is the one the proxy saw", async () => {
  const seen = [];
  await withUploadServer(async ({ url, token }) => {
    const send = (t, headers = {}) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${t}`, ...headers }, body: form([["a.png", PNG]]) });
    assert.equal((await send(token, { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal((await send(token)).status, 401, "the same token again is refused");
    assert.equal((await send(createVoiceToken(SHOP, { purpose: "voice" }))).status, 401, "a voice token cannot upload");
    assert.deepEqual(seen, [`${SHOP}|net:203.0.113.7`], "counted as the proxy's shopper, whatever header the browser sends");
  }, {
    replay: createTokenReplayGuard({ connected: () => false }),
    limiter: (req, _res, next) => { seen.push(visitorKey(req)); next(); },
  });
});

test("the vision call is measured: one AI call for this purpose, with its tokens", async () => {
  const metrics = await import("../src/observability/metrics.js");
  metrics.__resetMetricsForTest();
  const gemini = fakeGemini("A blue mug.");
  const realCreate = gemini.models.generateContent;
  gemini.models.generateContent = async (...a) => ({ ...(await realCreate(...a)), usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 12 } });
  __setLLMClientsForTest({ gemini });
  try {
    await describeAttachments([{ mime: "image/png", data: PNG.toString("base64") }], "");
    const rows = metrics.renderPrometheus();
    assert.match(rows, /llm_calls_total\{model="[^"]*",outcome="ok",provider="gemini",purpose="vision"\} 1/);
    assert.match(rows, /llm_tokens_total\{kind="input",model="[^"]*",provider="gemini",purpose="vision"\} 300/);
  } finally {
    __setLLMClientsForTest(null);
  }
});

test("the file name header keeps the shopper's name, safely", async () => {
  const { contentDisposition } = await import("../src/admin/routes.js");
  assert.equal(contentDisposition("photo 1.jpg"), `inline; filename="photo 1.jpg"; filename*=UTF-8''photo%201.jpg`);
  const hindi = contentDisposition('बिल"x\n.pdf');
  assert.doesNotMatch(hindi, /[\n"]x/, "no quote or line break can break the header");
  assert.match(hindi, /filename\*=UTF-8''%E0%A4%AC/);
  assert.equal(contentDisposition(""), `inline; filename="file"; filename*=UTF-8''file`);
});
