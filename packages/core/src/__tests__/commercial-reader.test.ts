import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CommercialReaderAgent, parseCommercialReaderResponse } from "../agents/commercial-reader.js";

describe("commercial reader", () => {
  it("parses a fully scored review and binds its candidate", () => {
    const result = parseCommercialReaderResponse(JSON.stringify({
      reviewer_role: "commercial-reader",
      total_score: 10,
      dimension_scores: {
        opening_hook: 90,
        pacing_tension: 88,
        emotional_investment: 90,
        plot_clarity: 89,
        dialogue_appeal: 88,
        western_cultural_naturalness: 86,
        commercial_appeal: 90,
        ending_hook: 91,
      },
      decision: "APPROVED",
      findings: [],
    }), { candidateSha: "abc", provider: "google", model: "gemini" });
    expect(result.totalScore).toBe(89);
    expect(result.reviewedCandidateSha).toBe("abc");
    expect(result.decision).toBe("APPROVED");
  });

  it("classifies empty and malformed output as INVALID_OUTPUT", () => {
    expect(parseCommercialReaderResponse("", { candidateSha: "abc", provider: null, model: null }).decision).toBe("INVALID_OUTPUT");
    expect(parseCommercialReaderResponse("not-json", { candidateSha: "abc", provider: null, model: null }).decision).toBe("INVALID_OUTPUT");
  });

  it.each([
    ["APPROVED", "CRITICAL"],
    ["APPROVED_WITH_NOTES", "MAJOR"],
  ] as const)("fails closed on contradictory %s with a %s finding", (decision, severity) => {
    const result = parseCommercialReaderResponse(JSON.stringify({
      reviewer_role: "commercial-reader",
      total_score: 92,
      dimension_scores: {
        opening_hook: 92,
        pacing_tension: 92,
        emotional_investment: 92,
        plot_clarity: 92,
        dialogue_appeal: 92,
        western_cultural_naturalness: 92,
        commercial_appeal: 92,
        ending_hook: 92,
      },
      decision,
      findings: [{
        finding_id: "blocking-1",
        severity,
        evidence: "The candidate contradicts committed authority.",
        impact: "canon",
        required_outcome: "Repair the contradiction.",
      }],
    }), { candidateSha: "abc", provider: "test-provider", model: "test-model" });

    expect(result.decision).toBe("INVALID_OUTPUT");
  });

  it("states the exact decision enum while keeping ACCEPT invalid", async () => {
    const agent = new CommercialReaderAgent({
      client: { provider: "test", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, extra: {} } } as never,
      model: "test-model",
      projectRoot: ".",
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({
          reviewer_role: "commercial-reader",
          total_score: 96,
          dimension_scores: {
            opening_hook: 96,
            pacing_tension: 96,
            emotional_investment: 96,
            plot_clarity: 96,
            dialogue_appeal: 96,
            western_cultural_naturalness: 96,
            commercial_appeal: 96,
            ending_hook: 96,
          },
          decision: "ACCEPT",
          findings: [],
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });

    const result = await agent.reviewChapter({ chapterNumber: 7, content: "candidate", candidateSha: "sha" });
    const system = (chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[0]?.content ?? "";

    expect(system).toContain("decision MUST be exactly one of: APPROVED, APPROVED_WITH_NOTES, REVISION_REQUIRED, HELD");
    expect(result.decision).toBe("INVALID_OUTPUT");
  });

  it("exposes the exact candidate-bound Provider input fingerprint used by the call", async () => {
    const client = {
      provider: "openai", service: "custom", apiFormat: "chat", stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    } as never;
    const agent = new CommercialReaderAgent({ client, model: "test-model", projectRoot: "." });
    let exactFinalMessages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }> = [];
    const chat = vi.spyOn(agent as unknown as { chat: (...args: any[]) => Promise<unknown> }, "chat")
      .mockImplementation(async (
        messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
        options: { onFinalProviderRequest?: (request: unknown) => void },
      ) => {
        exactFinalMessages = messages.map((message, index) => index === 0
          ? { ...message, content: `${message.content}\n\nACTIVATED_FINAL_READER_GUIDANCE` }
          : message);
        options.onFinalProviderRequest?.({
          provider: "custom", model: "test-model", messages: exactFinalMessages,
          temperature: 0.2, maxTokens: 4096, stream: false,
        });
        return {
        content: JSON.stringify({
          reviewer_role: "commercial-reader", total_score: 92,
          dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 },
          decision: "APPROVED", findings: [],
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      });

    const result = await agent.reviewChapter({ chapterNumber: 7, content: "exact candidate", candidateSha: "sha-7", chapterIntent: "intent" });
    const expected = createHash("sha256").update(JSON.stringify({
      provider: "custom", model: "test-model", messages: exactFinalMessages,
      temperature: 0.2, maxTokens: 4096, stream: false,
    }), "utf8").digest("hex");

    expect(result.providerRequest?.messages).toEqual(exactFinalMessages);
    expect(result.providerRequest?.messages[0]?.content).toContain("ACTIVATED_FINAL_READER_GUIDANCE");
    expect((result as typeof result & { providerInputFingerprint?: string }).providerInputFingerprint).toBe(expected);
  });
});
