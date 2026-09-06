import { describe, expect, it, vi } from "vitest";
import { TruthValidatorAgent, buildTruthValidatorMessages, parseTruthValidatorResponse } from "../agents/truth-validator.js";
import { sha256Utf8 } from "../state/canonical-json.js";

const SHA = "a".repeat(64);

describe("TruthValidatorAgent", () => {
  it("exports the exact deterministic messages used by validation", () => {
    const request = {
      candidate: "Ada opens the gate.", candidateSha256: sha256Utf8("Ada opens the gate."),
      predecessorTruthJson: "{}", predecessorTruthSha256: "a".repeat(64),
      acceptedDeltaJson: "{}", acceptedDeltaSha256: "b".repeat(64),
      resultingTruthJson: "{}", resultingTruthSha256: "c".repeat(64),
      committedAuthority: "authority", applicationReceiptSha256: "d".repeat(64),
      projectionManifestSha256: "e".repeat(64),
    };
    expect(buildTruthValidatorMessages(structuredClone(request))).toEqual(buildTruthValidatorMessages(request));
  });

  it.each(["PASS", "DELTA_EXTRACTION_DEFECT", "PROSE_CONTENT_DEFECT", "AUTHORITY_AMBIGUITY"] as const)(
    "parses only the locked %s semantic classification",
    (verdict) => {
      expect(parseTruthValidatorResponse(JSON.stringify({ verdict, diagnostics: verdict === "PASS" ? [] : ["specific defect"] })))
        .toEqual({ verdict, diagnostics: verdict === "PASS" ? [] : ["specific defect"] });
    },
  );

  it("rejects replacement truth, delta, projection, or prose bytes", () => {
    for (const forbidden of ["replacementDelta", "resultingTruth", "projectionBytes", "rewrittenProse"]) {
      expect(() => parseTruthValidatorResponse(JSON.stringify({ verdict: "DELTA_EXTRACTION_DEFECT", diagnostics: ["x"], [forbidden]: {} })))
        .toThrow(/unknown field|exact/i);
    }
  });

  it("binds prose, predecessor, accepted delta, resulting truth, and evidence hashes", async () => {
    const agent = new TruthValidatorAgent({ client: { provider: "test" } as never, model: "validator-model", projectRoot: "." });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: '{"verdict":"PASS","diagnostics":[]}', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const result = await agent.validate({
      candidate: "Ada opens the gate.", candidateSha256: sha256Utf8("Ada opens the gate."),
      predecessorTruthJson: "{}", predecessorTruthSha256: SHA,
      acceptedDeltaJson: "{}", acceptedDeltaSha256: SHA,
      resultingTruthJson: "{}", resultingTruthSha256: SHA,
      committedAuthority: "authority", applicationReceiptSha256: SHA, projectionManifestSha256: SHA,
    });
    const prompt = (chat.mock.calls[0]?.[0] as Array<{ content: string }>).map((message) => message.content).join("\n");
    expect(prompt).toContain("Ada opens the gate.");
    expect(prompt.match(new RegExp(SHA, "g"))?.length).toBeGreaterThanOrEqual(5);
    expect(result).toMatchObject({ verdict: "PASS", diagnostics: [], usage: { totalTokens: 2 } });
  });
});
