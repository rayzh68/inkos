import { describe, expect, it, vi } from "vitest";
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

  it("states the exact decision enum while keeping ACCEPT invalid", async () => {
    const agent = new CommercialReaderAgent({
      client: { provider: "test" } as never,
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
});
