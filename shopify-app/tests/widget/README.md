# Widget browser tests

Run the real theme block in Chromium with a fake backend, fake voice socket and fake speech.

```bash
npm i -D playwright && npx playwright install chromium
node e2e.mjs     # UI: teaser, chips, Hindi UI, attachments, call strip, mute, minimized live state, clear chat, no speech in text chat
node voice.mjs   # voice logic: live words, language, spoken replies, barge-in related labels
```
