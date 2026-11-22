import test from "node:test";
import assert from "node:assert/strict";
import { prepareVoiceFiles, FILES_ONLY_TEXT } from "../src/voice/voiceFiles.js";
import { chatRefFor } from "../src/services/conversationLog.js";

const SHOP = "gada.myshopify.com";
const CLIENT = "c_0123456789abcdef0123456789abcdef";
const file = (o = {}) => ({ _id: "a".repeat(24), name: "bill.jpg", kind: "image", mime: "image/jpeg", size: 10, data: Buffer.from("x"), ...o });

test("files from the call are looked up for THIS visitor only and described for the agent", async () => {
  let asked, described;
  const out = await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: ["a".repeat(24)], text: " is this the right one? " }, {
    loadAttachments: async (q) => { asked = q; return [file()]; },
    describeAttachments: async (media, said) => { described = { media, said }; return "a damaged phone"; },
    buildAttachmentNote: (files, description) => `NOTE:${files.length}:${description}`,
  });
  assert.equal(asked.chatRef, chatRefFor(SHOP, CLIENT));
  assert.equal(asked.shop, SHOP);
  assert.equal(described.said, "is this the right one?");
  assert.equal(described.media[0].mime, "image/jpeg");
  assert.equal(out.question, "is this the right one?");
  assert.equal(out.note, "NOTE:1:a damaged phone");
  assert.deepEqual(out.files, [{ id: "a".repeat(24), name: "bill.jpg", kind: "image", mime: "image/jpeg", size: 10 }]);
});

test("files sent without words get a plain placeholder, and videos are not sent to the image reader", async () => {
  let media;
  const out = await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: ["b".repeat(24)] }, {
    loadAttachments: async () => [file({ kind: "video", mime: "video/mp4" })],
    describeAttachments: async (m) => { media = m; return "x"; },
    buildAttachmentNote: () => "VIDEO NOTE",
  });
  assert.equal(media, undefined, "no image description is asked for a video");
  assert.equal(out.question, FILES_ONLY_TEXT);
  assert.equal(out.note, "VIDEO NOTE");
});

test("nothing happens for unknown files, no visitor, or no ids", async () => {
  const deps = { loadAttachments: async () => [], describeAttachments: async () => "", buildAttachmentNote: () => "" };
  assert.equal(await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: ["c".repeat(24)] }, deps), null);
  assert.equal(await prepareVoiceFiles({ shop: SHOP, clientId: "", ids: ["c".repeat(24)] }, deps), null);
  assert.equal(await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: [] }, deps), null);
  assert.equal(await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: "nope" }, deps), null);
});

test("a failing image reader does not lose the files: the agent is told it could not view them", async () => {
  const out = await prepareVoiceFiles({ shop: SHOP, clientId: CLIENT, ids: ["a".repeat(24)] }, {
    loadAttachments: async () => [file()],
    describeAttachments: async () => { throw new Error("vision down"); },
    buildAttachmentNote: (_f, description) => (description ? "seen" : "cannot view"),
  });
  assert.equal(out.note, "cannot view");
});
