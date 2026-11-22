const INDIAN_STATES_MAP = {
  up: { name: "Uttar Pradesh", code: "UP" },
  "uttar pradesh": { name: "Uttar Pradesh", code: "UP" },
  mp: { name: "Madhya Pradesh", code: "MP" },
  "madhya pradesh": { name: "Madhya Pradesh", code: "MP" },
  dl: { name: "Delhi", code: "DL" },
  delhi: { name: "Delhi", code: "DL" },
  "new delhi": { name: "Delhi", code: "DL" },
  mh: { name: "Maharashtra", code: "MH" },
  maharashtra: { name: "Maharashtra", code: "MH" },
  pb: { name: "Punjab", code: "PB" },
  punjab: { name: "Punjab", code: "PB" },
  hr: { name: "Haryana", code: "HR" },
  haryana: { name: "Haryana", code: "HR" },
  rj: { name: "Rajasthan", code: "RJ" },
  rajasthan: { name: "Rajasthan", code: "RJ" },
  uk: { name: "Uttarakhand", code: "UK" },
  uttarakhand: { name: "Uttarakhand", code: "UK" },
  hp: { name: "Himachal Pradesh", code: "HP" },
  "himachal pradesh": { name: "Himachal Pradesh", code: "HP" },
  gj: { name: "Gujarat", code: "GJ" },
  gujarat: { name: "Gujarat", code: "GJ" },
  ka: { name: "Karnataka", code: "KA" },
  karnataka: { name: "Karnataka", code: "KA" },
  tn: { name: "Tamil Nadu", code: "TN" },
  "tamil nadu": { name: "Tamil Nadu", code: "TN" },
  wb: { name: "West Bengal", code: "WB" },
  "west bengal": { name: "West Bengal", code: "WB" },
  br: { name: "Bihar", code: "BR" },
  bihar: { name: "Bihar", code: "BR" },
  ap: { name: "Andhra Pradesh", code: "AP" },
  "andhra pradesh": { name: "Andhra Pradesh", code: "AP" },
  ts: { name: "Telangana", code: "TS" },
  tg: { name: "Telangana", code: "TS" },
  telangana: { name: "Telangana", code: "TS" },
  kl: { name: "Kerala", code: "KL" },
  kerala: { name: "Kerala", code: "KL" },
  od: { name: "Odisha", code: "OR" },
  or: { name: "Odisha", code: "OR" },
  odisha: { name: "Odisha", code: "OR" },
  as: { name: "Assam", code: "AS" },
  assam: { name: "Assam", code: "AS" },
  jh: { name: "Jharkhand", code: "JH" },
  jharkhand: { name: "Jharkhand", code: "JH" },
  cg: { name: "Chhattisgarh", code: "CT" },
  ct: { name: "Chhattisgarh", code: "CT" },
  chhattisgarh: { name: "Chhattisgarh", code: "CT" },
  ga: { name: "Goa", code: "GA" },
  goa: { name: "Goa", code: "GA" },
  jk: { name: "Jammu and Kashmir", code: "JK" },
  "jammu and kashmir": { name: "Jammu and Kashmir", code: "JK" },
  ch: { name: "Chandigarh", code: "CH" },
  chandigarh: { name: "Chandigarh", code: "CH" },
};

