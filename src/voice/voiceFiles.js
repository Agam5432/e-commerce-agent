// Files a shopper attaches in the middle of a voice call. The browser uploads them first (the same upload the
// text chat uses) and then tells the call which files to look at. This turns those ids into what the agent
// needs for one turn: the files that really belong to this store and visitor, and the note describing them.
import { loadAttachments, mediaForAI, MAX_FILES } from "../services/attachmentService.js";
import { chatRefFor } from "../services/conversationLog.js";
import { describeAttachments } from "../agent/agent.js";
import { buildAttachmentNote } from "../routes/shopifyProxyRoutes.js";

const defaultDeps = { loadAttachments, describeAttachments, buildAttachmentNote, mediaForAI };
// what the transcript says when the shopper sent files without speaking about them
export const FILES_ONLY_TEXT = "(the customer sent files during the call without a message)";

/**
 * @returns {Promise<null | {question: string, note: string, files: {id: string, name: string, kind: string, mime: string, size: number}[]}>}
 *   null when none of the ids is a file of this visitor
 */
export async function prepareVoiceFiles({ shop, clientId, ids, text = "" }, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const wanted = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string").slice(0, MAX_FILES);
  if (!shop || !clientId || !wanted.length) return null;
  const stored = await d.loadAttachments({ shop, chatRef: chatRefFor(shop, clientId), ids: wanted });
  if (!stored.length) return null;
  const { media, viewed } = await d.mediaForAI(stored);
  const spoken = String(text || "").trim().slice(0, 500);
  const description = media.length ? await d.describeAttachments(media, spoken).catch(() => "") : "";
  return {
    question: spoken || FILES_ONLY_TEXT,
    note: d.buildAttachmentNote(stored, description, { viewed }),
    files: stored.map((f) => ({ id: String(f._id), name: f.name, kind: f.kind, mime: f.mime, size: f.size })),
  };
}
