import { describe, expect, it } from "vitest";
import type { ChapterDeltaProposalV1 } from "../models/chapter-delta.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { admitChapterDeltaV1, validateAcceptedChapterDeltaV1, validateBoundChapterDeltaBodyV1 } from "../state/chapter-delta-admission.js";
import { canonicalJsonBytes, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { reduceStructuredTruthV1 } from "../state/structured-truth-reducer.js";
import { BUILT_IN_TRUTH_VOCABULARY_V1, createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function emptyTruth(): StructuredTruthV1 {
  return {
    schemaVersion: "1.0",
    kind: "STRUCTURED_TRUTH",
    bookId: "book-1",
    throughChapter: 0,
    lineage: {
      kind: "BASELINE",
      predecessorCommitSha256: SHA_A,
      baselineSourceManifestSha256: SHA_B,
      seedVocabularyCatalogSha256: SHA_C,
      baselineMethod: "DETERMINISTIC",
      baselineConstructionReceiptSha256: SHA_D,
    },
    vocabulary: createVocabularyCatalogV1([]),
    entities: [],
    facts: [],
    relations: [],
    provenance: {
      schemaVersion: "1.0",
      producerKind: "BASELINE",
      producerId: "inkos.truth-baseline.builder.v1",
      producerVersion: "1.0",
      canonicalizationId: "inkos.jcs-ijson.v1",
      truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0",
      coreVocabularyVersion: "1.0",
    },
  };
}

function hostFor(candidate: string, predecessor = emptyTruth()) {
  return {
    transactionId: "txn-1",
    attemptId: "attempt-1",
    bookId: "book-1",
    chapterNumber: predecessor.throughChapter + 1,
    candidateSha256: sha256Utf8(candidate),
    predecessorCommitSha256: SHA_A,
    predecessorTruthSha256: canonicalSha256(predecessor),
    predecessorVocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
    extractorLogicalOperationId: "truth-extractor-1",
    extractorInputFingerprint: SHA_B,
    providerArtifactSha256: SHA_C,
    responseContentSha256: SHA_D,
  };
}

function entryId(name: string): string {
  const entry = BUILT_IN_TRUTH_VOCABULARY_V1.find((item) => item.canonicalName === name);
  if (!entry) throw new Error(`Missing test built-in ${name}`);
  return entry.entryId;
}

function sameDeltaProposal(candidate: string): ChapterDeltaProposalV1 {
  return {
    schemaVersion: "1.0",
    kind: "CHAPTER_DELTA_PROPOSAL",
    status: "READY",
    evidence: [{
      kind: "FINAL_PROSE_SPAN",
      evidenceId: "ev-0001",
      startUtf16: 0,
      endUtf16: candidate.length,
      quote: candidate,
    }],
    ambiguities: [],
    operations: [
      {
        kind: "DECLARE_ENTITY",
        operationId: "op-0001",
        localRef: "local:op-0001",
        before: { state: "ABSENT" },
        after: {
          state: "PRESENT",
          definition: {
            definitionType: "NARRATIVE_ENTITY",
            entityKind: "story.character",
            identityKey: "ada",
            canonicalName: "Ada",
            aliases: [],
          },
        },
        evidenceIds: ["ev-0001"],
      },
      {
        kind: "DECLARE_ENTITY",
        operationId: "op-0002",
        localRef: "local:op-0002",
        before: { state: "ABSENT" },
        after: {
          state: "PRESENT",
          definition: {
            definitionType: "VOCABULARY_FACT_KEY",
            metaKind: "system.vocabulary.fact-key",
            canonicalName: "custom.identity.codename",
            semanticDefinition: "The current exact operational codename.",
            valueContract: { contractType: "STRING" },
          },
        },
        evidenceIds: ["ev-0001"],
      },
      {
        kind: "SET_FACT",
        operationId: "op-0003",
        subject: { refType: "LOCAL_ENTITY", localRef: "local:op-0001" },
        factKey: { refType: "LOCAL_FACT_KEY", localRef: "local:op-0002" },
        before: { state: "UNKNOWN" },
        after: { state: "VALUE", value: { valueType: "STRING", value: "Raven" } },
        evidenceIds: ["ev-0001"],
      },
      {
        kind: "SET_RELATION",
        operationId: "op-0004",
        subject: { nodeKind: "ENTITY", refType: "LOCAL_ENTITY", localRef: "local:op-0001" },
        relationPredicate: { refType: "RELATION_PREDICATE_ENTRY_ID", entryId: entryId("knowledge.knows") },
        object: { nodeKind: "FACT_SLOT", refType: "OPERATION_TARGET", targetOperationId: "op-0003" },
        before: { state: "UNKNOWN" },
        after: { state: "PRESENT" },
        evidenceIds: ["ev-0001"],
      },
    ],
  };
}

function entityRefFactProposal(candidate: string): ChapterDeltaProposalV1 {
  return {
    schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", ambiguities: [],
    evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: candidate.length, quote: candidate }],
    operations: [{
      kind: "DECLARE_ENTITY", operationId: "op-0001", localRef: "local:op-0001", before: { state: "ABSENT" },
      after: { state: "PRESENT", definition: { definitionType: "NARRATIVE_ENTITY", entityKind: "story.character", identityKey: "ada", canonicalName: "Ada", aliases: [] } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "DECLARE_ENTITY", operationId: "op-0002", localRef: "local:op-0002", before: { state: "ABSENT" },
      after: { state: "PRESENT", definition: { definitionType: "NARRATIVE_ENTITY", entityKind: "story.character", identityKey: "bea", canonicalName: "Bea", aliases: [] } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "DECLARE_ENTITY", operationId: "op-0003", localRef: "local:op-0003", before: { state: "ABSENT" },
      after: { state: "PRESENT", definition: { definitionType: "VOCABULARY_FACT_KEY", metaKind: "system.vocabulary.fact-key", canonicalName: "custom.relationship.mentor", semanticDefinition: "The entity currently serving as mentor.", valueContract: { contractType: "ENTITY_REF" } } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_FACT", operationId: "op-0004", subject: { refType: "LOCAL_ENTITY", localRef: "local:op-0001" },
      factKey: { refType: "LOCAL_FACT_KEY", localRef: "local:op-0003" }, before: { state: "UNKNOWN" },
      after: { state: "VALUE", value: { valueType: "ENTITY_REF", entity: { refType: "LOCAL_ENTITY", localRef: "local:op-0002" } } }, evidenceIds: ["ev-0001"],
    }],
  } as ChapterDeltaProposalV1;
}

function predecessorWithFactAndRelation(): StructuredTruthV1 {
  const candidate = "Ada knows that her current operational codename is Raven.";
  const admitted = admitChapterDeltaV1({ rawProposal: JSON.stringify(sameDeltaProposal(candidate)), candidate, predecessor: emptyTruth(), host: hostFor(candidate) });
  if (admitted.status !== "ACCEPTED") throw new Error("expected accepted predecessor fixture");
  return reduceStructuredTruthV1({ predecessor: emptyTruth(), acceptedDelta: admitted.acceptedDelta });
}

function replacementProposal(
  candidate: string,
  predecessor: StructuredTruthV1,
  kind: "SET_FACT" | "RETRACT_FACT" | "SET_RELATION" | "RETRACT_RELATION",
  evidence: "PROSE_ONLY" | "SUBJECT_ONLY" | "TARGET" | "WRONG_TARGET_HASH",
): ChapterDeltaProposalV1 {
  const fact = predecessor.facts[0]!;
  const relation = predecessor.relations[0]!;
  const target = kind.endsWith("FACT")
    ? { nodeKind: "FACT_SLOT" as const, nodeId: fact.factSlotId }
    : { nodeKind: "RELATION" as const, nodeId: relation.relationId };
  const subject = kind.endsWith("FACT") ? fact.subject : relation.subject;
  const record = kind.endsWith("FACT") ? fact : relation;
  const evidenceRecords: any[] = [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: candidate.length, quote: candidate }];
  if (evidence !== "PROSE_ONLY") evidenceRecords.push({
    kind: "PREDECESSOR_TRUTH_RECORD",
    evidenceId: "ev-0002",
    recordRef: evidence === "SUBJECT_ONLY" ? subject : target,
    recordSha256: evidence === "WRONG_TARGET_HASH" ? "f".repeat(64) : canonicalSha256(evidence === "SUBJECT_ONLY" ? predecessor.entities[0] : record),
  });
  const evidenceIds = evidence === "PROSE_ONLY" ? ["ev-0001"] : ["ev-0001", "ev-0002"];
  const operation: any = kind.endsWith("FACT")
    ? {
      kind, operationId: "op-0001", subject: { refType: "ENTITY_ID", entityId: fact.subject.nodeId },
      factKey: { refType: "FACT_KEY_ENTRY_ID", entryId: fact.factKeyEntryId }, before: fact.assertion,
      after: kind === "SET_FACT" ? { state: "VALUE", value: { valueType: "STRING", value: "Crow" } } : { state: "UNKNOWN" }, evidenceIds,
    }
    : {
      kind, operationId: "op-0001", subject: { nodeKind: relation.subject.nodeKind, refType: "NODE_ID", nodeId: relation.subject.nodeId },
      relationPredicate: { refType: "RELATION_PREDICATE_ENTRY_ID", entryId: relation.predicateEntryId },
      object: { nodeKind: relation.object.nodeKind, refType: "NODE_ID", nodeId: relation.object.nodeId }, before: relation.assertion,
      after: kind === "SET_RELATION" ? { state: relation.assertion.state === "PRESENT" ? "ABSENT" : "PRESENT" } : { state: "UNKNOWN" }, evidenceIds,
    };
  return { schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [operation], evidence: evidenceRecords, ambiguities: [] } as ChapterDeltaProposalV1;
}

describe("ChapterDelta proposal admission", () => {
  it("requires exact target predecessor records for replacements and retractions in proposal, bound, and accepted admission", () => {
    const predecessor = predecessorWithFactAndRelation();
    const candidate = "Ada's current codename changes to Crow.";
    const host = hostFor(candidate, predecessor);
    for (const kind of ["SET_FACT", "RETRACT_FACT", "SET_RELATION", "RETRACT_RELATION"] as const) {
      expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, predecessor, kind, "PROSE_ONLY")), candidate, predecessor, host }))
        .toThrow(/exact target predecessor evidence/i);
    }
    const absentFactPredecessor = { ...predecessor, facts: predecessor.facts.map((fact) => ({ ...fact })) };
    absentFactPredecessor.facts[0]!.assertion = { state: "ABSENT" };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, absentFactPredecessor, "SET_FACT", "PROSE_ONLY")), candidate, predecessor: absentFactPredecessor, host: hostFor(candidate, absentFactPredecessor) }))
      .toThrow(/exact target predecessor evidence/i);
    const absentRelationPredecessor = { ...predecessor, relations: predecessor.relations.map((relation) => ({ ...relation })) };
    absentRelationPredecessor.relations[0]!.assertion = { state: "ABSENT" };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, absentRelationPredecessor, "SET_RELATION", "PROSE_ONLY")), candidate, predecessor: absentRelationPredecessor, host: hostFor(candidate, absentRelationPredecessor) }))
      .toThrow(/exact target predecessor evidence/i);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, predecessor, "SET_FACT", "SUBJECT_ONLY")), candidate, predecessor, host }))
      .toThrow(/exact target predecessor evidence/i);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, predecessor, "SET_FACT", "WRONG_TARGET_HASH")), candidate, predecessor, host }))
      .toThrow(/record hash mismatch/i);

    const admitted = admitChapterDeltaV1({ rawProposal: JSON.stringify(replacementProposal(candidate, predecessor, "SET_FACT", "TARGET")), candidate, predecessor, host });
    expect(admitted.status).toBe("ACCEPTED");
    if (admitted.status !== "ACCEPTED") throw new Error("expected exact-target replacement fixture");
    const loaded = structuredClone(admitted.acceptedDelta) as any;
    loaded.delta.evidence = loaded.delta.evidence.filter((item: { evidenceId: string }) => item.evidenceId !== "ev-0002");
    loaded.delta.operations[0].evidenceIds = ["ev-0001"];
    loaded.deltaId = canonicalSha256(loaded.delta);
    expect(() => validateBoundChapterDeltaBodyV1(loaded.delta)).toThrow(/exact target predecessor evidence/i);
    expect(() => validateAcceptedChapterDeltaV1(loaded, predecessor)).toThrow(/exact target predecessor evidence/i);
  });

  it("preserves prose-only admission for UNKNOWN-to-new fact and relation assertions", () => {
    const candidate = "Ada knows that her current operational codename is Raven.";
    expect(admitChapterDeltaV1({ rawProposal: JSON.stringify(sameDeltaProposal(candidate)), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }).status)
      .toBe("ACCEPTED");
  });

  it("binds same-delta entity, vocabulary, fact-slot, and higher-order relation references", () => {
    const candidate = "Ada knows that her current operational codename is Raven.";
    const result = admitChapterDeltaV1({
      rawProposal: JSON.stringify(sameDeltaProposal(candidate)),
      candidate,
      predecessor: emptyTruth(),
      host: hostFor(candidate),
    });
    expect(result.status).toBe("ACCEPTED");
    if (result.status !== "ACCEPTED") throw new Error("expected accepted delta");
    expect(result.acceptedDelta.deltaId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.acceptedDelta.delta.operations).toHaveLength(4);
    const [declaration, vocabulary, fact, relation] = result.acceptedDelta.delta.operations;
    expect(declaration).toMatchObject({ kind: "DECLARE_ENTITY", operationId: "op-0001" });
    expect(declaration).toHaveProperty("declaredEntityId");
    expect(declaration).not.toHaveProperty("localRef");
    expect(vocabulary).toHaveProperty("declaredEntryId");
    expect(fact).toMatchObject({ kind: "SET_FACT", operationId: "op-0003" });
    expect(fact).toHaveProperty("factSlotId");
    expect(relation).toMatchObject({
      kind: "SET_RELATION",
      operationId: "op-0004",
      directionality: "DIRECTED",
      object: { nodeKind: "FACT_SLOT", nodeId: (fact as { factSlotId: string }).factSlotId },
    });
  });

  it("binds a proposed LOCAL_ENTITY fact value to the stored ENTITY_REF node shape", () => {
    const candidate = "Ada's current mentor is Bea.";
    const result = admitChapterDeltaV1({ rawProposal: JSON.stringify(entityRefFactProposal(candidate)), candidate, predecessor: emptyTruth(), host: hostFor(candidate) });
    expect(result.status).toBe("ACCEPTED");
    if (result.status !== "ACCEPTED") throw new Error("expected accepted delta");
    const bea = result.acceptedDelta.delta.operations[1];
    const fact = result.acceptedDelta.delta.operations[3];
    expect(bea).toHaveProperty("declaredEntityId");
    expect(fact).toMatchObject({
      kind: "SET_FACT",
      after: { state: "VALUE", value: { valueType: "ENTITY_REF", value: { nodeKind: "ENTITY", nodeId: (bea as { declaredEntityId: string }).declaredEntityId } } },
    });
    expect(JSON.parse(JSON.stringify(fact))).not.toHaveProperty("after.value.entity");
  });

  it("rejects forward, missing, and stored-shape entity refs in proposed fact values", () => {
    const candidate = "Ada's current mentor is Bea.";
    const forward = structuredClone(entityRefFactProposal(candidate)) as any;
    const bea = forward.operations.splice(1, 1)[0];
    bea.operationId = "op-0004"; bea.localRef = "local:op-0004";
    forward.operations[1].operationId = "op-0002"; forward.operations[1].localRef = "local:op-0002";
    forward.operations[2].operationId = "op-0003";
    forward.operations[2].factKey.localRef = "local:op-0002";
    forward.operations[2].after.value.entity.localRef = "local:op-0004";
    forward.operations.push(bea);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(forward), candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/LOCAL_ENTITY|earlier/i);

    const missing = structuredClone(entityRefFactProposal(candidate)) as any;
    missing.operations[3].after.value.entity = { refType: "ENTITY_ID", entityId: "f".repeat(64) };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(missing), candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/unknown.*entity|ENTITY_ID/i);

    const storedShape = structuredClone(entityRefFactProposal(candidate)) as any;
    storedShape.operations[3].after.value = { valueType: "ENTITY_REF", value: { nodeKind: "ENTITY", nodeId: "f".repeat(64) } };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(storedShape), candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/proposed|ENTITY_REF|unknown field|missing field/i);
  });

  it("declares and first-uses a custom relation predicate and binds ENTITY to RELATION targets", () => {
    const candidate = "Ada mentors Bea and knows that relationship.";
    const base = sameDeltaProposal(candidate);
    const operations = [base.operations[0]!, {
      kind: "DECLARE_ENTITY" as const, operationId: "op-0002", localRef: "local:op-0002", before: { state: "ABSENT" as const },
      after: { state: "PRESENT" as const, definition: { definitionType: "NARRATIVE_ENTITY" as const, entityKind: "story.character" as const, identityKey: "bea", canonicalName: "Bea", aliases: [] } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "DECLARE_ENTITY" as const, operationId: "op-0003", localRef: "local:op-0003", before: { state: "ABSENT" as const },
      after: { state: "PRESENT" as const, definition: { definitionType: "VOCABULARY_RELATION_PREDICATE" as const, metaKind: "system.vocabulary.relation-predicate" as const, canonicalName: "custom.relationship.mentors", semanticDefinition: "The subject mentors the object.", subjectObjectContract: { schemaVersion: "1.0" as const, subjectKinds: ["ENTITY" as const], objectKinds: ["ENTITY" as const], allowReflexive: false }, directionality: "DIRECTED" as const } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION" as const, operationId: "op-0004", subject: { nodeKind: "ENTITY" as const, refType: "LOCAL_ENTITY" as const, localRef: "local:op-0001" }, relationPredicate: { refType: "LOCAL_RELATION_PREDICATE" as const, localRef: "local:op-0003" }, object: { nodeKind: "ENTITY" as const, refType: "LOCAL_ENTITY" as const, localRef: "local:op-0002" }, before: { state: "UNKNOWN" as const }, after: { state: "PRESENT" as const }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION" as const, operationId: "op-0005", subject: { nodeKind: "ENTITY" as const, refType: "LOCAL_ENTITY" as const, localRef: "local:op-0001" }, relationPredicate: { refType: "RELATION_PREDICATE_ENTRY_ID" as const, entryId: entryId("knowledge.knows") }, object: { nodeKind: "RELATION" as const, refType: "OPERATION_TARGET" as const, targetOperationId: "op-0004" }, before: { state: "UNKNOWN" as const }, after: { state: "PRESENT" as const }, evidenceIds: ["ev-0001"],
    }];
    const result = admitChapterDeltaV1({ rawProposal: JSON.stringify({ ...base, operations }), candidate, predecessor: emptyTruth(), host: hostFor(candidate) });
    expect(result.status).toBe("ACCEPTED");
    if (result.status === "ACCEPTED") expect(result.acceptedDelta.delta.operations[4]).toMatchObject({ object: { nodeKind: "RELATION" }, kind: "SET_RELATION" });
  });

  it("admits exactly 256 operations and rejects 257", () => {
    const candidate = "x";
    const proposal = (count: number): ChapterDeltaProposalV1 => ({
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "READY",
      operations: Array.from({ length: count }, (_, index) => {
        const operationId = `op-${String(index + 1).padStart(4, "0")}`;
        return {
          kind: "DECLARE_ENTITY" as const,
          operationId,
          localRef: `local:${operationId}`,
          before: { state: "ABSENT" as const },
          after: {
            state: "PRESENT" as const,
            definition: {
              definitionType: "NARRATIVE_ENTITY" as const,
              entityKind: "story.object" as const,
              identityKey: `e${index + 1}`,
              canonicalName: `Entity ${index + 1}`,
              aliases: [],
            },
          },
          evidenceIds: ["ev-0001"] as const,
        };
      }),
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: 1, quote: "x" }],
      ambiguities: [],
    });
    expect(admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal(256)), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }).status)
      .toBe("ACCEPTED");
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal(257) as unknown), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/256|operations/i);
  });

  it("rejects duplicate raw members, unknown proposal fields, and authoritative model fields", () => {
    const candidate = "x";
    expect(() => admitChapterDeltaV1({
      rawProposal: '{"schemaVersion":"1.0","schemaVersion":"1.0","kind":"CHAPTER_DELTA_PROPOSAL","status":"READY","operations":[],"evidence":[],"ambiguities":[]}',
      candidate,
      predecessor: emptyTruth(),
      host: hostFor(candidate),
    })).toThrow(/duplicate/i);
    expect(() => admitChapterDeltaV1({
      rawProposal: JSON.stringify({ ...sameDeltaProposal(candidate), transactionId: "model-chosen" }),
      candidate,
      predecessor: emptyTruth(),
      host: hostFor(candidate),
    })).toThrow(/unknown field|transactionId/i);
  });

  it("validates exact UTF-16 spans, surrogate boundaries, quote bytes, and quote length", () => {
    const candidate = "A😀雪";
    const proposal = structuredClone(sameDeltaProposal(candidate)) as any;
    proposal.evidence = [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 1, endUtf16: 2, quote: "\ud83d" }];
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/surrogate|boundary/i);

    const longCandidate = "x".repeat(4097);
    const longProposal = sameDeltaProposal(longCandidate);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(longProposal), candidate: longCandidate, predecessor: emptyTruth(), host: hostFor(longCandidate) }))
      .toThrow(/4096|quote/i);

    const maxCandidate = "x".repeat(4096);
    expect(admitChapterDeltaV1({ rawProposal: JSON.stringify(sameDeltaProposal(maxCandidate)), candidate: maxCandidate, predecessor: emptyTruth(), host: hostFor(maxCandidate) }).status).toBe("ACCEPTED");
  });

  it("accepts 512 evidence/ambiguities and rejects 513 independently", () => {
    const candidate = "x".repeat(512);
    const evidence = Array.from({ length: 512 }, (_, index) => ({ kind: "FINAL_PROSE_SPAN" as const, evidenceId: `ev-${String(index + 1).padStart(4, "0")}`, startUtf16: index, endUtf16: index + 1, quote: "x" }));
    const ambiguities = Array.from({ length: 512 }, (_, index) => ({ ambiguityId: `amb-${String(index + 1).padStart(4, "0")}`, classification: "PROSE_SEMANTICS_UNRESOLVED" as const, description: `Unresolved ${index + 1}.`, proseEvidenceIds: ["ev-0001"], predecessorEvidenceIds: [], relatedOperationIds: [], relatedNodeRefs: [] }));
    ambiguities[0]!.proseEvidenceIds = evidence.map((item) => item.evidenceId);
    const proposal = { schemaVersion: "1.0" as const, kind: "CHAPTER_DELTA_PROPOSAL" as const, status: "AMBIGUOUS" as const, operations: [], evidence, ambiguities };
    expect(admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }).status).toBe("AMBIGUOUS");
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify({ ...proposal, evidence: [...evidence, { ...evidence[0], evidenceId: "ev-0513" }] }), candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/512|evidence/i);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify({ ...proposal, ambiguities: [...ambiguities, { ...ambiguities[0], ambiguityId: "amb-0513" }] }), candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/512|ambiguities/i);
  });

  it("rejects an independently oversized raw proposal before parsing", () => {
    const candidate = "x";
    const rawProposal = `${JSON.stringify(sameDeltaProposal(candidate))}${" ".repeat(2_097_152)}`;
    expect(() => admitChapterDeltaV1({ rawProposal, candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/2.?097.?152|2 MiB|raw proposal/i);
  });

  it("rejects canonical proposed JCS above 2 MiB while the raw proposal remains within its limit", () => {
    const byteLimit = 2_097_152;
    const candidate = `${"x".repeat(1_000_000)}z`;
    const evidence = Array.from({ length: 512 }, (_, index) => ({
      kind: "FINAL_PROSE_SPAN" as const,
      evidenceId: `ev-${String(index + 1).padStart(4, "0")}`,
      startUtf16: 1_000_000,
      endUtf16: 1_000_001,
      quote: "z",
    }));
    const makeRaw = (description: string) => JSON.stringify({
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "AMBIGUOUS",
      operations: [],
      evidence,
      ambiguities: [{
        ambiguityId: "amb-0001",
        classification: "PROSE_SEMANTICS_UNRESOLVED",
        description,
        proseEvidenceIds: evidence.map((item) => item.evidenceId),
        predecessorEvidenceIds: [],
        relatedOperationIds: [],
        relatedNodeRefs: [],
      }],
    }).replaceAll('"startUtf16":1000000', '"startUtf16":1e6');
    const base = makeRaw("x");
    const rawProposal = makeRaw("x".repeat(byteLimit - 100 - new TextEncoder().encode(base).byteLength + 1));
    expect(new TextEncoder().encode(rawProposal).byteLength).toBe(byteLimit - 100);
    expect(() => admitChapterDeltaV1({ rawProposal, candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/canonical proposed JCS/i);
  });

  it("rejects canonical bound JCS above 2 MiB while raw and proposed JCS remain within their limits", () => {
    const byteLimit = 2_097_152;
    const candidate = "x";
    const makeProposal = (semanticDefinition: string): ChapterDeltaProposalV1 => ({
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "READY",
      operations: [{
        kind: "DECLARE_ENTITY",
        operationId: "op-0001",
        localRef: "local:op-0001",
        before: { state: "ABSENT" },
        after: {
          state: "PRESENT",
          definition: {
            definitionType: "VOCABULARY_FACT_KEY",
            metaKind: "system.vocabulary.fact-key",
            canonicalName: "custom.test.large",
            semanticDefinition,
            valueContract: { contractType: "STRING" },
          },
        },
        evidenceIds: ["ev-0001"],
      }],
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: 1, quote: "x" }],
      ambiguities: [],
    });
    const base = makeProposal("x");
    const proposal = makeProposal("x".repeat(byteLimit - 100 - canonicalJsonBytes(base).byteLength + 1));
    const rawProposal = JSON.stringify(proposal);
    expect(new TextEncoder().encode(rawProposal).byteLength).toBeLessThanOrEqual(byteLimit);
    expect(canonicalJsonBytes(proposal).byteLength).toBe(byteLimit - 100);
    expect(() => admitChapterDeltaV1({ rawProposal, candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/canonical bound JCS/i);
  });

  it("rejects independently loaded oversized bound and accepted delta bodies", () => {
    const byteLimit = 2_097_152;
    const candidate = "x";
    const admitted = admitChapterDeltaV1({ rawProposal: JSON.stringify(sameDeltaProposal(candidate)), candidate, predecessor: emptyTruth(), host: hostFor(candidate) });
    if (admitted.status !== "ACCEPTED") throw new Error("expected accepted fixture");
    const oversized = { ...admitted.acceptedDelta.delta, transactionId: "x".repeat(byteLimit) };
    expect(canonicalJsonBytes(oversized).byteLength).toBeGreaterThan(byteLimit);
    expect(() => validateBoundChapterDeltaBodyV1(oversized)).toThrow(/canonical bound JCS|2.?097.?152|2 MiB/i);
    expect(() => validateAcceptedChapterDeltaV1({ schemaVersion: "1.0", deltaId: canonicalSha256(oversized), delta: oversized }, emptyTruth())).toThrow(/canonical bound JCS|2.?097.?152|2 MiB/i);
  });

  it("enforces would-be bound size during AMBIGUOUS dry-run without exposing the body", () => {
    const byteLimit = 2_097_152;
    const candidate = "x";
    const makeProposal = (semanticDefinition: string) => ({
      schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "AMBIGUOUS",
      operations: [{
        kind: "DECLARE_ENTITY", operationId: "op-0001", localRef: "local:op-0001", before: { state: "ABSENT" },
        after: { state: "PRESENT", definition: { definitionType: "VOCABULARY_FACT_KEY", metaKind: "system.vocabulary.fact-key", canonicalName: "custom.test.ambiguous-large", semanticDefinition, valueContract: { contractType: "STRING" } } }, evidenceIds: ["ev-0001"],
      }],
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: 1, quote: "x" }],
      ambiguities: [{ ambiguityId: "amb-0001", classification: "PROSE_SEMANTICS_UNRESOLVED", description: "The durable meaning is unresolved.", proseEvidenceIds: ["ev-0001"], predecessorEvidenceIds: [], relatedOperationIds: ["op-0001"], relatedNodeRefs: [] }],
    });
    const base = makeProposal("x");
    const proposal = makeProposal("x".repeat(byteLimit - 100 - canonicalJsonBytes(base).byteLength + 1));
    const rawProposal = JSON.stringify(proposal);
    expect(new TextEncoder().encode(rawProposal).byteLength).toBeLessThanOrEqual(byteLimit);
    expect(canonicalJsonBytes(proposal).byteLength).toBe(byteLimit - 100);
    expect(() => admitChapterDeltaV1({ rawProposal, candidate, predecessor: emptyTruth(), host: hostFor(candidate) })).toThrow(/canonical bound JCS|2.?097.?152|2 MiB/i);
  });

  it("dry-runs AMBIGUOUS proposals but cannot create an accepted delta", () => {
    const candidate = "Unclear.";
    const proposal: ChapterDeltaProposalV1 = {
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "AMBIGUOUS",
      operations: [],
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: candidate.length, quote: candidate }],
      ambiguities: [{
        ambiguityId: "amb-0001",
        classification: "PROSE_SEMANTICS_UNRESOLVED",
        description: "The durable identity is unresolved.",
        proseEvidenceIds: ["ev-0001"],
        predecessorEvidenceIds: [],
        relatedOperationIds: [],
        relatedNodeRefs: [],
      }],
    };
    const result = admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal), candidate, predecessor: emptyTruth(), host: hostFor(candidate) });
    expect(result).toMatchObject({ status: "AMBIGUOUS", ambiguities: [{ ambiguityId: "amb-0001" }] });
    expect(result).not.toHaveProperty("acceptedDelta");
    expect(result).not.toHaveProperty("deltaId");
    expect(result).not.toHaveProperty("boundDelta");
  });

  it("rejects an illegal ambiguity node kind even when its nodeId matches a predecessor relation", () => {
    const seedCandidate = "Ada knows that her current operational codename is Raven.";
    const admitted = admitChapterDeltaV1({ rawProposal: JSON.stringify(sameDeltaProposal(seedCandidate)), candidate: seedCandidate, predecessor: emptyTruth(), host: hostFor(seedCandidate) });
    if (admitted.status !== "ACCEPTED") throw new Error("expected accepted predecessor fixture");
    const predecessor = reduceStructuredTruthV1({ predecessor: emptyTruth(), acceptedDelta: admitted.acceptedDelta });
    const candidate = "Unclear.";
    const proposal = {
      schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "AMBIGUOUS", operations: [],
      evidence: [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: candidate.length, quote: candidate }],
      ambiguities: [{
        ambiguityId: "amb-0001", classification: "PROSE_SEMANTICS_UNRESOLVED", description: "The related node kind is unresolved.",
        proseEvidenceIds: ["ev-0001"], predecessorEvidenceIds: [], relatedOperationIds: [],
        relatedNodeRefs: [{ nodeKind: "MODEL_CHOSEN", nodeId: predecessor.relations[0]!.relationId }],
      }],
    };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(proposal), candidate, predecessor, host: hostFor(candidate, predecessor) })).toThrow(/node kind|ENTITY|FACT_SLOT|RELATION/i);
  });

  it("rejects duplicate targets, forward/wrong-kind refs, stale before-values, and evidence without prose support", () => {
    const candidate = "Ada knows Raven.";
    const duplicate = structuredClone(sameDeltaProposal(candidate)) as any;
    duplicate.operations = [...duplicate.operations, {
      ...duplicate.operations[2]!,
      operationId: "op-0005",
      after: { state: "VALUE", value: { valueType: "STRING", value: "Crow" } },
    }];
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(duplicate), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/duplicate target|mutated.*once/i);

    const forward = structuredClone(sameDeltaProposal(candidate)) as any;
    const relation = forward.operations[3]!;
    if (relation.kind !== "SET_RELATION") throw new Error("bad test fixture");
    relation.object = { nodeKind: "RELATION", refType: "OPERATION_TARGET", targetOperationId: "op-0004" };
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify(forward), candidate, predecessor: emptyTruth(), host: hostFor(candidate) }))
      .toThrow(/earlier|self|operation target/i);
  });

  it("requires the exact closed host binding schema before constructing a body", () => {
    const candidate = "x";
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify({ ...sameDeltaProposal(candidate), operations: [] }), candidate, predecessor: emptyTruth(), host: { ...hostFor(candidate), extra: "x" } as never })).toThrow(/host|unknown|field/i);
    const { transactionId: _removed, ...missing } = hostFor(candidate);
    expect(() => admitChapterDeltaV1({ rawProposal: JSON.stringify({ ...sameDeltaProposal(candidate), operations: [] }), candidate, predecessor: emptyTruth(), host: missing as never })).toThrow(/host|missing|transaction/i);
  });
});
