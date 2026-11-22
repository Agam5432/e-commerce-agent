// src/agent/toolSchema.js
// Helpers to normalize tool parameter schemas for Groq (OpenAI-compatible) and Google Gemini.

// 1. Before sending tools to Groq: allow null on every optional (non-required) argument.
export function allowNullOnOptionalArgs(toolDefinitions = []) {
  return toolDefinitions.map((tool) => {
    const parameters = tool.function?.parameters;

    if (!parameters?.properties) return tool;

    const required = new Set(parameters.required || []);
    const properties = {};

    for (const [name, schema] of Object.entries(parameters.properties)) {
      const canAddNull =
        !required.has(name) &&
        typeof schema.type === "string" &&
        schema.type !== "null";

      properties[name] = canAddNull
        ? { ...schema, type: [schema.type, "null"] }
        : schema;
    }

    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: { ...parameters, properties },
      },
    };
  });
}

// 2. Sanitize a JSON Schema node for Google Gemini functionDeclarations:
//    - Gemini requires `type` to be a single string (never an array like ["string", "null"]).
//    - Gemini rejects `additionalProperties`.
function sanitizeSchemaForGemini(schema, isOptional = false) {
  if (!schema || typeof schema !== "object") return schema;

  const clone = { ...schema };
  delete clone.additionalProperties;

  if (Array.isArray(clone.type)) {
    const nonNull = clone.type.find((t) => t !== "null") || "string";
    const hadNull = clone.type.includes("null");
    clone.type = nonNull;
    if (hadNull || isOptional) {
      clone.nullable = true;
    }
  } else if (isOptional && typeof clone.type === "string") {
    clone.nullable = true;
  }

  if (clone.properties && typeof clone.properties === "object") {
    const reqSet = new Set(Array.isArray(clone.required) ? clone.required : []);
    const cleanProps = {};
    for (const [propName, propSchema] of Object.entries(clone.properties)) {
      cleanProps[propName] = sanitizeSchemaForGemini(
        propSchema,
        !reqSet.has(propName)
      );
    }
    clone.properties = cleanProps;
  }

  if (clone.items && typeof clone.items === "object") {
    clone.items = sanitizeSchemaForGemini(clone.items, false);
  }

  return clone;
}

export function toGeminiToolDeclarations(toolDefinitions = []) {
  return toolDefinitions.map((tool) => {
    const fn = tool.function || tool;
    const hasProps =
      fn.parameters?.properties &&
      Object.keys(fn.parameters.properties).length > 0;

    return {
      name: fn.name,
      description: fn.description || "",
      ...(hasProps
        ? { parameters: sanitizeSchemaForGemini(fn.parameters, false) }
        : {}),
    };
  });
}

// 3. After the model answers: remove null arguments, so handlers see "not provided" (undefined).
export function dropNullArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};

  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== null)
  );
}

// 4. A model sometimes writes an argument in snake_case ("shipping_rate") although the tool's schema says camelCase ("shippingRate"). The camelCase
// name is added next to it when the schema's own name is absent, so the tool never sees "nothing" for a value the model did send (real TechStore,
// 2026-11-17: "switch to Express" answered "that shipping option isn't available" while listing Express).
export function camelCaseArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (!key.includes("_")) continue;
    const camel = key.replace(/_+([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
    if (camel !== key && out[camel] === undefined) out[camel] = value;
  }
  return out;
}
