import mongoose from "mongoose";

const storeProfileSchema = new mongoose.Schema(
  {
    shopifyShopId: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    contactEmail: { type: String, default: null },
    myshopifyDomain: { type: String, default: null },
    shopUrl: { type: String, default: null },
    primaryDomain: {
      host: { type: String, default: null },
      url: { type: String, default: null },
      sslEnabled: { type: Boolean, default: null },
    },
    currencyCode: { type: String, default: null },
    ianaTimezone: { type: String, default: null },
    timezoneAbbreviation: { type: String, default: null },
    weightUnit: { type: String, default: null },
    plan: {
      displayName: { type: String, default: null },
      partnerDevelopment: { type: Boolean, default: null },
      shopifyPlus: { type: Boolean, default: null },
    },
    billingAddress: {
      address1: { type: String, default: null },
      address2: { type: String, default: null },
      city: { type: String, default: null },
      province: { type: String, default: null },
      provinceCode: { type: String, default: null },
      country: { type: String, default: null },
      countryCode: { type: String, default: null },
      zip: { type: String, default: null },
      phone: { type: String, default: null },
    },
    syncedAt: { type: Date, default: null },
  },
  { _id: false }
);

const storeIntegrationSchema = new mongoose.Schema(
  {
    industry: {
      type: String,
      required: true,
      default: "ecommerce",
      enum: ["ecommerce"],
    },

    platform: {
      type: String,
      required: true,
      default: "shopify",
      enum: ["shopify"],
    },

    storeDomain: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    // Permitted Shopify store details synced on install / profile refresh
    shopId: {
      type: String,
      default: null,
    },

    shopName: {
      type: String,
      default: null,
    },

    shopEmail: {
      type: String,
      default: null,
    },

    contactEmail: {
      type: String,
      default: null,
    },

    primaryDomain: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    currencyCode: {
      type: String,
      default: null,
    },

    countryCode: {
      type: String,
      default: null,
    },

    timezone: {
      type: String,
      default: null,
    },

    planName: {
      type: String,
      default: null,
    },

    storeProfile: {
      type: storeProfileSchema,
      default: () => ({}),
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    // Store encrypted token values here, never plaintext tokens.
    accessTokenEncrypted: {
      type: String,
      select: false,
      default: null,
    },

    refreshTokenEncrypted: {
      type: String,
      select: false,
      default: null,
    },

    accessTokenExpiresAt: {
      type: Date,
      default: null,
    },

    refreshTokenExpiresAt: {
      type: Date,
      default: null,
    },

    // Shopify refused the stored tokens: the store owner must open the app again (or reinstall) before the assistant can
    // read the catalog or place orders. Set when a refresh is refused, cleared by the next successful install/exchange.
    reauthRequiredAt: {
      type: Date,
      default: null,
    },
    reauthReason: {
      type: String,
      default: null,
    },

    scopes: {
      type: [String],
      default: [],
    },

    status: {
      type: String,
      enum: ["pending", "active", "uninstalled", "error"],
      default: "pending",
      required: true,
    },

    // when the offline token was last written (install, token exchange or refresh)
    tokenExchangedAt: {
      type: Date,
      default: null,
    },

    installedAt: {
      type: Date,
      default: null,
    },

    uninstalledAt: {
      type: Date,
      default: null,
    },

    uninstallReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "store_integrations",
  }
);

// A Shopify store should have only one installation record.
storeIntegrationSchema.index(
  { platform: 1, storeDomain: 1 },
  { unique: true }
);

storeIntegrationSchema.index({ platform: 1, primaryDomain: 1, status: 1 });
storeIntegrationSchema.index({ platform: 1, status: 1 });

const StoreIntegration = mongoose.models.StoreIntegration || mongoose.model("StoreIntegration",
  storeIntegrationSchema
);

export default StoreIntegration;