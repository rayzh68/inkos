import { describe, expect, it } from "vitest";
import {
  assertCanonicalRelativePath,
  assertNfcString,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  compareUnsignedUtf8,
  parseJsonRejectingDuplicates,
} from "../state/canonical-json.js";

describe("JCS / I-JSON canonical bytes", () => {
  it("uses RFC 8785 object ordering and ECMAScript number serialization", () => {
    const value = {
      z: 1,
      "\r": "CR",
      a: { y: 333333333.33333329, x: [true, null, "雪"] },
      "€": "Euro Sign",
      "😀": "Emoji",
    };
    expect(canonicalJson(value)).toBe(
      "{\"\\r\":\"CR\",\"a\":{\"x\":[true,null,\"雪\"],\"y\":333333333.3333333},\"z\":1,\"€\":\"Euro Sign\",\"😀\":\"Emoji\"}",
    );
    expect(new TextDecoder().decode(canonicalJsonBytes(value))).toBe(canonicalJson(value));
    expect(canonicalSha256({ b: 2, a: 1 })).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });

  it("rejects duplicate raw members before object construction", () => {
    expect(() => parseJsonRejectingDuplicates('{"a":1,"a":2}')).toThrow(/duplicate.*a/i);
    expect(() => parseJsonRejectingDuplicates('{"outer":{"x":1,"x":2}}')).toThrow(/duplicate.*x/i);
    expect(parseJsonRejectingDuplicates('{"a":1,"nested":{"b":2}}')).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("preserves __proto__ as an own data member at root and nested levels", () => {
    const root = parseJsonRejectingDuplicates('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>;
    const nested = parseJsonRejectingDuplicates('{"outer":{"__proto__":{"polluted":true}}}') as { outer: Record<string, unknown> };
    expect(Object.hasOwn(root, "__proto__")).toBe(true);
    expect(Object.hasOwn(nested.outer, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects non-I-JSON numbers and strings", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => canonicalJson({ value })).toThrow(/I-JSON|number/i);
    }
    expect(() => canonicalJson({ value: "\ud800" })).toThrow(/surrogate|I-JSON/i);
    expect(() => parseJsonRejectingDuplicates('{"value":1e400}')).toThrow(/I-JSON|number/i);
    expect(() => parseJsonRejectingDuplicates('{"value":9007199254740992}')).toThrow(/safe|number/i);
  });

  it("keeps evidence-like strings byte exact while exposing explicit NFC validation", () => {
    expect(canonicalJson({ quote: "e\u0301" })).toBe('{"quote":"é"}');
    expect(() => assertNfcString("e\u0301", "semantic value")).toThrow(/NFC/i);
    expect(assertNfcString("é", "semantic value")).toBe("é");
  });

  it("sorts set identities by unsigned UTF-8 bytes without locale rules", () => {
    expect(["雪", "z", "ä", "a"].sort(compareUnsignedUtf8)).toEqual(["a", "z", "ä", "雪"]);
  });

  it("accepts only normalized safe relative manifest paths", () => {
    expect(assertCanonicalRelativePath("state/current_state.json")).toBe("state/current_state.json");
    for (const path of ["/absolute", "C:/absolute", "state\\x.json", "state//x", "./x", "state/../x", "state/."]) {
      expect(() => assertCanonicalRelativePath(path)).toThrow(/path/i);
    }
  });
});
