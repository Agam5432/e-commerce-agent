// Email / phone validation used before a checkout can proceed.
// Phone rules are per country (national significant number length), no external deps.

const COUNTRIES = {
  IN: { name: "India", code: "91", lens: [10], lead: /^[6-9]/ },
  US: { name: "United States", code: "1", lens: [10], lead: /^[2-9]/ },
  CA: { name: "Canada", code: "1", lens: [10], lead: /^[2-9]/ },
  GB: { name: "United Kingdom", code: "44", lens: [10], trunk: true },
  AU: { name: "Australia", code: "61", lens: [9], trunk: true },
  NZ: { name: "New Zealand", code: "64", lens: [8, 9, 10], trunk: true },
  AE: { name: "UAE", code: "971", lens: [9], trunk: true },
  SA: { name: "Saudi Arabia", code: "966", lens: [9], trunk: true },
  SG: { name: "Singapore", code: "65", lens: [8] },
  MY: { name: "Malaysia", code: "60", lens: [9, 10], trunk: true },
  PK: { name: "Pakistan", code: "92", lens: [10], trunk: true },
  BD: { name: "Bangladesh", code: "880", lens: [10], trunk: true },
  NP: { name: "Nepal", code: "977", lens: [10] },
  LK: { name: "Sri Lanka", code: "94", lens: [9], trunk: true },
  DE: { name: "Germany", code: "49", lens: [10, 11], trunk: true },
  FR: { name: "France", code: "33", lens: [9], trunk: true },
  IT: { name: "Italy", code: "39", lens: [9, 10] },
  ES: { name: "Spain", code: "34", lens: [9] },
  NL: { name: "Netherlands", code: "31", lens: [9], trunk: true },
  ZA: { name: "South Africa", code: "27", lens: [9], trunk: true },
  ID: { name: "Indonesia", code: "62", lens: [9, 10, 11, 12], trunk: true },
  PH: { name: "Philippines", code: "63", lens: [10], trunk: true },
  JP: { name: "Japan", code: "81", lens: [10], trunk: true },
  CN: { name: "China", code: "86", lens: [11] },
  BR: { name: "Brazil", code: "55", lens: [10, 11] },
  MX: { name: "Mexico", code: "52", lens: [10] },
  RU: { name: "Russia", code: "7", lens: [10] },
};

const NAME_TO_ISO = {
  india: "IN", "united states": "US", usa: "US", "united states of america": "US", america: "US",
  canada: "CA", "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  australia: "AU", "new zealand": "NZ", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA",
  singapore: "SG", malaysia: "MY", pakistan: "PK", bangladesh: "BD", nepal: "NP", "sri lanka": "LK",
  germany: "DE", france: "FR", italy: "IT", spain: "ES", netherlands: "NL", "south africa": "ZA",
  indonesia: "ID", philippines: "PH", japan: "JP", china: "CN", brazil: "BR", mexico: "MX", russia: "RU",
};

// Longest calling code first so +971 is not read as +9 / +97.
const CODES = Object.entries(COUNTRIES)
  .map(([iso, c]) => ({ iso, code: c.code }))
  .sort((a, b) => b.code.length - a.code.length);

export function toIso(country) {
  const value = String(country || "").trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return NAME_TO_ISO[value.toLowerCase()] || "";
}



export function validateEmail(value) {
  const email = String(value || "").trim();
  if (!email) return { ok: false, reason: "missing" };
  if (email.length > 254 || /\s/.test(email)) return { ok: false, reason: "invalid" };
  const m = email.match(/^([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/);
  if (!m) return { ok: false, reason: "invalid" };
  const [, local, domain] = m;
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return { ok: false, reason: "invalid" };
  if (domain.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return { ok: false, reason: "invalid" };
  return { ok: true };
}

// phone: raw text; country: ISO code or country name of the delivery address.
export function validatePhone(phone, country) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "missing" };
  let iso = toIso(country);
  let national = digits;

  if (raw.startsWith("+") || raw.startsWith("00")) {
    const body = raw.startsWith("00") ? digits.slice(2) : digits;
    const hit = CODES.find((c) => body.startsWith(c.code));
    if (!hit) return { ok: false, reason: "invalid", iso };
    iso = hit.iso === "CA" && iso === "US" ? "US" : hit.iso === "US" && iso === "CA" ? "CA" : hit.iso;
    national = body.slice(hit.code.length);
  }

  const rule = COUNTRIES[iso];
  if (!rule) {
    const ok = digits.length >= 7 && digits.length <= 15;
    return { ok, reason: ok ? undefined : "invalid", iso };
  }
  if (!raw.startsWith("+") && !raw.startsWith("00") && digits.startsWith(rule.code) && digits.length === rule.code.length + Math.max(...rule.lens)) {
    national = digits.slice(rule.code.length);
  }
  if (rule.trunk && national.startsWith("0")) national = national.slice(1);
  const ok = rule.lens.includes(national.length) && (!rule.lead || rule.lead.test(national));
  return { ok, reason: ok ? undefined : "invalid", iso, country: rule.name, lengths: rule.lens };
}

export function phoneRuleText(country) {
  const rule = COUNTRIES[toIso(country)];
  if (!rule) return "a valid number with country code";
  const len = rule.lens.length === 1 ? `${rule.lens[0]}` : `${rule.lens[0]} to ${rule.lens[rule.lens.length - 1]}`;
  return `${len} digits for ${rule.name}`;
}

export function contactProblems({ email, phone, country } = {}) {
  const problems = [];
  const e = validateEmail(email);
  if (!e.ok) problems.push({ field: "email", reason: e.reason });
  const p = validatePhone(phone, country);
  if (!p.ok) problems.push({ field: "phone", reason: p.reason, rule: phoneRuleText(country) });
  return problems;
}

// Speakable lines for the agent, in the customer's language.
export function contactProblemMessage(problems, isHindi) {
  const parts = [];
  for (const p of problems) {
    if (p.field === "email") {
      parts.push(
        p.reason === "missing"
          ? isHindi ? "Order ke liye email address chahiye, bina email ke order place nahi hoga." : "An email address is required to place the order. I can't place it without one."
          : isHindi ? "Yeh email valid nahi hai. Sahi email address dobara bata do." : "That email is not valid. Please share a correct email address."
      );
    } else {
      parts.push(
        p.reason === "missing"
          ? isHindi ? "Order ke liye phone number chahiye, bina phone number ke order place nahi hoga." : "A phone number is required to place the order. I can't place it without one."
          : isHindi ? `Yeh phone number valid nahi hai. Sahi number chahiye (${p.rule}).` : `That phone number is not valid. It should be ${p.rule}.`
      );
    }
  }
  return parts.join(" ");
}