const US_STATES_MAP = {
  al: { name: "Alabama", code: "AL" },
  alabama: { name: "Alabama", code: "AL" },
  ak: { name: "Alaska", code: "AK" },
  alaska: { name: "Alaska", code: "AK" },
  az: { name: "Arizona", code: "AZ" },
  arizona: { name: "Arizona", code: "AZ" },
  ar: { name: "Arkansas", code: "AR" },
  arkansas: { name: "Arkansas", code: "AR" },
  ca: { name: "California", code: "CA" },
  california: { name: "California", code: "CA" },
  co: { name: "Colorado", code: "CO" },
  colorado: { name: "Colorado", code: "CO" },
  ct: { name: "Connecticut", code: "CT" },
  connecticut: { name: "Connecticut", code: "CT" },
  de: { name: "Delaware", code: "DE" },
  delaware: { name: "Delaware", code: "DE" },
  fl: { name: "Florida", code: "FL" },
  florida: { name: "Florida", code: "FL" },
  ga: { name: "Georgia", code: "GA" },
  georgia: { name: "Georgia", code: "GA" },
  hi: { name: "Hawaii", code: "HI" },
  hawaii: { name: "Hawaii", code: "HI" },
  id: { name: "Idaho", code: "ID" },
  idaho: { name: "Idaho", code: "ID" },
  il: { name: "Illinois", code: "IL" },
  illinois: { name: "Illinois", code: "IL" },
  in: { name: "Indiana", code: "IN" },
  indiana: { name: "Indiana", code: "IN" },
  ia: { name: "Iowa", code: "IA" },
  iowa: { name: "Iowa", code: "IA" },
  ks: { name: "Kansas", code: "KS" },
  kansas: { name: "Kansas", code: "KS" },
  ky: { name: "Kentucky", code: "KY" },
  kentucky: { name: "Kentucky", code: "KY" },
  la: { name: "Louisiana", code: "LA" },
  louisiana: { name: "Louisiana", code: "LA" },
  me: { name: "Maine", code: "ME" },
  maine: { name: "Maine", code: "ME" },
  md: { name: "Maryland", code: "MD" },
  maryland: { name: "Maryland", code: "MD" },
  ma: { name: "Massachusetts", code: "MA" },
  massachusetts: { name: "Massachusetts", code: "MA" },
  mi: { name: "Michigan", code: "MI" },
  michigan: { name: "Michigan", code: "MI" },
  mn: { name: "Minnesota", code: "MN" },
  minnesota: { name: "Minnesota", code: "MN" },
  ms: { name: "Mississippi", code: "MS" },
  mississippi: { name: "Mississippi", code: "MS" },
  mo: { name: "Missouri", code: "MO" },
  missouri: { name: "Missouri", code: "MO" },
  mt: { name: "Montana", code: "MT" },
  montana: { name: "Montana", code: "MT" },
  ne: { name: "Nebraska", code: "NE" },
  nebraska: { name: "Nebraska", code: "NE" },
  nv: { name: "Nevada", code: "NV" },
  nevada: { name: "Nevada", code: "NV" },
  nh: { name: "New Hampshire", code: "NH" },
  "new hampshire": { name: "New Hampshire", code: "NH" },
  nj: { name: "New Jersey", code: "NJ" },
  "new jersey": { name: "New Jersey", code: "NJ" },
  nm: { name: "New Mexico", code: "NM" },
  "new mexico": { name: "New Mexico", code: "NM" },
  ny: { name: "New York", code: "NY" },
  "new york": { name: "New York", code: "NY" },
  nc: { name: "North Carolina", code: "NC" },
  "north carolina": { name: "North Carolina", code: "NC" },
  nd: { name: "North Dakota", code: "ND" },
  "north dakota": { name: "North Dakota", code: "ND" },
  oh: { name: "Ohio", code: "OH" },
  ohio: { name: "Ohio", code: "OH" },
  ok: { name: "Oklahoma", code: "OK" },
  oklahoma: { name: "Oklahoma", code: "OK" },
  or: { name: "Oregon", code: "OR" },
  oregon: { name: "Oregon", code: "OR" },
  pa: { name: "Pennsylvania", code: "PA" },
  pennsylvania: { name: "Pennsylvania", code: "PA" },
  ri: { name: "Rhode Island", code: "RI" },
  "rhode island": { name: "Rhode Island", code: "RI" },
  sc: { name: "South Carolina", code: "SC" },
  "south carolina": { name: "South Carolina", code: "SC" },
  sd: { name: "South Dakota", code: "SD" },
  "south dakota": { name: "South Dakota", code: "SD" },
  tn: { name: "Tennessee", code: "TN" },
  tennessee: { name: "Tennessee", code: "TN" },
  tx: { name: "Texas", code: "TX" },
  texas: { name: "Texas", code: "TX" },
  ut: { name: "Utah", code: "UT" },
  utah: { name: "Utah", code: "UT" },
  vt: { name: "Vermont", code: "VT" },
  vermont: { name: "Vermont", code: "VT" },
  va: { name: "Virginia", code: "VA" },
  virginia: { name: "Virginia", code: "VA" },
  wa: { name: "Washington", code: "WA" },
  washington: { name: "Washington", code: "WA" },
  dc: { name: "District of Columbia", code: "DC" },
  "washington dc": { name: "District of Columbia", code: "DC" },
  wv: { name: "West Virginia", code: "WV" },
  "west virginia": { name: "West Virginia", code: "WV" },
  wi: { name: "Wisconsin", code: "WI" },
  wisconsin: { name: "Wisconsin", code: "WI" },
  wy: { name: "Wyoming", code: "WY" },
  wyoming: { name: "Wyoming", code: "WY" },
};

// Prefer the explicitly supplied country; never silently rewrite a delivery
// country from the shape of its postal code or fabricate missing address fields.
export function normalizeAddressForShopify(raw = {}) {
  const name = String(raw.name || [raw.firstName, raw.lastName].filter(Boolean).join(" ")).trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const requestedCountry = String(raw.countryCode || raw.country || "").trim();
  let countryCode = "";
  if (/^[a-z]{2}$/i.test(requestedCountry)) countryCode = requestedCountry.toUpperCase();
  else if (/^(india|bharat)$/i.test(requestedCountry)) countryCode = "IN";
  else if (/^(united states(?: of america)?|usa)$/i.test(requestedCountry)) countryCode = "US";
  else if (/^(united kingdom|uk|great britain)$/i.test(requestedCountry)) countryCode = "GB";
  else if (requestedCountry) {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90 && !countryCode; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        if (names.of(code)?.toLowerCase() === requestedCountry.toLowerCase()) { countryCode = code; break; }
      }
    }
  }
  const zip = String(raw.zip || "").trim();
  const province = String(raw.provinceCode || raw.province || "").trim();
  // Infer only when country is absent, never when it was explicitly supplied.
  if (!requestedCountry) {
    if (/^\d{6}$/.test(zip) || INDIAN_STATES_MAP[province.toLowerCase()]) countryCode = "IN";
    else if (/^\d{5}(?:-\d{4})?$/.test(zip)) countryCode = "US";
  }
  const state = (countryCode === "IN" ? INDIAN_STATES_MAP : countryCode === "US" ? US_STATES_MAP : {})[province.toLowerCase()];
  const digits = String(raw.phone || "").replace(/\D/g, "");
  let phone = String(raw.phone || "").trim();
  if (digits.length === 10 && ["IN", "US", "CA"].includes(countryCode)) phone = `${countryCode === "IN" ? "+91" : "+1"}${digits}`;
  else if (digits && phone.startsWith("+")) phone = `+${digits}`;
  return {
    name, firstName: raw.firstName || parts[0] || "", lastName: raw.lastName || parts.slice(1).join(" "),
    address1: String(raw.address1 || "").trim(), address2: String(raw.address2 || "").trim(),
    city: String(raw.city || "").trim(), province: state?.name || province,
    provinceCode: state?.code || (/^[A-Z0-9-]{1,3}$/i.test(province) ? province.toUpperCase() : undefined),
    zip, country: requestedCountry || countryCode, countryCode, phone,
  };
}
