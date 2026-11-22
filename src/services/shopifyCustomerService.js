import { getValidAccessToken } from "./shopifyTokenService.js";
import { shopifyApiVersion } from "../config/env.js";

const API_VERSION = shopifyApiVersion();

async function adminGraphql(shop, query, variables = {}) {
  const domain = String(shop || "").toLowerCase().trim();
  const accessToken = await getValidAccessToken(domain);

  const response = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(8000),
    }
  );

  if (!response.ok) {
    throw new Error(`Shopify Admin API ${response.status}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

const CUSTOMER_FIELDS = `
  id
  email
  phone
  firstName
  lastName
  displayName
  state
  defaultAddress {
    id
    address1
    address2
    city
    province
    zip
    country
    phone
    name
  }
`;

/**
 * Resolve storefront login from App Proxy logged_in_customer_id.
 * Returns { loggedIn, customer } — loggedIn is true only when Shopify confirms the customer.
 */
const protectedCustomerDataBlockedShops = new Map();

export async function resolveShopifyCustomer(shop, loggedInCustomerId) {
  const domain = String(shop || "").toLowerCase().trim();
  const raw = String(loggedInCustomerId || "").trim();
  if (!raw || !/^\d+$/.test(raw) || Date.now() - (protectedCustomerDataBlockedShops.get(domain) || 0) < 60000) {
    return { loggedIn: false, customer: null, source: "none" };
  }

  const gid = `gid://shopify/Customer/${raw}`;
  try {
  const data = await adminGraphql(
    shop,
    `query CustomerById($id: ID!) {
      customer(id: $id) {
        ${CUSTOMER_FIELDS}
      }
    }`,
    { id: gid }
  );

  const c = data?.customer;
  if (!c?.id) {
    return { loggedIn: false, customer: null, source: "shopify_missing" };
  }

  return {
    loggedIn: true,
    customer: mapCustomer(c),
    source: "shopify_session",
  };
  } catch (err) {
    if (/not approved to access the Customer object|protected-customer-data/i.test(String(err?.message || ""))) {
      protectedCustomerDataBlockedShops.set(domain, Date.now());
    }
    return { loggedIn: false, customer: null, source: "shopify_restricted" };
  }
}

/** Look up customer by email after OTP — confirms they exist in Shopify, not a browser session. */




function mapCustomer(c) {
  return {
    id: c.id,
    numericId: String(c.id || "").split("/").pop(),
    email: c.email || null,
    phone: c.phone || null,
    firstName: c.firstName || null,
    lastName: c.lastName || null,
    displayName: c.displayName || null,
    state: c.state || null,
    defaultAddress: c.defaultAddress
      ? {
          name: c.defaultAddress.name || null,
          phone: c.defaultAddress.phone || null,
          address1: c.defaultAddress.address1 || null,
          address2: c.defaultAddress.address2 || null,
          city: c.defaultAddress.city || null,
          province: c.defaultAddress.province || null,
          zip: c.defaultAddress.zip || null,
          country: c.defaultAddress.country || null,
        }
      : null,
  };
}
