import { describe, expect, it } from "vitest";
import { buildProductionRoleOverrides, validateProductionRoleSelection } from "./production-role-models.js";
import * as roleModels from "./production-role-models.js";

const catalog = ["openai/gpt", "deepseek/chat", "google/gemini"];

describe("production role model configuration", () => {
  it("maps fixed UI roles to the existing model override contract", () => {
    expect(buildProductionRoleOverrides({
      production: "openai/gpt",
      review: "deepseek/chat",
      reader: "google/gemini",
    }, { unrelated: "preserved" })).toEqual({
      defaultModel: "openai/gpt",
      modelOverrides: {
        unrelated: "preserved",
        auditor: "deepseek/chat",
        "commercial-reader": "google/gemini",
        planner: "openai/gpt",
        composer: "openai/gpt",
        writer: "openai/gpt",
        reviser: "openai/gpt",
        "chapter-analyzer": "openai/gpt",
        "state-validator": "openai/gpt",
        "observer-reflector": "openai/gpt",
      },
    });
  });

  it("allows an explicit OpenRouter slug even when it is not in the current catalog", () => {
    expect(validateProductionRoleSelection({
      production: "new-provider/new-model",
      review: "deepseek/chat",
      reader: "google/gemini",
    }, catalog).production).toBe("new-provider/new-model");
  });

  it("rejects blank or malformed manual model ids", () => {
    const selection = {
      production: "openai/gpt",
      review: "deepseek/chat",
      reader: "google/gemini",
    };
    expect(() => validateProductionRoleSelection({ ...selection, production: "" }, catalog)).toThrow(/required/i);
    expect(() => validateProductionRoleSelection({ ...selection, production: "not a slug" }, catalog)).toThrow(/model id/i);
  });

  it("searches a live catalog by model id and display name", () => {
    const models = [
      { id: "openai/gpt-new", name: "New GPT", contextWindow: 1000 },
      { id: "deepseek/review", name: "DeepSeek Reviewer", contextWindow: 2000 },
    ];
    expect(roleModels.searchProductionModelCatalog(models, "gpt").map((model) => model.id)).toEqual(["openai/gpt-new"]);
    expect(roleModels.searchProductionModelCatalog(models, "reviewer").map((model) => model.id)).toEqual(["deepseek/review"]);
  });

  it("requires explicit text input and output capability for live OpenRouter entries", () => {
    expect(roleModels.isTextGenerationCatalogModel({ id: "provider/text", name: "Text", contextWindow: 1, inputModalities: ["text"], outputModalities: ["text"] })).toBe(true);
    expect(roleModels.isTextGenerationCatalogModel({ id: "provider/image", name: "Image", contextWindow: 1, inputModalities: ["text"], outputModalities: ["image"] })).toBe(false);
  });

  it("binds every saved role to exact live-catalog pricing without treating it as provider actual", () => {
    const selection = {
      production: "openai/gpt-5.6-terra",
      review: "deepseek/deepseek-v4-pro-0813",
      reader: "google/gemini-3.7-flash",
    };
    const liveCatalog = [...new Set(Object.values(selection))].map((id, index) => ({
      id,
      name: id,
      contextWindow: 128_000 + index,
      maxOutputTokens: 16_000 + index,
      inputPrice: `0.00000${index + 1}`,
      outputPrice: `0.00001${index + 1}`,
      inputModalities: ["text"],
      outputModalities: ["text"],
    }));

    const bound = roleModels.bindProductionRolePricing(selection, liveCatalog);

    expect(Object.values(bound)).toHaveLength(3);
    expect(Object.values(bound).every((entry) => entry.status === "VERIFIED_IN_CURRENT_CATALOG")).toBe(true);
    expect(bound.production).toMatchObject({
      modelId: "openai/gpt-5.6-terra",
      inputUsdPerToken: 0.000001,
      outputUsdPerToken: 0.000011,
      pricingUnit: "USD_PER_TOKEN",
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
    });
  });

  it("fails pricing closed for an unknown model or missing price", () => {
    const selection = { production: "missing/model", review: "priced/model", reader: "priced/model" };
    const liveCatalog = [{ id: "priced/model", name: "Priced", contextWindow: 1, inputPrice: "0.1", inputModalities: ["text"], outputModalities: ["text"] }];
    const bound = roleModels.bindProductionRolePricing(selection, liveCatalog);
    expect(bound.production.status).toBe("MODEL_NOT_IN_CURRENT_CATALOG");
    expect(bound.review.status).toBe("PRICING_UNAVAILABLE");
  });

  it("migrates a legacy five-role selection with writer as the single Production authority", () => {
    expect(roleModels.migrateLegacyProductionRoleSelection({
      writer: "openai/production", logicAuditor: "deepseek/review", commercialReader: "google/reader",
      reviser: "other/legacy-split", observerReflector: "other/hidden",
    })).toEqual({ production: "openai/production", review: "deepseek/review", reader: "google/reader" });
  });
});
