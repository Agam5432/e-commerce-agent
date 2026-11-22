// Uploads stay bounded: never whole in memory, a few at a time, within each store's quota, scanned for
// viruses when a scanner is set up, optionally kept in S3-compatible storage, and only a few files go
// to the AI per turn.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { signRequest, createObjectStorage } from "../src/services/objectStorage.js";
import { scanWithClamd, createMalwareScanner, ScannerUnavailableError } from "../src/services/malwareScan.js";
import { saveAttachments, mediaForAI, removeAttachments, sweepExpiredObjects, attachmentBytes, storeQuotaBytes } from "../src/services/attachmentService.js";
import { createUploadRouter, createUploadSlots } from "../src/routes/uploadRoutes.js";
import { buildAttachmentNote } from "../src/routes/shopifyProxyRoutes.js";
import { createVoiceToken } from "../src/services/voiceTokenService.js";

const SHOP = "a.myshopify.com";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]);
const clean = { scan: async () => ({ clean: true }) };

function fakeModel(rows = []) {
  const stored = [...rows];
  const match = (d, f) => Object.entries(f).every(([k, v]) => (v && typeof v === "object" && "$lte" in v ? d[k] <= v.$lte : v && typeof v === "object" && "$in" in v ? v.$in.includes(d[k]) : d[k] === v));
  return {
    stored,
    async insertMany(docs) {
      const out = docs.map((d, i) => ({ _id: `id${stored.length + i}`, ...d }));
      stored.push(...out);
      return out;
    },
    find(filter) {
      const rowsFound = stored.filter((d) => match(d, filter));
      const q = { lean: async () => rowsFound, limit: () => q };
      return q;
    },
    async deleteMany(filter) {
      const before = stored.length;
      for (let i = stored.length - 1; i >= 0; i--) if (match(stored[i], filter)) stored.splice(i, 1);
      return { deletedCount: before - stored.length };
    },
    async deleteOne(filter) {
      const i = stored.findIndex((d) => match(d, filter));
      if (i >= 0) stored.splice(i, 1);
    },
  };
}

// ---- object storage ----------------------------------------------------------------------------
const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", now: new Date("2013-05-24T00:00:00Z") };

test("requests are signed exactly as AWS documents (Signature V4 examples)", () => {
  const get = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9" }, payloadHash: crypto.createHash("sha256").update("").digest("hex"), ...AWS });
  assert.match(get.Authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const body = "Welcome to Amazon S3.";
  const put = signRequest({ method: "PUT", url: "https://examplebucket.s3.amazonaws.com/test%24file.text", headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: crypto.createHash("sha256").update(body).digest("hex"), ...AWS });
  assert.match(put.Authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

const S3_ENV = { ATTACHMENT_STORAGE: "s3", S3_ENDPOINT: "https://acc.r2.example.com/", S3_REGION: "auto", S3_BUCKET: "orbi-files", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };

test("object storage is off unless configured, and a half-done setup is an error", () => {
  assert.equal(createObjectStorage({ env: {} }), null);
  assert.equal(createObjectStorage({ env: { ATTACHMENT_STORAGE: "mongo" } }), null);
  assert.throws(() => createObjectStorage({ env: { ATTACHMENT_STORAGE: "s3", S3_BUCKET: "b" } }), /S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
});

function fakeBucket() {
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, type: init.headers["content-type"] });
    const key = new URL(url).pathname;
    if (init.method === "PUT") { objects.set(key, Buffer.from(init.body)); return new Response(null, { status: 200 }); }
    if (init.method === "GET") return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
    if (init.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 400 });
  };
  return { objects, calls, storage: createObjectStorage({ env: S3_ENV, fetchImpl }) };
}

test("put, get and delete go to the bucket, path style, signed", async () => {
  const { storage, calls, objects } = fakeBucket();
  const key = storage.keyFor("A.myshopify.com");
  assert.match(key, /^attachments\/a\.myshopify\.com\/\d{4}-\d{2}\/[0-9a-f]{32}$/);
  await storage.put(key, PNG, "image/png");
  assert.equal(calls[0].url, `https://acc.r2.example.com/orbi-files/${key}`);
  assert.match(calls[0].auth, /^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(await storage.get(key), PNG);
  await storage.remove(key);
  assert.equal(objects.size, 0);
  assert.equal(await storage.get(key), null, "a missing object reads as null");
});

// ---- virus scan --------------------------------------------------------------------------------
// A tiny clamd: reads the INSTREAM chunks and answers like clamd does.
function fakeClamd(verdict) {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const head = "zINSTREAM\0";
      if (buf.length < head.length) return;
      let off = head.length;
      const parts = [];
      while (off + 4 <= buf.length) {
        const size = buf.readUInt32BE(off);
        if (size === 0) {
          received.push(Buffer.concat(parts));
          socket.end(verdict(Buffer.concat(parts)));
          return;
        }
        if (off + 4 + size > buf.length) return;
        parts.push(buf.subarray(off + 4, off + 4 + size));
        off += 4 + size;
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, received, port: server.address().port })));
}

