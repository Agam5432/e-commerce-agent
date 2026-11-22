// Files a shopper attaches in the chat: checked by their real content (not the name or the type
// the browser claims), scanned for viruses when a scanner is set up, kept within the store's storage
// quota, stored per shop (in MongoDB or object storage), and read back only for the shop and visitor
// they belong to.
import { readFile } from "node:fs/promises";
import Attachment from "../models/Attachment.js";
import SupportRecording from "../models/SupportRecording.js";
import { retentionDaysFor } from "../admin/settings.js";
import { fileKindAllowed } from "./bookingSettings.js";
import { attachmentStorage } from "./objectStorage.js";
import { malwareScanner } from "./malwareScan.js";

const envNumber = (name, fallback, env = process.env) => {
  const value = Number(env[name]);
  return env[name] !== undefined && String(env[name]).trim() !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const MAX_FILES = 10;
export const MAX_BYTES = { image: 8 * 1024 * 1024, pdf: 10 * 1024 * 1024, video: 15 * 1024 * 1024 };
export const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;
const LOOKS_LIKE_ID = /^[a-f0-9]{24}$/;

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/** What the bytes really are: { kind, mime } or null for anything that is not an allowed photo, video or PDF. */
export function detectFile(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif" };
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.toString("ascii", 8, 12) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return { kind: "pdf", mime: "application/pdf" };
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (/^(heic|heix|mif1|msf1)/.test(brand)) return { kind: "image", mime: "image/heic" };
    return { kind: "video", mime: brand.startsWith("qt") ? "video/quicktime" : "video/mp4" };
  }
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm" };
  return null;
}

const cleanName = (name) => String(name || "file").replace(/[\u0000-\u001f\u007f/\\]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

/** The file's bytes as a Buffer, whether the driver returned a Buffer or a BSON Binary. */
export function bytesOf(doc) {
  const data = doc?.data;
  if (Buffer.isBuffer(data)) return data;
  const raw = data?.buffer;
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw.subarray(0, Number.isInteger(data.position) ? data.position : raw.length));
}

export function toMeta(doc) {
  return { id: String(doc._id), name: doc.name, kind: doc.kind, mime: doc.mime, size: doc.size };
}

/** Bytes one store's live files take up now. */
export async function storeUsageBytes(shop, { model = Attachment } = {}) {
  if (typeof model.aggregate !== "function") return 0;
  const [row] = await model.aggregate([{ $match: { shop } }, { $group: { _id: null, bytes: { $sum: "$size" } } }]);
  return Number(row?.bytes) || 0;
}

/** The storage each store may use for shopper files (SHOP_ATTACHMENT_QUOTA_MB, 0 = no limit). */
export const storeQuotaBytes = (env = process.env) => envNumber("SHOP_ATTACHMENT_QUOTA_MB", 1024, env) * 1024 * 1024;

/**
 * Stores the files of one upload. Returns { attachments, rejected, reasons }: every accepted file as
 * metadata, the names of files that were not stored, and why (type, size, virus, quota).
 * A file may come as a Buffer (`buffer`) or as a temporary file on disk (`path`): files are read one at a time.
 * Throws ScannerUnavailableError when a virus scanner is configured but cannot be reached.
 */
export async function saveAttachments(
  { shop, chatRef, files = [], settings = {}, now = Date.now() },
  { model = Attachment, storage = attachmentStorage(), scanner = malwareScanner(), usedBytes = storeUsageBytes, quotaBytes = storeQuotaBytes(), log = console } = {}
) {
  const until = new Date(now + retentionDaysFor(settings) * DAY_MS);
  const accepted = [];
  const rejected = [];
  const reasons = {};
  const refuse = (name, reason) => {
    rejected.push(name);
    reasons[name] = reason;
  };
  let used = quotaBytes > 0 ? await usedBytes(shop, { model }) : 0;
  for (const file of files.slice(0, MAX_FILES)) {
    const name = cleanName(file.originalname);
    const buffer = file.buffer || (file.path ? await readFile(file.path) : Buffer.alloc(0));
    const type = detectFile(buffer);
    if (!type) {
      refuse(name, "type");
      continue;
    }
    if (buffer.length > MAX_BYTES[type.kind] || !fileKindAllowed(settings, type.kind)) {
      refuse(name, buffer.length > MAX_BYTES[type.kind] ? "size" : "type");
      continue;
    }
    if (quotaBytes > 0 && used + buffer.length > quotaBytes) {
      refuse(name, "quota");
      continue;
    }
    const verdict = await scanner.scan(buffer);
    if (!verdict.clean) {
      log.warn?.(`[uploads] ${shop}: a file was refused by the virus scanner (${verdict.signature || "infected"})`);
      refuse(name, "virus");
      continue;
    }
    used += buffer.length;
    const base = { shop, chatRef, name, mime: type.mime, kind: type.kind, size: buffer.length };
    if (storage) {
      const objectKey = storage.keyFor(shop);
      await storage.put(objectKey, buffer, type.mime);
      accepted.push({ ...base, storage: "s3", objectKey, deleteAfter: until });
    } else {
      accepted.push({ ...base, storage: "mongo", data: buffer, expiresAt: until });
    }
  }
  const docs = accepted.length ? await model.insertMany(accepted, { ordered: true }) : [];
  return { attachments: docs.map(toMeta), rejected, reasons };
}

