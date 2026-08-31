import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bindCandidateFactEvidence,
  buildSemanticAdjudicationBatch,
  buildSemanticAuthorityEnvelope,
  parseSemanticAdjudicationResponse,
  type SemanticAuthorityNomination,
} from "../agents/semantic-authority.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function envelope(options?: {
  readonly currentState?: unknown;
  readonly hooks?: unknown;
  readonly previousAuthoritySha256?: string;
  readonly transactionId?: string;
}) {
  const currentState = JSON.stringify(options?.currentState ?? {
    chapter: 5,
    facts: [
      {
        subject: "character",
        predicate: "location",
        object: "Gate",
        validFromChapter: 4,
        validUntilChapter: null,
        sourceChapter: 4,
      },
    ],
  });
  const hooks = JSON.stringify(options?.hooks ?? { hooks: [] });
  const authoritySha = options?.previousAuthoritySha256 ?? "a".repeat(64);
  return buildSemanticAuthorityEnvelope({
    transaction: {
      transactionId: options?.transactionId ?? "chapter-txn-test",
      bookId: "book-test",
      chapterNumber: 6,
      previousAuthoritySha256: authoritySha,
    },
    authority: {
      kind: "CHAPTER_COMMIT",
      chapterNumber: 5,
      authoritySha256: authoritySha,
      currentState: {
        relativePath: "story/commits/chapter-0005/state/current_state.json",
        content: currentState,
        sha256: sha(currentState),
        authorityMember: true,
      },
      hooks: {
        relativePath: "story/commits/chapter-0005/state/hooks.json",
        content: hooks,
        sha256: sha(hooks),
        authorityMember: true,
      },
    },
  });
}

function nomination(
  candidateContent: string,
  authority = envelope(),
  overrides?: Partial<SemanticAuthorityNomination>,
): SemanticAuthorityNomination {
  const record = authority.records.find((item) => item.factKey === "state:character::location")!;
  const quote = "The character remained at Harbor.";
  const evidence = bindCandidateFactEvidence(candidateContent, authority, [{
    kind: "CANDIDATE_ASSERTION",
    recordId: record.recordId,
    value: "Harbor",
    quote,
    startUtf16: candidateContent.indexOf(quote),
    endUtf16: candidateContent.indexOf(quote) + quote.length,
  }]);
  const assertion = evidence.assertions[0]!;
  return {
    findingId: "location-conflict",
    description: "The candidate silently changes the continuing location.",
    assertion,
    committedRecord: record,
    envelopeIdentity: authority.identity,
    ...overrides,
  };
}

function agreeingResponse(batch: ReturnType<typeof buildSemanticAdjudicationBatch>): string {
  return JSON.stringify({
    batchHash: batch.batchHash,
    items: batch.items.map((item) => ({
      ...item,
      candidateAssertsClaimedValue: true,
      semanticConflict: true,
      explicitTransition: false,
      uncertain: false,
    })),
  });
}

