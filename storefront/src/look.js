/* Taxonomy (department + product type) and generated artwork for products that have no photo yet. */
(function () {
  "use strict";
  var SETS = {
    electronics: /^(power_banks?|smartphones?|laptops?|phone_covers?|mouse|chargers?|speakers?|bluetooth_earbuds|electronics|headphones?|earbuds?|tablets?|cameras?|smart_?watch(es)?)$/,
    carry: /^(laptop_bags?|bags?|school_bags?|belts?|wallets?|eyewear|watches|watch|accessories_?)$/,
    modest: /^(abayas?|hijabs?(_and_scarves)?|hijabs?_scarves|scarves|modest.*)$/,
    fragrance: /^(perfumes?|bakhoor.*|oud.*|air_fresheners?|fragrances?)$/,
    sports: /^(snowboards?)$/,
    home: /^(home_and_kitchen|home_decor|gift|gifts|giftcard|gift_card)$/,
    women: /^(kurti|saree|bra|maternity_clothing|women_s_clothing)$/,
    men: /^(kurta|men_s_clothing)$/
  };
  var TYPE_LABEL = {
    t_shirt: "T-Shirts", shirt: "Shirts", jeans: "Jeans", footwear: "Footwear", shoes: "Shoes", hoodie: "Hoodies", sweater: "Sweaters",
    cardigan: "Cardigans", jacket: "Jackets", kurti: "Kurtis", kurta: "Kurtas", saree: "Sarees", bra: "Innerwear", maternity_clothing: "Maternity",
    women_s_clothing: "Clothing", men_s_clothing: "Clothing", kids_clothing: "Clothing", power_banks: "Power Banks", smartphones: "Smartphones",
    laptops: "Laptops", laptop_bags: "Laptop Bags", phone_covers: "Phone Covers", mouse: "Mice", chargers: "Chargers", speakers: "Speakers",
    bluetooth_earbuds: "Earbuds", electronics: "More Electronics", school_bags: "School Bags", bags: "Bags", belts: "Belts", wallets: "Wallets",
    eyewear: "Eyewear", watches: "Watches", gift: "Gift Sets", giftcard: "Gift Cards", home_and_kitchen: "Home & Kitchen", snowboard: "Snowboards",
    accessories: "Accessories", hijabs_and_scarves: "Hijabs & Scarves", abayas: "Abayas", perfumes: "Perfumes", bakhoor_and_oud: "Bakhoor & Oud",
    air_fresheners: "Air Fresheners"
  };
  function human(slug) {
    return String(slug || "other").replace(/_s_/g, "s_").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function typeLabel(cat) { return TYPE_LABEL[cat] || human(cat); }

  function department(p) {
    var c = String(p.category || ""), t = String(p.title || "");
    if (SETS.fragrance.test(c)) return "Fragrance";
    if (SETS.modest.test(c)) return "Modest Wear";
    if (SETS.electronics.test(c)) return "Electronics";
    if (SETS.sports.test(c) || /ski wax|snowboard/i.test(t)) return "Sports";
    if (/^(girls?|boys?|kids?)\b/i.test(t) || c === "kids_clothing" || c === "school_bags") return "Kids";
    if (SETS.home.test(c)) return "Home & Gifts";
    if (SETS.carry.test(c)) return "Bags & Accessories";
    if (SETS.women.test(c) || /^women/i.test(t)) return "Women";
    if (SETS.men.test(c) || /^men/i.test(t)) return "Men";
    if (/^(footwear|shoes)$/.test(c)) return "Footwear";
    if (/^(jeans|shirt|t_shirt|hoodie|sweater|cardigan|jacket)$/.test(c)) return "Men";
    return "More";
  }
  var DEPT_ORDER = ["Electronics", "Men", "Women", "Kids", "Footwear", "Modest Wear", "Fragrance", "Bags & Accessories", "Home & Gifts", "Sports", "More"];

  /* ---------- artwork ---------- */
  var COLORS = {
    black: "#1f2937", white: "#f8fafc", grey: "#9ca3af", gray: "#9ca3af", charcoal: "#475569", navy: "#1e3a8a", "dark blue": "#1e40af", "mid blue": "#3b82f6",
    "light blue": "#93c5fd", "sky blue": "#7dd3fc", blue: "#3b82f6", indigo: "#4f46e5", teal: "#14b8a6", mint: "#86efac", green: "#22c55e", olive: "#6b7a2a",
    yellow: "#facc15", mustard: "#ca8a04", gold: "#d4a017", orange: "#fb923c", peach: "#fdba74", coral: "#fb7185", red: "#ef4444", maroon: "#7f1d1d",
    burgundy: "#7f1d1d", pink: "#f472b6", rose: "#fb7185", lilac: "#c4b5fd", purple: "#8b5cf6", violet: "#8b5cf6", cream: "#fdf3d6", beige: "#e7d5b5",
    tan: "#c8a27a", brown: "#7c4a21", silver: "#cbd5e1", plum: "#7e22ce", khaki: "#b9a77a"
  };
  var KEYS = Object.keys(COLORS).sort(function (a, b) { return b.length - a.length; });
  function colorOf(title) {
    var m = String(title).match(/ - ([^-]+)$/), seg = (m ? m[1] : title).toLowerCase();
    for (var i = 0; i < KEYS.length; i++) if (seg.indexOf(KEYS[i]) > -1) return COLORS[KEYS[i]];
    return "";
  }
  var ICONS = {
    tee: '<path d="M32 18 18 28 10 44l14 6 4-6v38h44V44l4 6 14-6-8-16-14-10c-4 8-32 8-36 0Z"/>',
    long: '<path d="M32 16 14 28 8 70l14 2 6-28v40h44V44l6 28 14-2-6-42-18-12c-4 8-32 8-36 0Z"/>',
    hood: '<path d="M32 18 14 30 8 72l14 2 6-28v40h44V46l6 28 14-2-6-42-18-12c-2 6-8 12-18 12s-16-6-18-12Z"/><path d="M40 22c0 10 20 10 20 0" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3"/>',
    jacket: '<path d="M32 16 14 28 8 70l14 2 6-28v40h44V44l6 28 14-2-6-42-18-12-18 14-18-14Z"/><path d="M50 30v54" stroke="rgba(0,0,0,.25)" stroke-width="3"/>',
    jeans: '<path d="M30 14h40l4 72H54L50 40l-4 46H26Z"/><path d="M30 24h40" stroke="rgba(0,0,0,.25)" stroke-width="3"/>',
    dress: '<path d="M38 14h24l-4 22 18 50H24l18-50Z"/>',
    shoe: '<path d="M10 62c0-12 12-16 22-16l14 10c6 4 18 2 26-4 14 0 18 10 18 18v6H10Z"/><path d="M10 76h82" stroke="rgba(0,0,0,.25)" stroke-width="4"/>',
    bag: '<path d="M26 36h48l6 50H20Z"/><path d="M38 36v-8c0-12 24-12 24 8" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="5" stroke-linecap="round"/>',
    watch: '<path d="M40 8h20l2 20H38ZM38 72h24l-2 20H40Z"/><circle cx="50" cy="50" r="22"/><path d="M50 38v12l8 6" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="4" stroke-linecap="round"/>',
    gift: '<path d="M16 40h68v46H16ZM12 28h76v12H12Z"/><path d="M46 28h8v58h-8Z" fill="rgba(0,0,0,.18)"/><path d="M50 28c-10-14-24-8-18 0M50 28c10-14 24-8 18 0" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="4"/>',
    phone: '<rect x="32" y="10" width="36" height="80" rx="8"/><circle cx="50" cy="80" r="3" fill="rgba(0,0,0,.3)"/>',
    laptop: '<rect x="20" y="24" width="60" height="42" rx="4"/><path d="M8 72h84l-6 8H14Z"/>',
    speaker: '<rect x="28" y="12" width="44" height="76" rx="10"/><circle cx="50" cy="38" r="9" fill="rgba(0,0,0,.25)"/><circle cx="50" cy="66" r="12" fill="rgba(0,0,0,.25)"/>',
    plug: '<rect x="30" y="32" width="40" height="44" rx="8"/><path d="M40 32V16M60 32V16M50 76v12" stroke="rgba(0,0,0,.35)" stroke-width="6" stroke-linecap="round"/>',
    glasses: '<circle cx="30" cy="54" r="16"/><circle cx="70" cy="54" r="16"/><path d="M46 54h8" stroke="rgba(0,0,0,.35)" stroke-width="5"/>',
    bottle: '<path d="M42 10h16v10l6 8v58H36V28l6-8Z"/>',
    bottleSpray: '<path d="M40 30h20v10h10v48H30V40h10Z"/><path d="M44 14h12v16H44Z"/>',
    board: '<rect x="38" y="6" width="24" height="88" rx="12"/><path d="M38 34h24M38 66h24" stroke="rgba(0,0,0,.3)" stroke-width="3"/>',
    tag: '<path d="M14 14h40l32 32-40 40-32-32Z"/><circle cx="32" cy="32" r="5" fill="rgba(0,0,0,.3)"/>'
  };
  function iconFor(p) {
    var c = String(p.category || ""), t = String(p.title || "").toLowerCase();
    if (/^t_shirt$/.test(c) || /t-?shirt|polo/.test(t)) return "tee";
    if (c === "hoodie" || /hoodie/.test(t)) return "hood";
    if (c === "jacket" || /jacket/.test(t)) return "jacket";
    if (/^(sweater|cardigan|shirt|kurta)$/.test(c) || /sweater|cardigan|shirt|kurta/.test(t)) return "long";
    if (c === "jeans" || /jeans|denim|trouser|pant/.test(t)) return "jeans";
    if (/kurti|saree|dress|skirt|abaya|nursing|pajama|top\b/.test(t) || /kurti|saree|bra|maternity/.test(c)) return "dress";
    if (/footwear|shoes|sandal|sneaker|loafer|flats|boots?/.test(c + " " + t)) return "shoe";
    if (/bag|backpack|handbag|wallet|belt/.test(c + " " + t)) return "bag";
    if (/watch/.test(c + " " + t)) return "watch";
    if (/gift|jewel/.test(c + " " + t)) return "gift";
    if (/phone|smartphone/.test(c)) return "phone";
    if (/laptop/.test(c) && !/bag/.test(c)) return "laptop";
    if (/speaker|earbud|headphone/.test(c + " " + t)) return "speaker";
    if (/charger|power_bank|mouse/.test(c)) return "plug";
    if (/sunglass|eyewear|glass/.test(c + " " + t)) return "glasses";
    if (/bottle|flask/.test(t)) return "bottle";
    if (/perfume|spray|freshener|bakhoor|oud/.test(c + " " + t)) return "bottleSpray";
    if (/snowboard/.test(c)) return "board";
    return "tag";
  }
  var cache = {};
  function art(p) {
    var key = p.id; if (cache[key]) return cache[key];
    var col = colorOf(p.title) || "#6366f1", icon = ICONS[iconFor(p)];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/><g transform="translate(15 15) scale(.7)" fill="' + col + '" stroke="rgba(15,23,42,.28)" stroke-width="1.6" stroke-linejoin="round">' + icon + "</g></svg>";
    return (cache[key] = "data:image/svg+xml;utf8," + encodeURIComponent(svg));
  }
  window.Look = { department: department, deptOrder: DEPT_ORDER, typeLabel: typeLabel, art: art };
})();
