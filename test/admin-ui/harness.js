// The dashboard's logic tests were written with describe/it/expect. This small adapter lets them run on
// node:test (no extra test runner), with just the matchers they use.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

export { describe, it };

/** A pattern that matches a string (expect.stringMatching). */
class StringMatching {
  constructor(re) { this.re = re; }
}

function matches(actual, expected) {
  if (expected instanceof StringMatching) return typeof actual === "string" && expected.re.test(actual);
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches(actual[k], v));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matches(actual[i], v));
  return Object.is(actual, expected);
}

function deepEqual(actual, expected) {
  // expect.stringMatching can sit anywhere inside the expected value
  const prune = (a, e) => {
    if (e instanceof StringMatching) return matches(a, e) ? e : a;
    if (Array.isArray(e) && Array.isArray(a)) return a.map((x, i) => prune(x, e[i]));
    if (e && typeof e === "object" && a && typeof a === "object") return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, prune(v, e[k])]));
    return a;
  };
  assert.deepEqual(prune(actual, expected), expected);
}

function build(actual, negate = false) {
  const check = (ok, message) => assert.ok(negate ? !ok : ok, message);
  return {
    toBe: (expected) => (negate ? assert.notStrictEqual(actual, expected) : assert.strictEqual(actual, expected)),
    toEqual: (expected) => deepEqual(actual, expected),
    toMatchObject: (expected) => check(matches(actual, expected), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
    toMatch: (re) => check(typeof re === "string" ? String(actual).includes(re) : re.test(String(actual)), `expected ${JSON.stringify(actual)} to match ${re}`),
    toHaveLength: (n) => assert.strictEqual(actual?.length, n),
    toBeInstanceOf: (cls) => check(actual instanceof cls, `expected an instance of ${cls.name}`),
    toThrow: (expected) => assert.throws(actual, expected),
    get not() { return build(actual, !negate); },
    get rejects() {
      return {
        toMatchObject: async (expected) => {
          let error;
          try { await actual; } catch (e) { error = e; }
          assert.ok(error, "expected the promise to reject");
          assert.ok(matches(error, expected), `expected ${error?.message} to match ${JSON.stringify(expected)}`);
        },
        toBeInstanceOf: async (cls) => {
          let error;
          try { await actual; } catch (e) { error = e; }
          assert.ok(error instanceof cls, `expected an instance of ${cls.name}`);
        },
        toThrow: async () => { await assert.rejects(actual); },
      };
    },
  };
}

export const expect = Object.assign((actual) => build(actual), {
  stringMatching: (re) => new StringMatching(re instanceof RegExp ? re : new RegExp(re)),
});
