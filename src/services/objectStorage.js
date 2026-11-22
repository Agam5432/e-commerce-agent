// Optional object storage for shopper files (any S3-compatible service: AWS S3, Cloudflare R2,
// Backblaze B2, MinIO, DigitalOcean Spaces). Without it, files stay in MongoDB as before.
// Requests are signed with AWS Signature V4 using node:crypto, so no SDK is needed.
//
// ATTACHMENT_STORAGE=s3 turns it on, with:
//   S3_ENDPOINT          e.g. https://<account>.r2.cloudflarestorage.com or https://s3.ap-south-1.amazonaws.com
//   S3_REGION            e.g. ap-south-1 (R2: auto)
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//   S3_PREFIX            folder for these files (default "attachments")
import crypto from "node:crypto";

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const EMPTY_HASH = sha256Hex("");

const encodeRfc3986 = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const canonicalPath = (pathname) => pathname.split("/").map((part) => encodeRfc3986(decodeURIComponent(part))).join("/");

/**
 * Signs one request (AWS Signature Version 4). Returns the headers to send, Authorization included.
 * `payloadHash` is the hex SHA-256 of the body (EMPTY_HASH for no body).
 */
export function signRequest({ method, url, headers = {}, payloadHash = EMPTY_HASH, accessKeyId, secretAccessKey, region, service = "s3", now = new Date() }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const all = { ...headers, host: target.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...target.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [method.toUpperCase(), canonicalPath(target.pathname), query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const out = { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** The storage configured in the environment, or null when files stay in MongoDB. Throws on a half-done setup. */
export function createObjectStorage({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => new Date() } = {}) {
  if (String(env.ATTACHMENT_STORAGE || "mongo").toLowerCase() !== "s3") return null;
  const missing = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !String(env[k] || "").trim());
  if (missing.length) throw new Error(`ATTACHMENT_STORAGE=s3 needs ${missing.join(", ")}`);
  const endpoint = String(env.S3_ENDPOINT).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(endpoint)) throw new Error("S3_ENDPOINT must start with https://");
  const bucket = String(env.S3_BUCKET).trim();
  const credentials = { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, region: env.S3_REGION };
  const prefix = String(env.S3_PREFIX || "attachments").replace(/^\/+|\/+$/g, "") || "attachments";
  const objectUrl = (key) => `${endpoint}/${bucket}/${key}`;

  async function send(method, key, { body, headers = {} } = {}) {
    const payloadHash = body ? sha256Hex(body) : EMPTY_HASH;
    const signed = signRequest({ method, url: objectUrl(key), headers, payloadHash, ...credentials, now: now() });
    // a stalled storage endpoint must not hold an upload or a sweep forever
    const timeoutMs = Number(env.S3_TIMEOUT_MS) > 0 ? Number(env.S3_TIMEOUT_MS) : 15_000;
    return fetchImpl(objectUrl(key), { method, headers: signed, signal: AbortSignal.timeout(timeoutMs), ...(body ? { body } : {}) });
  }

  return {
    kind: "s3",
    /** A new object name for one store's file: only safe characters, unguessable. */
    keyFor(shop) {
      const store = String(shop || "unknown").toLowerCase().replace(/[^a-z0-9.-]/g, "-");
      const month = now().toISOString().slice(0, 7);
      return `${prefix}/${store}/${month}/${crypto.randomBytes(16).toString("hex")}`;
    },
    async put(key, body, contentType) {
      const res = await send("PUT", key, { body, headers: { "content-type": contentType || "application/octet-stream" } });
      if (!res.ok) throw new Error(`object storage refused the file (${res.status})`);
    },
    /** The bytes, or null when the object is gone. */
    async get(key) {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`object storage read failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await send("DELETE", key);
      if (!res.ok && res.status !== 404) throw new Error(`object storage delete failed (${res.status})`);
    },
  };
}

let shared;
/** The process-wide storage (null = MongoDB). */
export function attachmentStorage() {
  if (shared === undefined) shared = createObjectStorage();
  return shared;
}
export function __setAttachmentStorageForTest(value) {
  shared = value;
}
