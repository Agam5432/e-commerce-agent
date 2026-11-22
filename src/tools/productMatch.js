// Pure product matching: title + description + colour, synonyms, and fit.
// No Shopify calls here so it can be unit-tested on its own.

const COLOR_ALIASES = {
  black: "black",
  kala: "black",
  kali: "black",
  kale: "black",
  white: "white",
  safed: "white",
  safaid: "white",
  blue: "blue",
  neela: "blue",
  neeli: "blue",
  neele: "blue",
  navy: "navy",
  red: "red",
  lal: "red",
  laal: "red",
  green: "green",
  hara: "green",
  hari: "green",
  olive: "olive",
  grey: "grey",
  gray: "grey",
  pink: "pink",
  gulabi: "pink",
  yellow: "yellow",
  peela: "yellow",
  peeli: "yellow",
  brown: "brown",
  bhura: "brown",
  beige: "beige",
  maroon: "maroon",
  purple: "purple",
  baingani: "purple",
  orange: "orange",
  khaki: "khaki",
  cream: "cream",
  teal: "teal",
  gold: "gold",
  silver: "silver",
  charcoal: "charcoal",
};

const COLOR_SET = new Set(Object.values(COLOR_ALIASES));

export function canonicalToken(token) {
  const t = String(token || "").toLowerCase();
  return COLOR_ALIASES[t] || t;
}

export function isColorToken(token) {
  return COLOR_SET.has(canonicalToken(token));
}

export function extractColors(text) {
  const found = [];
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9+]+/)) {
    if (!raw) continue;
    const canon = COLOR_ALIASES[raw];
    if (canon && !found.includes(canon)) found.push(canon);
  }
  return found;
}

export function splitProductAsks(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw
    .split(/\s+(?:and|aur|or|ya|\+)\s+|[,;]/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (parts.length < 2) return [raw];
  if (parts.some((part) => part.split(/\s+/).length > 4)) return [raw];
  return parts.slice(0, 5);
}

