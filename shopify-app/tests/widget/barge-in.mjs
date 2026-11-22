// MOCK/AUTOMATED (real Chromium + the real widget script, but a scripted backend, voice socket and speech synthesis).
// The shopper starts talking (a loud fake microphone) while the assistant's voice is speaking: the voice must go quiet at
// once, and carry on only if it was just noise; real words from the server stop it for good, and it never speaks again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup } from "./harness.mjs";

// quiet, then the shopper's voice in two bursts with quiet between (so the second reply also starts over quiet)
function tone(file, bursts = [[4, 5.5], [9, 19]], total = 19, rate = 48000) {
  const n = rate * total, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (const [from, to] of bursts) for (let i = rate * from; i < Math.min(n, rate * to); i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.6 * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
const wav = path.join(os.tmpdir(), "orbi-loud-tone.wav");
tone(wav);
const { page, browser, check, errors } = await setup({ audio: wav });
// a voice that keeps "speaking" until it is paused or cancelled, and records what was done to it
await page.addInitScript(() => {
  window.__synth = [];
  const synth = window.speechSynthesis;
  Object.defineProperty(synth, "paused", { get: () => window.__paused === true });
  synth.speak = (u) => { window.__synth.push("speak:" + u.text); window.__paused = false; setTimeout(() => u.onstart && u.onstart(), 5); };
  synth.pause = () => { window.__paused = true; window.__synth.push("pause"); };
  synth.resume = () => { window.__paused = false; window.__synth.push("resume"); };
  synth.cancel = () => { window.__synth.push("cancel"); };
});
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(300);
await page.click(".ai-commerce-chat-mic");
await page.waitForTimeout(300);
const synth = () => page.evaluate(() => window.__synth.slice());
const sent = () => page.evaluate(() => window.__sent.map((d) => { try { return JSON.parse(d); } catch { return {}; } }));

await page.evaluate(() => window.__push({ type: "answer", text: "Yeh raha ek bahut lamba jawab jo abhi bola ja raha hai.", runId: 1, products: [], actions: [] }));
await page.waitForTimeout(4200); // the shopper's voice (the loud tone) starts at 4 s, while it speaks

let log = await synth();
check("the assistant started speaking", log.some((x) => x.startsWith("speak:")), JSON.stringify(log));
check("the voice is paused as soon as the shopper is heard talking", log.includes("pause"), JSON.stringify(log));
const answerAt = log.findIndex((x) => x.startsWith("speak:Yeh raha"));
check("it did not wait for the server to stop talking (no cancel before the pause)", log.indexOf("pause") > answerAt && !log.slice(answerAt, log.indexOf("pause")).includes("cancel"), JSON.stringify(log.slice(answerAt)));

// real words come back from the server: stop for good, tell the server, never speak the old answer again
await page.evaluate(() => window.__push({ type: "interim", text: "ruko mujhe kuch aur poochna hai" }));
await page.waitForTimeout(200);
log = await synth();
check("real words stop the old answer for good", log.includes("cancel"), JSON.stringify(log));
check("the server is told about the interruption", (await sent()).some((m) => m.type === "interrupt"));
const speaksBefore = log.filter((x) => x.startsWith("speak:")).length;
await page.waitForTimeout(800);
log = await synth();
check("the interrupted answer never starts again", log.filter((x) => x.startsWith("speak:")).length === speaksBefore && !log.slice(log.lastIndexOf("cancel") + 1).some((x) => x === "resume" || x.startsWith("speak:")), JSON.stringify(log));

// a late answer of the interrupted turn is dropped; the answer to the NEW sentence is spoken
const before = speaksBefore;
await page.evaluate(() => window.__push({ type: "answer", text: "Purana jawab jo ab nahi bolna chahiye.", runId: 1, products: [], actions: [] }));
await page.waitForTimeout(200);
log = await synth();
check("a late answer of the interrupted turn is not spoken", log.filter((x) => x.startsWith("speak:")).length === before, JSON.stringify(log.slice(-3)));
// the shopper's new sentence is answered normally (the loud voice is quiet again by now)
await page.waitForTimeout(800);
await page.evaluate(() => window.__push({ type: "transcript", text: "mujhe sasta wala dikhao", runId: 2 }));
await page.evaluate(() => window.__push({ type: "answer", text: "Ye lijiye sasta wala.", runId: 2, products: [], actions: [] }));
await page.waitForTimeout(300);
log = await synth();
check("the answer to the new sentence is spoken", log.some((x) => x === "speak:Ye lijiye sasta wala."), JSON.stringify(log.slice(-3)));
// and it can be interrupted again (the loud voice is still on the microphone)
await page.waitForTimeout(4500); // the second burst of the shopper's voice
log = await synth();
const second = log.length - 1 - [...log].reverse().findIndex((x) => x === "speak:Ye lijiye sasta wala.");
check("a second interruption pauses the new answer too", log.slice(second).includes("pause"), JSON.stringify(log.slice(second)));
await page.evaluate(() => window.__push({ type: "interim", text: "nahi ruko ek second", runId: 2 }));
await page.waitForTimeout(200);
log = await synth();
check("and stops it for good", log.slice(second).includes("cancel"), JSON.stringify(log.slice(second)));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
