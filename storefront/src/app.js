(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 24;
  var products = [], shown = PAGE, category = "all", query = "", sort = "featured", labels = {};
  var money;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function img(url, w) {
    if (!url) return "";
    return url + (url.indexOf("?") > -1 ? "&" : "?") + "width=" + (w || 500);
  }
  function humanize(slug) { return String(slug || "other").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function fmt(n) { return money.format(Number(n) || 0); }
  function minPrice(p) { var n = Number(p.price); return isFinite(n) ? n : Math.min.apply(null, p.variants.map(function (v) { return Number(v.price); })); }
  function firstSellable(p) { return p.variants.filter(function (v) { return v.inStock; })[0] || null; }
  function onlyDefault(p) { return p.variants.length === 1 && /^default title$/i.test(p.variants[0].title); }

  function toast(text) {
    var t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  /* ---------- grid ---------- */
  function filtered() {
    var q = query.trim().toLowerCase();
    var list = products.filter(function (p) {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (p.title + " " + p.vendor + " " + labels[p.category]).toLowerCase().indexOf(q) > -1;
    });
    if (sort === "low") list = list.slice().sort(function (a, b) { return minPrice(a) - minPrice(b); });
    if (sort === "high") list = list.slice().sort(function (a, b) { return minPrice(b) - minPrice(a); });
    return list;
  }

  function cardHtml(p) {
    var v = firstSellable(p);
    var compare = v && Number(v.compareAtPrice) > Number(v.price) ? "<s>" + fmt(v.compareAtPrice) + "</s>" : "";
    var from = p.variants.length > 1 ? "From " : "";
    return '<article class="card"><button class="card-img" type="button" data-open="' + esc(p.id) + '" aria-label="View ' + esc(p.title) + '">' +
      (p.image ? '<img src="' + esc(img(p.image)) + '" alt="' + esc(p.title) + '" loading="lazy" width="500" height="500">' : '<span class="noimg">No image</span>') +
      '</button><div class="card-body">' + (p.vendor ? '<span class="card-vendor">' + esc(p.vendor) + "</span>" : "") +
      '<button class="card-title" type="button" data-open="' + esc(p.id) + '">' + esc(p.title) + "</button>" +
      '<div class="price">' + from + fmt(minPrice(p)) + compare + "</div>" +
      '<div class="card-foot"><button class="add" type="button" data-add="' + esc(p.id) + '"' + (v ? "" : " disabled") + ">" +
      (v ? (p.variants.length > 1 ? "Choose options" : "Add to cart") : "Sold out") + "</button></div></div></article>";
  }

  function renderGrid() {
    var list = filtered();
    $("grid").innerHTML = list.slice(0, shown).map(cardHtml).join("");
    $("resultCount").textContent = list.length + (list.length === 1 ? " product" : " products");
    $("moreBtn").hidden = list.length <= shown;
    $("state").hidden = list.length > 0;
    if (!list.length) $("state").textContent = "No products match. Try another word, or ask Orbi.";
  }

  function renderChips() {
    var counts = {};
    products.forEach(function (p) { counts[p.category] = (counts[p.category] || 0) + 1; labels[p.category] = humanize(p.category); });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 12);
    var html = ['<button class="chip" role="tab" data-cat="all" aria-selected="' + (category === "all") + '">All</button>'];
    keys.forEach(function (k) { html.push('<button class="chip" role="tab" data-cat="' + esc(k) + '" aria-selected="' + (category === k) + '">' + esc(labels[k]) + "</button>"); });
    $("chips").innerHTML = html.join("");
  }

  /* ---------- product modal ---------- */
  var modalProduct = null, modalVariant = null, modalPrev = null;
  function openProduct(id) {
    modalProduct = products.filter(function (p) { return p.id === id; })[0];
    if (!modalProduct) return;
    modalVariant = firstSellable(modalProduct) || modalProduct.variants[0];
    modalPrev = document.activeElement;
    drawModal();
    $("modal").hidden = false;
    $("modalClose").focus();
  }
  function drawModal() {
    var p = modalProduct, v = modalVariant;
    var opts = onlyDefault(p) ? "" : '<div class="opts" role="group" aria-label="Options">' + p.variants.map(function (x) {
      return '<button class="opt" type="button" data-var="' + esc(x.id) + '" aria-pressed="' + (x.id === v.id) + '"' + (x.inStock ? "" : " disabled") + ">" + esc(x.title) + "</button>";
    }).join("") + "</div>";
    var pic = v.image || p.image;
    $("modalBody").innerHTML = '<div class="pm"><div class="pm-img">' + (pic ? '<img src="' + esc(img(pic, 800)) + '" alt="' + esc(p.title) + '">' : '<span class="noimg">No image</span>') + "</div><div>" +
      (p.vendor ? '<span class="card-vendor">' + esc(p.vendor) + "</span>" : "") + '<h3 id="modalTitle">' + esc(p.title) + "</h3>" +
      '<div class="price">' + fmt(v.price) + (Number(v.compareAtPrice) > Number(v.price) ? "<s>" + fmt(v.compareAtPrice) + "</s>" : "") + "</div>" +
      opts + (p.description ? "<p>" + esc(p.description) + "</p>" : "") +
      '<div class="pm-actions"><button class="btn solid" id="pmAdd" type="button"' + (v.inStock ? "" : " disabled") + ">" + (v.inStock ? "Add to cart" : "Sold out") + "</button>" +
      '<button class="btn ghost" id="pmAsk" type="button" style="color:var(--ink)">Ask Orbi about this</button></div></div></div>';
  }
  function closeModal() { $("modal").hidden = true; if (modalPrev && modalPrev.focus) modalPrev.focus(); }

  /* ---------- cart ---------- */
  function updateCount(cart) {
    var n = cart.item_count;
    $("cartCount").hidden = !n; $("cartCount").textContent = n;
  }
  function drawCart(cart) {
    updateCount(cart);
    if (!cart.items.length) {
      $("drawerBody").innerHTML = '<div class="empty">Your cart is empty.<br>Add something, or ask Orbi to pick for you.</div>';
      $("drawerFoot").innerHTML = '<button class="btn solid" type="button" id="emptyAsk">Ask Orbi</button>';
      return;
    }
    $("drawerBody").innerHTML = cart.items.map(function (i) {
      return '<div class="line">' + (i.image ? '<img src="' + esc(img(i.image, 160)) + '" alt="" loading="lazy">' : '<span class="noimg"></span>') +
        '<div><div class="line-title">' + esc(i.product_title) + "</div>" + (i.variant_title ? '<div class="line-var">' + esc(i.variant_title) + "</div>" : "") +
        '<div class="qty"><button type="button" data-dec="' + esc(i.key) + '" aria-label="Decrease">&minus;</button><span>' + i.quantity +
        '</span><button type="button" data-inc="' + esc(i.key) + '" aria-label="Increase">+</button></div></div>' +
        '<div><div class="line-price">' + fmt(i.line_price / 100) + '</div><button class="rm" type="button" data-rm="' + esc(i.key) + '">Remove</button></div></div>';
    }).join("");
    $("drawerFoot").innerHTML = '<div class="total"><span>Subtotal</span><span>' + fmt(cart.total_price / 100) + "</span></div>" +
      '<button class="btn solid" type="button" id="checkoutBtn">Checkout with Orbi</button>' +
      '<p class="note">Orbi collects your delivery details and places the order. Cash on delivery is available.</p>';
  }
  function openDrawer() { $("scrim").hidden = false; $("drawer").hidden = false; drawCart(TS.cart.get()); }
  function closeDrawer() { $("scrim").hidden = true; $("drawer").hidden = true; }

  /* ---------- Orbi ---------- */
  function orbi() { return document.querySelector(".ai-commerce-chat-root"); }
  function openOrbi() {
    var root = orbi(); if (!root) return null;
    var panel = root.querySelector(".ai-commerce-chat-panel");
    if (panel && panel.hidden) root.querySelector(".ai-commerce-chat-toggle").click();
    if (panel && panel.classList.contains("is-minimized")) panel.classList.remove("is-minimized");
    return root;
  }
  function sayToOrbi(text) {
    var root = openOrbi(); if (!root) return;
    var tries = 0;
    (function go() {
      var input = root.querySelector(".ai-commerce-chat-input"), form = root.querySelector(".ai-commerce-chat-form");
      var panel = root.querySelector(".ai-commerce-chat-panel");
      if (input && form && panel && !panel.hidden) {
        input.value = text;
        if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      } else if (tries++ < 20) setTimeout(go, 150);
    })();
  }

  /* ---------- events ---------- */
  function addVariant(variantId, title) {
    TS.cart.add(variantId, 1).then(function () { toast("Added " + title + " to cart"); }, function (e) { toast(e.message || "Could not add"); });
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-open],[data-add],[data-cat],[data-var],[data-inc],[data-dec],[data-rm]");
    if (t) {
      if (t.dataset.open) return openProduct(t.dataset.open);
      if (t.dataset.add) {
        var p = products.filter(function (x) { return x.id === t.dataset.add; })[0];
        if (!p) return;
        if (p.variants.length > 1) return openProduct(p.id);
        return addVariant(firstSellable(p).id, p.title);
      }
      if (t.dataset.cat) { category = t.dataset.cat; shown = PAGE; renderChips(); return renderGrid(); }
      if (t.dataset.var) { modalVariant = modalProduct.variants.filter(function (v) { return v.id === t.dataset.var; })[0] || modalVariant; return drawModal(); }
      var cart = TS.cart.get();
      var key = t.dataset.inc || t.dataset.dec || t.dataset.rm;
      var line = cart.items.filter(function (i) { return i.key === key; })[0];
      if (line) TS.cart.set(key, t.dataset.inc ? line.quantity + 1 : t.dataset.dec ? line.quantity - 1 : 0);
      return;
    }
    if (e.target.id === "pmAdd") { addVariant(modalVariant.id, modalProduct.title); return closeModal(); }
    if (e.target.id === "pmAsk") { var title = modalProduct.title; closeModal(); return sayToOrbi("Tell me about " + title); }
    if (e.target.id === "checkoutBtn") { closeDrawer(); return sayToOrbi("Proceed to checkout"); }
    if (e.target.id === "emptyAsk") { closeDrawer(); return openOrbi(); }
  });
  $("cartBtn").addEventListener("click", openDrawer);
  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  $("modalClose").addEventListener("click", closeModal);
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!$("modal").hidden) closeModal(); else if (!$("drawer").hidden) closeDrawer(); } });
  $("askOrbi").addEventListener("click", openOrbi);
  $("moreBtn").addEventListener("click", function () { shown += PAGE; renderGrid(); });
  $("sortSel").addEventListener("change", function (e) { sort = e.target.value; renderGrid(); });
  $("searchForm").addEventListener("submit", function (e) { e.preventDefault(); });
  $("searchInput").addEventListener("input", function (e) { query = e.target.value; shown = PAGE; renderGrid(); });
  window.addEventListener("ts:cart", function (e) { if ($("drawer").hidden) updateCount(e.detail); else drawCart(e.detail); });
  window.addEventListener("hashchange", function () { if (location.hash === "#cart") { history.replaceState(null, "", location.pathname); openDrawer(); } });
  $("year").textContent = new Date().getFullYear();

  TS.catalogPromise.then(function (data) {
    money = new Intl.NumberFormat("en-IN", { style: "currency", currency: data.currency || "INR", maximumFractionDigits: 0 });
    products = data.products;
    renderChips(); renderGrid(); updateCount(TS.cart.get());
  }, function () {
    $("state").textContent = "We could not load the products. Please refresh in a minute (the server may be waking up).";
  });
})();
