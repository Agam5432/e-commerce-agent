// The shopper's gender is never guessed from their voice. Only what they say counts, and an old saved
// voice guess is dropped the next time their profile is read.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as profileModule from "../src/services/conversationProfile.js";

const { resolveShoppingGender, prepareConversation, withoutVoiceGuess } = profileModule;

test("there is no voice-based gender guess left to call", () => {
  assert.equal(profileModule.inferGenderFromVoice, undefined);
});

test("a voice guess in the profile never decides what to show", () => {
  assert.equal(resolveShoppingGender("show me something for myself", [], { recipient: "self", voiceGender: "women", voicePitchHz: 210 }), "");
  assert.equal(resolveShoppingGender("show shirts", [], { voiceGender: "men", voicePitchHz: 120 }), "");
  // what the shopper says still counts
  assert.equal(resolveShoppingGender("show shirts", [], { recipient: "self", voiceGender: "women", gender: "men" }), "men");
});

test("an old saved voice guess is removed from the profile and the cleaned profile is saved", async () => {
  let saved = null;
  const io = {
    load: async () => ({ profile: { voiceGender: "women", voicePitchHz: 205, customerName: "Asha", recipient: "self" } }),
    save: async (_shop, _client, patch) => { saved = patch; },
  };
  const result = await prepareConversation("a.myshopify.com", "buyer-0123456789ab", "hello", [], null, io);
  assert.equal(result.profile.voiceGender, undefined);
  assert.equal(result.profile.voicePitchHz, undefined);
  assert.equal(result.profile.customerName, "Asha", "everything else is kept");
  assert.ok(saved?.profile, "the cleaned profile is written back");
  assert.equal("voiceGender" in saved.profile, false);
});

test("prepareConversation no longer takes a voice guess as input", async () => {
  const io = { load: async () => null, save: async () => {} };
  const result = await prepareConversation("a.myshopify.com", "buyer-0123456789ab", "hello", [], null, { ...io, voiceGender: "men", voicePitchHz: 110 });
  assert.equal(result.profile.voiceGender, undefined);
  assert.deepEqual(withoutVoiceGuess({ voiceGender: "men", voicePitchHz: 1, a: 1 }), { a: 1 });
  assert.deepEqual(withoutVoiceGuess(null), {});
});

// Nothing on the server or in the storefront widget measures pitch or sends a voice guess any more.
function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test("no code path measures voice pitch or passes a voice gender", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [join(root, "server.js"), ...filesUnder(join(root, "src"))];
  const offenders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    if (file.endsWith("conversationProfile.js")) return /inferGenderFromVoice|PitchHz\s*[(:=]/.test(text.replace(/VOICE_GUESS_FIELDS = \[[^\]]*\]/, ""));
    return /voiceGender|voicePitchHz|PitchHz\(|voice_profile|Voice cue/.test(text);
  });
  assert.deepEqual(offenders, []);
});
