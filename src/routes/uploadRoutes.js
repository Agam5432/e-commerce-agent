import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { verifyVoiceSessionToken } from "../services/voiceTokenService.js";
import { tokenReplayGuard } from "../services/tokenReplay.js";
import { resolveClientId, verifiedCustomerGid } from "../services/customerContext.js";
import { chatRefFor } from "../services/conversationLog.js";
import { getAgentSettings } from "../admin/settings.js";
import { saveAttachments, MAX_BYTES, MAX_FILES, MAX_REQUEST_BYTES } from "../services/attachmentService.js";
import { ScannerUnavailableError } from "../services/malwareScan.js";
import { createChatRateLimiter, createShopBudget, envCount } from "../http/hardening.js";
import { inc } from "../observability/metrics.js";
import { alert } from "../observability/alerts.js";
import { reportError } from "../observability/errors.js";

const biggest = Math.max(...Object.values(MAX_BYTES));

/** Where an upload waits while it is checked: on disk, so a large upload never sits whole in memory. */
export function uploadTempDir(env = process.env) {
  const dir = env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), "orbi-uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function uploadParser(dir) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      // never the shopper's file name on disk
      filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
    }),
    limits: { fileSize: biggest, files: MAX_FILES, fields: 4, parts: MAX_FILES + 5 },
  }).array("files", MAX_FILES);
}

/**
 * How many uploads this process handles at once (MAX_CONCURRENT_UPLOADS, default 4). Each one holds
 * at most one file in memory at a time, so memory use stays bounded whatever arrives.
 */
export function createUploadSlots(limit = envCount("MAX_CONCURRENT_UPLOADS", 4) || 4) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    take() {
      if (active >= limit) return null;
      active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active--;
        }
      };
    },
  };
}

const removeTempFiles = (files = []) => Promise.all(files.map((f) => (f?.path ? unlink(f.path).catch(() => {}) : null)));

/**
 * POST /api/uploads : multipart { clientId, files[] } with `Authorization: Bearer <token>`.
 * The token is a short-lived, shop-bound upload token from the App Proxy (POST /voice-token with
 * purpose "upload"), used once, so a file can only be stored for a verified storefront and each upload
 * needs a fresh token from the proxy (whose limits count the real shopper). The storefront sends files
 * here directly because the App Proxy is not meant for large bodies.
 * Answers carry a `code` the widget turns into its own words: rate_limited, store_busy, uploads_busy,
 * too_large, too_many, not_allowed, quota_full, scanner_unavailable.
 */
export function createUploadRouter({
  save = saveAttachments,
  settingsFor = getAgentSettings,
  replay = tokenReplayGuard(),
  limiter = createChatRateLimiter({ name: "uploads", limit: Number(process.env.UPLOAD_RATE_LIMIT) || 12 }),
  // a ceiling for the whole store's uploads: files are stored, so storage cannot grow without bound
  shopLimit = createShopBudget({ name: "uploads", perMinute: envCount("SHOP_UPLOAD_RATE_LIMIT_PER_MINUTE", 60), perDay: envCount("SHOP_UPLOAD_LIMIT_PER_DAY", 2000) }),
  slots = createUploadSlots(),
  tempDir = uploadTempDir(),
  log = console,
} = {}) {
  const router = Router();
  const parse = uploadParser(tempDir);
  const unauthorised = (res) => res.status(401).json({ error: "Upload is not authorised. Please reload the page.", code: "unauthorised" });

  router.post(
    "/",
    (req, res, next) => {
      const session = verifyVoiceSessionToken(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), { purpose: "upload" });
      if (!session) return unauthorised(res);
      // each upload token works once
      Promise.resolve(replay.consume(session.jti, session.exp))
        .then((fresh) => {
          if (!fresh) return unauthorised(res);
          req.verifiedShop = session.shop;
          req.uploadCustomerId = session.customerId;
          req.tokenVisitor = session.visitor;
          return next();
        })
        .catch(next);
    },
    limiter,
    ...shopLimit,
    (req, res, next) => {
      if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) return res.status(413).json({ error: "These files are too large to send together.", code: "too_large" });
      // taken before the body is read, so a flood of uploads waits outside instead of filling memory or disk
      const release = slots.take();
      if (!release) {
        inc("uploads_refused_total", { reason: "busy" });
        return res.status(503).json({ error: "Uploads are busy right now. Please try again in a moment.", code: "uploads_busy" });
      }
      res.on("finish", release);
      res.on("close", release);
      parse(req, res, async (error) => {
        if (!error) return next();
        await removeTempFiles(req.files);
        if (error instanceof multer.MulterError) {
          const tooBig = error.code === "LIMIT_FILE_SIZE";
          const tooMany = error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE";
          const message = tooBig ? "A file is too large." : tooMany ? `You can attach up to ${MAX_FILES} files.` : "Invalid upload.";
          return res.status(tooBig ? 413 : 400).json({ error: message, code: tooBig ? "too_large" : tooMany ? "too_many" : "invalid" });
        }
        return next(error);
      });
    },
    async (req, res) => {
      const files = req.files || [];
      let status = 200;
      let body;
      try {
        if (!files.length) {
          status = 400;
          body = { error: "No files were sent.", code: "invalid" };
        } else {
          const clientId = resolveClientId({ clientId: req.body?.clientId, shop: req.verifiedShop, customerId: verifiedCustomerGid(req.uploadCustomerId) });
          const chatRef = chatRefFor(req.verifiedShop, clientId);
          const settings = await settingsFor(req.verifiedShop);
          const { attachments, rejected, reasons = {} } = await save({ shop: req.verifiedShop, chatRef, files, settings });
          for (const reason of Object.values(reasons)) inc("uploads_refused_total", { reason }, 1, "Shopper files not stored, by reason");
          inc("uploads_stored_total", {}, attachments.length, "Shopper files stored");
          if (attachments.length) body = { attachments, rejected };
          else if (Object.values(reasons).includes("quota")) {
            alert(`quota:${req.verifiedShop}`, `${req.verifiedShop} reached its storage quota for shopper files (SHOP_ATTACHMENT_QUOTA_MB); new files are refused until old ones expire.`);
            status = 507;
            body = { error: "This store cannot take more files right now.", code: "quota_full", rejected };
          } else {
            status = 415;
            body = { error: "These files cannot be attached here. Photos, videos and PDFs of a normal size are accepted, if this store allows them.", code: "not_allowed", rejected };
          }
        }
      } catch (error) {
        if (error instanceof ScannerUnavailableError) {
          log.error?.(`[uploads] ${req.verifiedShop}: ${error.message}; files refused until the scanner is back`);
          alert("scanner_down", `The virus scanner is unreachable (${error.message}); shopper files are refused until it is back.`);
          status = 503;
          body = { error: "Files cannot be checked right now. Please try again later.", code: "scanner_unavailable" };
        } else {
          log.error?.("Upload failed:", String(error?.message || error).slice(0, 160));
          reportError(error, { scope: "uploads", tags: { shop: req.verifiedShop } });
          status = 500;
          body = { error: "Could not upload the files. Please try again.", code: "failed" };
        }
      }
      // the temporary files are gone before the answer goes out
      await removeTempFiles(files);
      return res.status(status).json(body);
    }
  );

  return router;
}

export default createUploadRouter();
