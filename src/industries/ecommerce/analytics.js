// What the dashboard counts for this store type, and what the owner may configure.
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import { bookingEnabled, audioCallEnabled } from "../../services/bookingSettings.js";

// What the dashboard counts for this industry. The core records `conversation_started` and `turn`
// for every industry; these are the store-specific facts a turn can produce.
const analytics = {
  // the steps a shopper goes through, in order (the dashboard's funnel)
  funnel: ["conversation_started", "products_shown", "cart_add", "checkout_started", "order_placed"],
  // the event that carries revenue, and where its amount and currency are
  // Shopify reports each order in the store's own currency (shopTotal); the chat only knows the shopper's (total)
  revenue: { event: "order_placed", amount: ["props.shopTotal", "props.total"], currency: ["props.shopCurrency", "props.currency"], refunded: "props.refundedTotal", source: "props.source", payment: "props.paymentMethod" },
  // chats that got part-way and stopped: they did `reached` but never produced the revenue event
  dropoffs: [
    { key: "cartOnly", reached: "cart_add" },
    { key: "checkoutNoOrder", reached: "checkout_started" },
  ],
  // "top lists" for the dashboard: count by a field of an event (optionally inside a list)
  rankings: [
    { key: "productsShown", event: "products_shown", list: "props.items", field: "title" },
    { key: "productsAdded", event: "cart_add", field: "props.title" },
    { key: "searchedNotFound", event: "search_no_match", field: "props.term" },
  ],
  // how far a chat got, by the event that shows it (higher = further along)
  outcomes: { products_shown: 1, cart_add: 2, call_booked: 3, checkout_started: 3, payment_link_created: 3, order_placed: 4 },
  // Who the shopper turned out to be in this turn: the signed-in customer, or the name, email and phone
  // given for delivery. Kept on the chat for the owner's Customers screen, and removed by the erase tools.
  contactFromResult(result = {}) {
    const checkout = result.checkout || {};
    const placed = (Array.isArray(result.actions) ? result.actions : []).find((a) => a?.type === "order_placed" || a?.type === "checkout_ready");
    const ship = placed?.shipping || checkout.shipping || {};
    return {
      name: checkout.customer?.name || ship.name || [ship.firstName, ship.lastName].filter(Boolean).join(" "),
      email: checkout.customer?.email || placed?.recipientEmail || placed?.email || ship.email,
      phone: checkout.customer?.phone || ship.phone,
    };
  },
  // What the shopper saw with this reply, kept on the transcript so the owner sees the same thing.
  // Plain facts only (the dashboard words them); no personal details.
  shownFromResult(result = {}) {
    const products = (Array.isArray(result.products) ? result.products : []).slice(0, 8).map((p) => ({
      id: String(p.id ?? p.handle ?? ""), title: String(p.title ?? "").slice(0, 120), handle: String(p.handle ?? "").slice(0, 120),
      image: typeof p.image === "string" ? p.image : p.image?.url || "", price: p.price == null ? "" : String(p.price), compareAtPrice: p.compareAtPrice == null ? "" : String(p.compareAtPrice),
      currency: String(p.currency || ""), url: String(p.onlineStoreUrl || p.url || ""),
      inStock: p.inventoryQuantity == null ? undefined : p.inventoryQuantity > 0,
    }));
    const actions = [];
    for (const a of Array.isArray(result.actions) ? result.actions : []) {
      if (a?.type === "add_to_cart") actions.push({ type: "add_to_cart", title: String(a.title ?? "").slice(0, 120), quantity: Number(a.quantity) || 1 });
      else if (a?.type === "begin_checkout") actions.push({ type: "begin_checkout", total: Number(a.total) || 0, currency: String(a.currency || "") });
      else if (a?.type === "apply_discount") actions.push({ type: "apply_discount", code: String(a.discountCode || a.code || "").slice(0, 40) });
      else if (a?.type === "checkout_redirect" && a.paymentRequired) actions.push({ type: "payment_link" });
      else if (a?.type === "order_placed") actions.push({ type: "order_placed", orderId: String(a.orderId || ""), total: Number(a.total) || 0, currency: String(a.currency || ""), paymentMethod: String(a.paymentMethod || "") });
      else if (a?.type === "call_booked") actions.push({ type: "call_booked", bookingId: String(a.bookingId || ""), startAt: String(a.startAt || ""), timezone: String(a.timezone || ""), status: String(a.status || "") });
      else if (a?.type === "human_support") actions.push({ type: "human_support", reason: String(a.reason || "").slice(0, 240) });
      else if (a?.type === "flag_for_owner") actions.push({ type: "flag_for_owner", reason: String(a.reason || "").slice(0, 240) });
      // what the owner and the shopper may read in the transcript: that a complaint was raised and what became of its email, as it was
      else if (a?.type === "complaint_raised") actions.push({ type: "complaint_raised", reference: String(a.reference || "").slice(0, 16), channel: String(a.channel || ""), emailStatus: String(a.emailStatus || "") });
    }
    return { products, actions };
  },
  // Flags the owner acts on: a call was requested, or the AI asked for a person.
  flagsFromResult(result = {}) {
    const actions = Array.isArray(result.actions) ? result.actions : [];
    const flag = actions.find((a) => a?.type === "flag_for_owner" || a?.type === "human_support");
    return {
      ...(actions.some((a) => a?.type === "call_booked") ? { callRequested: true, needsFollowUp: true } : {}),
      ...(flag ? { needsFollowUp: true, reason: String(flag.reason || "") } : {}),
      // a complaint needs the team too; its own email (or the Complaints screen) tells them, so no second "needs you" email is sent
      ...(actions.some((a) => a?.type === "complaint_raised") ? { needsFollowUp: true } : {}),
    };
  },
  // Booking ids made this turn, so they can be tied to the chat once it is stored.
  bookingIdsFromResult(result = {}) {
    return (Array.isArray(result.actions) ? result.actions : []).filter((a) => a?.type === "call_booked" && a.bookingId).map((a) => String(a.bookingId));
  },
  eventsFromResult(result = {}) {
    const events = [];
    const products = Array.isArray(result.products) ? result.products : [];
    if (products.length) {
      events.push({ type: "products_shown", props: { count: products.length, items: products.slice(0, 5).map((p) => ({ id: String(p.id ?? p.handle ?? ""), title: String(p.title ?? "").slice(0, 80) })) } });
    }
    for (const m of Array.isArray(result.missed) ? result.missed : []) {
      if (m?.term) events.push({ type: "search_no_match", props: { term: String(m.term).slice(0, 80), soldOut: Boolean(m.soldOut) } });
    }
    for (const action of Array.isArray(result.actions) ? result.actions : []) {
      if (action?.type === "add_to_cart") events.push({ type: "cart_add", props: { title: String(action.title ?? "").slice(0, 80), quantity: Number(action.quantity) || 1 } });
      else if (action?.type === "begin_checkout") events.push({ type: "checkout_started", props: { total: Number(action.total) || 0, currency: String(action.currency || "") } });
      else if (action?.type === "call_booked") events.push({ type: "call_booked", props: { status: String(action.status || ""), startAt: String(action.startAt || "") } });
      else if (action?.type === "human_support") events.push({ type: "human_requested", props: { reason: String(action.reason || "").slice(0, 200), available: Boolean(action.available) } });
      else if (action?.type === "flag_for_owner") events.push({ type: "flagged_for_owner", props: { reason: String(action.reason || "").slice(0, 200) } });
      else if (action?.type === "complaint_raised") events.push({ type: "complaint_raised", props: { reference: String(action.reference || ""), channel: String(action.channel || ""), emailStatus: String(action.emailStatus || "") } });
      else if (action?.type === "checkout_redirect" && action.paymentRequired) events.push({ type: "payment_link_created", props: {} });
      else if (action?.type === "order_placed") {
        events.push({
          type: "order_placed",
          dedupeKey: action.orderId ? `order:${action.orderId}` : undefined,
          props: {
            orderName: String(action.orderId || ""),
            total: Number(action.total) || 0,
            currency: String(action.currency || ""),
            paymentMethod: String(action.paymentMethod || ""),
            items: Array.isArray(action.cart?.items) ? action.cart.items.length : 0,
            discountAmount: Number(action.discountAmount) || 0,
            source: "agent",
          },
        });
      }
    }
    return events;
  },
};

// What the store owner may configure for this industry (this store type has no extra settings yet).
const admin = {
  // tools the owner may switch off (the rest are needed for the agent to work safely)
  // tools that exist only when the owner has switched the feature on (kept out of the AI's tool list otherwise)
  inactiveTools: (settings) => (bookingEnabled(settings) ? [] : ["get_call_slots", "book_call"]),
  // the tool for asking a person to join an audio call exists only when the owner has switched live help on
  liveSupportTools: (settings) => (audioCallEnabled(settings) ? [] : ["request_human_support"]),
  configurableTools: ["raise_complaint", "track_issue", "place_order", "apply_discount_or_offer", "get_discounts_and_offers", "cancel_order", "request_order_cancellation", "confirm_order_cancellation", "get_order_details", "list_my_orders"],
};

export { analytics, admin };
