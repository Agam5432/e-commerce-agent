// Why an order could not be placed, as a machine-readable reason. The AI explains it to the
// customer in its own words; checkoutFailureMessage() is only the wording used when no AI
// provider is reachable (degraded mode).
export function checkoutFailureReason(error) {
  const message = String(error?.message || "");
  if (error?.uncertain) return "order_status_unknown";
  if (/price has changed|currency differs|different currency|conflicting prices|cart prices|prices are missing/i.test(message)) return "cart_prices_changed";
  if (/quantity must be|cart must contain|real shopify variant/i.test(message)) return "cart_needs_changes";
  if (/insufficient stock|no longer published/i.test(message)) return "item_unavailable";
  if (/valid customer email|complete name, street|choose cod|personal checkout session/i.test(message)) return "checkout_details_missing";
  return "store_could_not_confirm";
}

const FAILURE_FACTS = {
  order_status_unknown: "The store has not confirmed whether the order went through. The cart is safe. The order status must be checked before ordering again, so no duplicate order is created.",
  cart_prices_changed: "The cart prices changed or are missing. The cart must be refreshed before ordering so the total is correct.",
  cart_needs_changes: "The cart cannot be ordered as it is: it is empty, a product line is over the allowed quantity (1 to 50 per product) or a line is not a real store product. The cart must be adjusted first.",
  item_unavailable: "One of the selected items is no longer available. The cart must be updated before the order is confirmed.",
  checkout_details_missing: "Some checkout details are incomplete (delivery address, email or payment choice).",
  store_could_not_confirm: "The store could not confirm the order right now. The cart is safe and no confirmation email was sent. It can be tried again shortly.",
};

/** Plain facts about the failure for the AI to explain (not customer wording). */
export function checkoutFailureFacts(reason) {
  return FAILURE_FACTS[reason] || FAILURE_FACTS.store_could_not_confirm;
}

export function checkoutFailureMessage(error, language = "en") {
  const hindi = ["hi", "hinglish"].includes(language);
  const reason = checkoutFailureReason(error);
  if (reason === "order_status_unknown") return hindi
    ? "Store se order ka final status abhi nahi mila. Tumhara cart safe hai. Dobara order dene se pehle order status check kar lete hain, taaki duplicate na bane."
    : "I'm still waiting for the store to confirm your order status. Your cart is safe. Please check the order status before ordering again so we avoid a duplicate.";
  if (reason === "cart_prices_changed") return hindi
    ? "Order se pehle cart ke latest prices chahiye. Cart refresh kar do, phir sahi total par aage badhte hain."
    : "Let's refresh your cart prices before ordering so you get the correct total. Please refresh the cart, then we can continue.";
  if (reason === "cart_needs_changes") return hindi
    ? "Cart abhi order ke liye theek nahi hai (khaali hai ya kisi product ki quantity limit se zyada hai). Cart sahi kar lete hain, phir aage badhte hain."
    : "Your cart can't be ordered as it is (it may be empty, or a quantity is over the limit). Let's adjust the cart and then continue.";
  if (reason === "item_unavailable") return hindi
    ? "Ek selected item ab available nahi hai. Cart update kar lete hain, phir order confirm karenge."
    : "One of your selected items is no longer available. Let's update the cart before confirming your order.";
  if (reason === "checkout_details_missing") return hindi
    ? "Checkout ki kuch details abhi complete karni hain. Delivery address, email aur payment choice check kar lete hain."
    : "We still need a few checkout details. Let's check your delivery address, email and payment choice.";
  return hindi
    ? "Store abhi order confirm nahi kar saka. Tumhara cart safe hai aur confirmation email abhi nahi bheji gayi. Thodi der mein dobara try karte hain."
    : "The store couldn't confirm your order just yet. Your cart is safe, and no confirmation email was sent. Please try again in a moment.";
}