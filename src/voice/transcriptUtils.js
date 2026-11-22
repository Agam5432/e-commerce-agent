const wordsOf = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/**
 * How long the assistant is still talking after its answer was written: about 400 ms a word (slow Hinglish TTS) plus the
 * time it takes to start. A transcript that arrives inside this window can be the microphone hearing the assistant itself.
 */
export const speechWindowMs = answer => Math.min(45000, 800 + wordsOf(answer).length * 400);

// A speech recogniser never writes a spoken sentence exactly as the text-to-speech was given it: it drops a word, changes
// "Rs" to a symbol, splits a long word. So an echo is recognised by how much of what was heard is the assistant's own
// words, in the same order, not by an exact match.
function echoOverlap(words, spoken) {
  const spokenSet = new Set(spoken);
  const inSpoken = words.filter(word => spokenSet.has(word)).length;
  const spokenPairs = new Set(spoken.slice(1).map((word, i) => `${spoken[i]} ${word}`));
  const pairs = words.slice(1).map((word, i) => `${words[i]} ${word}`);
  const pairsInSpoken = pairs.filter(pair => spokenPairs.has(pair)).length;
  return { words: inSpoken / words.length, pairs: pairs.length ? pairsInSpoken / pairs.length : 0 };
}

export function isLikelyEcho(transcript, answer, answeredAt, now = Date.now()) {
  if (!answer) return false;
  const words = wordsOf(transcript);
  const spoken = wordsOf(answer);
  // Anything with numbers (an address, a phone, a quantity) can legitimately repeat the assistant's words.
  if (/\p{N}/u.test(transcript)) return words.length >= 12 && exactRun(words, spoken, answeredAt, now);

  // Inside the time the assistant is still speaking, what the microphone hears that is made of the assistant's own words,
  // in its order, is the assistant. (A shopper who answers after the assistant has finished is not caught by this.)
  if (now - answeredAt <= speechWindowMs(answer) && words.length >= 3) {
    const o = echoOverlap(words, spoken);
    if ((words.length >= 3 && o.words >= 0.85 && o.pairs >= 0.5) || (words.length >= 6 && o.words >= 0.65 && o.pairs >= 0.35)) return true;
  }

  // Short answers can legitimately repeat the assistant's words. Only a long run of its exact words, heard right after
  // it spoke, is an echo.
  return words.length >= 12 && exactRun(words, spoken, answeredAt, now);
}

function exactRun(words, spoken, answeredAt, now) {
  if (now - answeredAt > Math.min(30000, 1500 + spoken.length * 500)) return false;
  const normalized = ` ${words.join(" ")} `;
  const spokenText = ` ${spoken.join(" ")} `;
  return spokenText.includes(normalized);
}
