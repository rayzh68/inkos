import { describe, expect, it } from "vitest";
import { buildTruthExtractorMessages, type TruthExtractionRequest } from "../agents/truth-extractor.js";
import { buildTruthValidatorMessages } from "../agents/truth-validator.js";
import { canonicalJson, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { estimatePiContextTokens, type LLMMessage } from "../llm/provider.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import { admitChapterDeltaV1 } from "../state/chapter-delta-admission.js";
import { reduceStructuredTruthV1 } from "../state/structured-truth-reducer.js";

function fixture(bookId = "book-alpha", chapterNumber = 3) {
  const memo = `Memo for ${bookId}: keep the locked gate unexplained.`;
  const predecessor = { bookId, throughChapter: chapterNumber - 1,
    vocabulary: { entries: [{ name: "gate-status", meaning: "Whether the gate is locked." }] },
    facts: [{ subject: "gate", value: false }], entities: [], relations: [] };
  const authority = {
    schemaVersion: "1.0", kind: "CANONICAL_TRUTH_COMMITTED_AUTHORITY",
    structuredTruth: predecessor,
    storyFrame: "Frame: 🌍 north quay remains closed; south quay remains open.",
    volumeMap: "Volume plan: departure, separation, return. Do not omit the return.",
    parentCanon: "Parent canon remains binding.", fanficCanon: "Fanfic canon remains binding.",
    bookRules: { enabled: false, note: "", limit: 0, optional: null, list: [] },
    chapterIntent: {
      markdown: `Unique opening.\n${memo}\nUnique conclusion.`,
      memo: { body: memo, author: "author", active: false },
      intentData: { focus: "Unique intent", optional: null }, ruleStack: ["Unique rule"],
      contextPackage: { enabled: false, selectedContext: [
        { source: "truth", reason: "predecessor", excerpt: JSON.stringify(predecessor, null, 2) },
        { source: "frame", reason: "location", excerpt: "north quay remains closed" },
        { source: "volume", reason: "future", excerpt: "departure, separation, return" },
        { source: "memo", reason: "chapter", excerpt: `Selected prefix. ${memo} Selected suffix.` },
        { source: "author", reason: "intent", excerpt: "Unique author intent" },
        { source: "focus", reason: "current", excerpt: "Unique current focus" },
        { source: "empty", reason: "legitimate empty", excerpt: "", enabled: false },
      ] },
    },
  };
  const request: TruthExtractionRequest = {
    transactionId: `synthetic-${bookId}-${chapterNumber}`, attemptId: "attempt-7", chapterNumber,
    candidate: "The gate stays locked.", candidateSha256: sha256Utf8("The gate stays locked."),
    predecessorTruthJson: canonicalJson(predecessor), predecessorTruthSha256: canonicalSha256(predecessor),
    predecessorCommitSha256: "a".repeat(64), vocabularyCatalogJson: canonicalJson(predecessor.vocabulary),
    vocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary), extractionKind: "INITIAL", repairOrdinal: 0,
    committedAuthority: canonicalJson(authority), chapterMemo: memo,
  };
  return { request, authority, memo, predecessor };
}

function section(prompt: string, heading: string) {
  return prompt.split(`## ${heading}\n\n`)[1]!.split("\n\n## ")[0]!;
}

