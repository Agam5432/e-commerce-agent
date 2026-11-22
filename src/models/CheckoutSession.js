import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    name: String,
    firstName: String,
    lastName: String,
    email: String,
    phone: String,
    address1: String,
    address2: String,
    city: String,
    province: String,
    provinceCode: String,
    zip: String,
    country: String,
    countryCode: String,
  },
  { _id: false }
);

const checkoutSessionSchema = new mongoose.Schema(
  {
    shop: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    clientId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    loggedIn: { type: Boolean, default: false },
    loginMethod: {
      type: String,
      enum: ["email_otp", "phone_otp", "manual", "shopify_customer", "guest", null],
      default: null,
    },
    customer: {
      id: String,
      name: String,
      email: String,
      phone: String,
      method: String,
    },
    shipping: { type: addressSchema, default: null },
    // the address of this chat's last order: offered again for the next order in the same chat ("pehle wala address")
    lastOrderShipping: { type: addressSchema, default: null },
    shippingSource: { type: String, default: null },
    shippingNeedsUpdate: { type: Boolean, default: false },
    shippingConfirmed: { type: Boolean, default: false },
    billingConfirmed: { type: Boolean, default: false },
    billingNeedsUpdate: { type: Boolean, default: false },
    addressUpdatedAt: Date,
    profile: { type: mongoose.Schema.Types.Mixed, default: null },
    // Conversation continuity (server clock): when this shopper last wrote, and what was going on.
    lastActivityAt: { type: Date, default: null },
    conversationRecap: { type: mongoose.Schema.Types.Mixed, default: null },
    billing: { type: addressSchema, default: null },
    billingSameAsShipping: { type: Boolean, default: true },
    // Title of the selected Shopify shipping rate ("standard" = none selected yet).
    shippingMethod: { type: String, default: "standard", maxlength: 200 },
    // The store's own Shopify shipping rate for this cart + address, and the rates offered.
    shippingRate: { type: mongoose.Schema.Types.Mixed, default: null },
    shippingRates: { type: mongoose.Schema.Types.Mixed, default: null },
    shippingRatesKey: { type: String, default: "" },
    shippingCost: { type: Number, default: 0 },
    appliedDiscount: { type: mongoose.Schema.Types.Mixed, default: null },
    discountClearedAfterOrder: { type: Boolean, default: false },
    guestDetailsClearedAfterOrder: { type: Boolean, default: false },
    discountAmount: { type: Number, default: 0 },
    finalTotal: { type: Number, default: null },
    orderId: { type: String, default: null },
    shopifyOrderId: { type: String, default: null },
    checkoutAttemptId: { type: String, default: null },
    orderQuote: { type: mongoose.Schema.Types.Mixed, default: null },
    lastOrderCartKey: { type: String, default: null },
    lastOrderResult: { type: mongoose.Schema.Types.Mixed, default: null },
    paymentUrl: { type: String, default: null },
    paymentMethod: { type: String, default: null },
    selectedPaymentMethod: { type: String, enum: ["cod", "prepaid", null], default: null },
    step: {
      type: String,
      enum: [
        "cart",
        "login",
        "address",
        "billing_inquiry",
        "shipping_method",
        "review",
        "ready",
      ],
      default: "cart",
    },
    otp: {
      method: String,
      target: String,
      code: String,
      attempts: { type: Number, default: 0 },
      expiresAt: Date,
    },
    lastCartSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    chatHistory: {
      type: [
        {
          role: String,
          content: String,
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "checkout_sessions",
  }
);

checkoutSessionSchema.index({ shop: 1, clientId: 1 }, { unique: true });

const CheckoutSession = mongoose.models.CheckoutSession || mongoose.model("CheckoutSession", checkoutSessionSchema);
export default CheckoutSession;