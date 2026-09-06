import { describe, expect, it, vi } from "vitest";
import {
  FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR,
  TruthExtractorAgent,
  buildTruthExtractorMessages,
  parseTruthExtractorResponse,
} from "../agents/truth-extractor.js";
import { sha256Utf8 } from "../state/canonical-json.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("TruthExtractorAgent", () => {
  it("exports deterministic complete messages with the frozen five-operation proposal grammar", () => {
    const request = {
      transactionId: "txn-1", attemptId: "attempt-1", chapterNumber: 1,
      candidate: "Ada opens the gate.", candidateSha256: sha256Utf8("Ada opens the gate."),
      predecessorTruthSha256: "a".repeat(64), predecessorCommitSha256: "b".repeat(64),
      vocabularyCatalogSha256: "c".repeat(64), extractionKind: "INITIAL" as const, repairOrdinal: 0 as const,
      predecessorTruthJson: "{}", vocabularyCatalogJson: "{}", committedAuthority: "authority",
    };

    const first = buildTruthExtractorMessages(request);
    const second = buildTruthExtractorMessages(structuredClone(request));

    expect(second).toEqual(first);
    const prompt = first.map((message) => message.content).join("\n");
    const encodedGrammar = prompt.match(/BEGIN_FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR\n([\s\S]*?)\nEND_FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR/u)?.[1];
    expect(encodedGrammar).toBeDefined();
    const grammar = JSON.parse(encodedGrammar!);
    expect(grammar).toEqual(FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR);
    expect(grammar.definitions.subjectObjectContract).toEqual({
      exactFields: ["schemaVersion", "subjectKinds", "objectKinds", "allowReflexive"],
      schemaVersion: "1.0",
      subjectKinds: ["ENTITY", "FACT_SLOT", "RELATION"],
      objectKinds: ["ENTITY", "FACT_SLOT", "RELATION"],
      allowReflexive: "BOOLEAN",
    });
  });

  it("binds the exact candidate and predecessor identities and returns only raw ChapterDelta proposal text", async () => {
    const rawProposal = JSON.stringify({
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "READY",
      operations: [],
      evidence: [],
      ambiguities: [],
    });
    const agent = new TruthExtractorAgent({ client: { provider: "test" } as never, model: "extractor-model", projectRoot: "." });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: rawProposal, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } });

    const result = await agent.extract({
      transactionId: "txn-1",
      attemptId: "attempt-1",
      chapterNumber: 1,
      candidate: "Ada opens the gate.",
      candidateSha256: sha256Utf8("Ada opens the gate."),
      predecessorTruthSha256: SHA_B,
      predecessorCommitSha256: SHA_C,
      vocabularyCatalogSha256: SHA_A,
      extractionKind: "INITIAL",
      repairOrdinal: 0,
      predecessorTruthJson: "{}",
      vocabularyCatalogJson: "{}",
      committedAuthority: "authority",
      chapterMemo: "memo",
    });

    const prompts = (chat.mock.calls[0]?.[0] as Array<{ content: string }>).map((message) => message.content).join("\n");
    expect(prompts).toContain("Ada opens the gate.");
    expect(prompts).toContain(SHA_B);
    expect(prompts).toContain(SHA_C);
    expect(prompts).toContain("INITIAL");
    expect(result).toEqual({
      rawProposal,
      responseContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    });
  });

  it("accepts only the exact ChapterDeltaProposalV1 envelope", () => {
    expect(parseTruthExtractorResponse(JSON.stringify({
      schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [], evidence: [], ambiguities: [],
    }))).toMatchObject({ kind: "CHAPTER_DELTA_PROPOSAL", status: "READY" });
    expect(() => parseTruthExtractorResponse(JSON.stringify({
      schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [], evidence: [], ambiguities: [],
      resultingTruth: {},
    }))).toThrow(/unknown field|exact/i);
  });

  it("returns malformed model bytes untouched so the transaction owns the bounded repair decision", async () => {
    const rawProposal = "not-json";
    const agent = new TruthExtractorAgent({ client: { provider: "test" } as never, model: "extractor-model", projectRoot: "." });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: rawProposal, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

    await expect(agent.extract({
      transactionId: "txn-1", attemptId: "attempt-1", chapterNumber: 1,
      candidate: "Ada opens the gate.", candidateSha256: sha256Utf8("Ada opens the gate."),
      predecessorTruthSha256: SHA_B, predecessorCommitSha256: SHA_C, vocabularyCatalogSha256: SHA_A,
      extractionKind: "INITIAL", repairOrdinal: 0, predecessorTruthJson: "{}", vocabularyCatalogJson: "{}",
      committedAuthority: "authority",
    })).resolves.toMatchObject({ rawProposal, responseContentSha256: sha256Utf8(rawProposal) });
  });
});