describe("Canonical Truth settlement model context", () => {
  it("keeps large synthetic settlement requests in budget with a real admitted delta and complete resulting truth", () => {
    const hash = "a".repeat(64);
    const predecessor: StructuredTruthV1 = {
      schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: "large-budget-book", throughChapter: 16,
      lineage: { kind: "BASELINE", predecessorCommitSha256: hash, baselineSourceManifestSha256: hash,
        seedVocabularyCatalogSha256: hash, baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: hash },
      vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
      provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1",
        producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
        vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
    };
    const candidate = "Ada finds a brass key.".padEnd(14000, " narrative");
    const memo = "Preserve the mystery. ".padEnd(8000, "memo ");
    const volumeMap = "Complete unique volume plan. ".padEnd(315000, "future event ");
    const storyFrame = "Complete unique story frame. ".padEnd(40000, "world rule ");
    const committedAuthority = canonicalJson({ schemaVersion: "1.0", kind: "CANONICAL_TRUTH_COMMITTED_AUTHORITY",
      structuredTruth: predecessor, volumeMap, storyFrame, bookRules: { fanficMode: false },
      chapterIntent: { memo: { body: memo }, markdown: `Unique intent before. ${memo} Unique intent after.`,
        contextPackage: { selectedContext: [
          { source: "truth", reason: "state", excerpt: canonicalJson(predecessor) },
          { source: "memo", reason: "intent", excerpt: memo },
          ...Array.from({ length: 10 }, (_, index) => ({ source: `volume-${index}`, reason: "planning",
            excerpt: volumeMap.slice(index * 20000, index * 20000 + 24000) })),
          { source: "author", reason: "unique", excerpt: "Unique author instruction remains exact." },
        ] } } });
    const request: TruthExtractionRequest = { transactionId: "large-budget-transaction", attemptId: "attempt-9", chapterNumber: 17,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorTruthJson: canonicalJson(predecessor),
      predecessorTruthSha256: canonicalSha256(predecessor), predecessorCommitSha256: hash,
      vocabularyCatalogJson: canonicalJson(predecessor.vocabulary), vocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
      committedAuthority, chapterMemo: memo, extractionKind: "INITIAL", repairOrdinal: 0 };
    const quote = "Ada finds a brass key.";
    const rawProposal = canonicalJson({ schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", ambiguities: [],
      operations: [{ kind: "DECLARE_ENTITY", operationId: "op-0001", localRef: "local:op-0001", before: { state: "ABSENT" },
        after: { state: "PRESENT", definition: { definitionType: "NARRATIVE_ENTITY", entityKind: "story.object",
          identityKey: "brass-key", canonicalName: "Brass key", aliases: [] } }, evidenceIds: ["ev-0001"] }],
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: quote.length, quote }] });
    const admission = admitChapterDeltaV1({ rawProposal, candidate, predecessor, host: {
      transactionId: request.transactionId, attemptId: request.attemptId, bookId: predecessor.bookId, chapterNumber: request.chapterNumber,
      candidateSha256: request.candidateSha256, predecessorCommitSha256: hash, predecessorTruthSha256: request.predecessorTruthSha256,
      predecessorVocabularyCatalogSha256: request.vocabularyCatalogSha256, extractorLogicalOperationId: "budget-extraction",
      extractorInputFingerprint: hash, providerArtifactSha256: hash, responseContentSha256: sha256Utf8(rawProposal),
    } });
    expect(admission.status).toBe("ACCEPTED");
    if (admission.status !== "ACCEPTED") throw new Error("synthetic delta must be valid");
    const resultingTruth = reduceStructuredTruthV1({ predecessor, acceptedDelta: admission.acceptedDelta });
    const resultingTruthJson = canonicalJson(resultingTruth);
    expect(resultingTruthJson.length).toBeGreaterThanOrEqual(request.predecessorTruthJson.length);
    const extractor = buildTruthExtractorMessages(request);
    const validator = buildTruthValidatorMessages({ ...request, acceptedDeltaJson: canonicalJson(admission.acceptedDelta),
      acceptedDeltaSha256: canonicalSha256(admission.acceptedDelta), resultingTruthJson, resultingTruthSha256: canonicalSha256(resultingTruth),
      applicationReceiptSha256: hash, projectionManifestSha256: hash });
    const estimate = (messages: readonly LLMMessage[]) => estimatePiContextTokens({
      systemPrompt: messages[0]!.content, messages: [{ role: "user", content: messages[1]!.content, timestamp: 0 }],
    });
    // Independent pre-fix control restores only the three formerly duplicated model sections.
    const expanded = extractor.map((message) => ({ ...message }));
    expanded[1]!.content = expanded[1]!.content
      .replace(section(expanded[1]!.content, "Verified committed authority"), committedAuthority)
      .replace(section(expanded[1]!.content, "Verified vocabulary catalog"), request.vocabularyCatalogJson)
      .replace(section(expanded[1]!.content, "Non-authorizing chapter memo"), memo);
    expect(estimate(expanded)).toBeGreaterThan(111616);
    expect(estimate(extractor)).toBeLessThanOrEqual(103000);
    expect(111616 - estimate(extractor)).toBeGreaterThanOrEqual(8600);
    expect(125952 - estimate(validator)).toBeGreaterThanOrEqual(8000);
    expect(section(validator[1]!.content, "Deterministically resulting StructuredTruthV1")).toBe(resultingTruthJson);
    for (const messages of [extractor, validator]) {
      const projected = JSON.parse(section(messages[1]!.content, "Verified committed authority"));
      expect(projected.volumeMap).toBe(volumeMap);
      expect(projected.storyFrame).toBe(storyFrame);
      expect(projected.chapterIntent.memo.body).toBe(memo);
      expect(section(messages[1]!.content, "Exact approved candidate")).toBe(candidate);
    }
  });

  it.each([["book-alpha", 3], ["book-beta", 17], ["book-gamma", 81]] as const)(
    "removes only proven duplicate authority for %s chapter %i in both roles", (bookId, chapter) => {
      const { request, authority, memo } = fixture(bookId, chapter);
      const original = structuredClone(request);
      const extractor = buildTruthExtractorMessages(request)[1]!.content;
      const resultingTruthJson = canonicalJson({ ...JSON.parse(request.predecessorTruthJson), throughChapter: chapter });
      const validator = buildTruthValidatorMessages({ ...request, acceptedDeltaJson: '{"accepted":"unique delta"}',
        acceptedDeltaSha256: "b".repeat(64), resultingTruthJson, resultingTruthSha256: sha256Utf8(resultingTruthJson),
        applicationReceiptSha256: "c".repeat(64), projectionManifestSha256: "d".repeat(64) })[1]!.content;
      const projected = JSON.parse(section(extractor, "Verified committed authority"));
      expect(projected).toEqual(JSON.parse(section(validator, "Verified committed authority")));
      expect(projected.structuredTruth).toEqual({ reference: "Verified predecessor StructuredTruthV1", sha256: request.predecessorTruthSha256 });
      for (const prompt of [extractor, validator]) {
        expect(section(prompt, "Exact approved candidate")).toBe(request.candidate);
        expect(section(prompt, "Verified predecessor StructuredTruthV1")).toBe(request.predecessorTruthJson);
      }
      expect(section(validator, "Deterministically resulting StructuredTruthV1")).toBe(resultingTruthJson);
      expect(section(validator, "Accepted ChapterDeltaV1")).toBe('{"accepted":"unique delta"}');
      expect(section(extractor, "Verified vocabulary catalog")).not.toContain(request.vocabularyCatalogJson);
      expect(extractor).toContain(`vocabularyCatalogSha256=${request.vocabularyCatalogSha256}`);
      expect(extractor.split(request.vocabularyCatalogJson)).toHaveLength(2);
      expect(extractor.split(memo)).toHaveLength(2);
      expect(validator.split(memo)).toHaveLength(2);
      expect(projected.chapterIntent.memo).toEqual(authority.chapterIntent.memo);
      expect(projected.chapterIntent.markdown).toContain("Unique opening.");
      expect(projected.chapterIntent.markdown).toContain("Unique conclusion.");
      expect(projected.chapterIntent.markdown).not.toContain(memo);
      for (const key of ["storyFrame", "volumeMap", "parentCanon", "fanficCanon", "bookRules"] as const) {
        expect(projected[key]).toEqual(authority[key]);
      }
      expect(projected.chapterIntent.intentData).toEqual(authority.chapterIntent.intentData);
      expect(projected.chapterIntent.ruleStack).toEqual(authority.chapterIntent.ruleStack);
      expect(projected.chapterIntent.contextPackage.enabled).toBe(false);
      const selected = projected.chapterIntent.contextPackage.selectedContext;
      selected.forEach((entry: { source: string; reason: string }, index: number) => {
        expect(entry.source).toBe(authority.chapterIntent.contextPackage.selectedContext[index]!.source);
        expect(entry.reason).toBe(authority.chapterIntent.contextPackage.selectedContext[index]!.reason);
      });
      expect(selected[0].excerpt).not.toContain('"facts"');
      for (const [index, key] of [[1, "storyFrame"], [2, "volumeMap"]] as const) {
        const range = selected[index].excerpt.match(/UTF-16 (\d+):(\d+)/u);
        expect(range).not.toBeNull();
        expect(projected[key].slice(Number(range[1]), Number(range[2])))
          .toBe(authority.chapterIntent.contextPackage.selectedContext[index]!.excerpt);
      }
      expect(selected[3].excerpt).toContain("Selected prefix.");
      expect(selected[3].excerpt).toContain("Selected suffix.");
      expect(selected[3].excerpt).not.toContain(memo);
      expect(selected.slice(4)).toEqual(authority.chapterIntent.contextPackage.selectedContext.slice(4));
      expect(request).toEqual(original);
      expect(buildTruthExtractorMessages(structuredClone(request))[1]!.content).toBe(extractor);
    });

  it("preserves conflicting truth, vocabulary, standalone memo and non-covered excerpt bytes", () => {
    const { request, authority } = fixture();
    authority.structuredTruth.facts[0]!.value = true;
    const changed = { ...request, committedAuthority: canonicalJson(authority), vocabularyCatalogJson: '{"entries":[]}', chapterMemo: "Different standalone memo" };
    const prompt = buildTruthExtractorMessages(changed)[1]!.content;
    const projected = JSON.parse(section(prompt, "Verified committed authority"));
    expect(projected.structuredTruth).toEqual(authority.structuredTruth);
    expect(section(prompt, "Verified vocabulary catalog")).toBe(changed.vocabularyCatalogJson);
    expect(section(prompt, "Non-authorizing chapter memo")).toBe(changed.chapterMemo);
  });

  it.each(["plain legacy authority", '{"kind":"OTHER","structuredTruth":{}}',
    '{"kind":"CANONICAL_TRUTH_COMMITTED_AUTHORITY","kind":"OTHER"}'])(
    "does not reinterpret an unrecognized or invalid authority envelope: %s", (committedAuthority) => {
      const { request } = fixture();
      const prompt = buildTruthExtractorMessages({ ...request, committedAuthority })[1]!.content;
      expect(section(prompt, "Verified committed authority")).toBe(committedAuthority);
      expect(section(prompt, "Non-authorizing chapter memo")).toBe(request.chapterMemo);
    });

  it("does not equate two invalid JSON inputs or delete a legitimate empty memo", () => {
    const { request, authority } = fixture();
    authority.chapterIntent.memo.body = "";
    const prompt = buildTruthExtractorMessages({ ...request, predecessorTruthJson: "invalid", vocabularyCatalogJson: "invalid",
      chapterMemo: "", committedAuthority: canonicalJson(authority) })[1]!.content;
    expect(section(prompt, "Verified vocabulary catalog")).toBe("invalid");
    expect(section(prompt, "Non-authorizing chapter memo")).toBe("");
    expect(JSON.parse(section(prompt, "Verified committed authority")).chapterIntent.memo.body).toBe("");
  });
});