test("files are streamed to clamd; a clean file passes and an infected one is named", async () => {
  const clamd = await fakeClamd((bytes) => (bytes.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"));
  try {
    const big = Buffer.alloc(200 * 1024, 7);
    assert.deepEqual(await scanWithClamd(big, { host: "127.0.0.1", port: clamd.port }), { clean: true });
    assert.deepEqual(clamd.received[0], big, "sent whole, in chunks");
    assert.deepEqual(await scanWithClamd(Buffer.from("x EICAR x"), { host: "127.0.0.1", port: clamd.port }), { clean: false, signature: "Eicar-Test-Signature" });
  } finally {
    clamd.server.close();
  }
});

test("a configured scanner that cannot be reached refuses files, unless CLAMAV_FAIL_OPEN=1", async () => {
  const unreachable = { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: "1", CLAMAV_TIMEOUT_MS: "500" };
  await assert.rejects(createMalwareScanner({ env: unreachable }).scan(PNG), ScannerUnavailableError);
  const open = await createMalwareScanner({ env: { ...unreachable, CLAMAV_FAIL_OPEN: "1" }, log: { warn() {} } }).scan(PNG);
  assert.deepEqual(open, { clean: true, unscanned: true });
  assert.equal(createMalwareScanner({ env: {} }).enabled, false);
});

// ---- saving -------------------------------------------------------------------------------------
test("a file over the store's quota is refused, with the reason", async () => {
  const model = fakeModel();
  const out = await saveAttachments(
    { shop: SHOP, chatRef: "r", files: [{ originalname: "a.png", buffer: PNG }, { originalname: "b.pdf", buffer: PDF }] },
    { model, storage: null, scanner: clean, usedBytes: async () => 1000 - PNG.length, quotaBytes: 1000 }
  );
  assert.deepEqual(out.attachments.map((a) => a.name), ["a.png"]);
  assert.deepEqual(out.reasons, { "b.pdf": "quota" });
  assert.equal(storeQuotaBytes({ SHOP_ATTACHMENT_QUOTA_MB: "2" }), 2 * 1024 * 1024);
  assert.equal(storeQuotaBytes({}), 1024 * 1024 * 1024);
});

test("an infected file is refused; a scanner outage stops the upload", async () => {
  const model = fakeModel();
  const scanner = { scan: async (b) => (b.equals(PDF) ? { clean: false, signature: "Bad" } : { clean: true }) };
  const out = await saveAttachments({ shop: SHOP, chatRef: "r", files: [{ originalname: "a.png", buffer: PNG }, { originalname: "b.pdf", buffer: PDF }] }, { model, storage: null, scanner, quotaBytes: 0, log: { warn() {} } });
  assert.deepEqual(out.reasons, { "b.pdf": "virus" });
  await assert.rejects(
    saveAttachments({ shop: SHOP, chatRef: "r", files: [{ originalname: "a.png", buffer: PNG }] }, { model, storage: null, scanner: { scan: async () => { throw new ScannerUnavailableError("down"); } }, quotaBytes: 0 }),
    ScannerUnavailableError
  );
});

test("with object storage the bytes go to the bucket and the record keeps only the key", async () => {
  const { storage, objects } = fakeBucket();
  const model = fakeModel();
  const now = Date.UTC(2026, 10, 1);
  const dir = mkdtempSync(path.join(os.tmpdir(), "orbi-test-"));
  const onDisk = path.join(dir, "upload");
  writeFileSync(onDisk, PNG);
  const out = await saveAttachments({ shop: SHOP, chatRef: "r", now, settings: { logging: { retentionDays: 10 } }, files: [{ originalname: "a.png", path: onDisk }] }, { model, storage, scanner: clean, quotaBytes: 0 });
  assert.equal(out.attachments.length, 1);
  const row = model.stored[0];
  assert.equal(row.storage, "s3");
  assert.equal(row.data, undefined, "no bytes in the database");
  assert.equal(row.expiresAt, undefined, "the database must not drop the record before the object");
  assert.equal(row.deleteAfter.getTime(), now + 10 * 86400_000);
  assert.deepEqual(objects.get(`/orbi-files/${row.objectKey}`), PNG);
  assert.deepEqual(await attachmentBytes(row, { storage }), PNG);
});

test("expired objects are swept with their records; a privacy erase removes the objects too", async () => {
  const { storage, objects } = fakeBucket();
  await storage.put("attachments/x/old", PNG, "image/png");
  await storage.put("attachments/x/new", PNG, "image/png");
  const model = fakeModel([
    { _id: "1", shop: SHOP, chatRef: "r", storage: "s3", objectKey: "attachments/x/old", deleteAfter: new Date(1000) },
    { _id: "2", shop: SHOP, chatRef: "r", storage: "s3", objectKey: "attachments/x/new", deleteAfter: new Date(9e15) },
    { _id: "3", shop: SHOP, chatRef: "r", storage: "mongo", data: PNG },
  ]);
  assert.equal(await sweepExpiredObjects({ model, storage, now: 5000 }), 1);
  assert.deepEqual([...objects.keys()], ["/orbi-files/attachments/x/new"]);
  assert.equal(await removeAttachments({ shop: SHOP, chatRef: "r" }, { model, storage }), 2);
  assert.equal(objects.size, 0);
  assert.equal(model.stored.length, 0);
});

// ---- what the AI sees ----------------------------------------------------------------------------
test("only a few photos and PDFs go to the AI, never videos or very large files", async () => {
  const files = [
    { kind: "video", mime: "video/mp4", size: 10, data: MP4 },
    ...Array.from({ length: 5 }, () => ({ kind: "image", mime: "image/png", size: PNG.length, data: PNG })),
    { kind: "pdf", mime: "application/pdf", size: 9 * 1024 * 1024, data: PDF },
  ];
  const three = await mediaForAI(files, { env: {} });
  assert.equal(three.viewed, 3);
  assert.ok(three.media.every((m) => m.mime === "image/png"));
  assert.equal((await mediaForAI(files, { env: { MAX_FILES_TO_AI: "10" } })).viewed, 5, "the 9 MB PDF is over the size cap");
  assert.equal((await mediaForAI(files, { env: { MAX_FILES_TO_AI: "10", MAX_FILE_MB_TO_AI: "10" } })).viewed, 6);
  const note = buildAttachmentNote(files, "five shoes", { viewed: 3 });
  assert.match(note, /Only 3 of the 6 were looked at/);
  assert.doesNotMatch(buildAttachmentNote(files.slice(1, 3), "two shoes", { viewed: 2 }), /Only/);
});

// ---- the route ------------------------------------------------------------------------------------
async function withServer(options, fn) {
  process.env.SHOPIFY_CLIENT_SECRET = "bounded-upload-secret";
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "orbi-up-"));
  const app = express();
  app.use("/up", createUploadRouter({ settingsFor: async () => ({}), replay: { consume: async () => true }, limiter: (r, s, n) => n(), shopLimit: [], tempDir, log: { error() {} }, ...options }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn({ url: `http://127.0.0.1:${server.address().port}/up`, tempDir });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const send = (url) => {
  const body = new FormData();
  body.append("clientId", "client-abcdefghijklmnop");
  body.append("files", new Blob([PNG]), "a.png");
  return fetch(url, { method: "POST", headers: { Authorization: `Bearer ${createVoiceToken(SHOP, { purpose: "upload" })}` }, body });
};

test("uploads wait on disk, are removed after, and only a few run at once", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const seenPaths = [];
  await withServer(
    {
      slots: createUploadSlots(1),
      save: async ({ files }) => { seenPaths.push(files[0].path); await gate; return { attachments: [{ id: "x" }], rejected: [] }; },
    },
    async ({ url, tempDir }) => {
      const first = send(url);
      await new Promise((r) => setTimeout(r, 150));
      const second = await send(url);
      assert.equal(second.status, 503);
      assert.equal((await second.json()).code, "uploads_busy");
      assert.ok(seenPaths[0]?.startsWith(tempDir), "the file was on disk, not in memory");
      release();
      assert.equal((await first).status, 200);
      assert.deepEqual(readdirSync(tempDir), [], "the temporary file is removed");
      assert.equal((await send(url)).status, 200, "the slot is free again");
    }
  );
});

test("the route answers with codes for a full store and a scanner outage", async () => {
  await withServer({ save: async () => ({ attachments: [], rejected: ["a.png"], reasons: { "a.png": "quota" } }) }, async ({ url }) => {
    const res = await send(url);
    assert.equal(res.status, 507);
    assert.equal((await res.json()).code, "quota_full");
  });
  await withServer({ save: async () => { throw new ScannerUnavailableError("down"); } }, async ({ url, tempDir }) => {
    const res = await send(url);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "scanner_unavailable");
    assert.deepEqual(readdirSync(tempDir), [], "removed after a failure too");
  });
});
