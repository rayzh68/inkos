import { describe, expect, it } from "vitest";
import { isValidProviderUsage, normalizeProviderUsage } from "../llm/usage.js";

describe("canonical provider usage", () => {
  it.each([[100, 20, 120], [100, 20, 125], [0, 0, 0], [97988, 1233, 101004]])("accepts %i/%i/%i", (promptTokens, completionTokens, totalTokens) => {
    expect(isValidProviderUsage({ promptTokens, completionTokens, totalTokens })).toBe(true);
  });
  it.each(["promptTokens", "completionTokens", "totalTokens"])("rejects malformed %s", (field) => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "120", undefined]) {
      expect(isValidProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 125, [field]: value })).toBe(false);
    }
  });
  it("rejects totals below classified usage and unsafe sums", () => {
    expect(isValidProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 119 })).toBe(false);
    expect(isValidProviderUsage({ promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER })).toBe(false);
  });
  it("preserves actual cost but rejects invalid explicit costs", () => {
    for (const actualCostUsd of [0, 0.4]) expect(isValidProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 125, actualCostUsd })).toBe(true);
    for (const actualCostUsd of [-1, NaN, Infinity, null, "0.4"]) expect(isValidProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 125, actualCostUsd })).toBe(false);
  });
  it("derives only absent adapter totals, retaining malformed explicit evidence for validation", () => {
    expect(normalizeProviderUsage({ promptTokens: 100, completionTokens: 20 })).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(normalizeProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 125, actualCostUsd: 0.4 })).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 125, actualCostUsd: 0.4 });
    expect(normalizeProviderUsage({ promptTokens: 100, completionTokens: 20, totalTokens: null }).totalTokens).toBeNull();
  });
});