describe("semantic authority envelope and independent adjudication", () => {
  it("builds one SHA-bound transaction envelope from structured committed state", () => {
    const authority = envelope();

    expect(authority).toMatchObject({
      status: "VERIFIED",
      identity: {
        transactionId: "chapter-txn-test",
        previousAuthoritySha256: "a".repeat(64),
        authorityChapterNumber: 5,
      },
      records: [expect.objectContaining({
        factKey: "state:character::location",
        fieldPath: "/facts/0/object",
        value: "Gate",
        source: "current_state.json",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        tier: "COMMITTED_STRUCTURED_CURRENT_STATE",
      })],
    });
    expect(authority.identity.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when no host-verifiable structured anchor exists", () => {
    const currentState = "{}";
    const hooks = "{}";
    const result = buildSemanticAuthorityEnvelope({
      transaction: {
        transactionId: "chapter-txn-test", bookId: "book-test", chapterNumber: 6,
        previousAuthoritySha256: "a".repeat(64),
      },
      authority: {
        kind: "CHAPTER_COMMIT", chapterNumber: 5, authoritySha256: "a".repeat(64),
        currentState: { relativePath: "current_state.json", content: currentState, sha256: sha(currentState), authorityMember: true },
        hooks: { relativePath: "hooks.json", content: hooks, sha256: sha(hooks), authorityMember: true },
      },
    });

    expect(result).toMatchObject({ status: "UNAVAILABLE", records: [] });
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each(["currentState", "hooks"] as const)(
    "fails closed when schema-valid %s bytes are absent from the verified authority manifest",
    (missingAnchor) => {
      const currentState = JSON.stringify({
        chapter: 5,
        facts: [{
          subject: "character", predicate: "location", object: "Gate",
          validFromChapter: 4, validUntilChapter: null, sourceChapter: 4,
        }],
      });
      const hooks = JSON.stringify({ hooks: [] });
      const result = buildSemanticAuthorityEnvelope({
        transaction: {
          transactionId: "chapter-txn-test", bookId: "book-test", chapterNumber: 6,
          previousAuthoritySha256: "a".repeat(64),
        },
        authority: {
          kind: "CHAPTER_COMMIT", chapterNumber: 5, authoritySha256: "a".repeat(64),
          currentState: {
            relativePath: "story/commits/chapter-0005/state/current_state.json",
            content: currentState,
            sha256: sha(currentState),
            authorityMember: missingAnchor !== "currentState",
          },
          hooks: {
            relativePath: "story/commits/chapter-0005/state/hooks.json",
            content: hooks,
            sha256: sha(hooks),
            authorityMember: missingAnchor !== "hooks",
          },
        },
      } as Parameters<typeof buildSemanticAuthorityEnvelope>[0]);

      expect(result).toMatchObject({ status: "UNAVAILABLE", records: [] });
      expect(result.issues).toContain(`${missingAnchor === "currentState" ? "current_state.json" : "hooks.json"} is not a verified authority-tree member.`);
      const candidateContent = "The character remained at Harbor.";
      const verifiedBaseline = envelope();
      expect(buildSemanticAdjudicationBatch({
        candidateContent,
        envelope: result,
        nominations: [nomination(candidateContent, verifiedBaseline)],
      })).toMatchObject({ status: "AMBIGUOUS", items: [] });
    },
  );

  it("rejects a lower-priority stale record when a higher active record exists", () => {
    const authority = envelope({
      currentState: {
        chapter: 5,
        facts: [
          { subject: "character", predicate: "location", object: "Old Gate", validFromChapter: 1, validUntilChapter: 3, sourceChapter: 1 },
          { subject: "character", predicate: "location", object: "Current Gate", validFromChapter: 4, validUntilChapter: null, sourceChapter: 4 },
        ],
      },
    });
    const stale = authority.records.find((record) => record.value === "Old Gate")!;
    const content = "The character remained at Harbor.";

    const evidence = bindCandidateFactEvidence(content, authority, [{
      kind: "CANDIDATE_ASSERTION", recordId: stale.recordId, value: "Harbor", quote: content,
      startUtf16: 0, endUtf16: content.length,
    }]);

    expect(evidence.assertions).toEqual([]);
    expect(evidence.issues).toContain("Candidate evidence 1 is not host-bindable.");
  });

  it.each([
    ["wrong transaction", (n: SemanticAuthorityNomination) => ({ ...n, envelopeIdentity: { ...n.envelopeIdentity, transactionId: "wrong" } })],
    ["wrong previous authority", (n: SemanticAuthorityNomination) => ({ ...n, envelopeIdentity: { ...n.envelopeIdentity, previousAuthoritySha256: "b".repeat(64) } })],
    ["wrong catalog hash", (n: SemanticAuthorityNomination) => ({ ...n, envelopeIdentity: { ...n.envelopeIdentity, catalogHash: "b".repeat(64) } })],
    ["wrong source SHA", (n: SemanticAuthorityNomination) => ({ ...n, committedRecord: { ...n.committedRecord, sourceSha256: "b".repeat(64) } })],
    ["wrong field path", (n: SemanticAuthorityNomination) => ({ ...n, committedRecord: { ...n.committedRecord, fieldPath: "/facts/9/object" } })],
    ["wrong candidate SHA", (n: SemanticAuthorityNomination) => ({ ...n, assertion: { ...n.assertion, candidateSha256: "b".repeat(64) } })],
    ["wrong quote", (n: SemanticAuthorityNomination) => ({ ...n, assertion: { ...n.assertion, quote: "unrelated real quote" } })],
    ["wrong span", (n: SemanticAuthorityNomination) => ({ ...n, assertion: { ...n.assertion, startUtf16: 1 } })],
  ])("denies batch construction for %s", (_label, mutate) => {
    const authority = envelope();
    const content = "The character remained at Harbor. Another real sentence follows.";
    const result = buildSemanticAdjudicationBatch({
      candidateContent: content,
      envelope: authority,
      nominations: [mutate(nomination(content, authority))],
    });

    expect(result).toMatchObject({ status: "AMBIGUOUS", items: [] });
  });

  it("authorizes the same structured fact/value conflict only after independent agreement", () => {
    const authority = envelope();
    const content = "The character remained at Harbor.";
    const batch = buildSemanticAdjudicationBatch({
      candidateContent: content,
      envelope: authority,
      nominations: [nomination(content, authority)],
    });

    expect(batch.status).toBe("READY");
    expect(parseSemanticAdjudicationResponse(agreeingResponse(batch), batch)).toMatchObject({
      status: "AUTHORIZED",
      authorizedFindingIds: ["location-conflict"],
    });
  });

  it.each([
    ["an adjacent explicit transition", "She left Gate and reached Harbor."],
    ["nearby map-title context", "The map title read Harbor, while she remained at Gate."],
  ])("binds the full candidate prose so a value-only quote cannot hide %s", (_label, content) => {
    const authority = envelope();
    const record = authority.records[0]!;
    const quote = "Harbor";
    const evidence = bindCandidateFactEvidence(content, authority, [{
      kind: "CANDIDATE_ASSERTION",
      recordId: record.recordId,
      value: quote,
      quote,
      startUtf16: content.indexOf(quote),
      endUtf16: content.indexOf(quote) + quote.length,
    }]);
    const batch = buildSemanticAdjudicationBatch({
      candidateContent: content,
      envelope: authority,
      nominations: [{
        findingId: "context-sensitive-location",
        description: "The narrow quote requires full-prose inspection.",
        assertion: evidence.assertions[0]!,
        committedRecord: record,
        envelopeIdentity: authority.identity,
      }],
    });

    expect(batch).toMatchObject({ status: "READY", candidateContent: content });
  });

  it.each([
    [
      "different candidate values",
      "Harbor then Port.",
      [
        { kind: "CANDIDATE_ASSERTION", value: "Harbor", quote: "Harbor", startUtf16: 0, endUtf16: 6 },
        { kind: "CANDIDATE_ASSERTION", value: "Port", quote: "Port", startUtf16: 12, endUtf16: 16 },
      ],
    ],
    [
      "an assertion and explicit transition",
      "She left Gate and reached Harbor.",
      [
        { kind: "CANDIDATE_ASSERTION", value: "Harbor", quote: "Harbor", startUtf16: 26, endUtf16: 32 },
        { kind: "EXPLICIT_TRANSITION", value: "Harbor", fromValue: "Gate", quote: "She left Gate and reached Harbor.", startUtf16: 0, endUtf16: 33 },
      ],
    ],
  ] as const)("fails closed when one authority fact has %s", (_label, content, rawAssertions) => {
    const authority = envelope();
    const record = authority.records[0]!;
    const evidence = bindCandidateFactEvidence(
      content,
      authority,
      rawAssertions.map((assertion) => ({ ...assertion, recordId: record.recordId })),
    );

    expect(evidence.assertions).toEqual([]);
    expect(evidence.issues).toContain(`Candidate evidence contains duplicate or conflicting assertions for ${record.recordId}.`);
  });

  it("rejects duplicate nominations for one authority fact before focused adjudication", () => {
    const authority = envelope();
    const content = "The character remained at Harbor.";
    const first = nomination(content, authority);
    const batch = buildSemanticAdjudicationBatch({
      candidateContent: content,
      envelope: authority,
      nominations: [first, { ...first, findingId: "second-location-conflict" }],
    });

    expect(batch).toMatchObject({ status: "AMBIGUOUS", items: [] });
    expect(batch.issues).toContain(`Semantic adjudication contains duplicate or conflicting nominations for ${first.committedRecord.recordId}.`);
  });

  it.each([
    ["different fact identity", (item: Record<string, unknown>) => ({ ...item, factKey: "hook:map::title" })],
    ["different candidate value", (item: Record<string, unknown>) => ({ ...item, candidateValue: "Map Harbor" })],
    ["explicit transition", (item: Record<string, unknown>) => ({ ...item, explicitTransition: true })],
    ["uncertain", (item: Record<string, unknown>) => ({ ...item, uncertain: true })],
    ["no semantic conflict", (item: Record<string, unknown>) => ({ ...item, semanticConflict: false })],
  ])("fails closed when the secondary judgment reports %s", (_label, mutate) => {
    const authority = envelope();
    const content = "The character remained at Harbor.";
    const batch = buildSemanticAdjudicationBatch({ candidateContent: content, envelope: authority, nominations: [nomination(content, authority)] });
    const response = JSON.parse(agreeingResponse(batch)) as { batchHash: string; items: Array<Record<string, unknown>> };
    response.items[0] = mutate(response.items[0]!);

    expect(parseSemanticAdjudicationResponse(JSON.stringify(response), batch)).toMatchObject({
      status: "AMBIGUOUS",
      authorizedFindingIds: [],
    });
  });

  it.each([
    ["malformed", () => "not-json"],
    ["missing", (batch: ReturnType<typeof buildSemanticAdjudicationBatch>) => JSON.stringify({ batchHash: batch.batchHash, items: [] })],
    ["duplicate", (batch: ReturnType<typeof buildSemanticAdjudicationBatch>) => {
      const response = JSON.parse(agreeingResponse(batch)) as { batchHash: string; items: unknown[] };
      return JSON.stringify({ ...response, items: [response.items[0], response.items[0]] });
    }],
    ["extra", (batch: ReturnType<typeof buildSemanticAdjudicationBatch>) => {
      const response = JSON.parse(agreeingResponse(batch)) as { batchHash: string; items: Array<Record<string, unknown>> };
      return JSON.stringify({ ...response, items: [...response.items, { ...response.items[0], findingId: "extra" }] });
    }],
    ["unknown field", (batch: ReturnType<typeof buildSemanticAdjudicationBatch>) => {
      const response = JSON.parse(agreeingResponse(batch)) as { batchHash: string; items: Array<Record<string, unknown>> };
      return JSON.stringify({ ...response, items: [{ ...response.items[0], surprise: true }] });
    }],
  ])("rejects strict %s adjudication output", (_label, responseFor) => {
    const authority = envelope();
    const content = "The character remained at Harbor.";
    const batch = buildSemanticAdjudicationBatch({ candidateContent: content, envelope: authority, nominations: [nomination(content, authority)] });

    expect(parseSemanticAdjudicationResponse(responseFor(batch), batch)).toMatchObject({
      status: "AMBIGUOUS",
      authorizedFindingIds: [],
    });
  });

  it("canonically orders one focused batch independent of nomination order", () => {
    const authority = envelope({
      hooks: { hooks: [{
        hookId: "h1", startChapter: 1, type: "promise", status: "open",
        lastAdvancedChapter: 5, expectedPayoff: "A", notes: "A",
      }] },
    });
    const content = "The character remained at Harbor. The promise now pays B.";
    const first = nomination(content, authority);
    const hookRecord = authority.records.find((record) => record.factKey === "hook:h1::expectedpayoff")!;
    const quote = "The promise now pays B.";
    const evidence = bindCandidateFactEvidence(content, authority, [{
      kind: "CANDIDATE_ASSERTION", recordId: hookRecord.recordId, value: "B", quote,
      startUtf16: content.indexOf(quote), endUtf16: content.indexOf(quote) + quote.length,
    }]);
    const second: SemanticAuthorityNomination = {
      findingId: "hook-conflict", description: "silent hook change", assertion: evidence.assertions[0]!,
      committedRecord: hookRecord, envelopeIdentity: authority.identity,
    };

    const left = buildSemanticAdjudicationBatch({ candidateContent: content, envelope: authority, nominations: [first, second] });
    const right = buildSemanticAdjudicationBatch({ candidateContent: content, envelope: authority, nominations: [second, first] });

    expect(left.status).toBe("READY");
    expect(right.items).toEqual(left.items);
    expect(right.batchHash).toBe(left.batchHash);
  });
});