/** The bytes of one stored file, wherever it is kept (null when its object is gone). */
export async function attachmentBytes(doc, { storage = attachmentStorage() } = {}) {
  if (doc?.storage === "s3") {
    if (!storage || !doc.objectKey) return null;
    return storage.get(doc.objectKey);
  }
  return bytesOf(doc);
}

/**
 * The files' content for the AI to look at: photos and PDFs only, at most MAX_FILES_TO_AI of them
 * (default 3) and none bigger than MAX_FILE_MB_TO_AI (default 5). Returns { media, viewed }.
 */
export async function mediaForAI(files = [], { env = process.env, read = attachmentBytes } = {}) {
  const limit = envNumber("MAX_FILES_TO_AI", 3, env);
  const maxBytes = envNumber("MAX_FILE_MB_TO_AI", 5, env) * 1024 * 1024;
  const media = [];
  for (const file of files) {
    if (media.length >= limit) break;
    if (file.kind === "video" || file.size > maxBytes) continue;
    const bytes = await read(file).catch(() => null);
    if (bytes?.length) media.push({ mime: file.mime, data: bytes.toString("base64") });
  }
  return { media, viewed: media.length };
}

/**
 * Deletes the files matching `filter`, with their objects in object storage. Returns how many.
 * Used by the privacy erase and the retention sweeper.
 */
export async function removeAttachments(filter, { model = Attachment, storage = attachmentStorage(), log = console } = {}) {
  const inObjects = await model.find({ ...filter, storage: "s3" }, { objectKey: 1 }).lean();
  if (inObjects.length && !storage) log.warn?.(`[uploads] ${inObjects.length} file(s) are in object storage but ATTACHMENT_STORAGE is not set; their objects stay until the bucket's own expiry`);
  if (storage) for (const row of inObjects) if (row.objectKey) await storage.remove(row.objectKey);
  return (await model.deleteMany(filter)).deletedCount || 0;
}

/** Files in object storage whose retention has ended: object first, then the record. */
export async function sweepExpiredObjects({ model = Attachment, storage = attachmentStorage(), now = Date.now(), batch = 200, log = console } = {}) {
  if (!storage) return 0;
  const due = await model.find({ storage: "s3", deleteAfter: { $lte: new Date(now) } }, { objectKey: 1 }).limit(batch).lean();
  let removed = 0;
  for (const row of due) {
    try {
      if (row.objectKey) await storage.remove(row.objectKey);
      await model.deleteOne({ _id: row._id });
      removed++;
    } catch (error) {
      log.warn?.(`[uploads] could not remove an expired file yet: ${String(error?.message || error).slice(0, 120)}`);
    }
  }
  return removed;
}

/** Call recordings kept in object storage whose time is up (retention ended, or the customer was erased). */
export function sweepExpiredRecordings(options = {}) {
  return sweepExpiredObjects({ ...options, model: SupportRecording });
}

/** The files a chat message refers to (with bytes), only if they belong to this shop and visitor. */
export async function loadAttachments({ shop, chatRef, ids = [] }, { model = Attachment } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => LOOKS_LIKE_ID.test(id)))].slice(0, MAX_FILES);
  if (!wanted.length) return [];
  return model.find({ _id: { $in: wanted }, shop, chatRef }).select("+data").lean();
}

/** One file for the store owner's dashboard (shop-scoped; the visitor does not matter here). */
export async function readAttachmentForOwner(shop, id, { model = Attachment } = {}) {
  if (!LOOKS_LIKE_ID.test(String(id))) return null;
  return model.findOne({ _id: id, shop }).select("+data").lean();
}
