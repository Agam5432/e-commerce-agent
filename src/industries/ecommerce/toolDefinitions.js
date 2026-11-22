// The tools the AI can call, with their parameters (what each one is for is in its description).
// Part of the e-commerce industry module (see ../ecommerce.js); moved here unchanged.
import { ORDER_FIELD_GROUPS } from "../../services/shopifyOrderLookupService.js";

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "request_billing_update",
      description:
        "Mark billing details as needing an update when the shopper requests a different billing address. Ask for the new billing address; do not submit an order until it is complete.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shipping_options",
      description:
        "Read the store's own Shopify shipping rates for the saved delivery address (needs the address). Use for delivery cost questions. Delivery dates are unknown unless verified separately.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_categories",
      description:
        "Read actual store catalog categories without displaying unsolicited products.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_checkout_details",
      description:
        "Read the actual current checkout shipping/billing address and state. Use for address questions; never substitute the customer account default.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Category-first product search whenever the customer wants to see, find, buy or asks if the store has a product or category, OR describes a need, use or situation a product could solve (\"something to carry my laptop\", \"I am thirsty\"): search for the item they would buy. Do NOT call on 'what do you do', 'okay', 'what categories do you have', or non-store items like bidi/hookah/durex!",
      parameters: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description:
              "One product name or category from this store (e.g. whatever the customer asked for). Empty string if using searchTerms.",
          },
          searchTerms: {
            type: "array",
            items: { type: "string" },
            description:
              "2 to 5 product names/categories when searching multiple categories at once. Empty array for single search.",
          },
          sortBy: {
            type: "string",
            enum: ["price_low", "price_high"],
            description:
              "Set when the customer asks for the cheapest / lowest priced (price_low) or the most expensive / highest priced (price_high). The store's whole catalog is then ordered by price in the customer's currency. Leave empty otherwise.",
          },
          gender: {
            type: "string",
            description:
              "Target gender ('men', 'women', or 'kids'). When the customer is shopping for themselves ('apne liye'/'mere liye'), use your own intelligence to judge 'men' or 'women' from the Customer Name, Voice Cue, or conversation context. Leave empty if unknown.",
          },
          color: {
            type: "string",
            description:
              "Requested colour, e.g. red. Preserve the customer's explicit colour.",
          },
          size: {
            type: "string",
            description: "Requested size, e.g. M or 32.",
          },
          maxPrice: {
            type: "number",
            description: "Maximum price in store currency. Use it ONLY when the customer states a budget in numbers. For words like cheap, sasta, affordable or budget with no number, do not guess a number: use sortBy price_low instead.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_details",
      description:
        "Full detail for ONE product when the customer asks to brief/describe/tell more about it. Do NOT call this when the customer says 'add this product' — call add_to_cart instead!",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description:
              "Exact product title from conversation history or user query.",
          },
        },
        required: ["productName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description:
        "Compare 2 or 3 products side by side (price, stock, features, options).",
      parameters: {
        type: "object",
        properties: {
          productNames: {
            type: "array",
            items: { type: "string" },
            description: "2 or 3 product names to compare.",
          },
        },
        required: ["productNames"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_variant_availability",
      description:
        "Check whether a product (and optional size/colour) is in stock.",
      parameters: {
        type: "object",
        properties: {
          productName: { type: "string", description: "Product name." },
          variantName: {
            type: "string",
            description:
              "Size and/or colour if specified. Empty string if not.",
          },
          quantity: { type: "integer", description: "How many units the customer asked about (\"do you have 100?\"); 0 when they did not name a number." },
        },
        required: ["productName", "variantName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recommendations",
      description:
        "Curated product recommendations ONLY when the customer asks for suggestions, gift ideas, alternatives, or browse help. NEVER call this on 'what do you do', 'what can you do', 'okay', or pure category questions!",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Product category keyword(s) strictly matching what the customer asked for (exactly what the customer named; only pass several if they did NOT name a specific product type).",
          },
          excludeKeywords: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional keywords to exclude if the customer rejected a category (the words they rejected).",
          },
          gender: {
            type: "string",
            description:
              "Target gender ('men', 'women', or 'kids'). When the customer is shopping for themselves ('apne liye'/'mere liye'), use your own intelligence to judge 'men' or 'women' from the Customer Name, Voice Cue, or conversation context. Leave empty if unknown.",
          },
          maxPrice: {
            type: "number",
            description:
              "Maximum price in the store currency. Use 0 if no budget was given.",
          },
          count: {
            type: "integer",
            description: "How many products to return (1 to 8). Default 6.",
          },
        },
        required: ["keywords"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_store_info",
      description:
        "The store itself: name, website, contact email, currency, countries it ships to, wallets accepted, and pickup locations with address and phone. Use for any question about who the store is, where it is, how to contact it or where it delivers. Say plainly when something is not listed; never invent contact details, hours or addresses.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reply_language",
      description:
        "Call ONLY when the customer explicitly asks you to talk in a particular language from now on (e.g. 'Hindi me baat karo', 'please speak English'), or asks you to go back to following their language ('auto'). Never call it just because the customer wrote in some language.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["english", "hindi", "hinglish", "auto"],
            description: "hindi = Hindi in Devanagari script, hinglish = Hindi in Roman letters, auto = mirror the customer's language again.",
          },
        },
        required: ["language"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description:
        "Add a product to the cart when the customer says add / put in cart / this one, or replies with a size/colour/variant. IMPORTANT: Pass variantName as '' (empty string) unless the customer explicitly said a size/colour in their message!",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description:
              "Full product title from history or the user's message.",
          },
          variantName: {
            type: "string",
            description:
              "ONLY pass a size/colour if the customer explicitly said it in their message (e.g. 'M', 'L', '32', 'Silver'). Otherwise MUST be '' (empty string) so we ask the customer for their size!",
          },
          quantity: {
            type: "integer",
            description:
              "How many to add. Use 1 unless the customer said a number. When they said a number, pass EXACTLY that number, even a very large one (\"99999\"): never swap it for 1 or a smaller number yourself. The store checks real stock and tells you how many could be added.",
          },
        },
        required: ["productName", "variantName", "quantity"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_website_product_count",
      description: "Count active products on this store.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cart",
      description:
        "Read the customer's current cart (items, quantities, totals). Always call this before answering cart questions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cart_item",
      description:
        "Change the quantity of a line already in the cart, or remove it (quantity 0). For \"add one more\" / \"another one\" / \"one extra\" of something already in the cart, pass addQuantity (how many MORE) instead of quantity: never call add_to_cart or search for it again.",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description:
              "Product name as the customer said it or as it appears in the cart",
          },
          variantName: {
            type: "string",
            description:
              "Colour/size if needed to pick the right line. Empty string if only one match.",
          },
          quantity: {
            type: "integer",
            description: "Final quantity they want (0 removes the line). Leave out when using addQuantity.",
          },
          addQuantity: {
            type: "integer",
            description: "How many MORE of this line to add on top of what the cart already has (\"add one more\" = 1). Use instead of quantity.",
          },
        },
        required: ["productName", "variantName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_cart",
      description: "Remove ALL items from the cart in one step.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "begin_checkout",
      description:
        "Start checkout and review all order details. Never asks for sign in or OTP. Automatically checks if customer is logged in in Shopify.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_shipping_address",
      description:
        "Save only address/contact fields supplied by the user. Omit missing fields. Never guess phone digits, postal codes or repeat old values on a partial correction.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name" },
          phone: { type: "string", description: "Phone number" },
          email: {
            type: "string",
            description:
              "Email address (required for guest, optional if customer is already logged in)",
          },
          address1: { type: "string", description: "Street address line 1" },
          address2: {
            type: "string",
            description: "Apartment, suite, or landmark (empty string if none)",
          },
          city: { type: "string", description: "City" },
          province: { type: "string", description: "State or province" },
          zip: { type: "string", description: "Postal / PIN code" },
          country: {
            type: "string",
            description: "Country name or code (e.g. India, US)",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_billing_same_as_shipping",
      description:
        "Call this when the customer confirms that their Billing Address is the same as their Shipping Address (e.g. 'same', 'yes same', 'billing is same', 'dono same hai', 'both same').",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_billing_address",
      description:
        "Save a different Billing Address when the customer specifies a billing address that differs from their shipping address.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Billing recipient full name" },
          phone: { type: "string", description: "Billing phone number" },
          address1: {
            type: "string",
            description: "Billing street address line 1",
          },
          address2: {
            type: "string",
            description:
              "Billing apartment, suite, or landmark (empty string if none)",
          },
          city: { type: "string", description: "Billing city" },
          province: {
            type: "string",
            description: "Billing state or province",
          },
          zip: { type: "string", description: "Billing postal / PIN code" },
          country: {
            type: "string",
            description: "Billing country name or code (e.g. India)",
          },
        },
        required: [
          "name",
          "address1",
          "address2",
          "city",
          "province",
          "zip",
          "country",
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_prepaid_discount",
      description:
        "Check in real time whether a Prepaid (online payment) discount is active and what the shopper would actually pay with Prepaid vs Cash on Delivery (Shopify totals including tax). Also use it, with apply=true, when the shopper asks to APPLY that discount or says they want to pay online to get it: it selects Prepaid, applies the discount and refreshes the order review.",
      parameters: {
        type: "object",
        properties: {
          apply: {
            type: "boolean",
            description: "true when the shopper wants the prepaid discount applied / chooses Prepaid for it; false when they are only asking whether a discount exists.",
          },
        },
        required: ["apply"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_checkout_ready",
      description:
        "Show the ONE order preview card before payment: items, delivery/billing address, contact info, discount, shipping, Shopify-calculated tax and the final payable total. The card already shows every detail, so do not list them again in text. Call it once when checkout details are complete; do not call it again unless the customer asks to see the order again or changes something.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tax_details",
      description:
        "Row-by-row price breakdown of the current checkout exactly as Shopify calculated it for the delivery address (items, discount, shipping, each tax line, other charges, payable total) with the arithmetic already done. Use for ANY question about tax, GST, VAT, duties, discounts, shipping cost, 'what is this amount', 'why is the total higher', 'the total should be X', or 'where does this number come from'. Never answer such questions from memory or from your own arithmetic.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_shipping_method",
      description:
        "Switch to another of the store's own Shopify shipping rates for this address (get_shipping_options lists them). The cheapest rate is already selected by default. Never promise delivery dates.",
      parameters: {
        type: "object",
        properties: {
          shippingRate: {
            type: "string",
            description:
              "The title of the rate exactly as get_shipping_options returned it.",
          },
        },
        required: ["shippingRate"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description:
        "Confirm and place the order in Shopify Admin once the customer has reviewed the order and chosen Cash on Delivery (COD) or Prepaid (Online payment).",
      parameters: {
        type: "object",
        properties: {
          paymentMethod: {
            type: "string",
            enum: ["cod", "prepaid"],
            description:
              "Chosen payment method: 'cod' for Cash on Delivery, or 'prepaid' for Online payment (UPI/Card/Test Payment Gateway).",
          },
          customerConfirmed: {
            type: "boolean",
            description:
              "true ONLY when the customer's latest message clearly says to go ahead now (in any language or wording): they tell you to place/confirm the order, or they pick a payment method right after seeing the order review. false when they only ask something, hesitate, or want a change. When false the tool returns the total and asks them to confirm.",
          },
          shippingMethod: {
            type: "string",
            description:
              "Optional: title of one of the store's shipping rates (from get_shipping_options) if the customer asked to switch. Empty string otherwise.",
          },
          customerNotes: {
            type: "string",
            description:
              "Optional customer instructions or notes (empty string if none).",
          },
        },
        required: ["paymentMethod", "customerConfirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_discounts_and_offers",
      description:
        "Check official active discounts configured by the store owner in Shopify Admin and product-specific compare-at sale savings.",
      parameters: {
        type: "object",
        properties: {
          productName: {
            type: "string",
            description:
              "Optional product name to check specific sale discount or compare-at price savings.",
          },
          variantName: {
            type: "string",
            description:
              "Optional option the customer asked about (for example \"256GB\" or \"Blue / 128GB\"). Each option has its own price and sale: quote only that option's figures, and never combine one option's original price with another option's price.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_discount_or_offer",
      description:
        "Apply an official active discount or promo coupon code configured by the store owner in Shopify Admin to the customer's cart.",
      parameters: {
        type: "object",
        properties: {
          discountCode: {
            type: "string",
            description: "Coupon or discount code to apply.",
          },
          offerTitle: {
            type: "string",
            description:
              "Optional human-readable title of the offer being applied.",
          },
        },
        required: ["discountCode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_call_slots",
      description:
        "List the times the store team is free for a phone call (real times from the owner's calendar rules). Call it before offering any time. Pass date (YYYY-MM-DD) only when the customer asked for a particular day.",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "Optional day the customer asked for, as YYYY-MM-DD in the store's time zone." } },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_call",
      description:
        "Book a phone call with the store team at one of the times from get_call_slots. Only call it after the customer agreed to that exact time and you have their name, phone number and email. Never invent or change a slot.",
      parameters: {
        type: "object",
        properties: {
          slotStart: { type: "string", description: "The `start` value of the chosen slot, exactly as get_call_slots returned it." },
          name: { type: "string", description: "The customer's name." },
          phone: { type: "string", description: "The customer's phone number." },
          email: { type: "string", description: "The customer's email (the confirmation is sent here)." },
          topic: { type: "string", description: "What the call is about, in a few words." },
          customerConfirmed: { type: "boolean", description: "true only when the customer clearly agreed to this time." },
        },
        required: ["slotStart", "name", "phone", "email", "customerConfirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human_support",
      description:
        "The customer clearly wants to talk to a person (customer care, a human, a call right now). Call it once; the backend checks who is free and the chat window takes it from there. Only available when the store offers live help. Never use it for a scheduled call (get_call_slots) or when the customer only has a problem you can solve.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why they want a person, in one short sentence (their words)." } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "track_issue",
      description:
        "Customer care: write down the customer's problem (a complaint, a damaged or wrong product, late delivery, an order, payment, return, refund or warranty issue) and what you suggest. Call it when they describe the problem and again each time you suggest a step or they answer, so nothing has to be asked twice. Facts only, from the conversation or from a tool: never invent an order number, product or detail.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "The problem in one or two short factual sentences." },
          originalMessage: { type: "string", description: "The customer's own first words about it, as they wrote them. Leave empty if already recorded." },
          orderNumber: { type: "string", description: "The order number, only if the customer or a tool gave it." },
          productName: { type: "string", description: "The product concerned, only if known." },
          attempted: { type: "array", items: { type: "string" }, description: "Steps you suggested or checks you made THIS turn (for example: asked for the order number, asked for a photo, checked the order status, offered a replacement). Short, factual. Include every question you asked for a detail, so it is never asked again." },
          customerResponse: { type: "string", description: "What the customer said about your suggestion (for example: does not want a replacement, still not fixed)." },
          askingFor: { type: "array", items: { type: "string", enum: ["orderNumber", "email", "photo", "other"] }, description: "The detail(s) your reply is about to ASK the customer for. The store remembers it: a detail already asked for is not to be asked again, and this call then tells you so." },
          customerName: { type: "string", description: "Their name, only if they gave it." },
          customerEmail: { type: "string", description: "Their email address, only if they gave it." },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "raise_complaint",
      description:
        "Raise the customer's complaint for the store's support team. Use it when the customer repeats the problem, says it is still not solved or that they already told you, asks to raise a complaint, or is unhappy with your help. channel \"email\": the complaint is emailed to the store with a copy to the customer (only after the customer agreed to an email: customerAgreed true). channel \"human\": the customer does NOT want an email or wants a person: no email is sent and the person gets the whole complaint. Never ask the customer to explain again; pass what is already known. Say only what the result says happened.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["email", "human"], description: "Only when the customer has CHOSEN. email: send by email (needs customerAgreed). human: no email, connect them to a person. If the customer only said \"raise a complaint\" and has not yet been asked, LEAVE THIS OUT: the result then gives you the one question to ask." },
          customerAgreed: { type: "boolean", description: "true ONLY when the customer clearly said yes to the complaint being sent by email (with a copy to them)." },
          summary: { type: "string", description: "The problem in one or two factual sentences, from what the customer already said." },
          originalMessage: { type: "string", description: "The customer's own first words about it. Leave empty if already recorded." },
          orderNumber: { type: "string", description: "Order number, only if given." },
          productName: { type: "string", description: "Product, only if known." },
          attempted: { type: "array", items: { type: "string" }, description: "What was already suggested or checked." },
          customerResponse: { type: "string", description: "What the customer said about it." },
          reason: { type: "string", description: "Why it is being escalated (for example: the problem is still not solved after the suggestions; the customer asked for a person)." },
          customerName: { type: "string" },
          customerEmail: { type: "string", description: "The address a copy goes to: the one the customer gave or that is on their signed-in account." },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_for_owner",
      description:
        "Mark this chat for the store owner's attention when it needs a person (a complaint, refund dispute, something you cannot fix or are not allowed to do). Give a short reason. Does not book a call.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the owner should look at this chat, in one short sentence." } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_warranty_and_policy",
      description:
        "Read the store's own published policies from Shopify (returns/refunds, shipping, privacy, terms) plus an optional product's description. Use for warranty, return, replacement, delivery-time, privacy or terms questions. Pass topic to get only the relevant policy. Never assume anything that is not written there.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["returns", "shipping", "privacy", "terms", "subscription", "contact"],
            description: "Which policy the customer asked about. Omit if unclear.",
          },
          productName: {
            type: "string",
            description:
              "Optional product name to check specific warranty/guarantee details.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_order_otp",
      description:
        "Email a 6-digit verification code so a GUEST (not logged in) can safely view the status or details of an existing order. Use ONLY when the customer wants to see an existing order (status, tracking, details) and is not logged in, or wants an order that was placed with a different email. First ask for the email used on the order, then call this with that email. To RESEND a fresh code to the email already being verified, call it again WITHOUT the email argument. Never reveal, guess or repeat the code.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description:
              "The email address the customer gave (the one used on the order). Omit it to resend a new code to the email already in verification.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_order_otp",
      description:
        "Check the 6-digit code the customer typed or said after send_order_otp. Pass exactly what they gave. The code must be exactly 6 digits; a wrong code cancels it and a new one must be sent.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The verification code exactly as the customer gave it (digits).",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_details",
      description:
        "Fetch a REAL order from Shopify by its order number (like #1001). Works only for a logged-in customer or after email-OTP verification, and only for orders that belong to that identity. Always ask for the order number first. Choose `fields` to match ONLY what the customer asked for: 'status' for order status / kahan hai mera order, 'tracking' for courier / tracking / delivery date, 'items', 'payment', 'total', 'shipping_address', 'billing_address', 'shipping_method', 'order_date', 'contact', 'discount'; use 'all' only when they ask for the full order details. Never request more than was asked.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: {
            type: "string",
            description:
              "The order number the customer gave, e.g. 1001 or #1001. Omit it when the customer is still talking about the order already being discussed in this chat.",
          },
          fields: {
            type: "array",
            items: { type: "string", enum: [...ORDER_FIELD_GROUPS, "all"] },
            description:
              "Only the detail groups the customer asked for. Use ['all'] only for a full order-details request. Defaults to ['status'].",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_orders",
      description:
        "The verified customer's OWN orders from Shopify: how many they placed today, in the last 7 and 30 days, and a short list of the latest ones (number, date, status, total, items). Use it when they ask how many orders they placed, or for their past/recent orders without a specific order number. Works only for a logged-in customer or after email-OTP verification.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "show_preview",
      description:
        "Show the customer a visual PREVIEW CARD in the chat. Call this whenever the customer wants to SEE / review / preview / check a summary of something, in any wording or language (e.g. 'show my order', 'order preview', 'review before placing', 'mera cart dikhao', 'pura detail dikhao', 'order ki summary'), or when a full visual summary clearly helps. kind='order' = an order that was ALREADY placed (needs verification or login; pass orderNumber if given). kind='checkout' = the order review BEFORE placing an order (the current cart, address, shipping and total). kind='cart' = the items currently in the cart. If you cannot tell which one they mean, do NOT guess: ask one short question instead of calling this tool. After the card is shown, do not repeat every detail in text.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["order", "checkout", "cart"], description: "What to preview." },
          orderNumber: { type: "string", description: "For kind='order': the order number (e.g. 1001 or #1001). Omit to use the order already being discussed." },
          fields: {
            type: "array",
            items: { type: "string", enum: [...ORDER_FIELD_GROUPS, "all"] },
            description: "For kind='order': which detail groups to show. Use ['all'] (default) for a full preview, or only the groups the customer asked about.",
          },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_order_cancellation",
      description:
        "STEP 1 of cancelling an order. Use when the customer wants to cancel an existing order. Checks (server side) that the customer is verified, the order is theirs and it has NOT been shipped yet, then returns the order details to show in the confirmation question. Does NOT cancel anything. Omit orderNumber to use the order already being discussed.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: { type: "string", description: "Order number like 1002 or #1002. Omit if already discussed in this chat." },
          reason: { type: "string", description: "ONLY if the customer already said why in this same message: their exact words. Otherwise omit." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order_cancellation",
      description:
        "STEP 2. Call ONLY after you asked 'are you sure you want to cancel order X?' with its details and the customer answered in a NEW message. confirmed=true when they said yes, false when they said no. Never call it in the same message as step 1. If they change their mind later (even after saying yes, before the cancel is done), call it with confirmed=false.",
      parameters: {
        type: "object",
        properties: {
          confirmed: { type: "boolean", description: "true if the customer clearly said yes, false if they said no." },
          reason: { type: "string", description: "ONLY if the customer's yes message also says why: their exact words. Otherwise omit." },
        },
        required: ["confirmed"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description:
        "STEP 3. Cancels the order in Shopify. Call ONLY after the customer confirmed (step 2) AND then gave their reason for cancelling in a NEW message. Pass the reason in their own words. Never invent a reason and never call it in the same message as step 2.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "The customer's own reason for cancelling the order." },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

export { toolDefinitions };
