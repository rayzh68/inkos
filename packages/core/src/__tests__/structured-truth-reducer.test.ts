import { describe, expect, it } from "vitest";
import type { AcceptedChapterDeltaV1, BoundChapterDeltaBodyV1 } from "../models/chapter-delta.js";
import { validateStructuredTruthV1, type StructuredTruthV1 } from "../models/structured-truth.js";
import { canonicalJson, canonicalSha256 } from "../state/canonical-json.js";
import {
  deriveChapterDeltaEntityId,
  deriveCustomVocabularyEntryId,
  deriveFactSlotId,
  deriveRelationIdentity,
} from "../state/truth-identities.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import { reduceStructuredTruthV1, validateChapterDeltaTruthAuthorityV1 } from "../state/structured-truth-reducer.js";
import { validateAcceptedChapterDeltaV1 } from "../state/chapter-delta-admission.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

function predecessor(): StructuredTruthV1 {
  return {
    schemaVersion: "1.0",
    kind: "STRUCTURED_TRUTH",
    bookId: "book-1",
    throughChapter: 0,
    lineage: {
      kind: "BASELINE",
      predecessorCommitSha256: A,
      baselineSourceManifestSha256: B,
      seedVocabularyCatalogSha256: C,
      baselineMethod: "DETERMINISTIC",
      baselineConstructionReceiptSha256: D,
    },
    vocabulary: createVocabularyCatalogV1([]),
    entities: [], facts: [], relations: [],
    provenance: {
      schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1",
      producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
    },
  };
}

function accepted(operations: BoundChapterDeltaBodyV1["operations"], prior = predecessor(), chapterNumber = 1): AcceptedChapterDeltaV1 {
  const evidence: BoundChapterDeltaBodyV1["evidence"][number][] = [{ kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: 1, quote: "x", candidateSha256: A }];
  let evidenceOrdinal = 2;
  const targetEvidenceIds = new Map<string, string>();
  const boundOperations = operations.map((operation) => {
    const target = operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT"
      ? { nodeKind: "FACT_SLOT" as const, nodeId: operation.factSlotId }
      : operation.kind === "SET_RELATION" || operation.kind === "RETRACT_RELATION"
        ? { nodeKind: "RELATION" as const, nodeId: operation.relationId }
        : undefined;
    const requiresTargetEvidence = target !== undefined
      && (operation.kind === "RETRACT_FACT" || operation.kind === "RETRACT_RELATION" || operation.before.state !== "UNKNOWN");
    if (!target || !requiresTargetEvidence) return operation;
    const record = target.nodeKind === "FACT_SLOT"
      ? prior.facts.find((item) => item.factSlotId === target.nodeId)
      : prior.relations.find((item) => item.relationId === target.nodeId);
    if (!record) return operation;
    const targetKey = `${target.nodeKind}:${target.nodeId}`;
    let evidenceId = targetEvidenceIds.get(targetKey);
    if (!evidenceId) {
      evidenceId = `ev-${String(evidenceOrdinal).padStart(4, "0")}`;
      evidenceOrdinal += 1;
      targetEvidenceIds.set(targetKey, evidenceId);
      evidence.push({
        kind: "PREDECESSOR_TRUTH_RECORD", evidenceId, recordRef: target,
        recordSha256: canonicalSha256(record), predecessorTruthSha256: canonicalSha256(prior),
      });
    }
    return { ...operation, evidenceIds: [...operation.evidenceIds, evidenceId] };
  });
  const body: BoundChapterDeltaBodyV1 = {
    schemaVersion: "1.0",
    transactionId: "txn-1",
    attemptId: "attempt-1",
    bookId: "book-1",
    chapterNumber,
    candidateSha256: A,
    predecessorCommitSha256: B,
    predecessorTruthSha256: canonicalSha256(prior),
    predecessorVocabularyCatalogSha256: canonicalSha256(prior.vocabulary),
    extractorLogicalOperationId: "extract-1",
    extractorInputFingerprint: C,
    providerArtifactSha256: D,
    responseContentSha256: E,
    proposedDeltaCanonicalSha256: A,
    evidence,
    operations: boundOperations,
  };
  return { schemaVersion: "1.0", deltaId: canonicalSha256(body), delta: body };
}

function entityDeclaration() {
  const entityId = deriveChapterDeltaEntityId({
    bookId: "book-1", candidateSha256: A, declarationOperationId: "op-0001",
    entityKind: "story.character", identityKey: "ada",
  });
  return {
    entityId,
    operation: {
      kind: "DECLARE_ENTITY" as const,
      operationId: "op-0001",
      before: { state: "ABSENT" as const },
      after: {
        state: "PRESENT" as const,
        definition: {
          definitionType: "NARRATIVE_ENTITY" as const,
          entityKind: "story.character" as const,
          identityKey: "ada",
          canonicalName: "Ada",
          aliases: [] as string[],
        },
      },
      declaredEntityId: entityId,
      evidenceIds: ["ev-0001"] as string[],
    },
  };
}

describe("pure structured-truth reducer", () => {
  it("applies declarations and VALUE facts without mutating either input", () => {
    const prior = predecessor();
    const { entityId, operation } = entityDeclaration();
    const factKeyEntryId = createVocabularyCatalogV1([]).entries.find((entry) => entry.canonicalName === "identity.name")!.entryId;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId });
    const delta = accepted([operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId, factSlotId, before: { state: "UNKNOWN" },
      after: { state: "VALUE", value: { valueType: "STRING", value: "A|B`C\n雪" } }, evidenceIds: ["ev-0001"],
    }], prior);
    const priorBytes = canonicalJson(prior);
    const deltaBytes = canonicalJson(delta);
    const result = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: delta });
    expect(canonicalJson(prior)).toBe(priorBytes);
    expect(canonicalJson(delta)).toBe(deltaBytes);
    expect(result.throughChapter).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.facts).toMatchObject([{ factSlotId, assertion: { state: "VALUE" }, validFromChapter: 1, lastChangedChapter: 1 }]);
    expect(result.lineage).toMatchObject({ kind: "CHAPTER_DELTA", deltaId: delta.deltaId });
  });

  it("stores explicit ABSENT but RETRACT returns the slot to structural UNKNOWN", () => {
    const prior = predecessor();
    const { entityId, operation } = entityDeclaration();
    const factKeyEntryId = createVocabularyCatalogV1([]).entries.find((entry) => entry.canonicalName === "state.status")!.entryId;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId });
    const firstDelta = accepted([operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    const first = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: firstDelta });
    expect(first.facts).toMatchObject([{ factSlotId, assertion: { state: "ABSENT" } }]);
    const secondDelta = accepted([{
      kind: "RETRACT_FACT", operationId: "op-0001", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId, factSlotId, before: { state: "ABSENT" }, after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    const second = reduceStructuredTruthV1({ predecessor: first, acceptedDelta: secondDelta });
    expect(second.facts).toEqual([]);
  });

  it("is byte-replayable from the same predecessor and rejects applying to the successor", () => {
    const prior = predecessor();
    const delta = accepted([entityDeclaration().operation], prior);
    const left = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: delta });
    const right = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: delta });
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(() => reduceStructuredTruthV1({ predecessor: left, acceptedDelta: delta })).toThrow(/predecessor|chapter|stale/i);
  });

  it("fails atomically on a stale before-value", () => {
    const baseline = predecessor();
    const { entityId, operation } = entityDeclaration();
    const factKeyEntryId = createVocabularyCatalogV1([]).entries.find((entry) => entry.canonicalName === "state.status")!.entryId;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId });
    const prior = reduceStructuredTruthV1({ predecessor: baseline, acceptedDelta: accepted([operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], baseline) });
    const delta = accepted([{
      kind: "SET_FACT", operationId: "op-0001", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId, factSlotId, before: { state: "VALUE", value: { valueType: "STRING", value: "active" } },
      after: { state: "VALUE", value: { valueType: "STRING", value: "inactive" } }, evidenceIds: ["ev-0001"],
    }], prior, 2);
    const priorBytes = canonicalJson(prior);
    expect(() => reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: delta })).toThrow(/before|UNKNOWN/i);
    expect(canonicalJson(prior)).toBe(priorBytes);
  });

  it("disconnects output references and never freezes either input graph", () => {
    const prior = predecessor();
    const delta = accepted([entityDeclaration().operation], prior);
    const priorVocabularyFrozenBefore = Object.isFrozen(prior.vocabulary);
    const result = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: delta });
    expect(Object.isFrozen(prior)).toBe(false);
    expect(Object.isFrozen(prior.vocabulary)).toBe(priorVocabularyFrozenBefore);
    expect(Object.isFrozen(delta)).toBe(false);
    expect(result.vocabulary).not.toBe(prior.vocabulary);
    expect(result.vocabulary.entries[0]).not.toBe(prior.vocabulary.entries[0]);
    expect(result.entities[0]).not.toBe(delta.delta.operations[0]?.after);
  });

  it("rejects a self-consistent but non-closed accepted delta before application", () => {
    const prior = predecessor();
    const valid = accepted([entityDeclaration().operation], prior);
    const malformedBody = { ...valid.delta, extra: true };
    const malformed = { schemaVersion: "1.0" as const, deltaId: canonicalSha256(malformedBody), delta: malformedBody } as unknown as AcceptedChapterDeltaV1;
    expect(() => reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: malformed })).toThrow(/unknown|closed|field/i);

    const wrongCandidateEvidence = structuredClone(valid) as any;
    wrongCandidateEvidence.delta.evidence[0].candidateSha256 = "f".repeat(64);
    wrongCandidateEvidence.deltaId = canonicalSha256(wrongCandidateEvidence.delta);
    expect(() => validateAcceptedChapterDeltaV1(wrongCandidateEvidence, prior)).toThrow(/candidate|evidence|binding/i);

    const malformedPredecessorEvidence = structuredClone(valid) as any;
    malformedPredecessorEvidence.delta.evidence[0] = {
      kind: "PREDECESSOR_TRUTH_RECORD", evidenceId: "ev-0001",
      recordRef: { nodeKind: "MODEL_CHOSEN", nodeId: "f".repeat(64) },
      recordSha256: "e".repeat(64), predecessorTruthSha256: malformedPredecessorEvidence.delta.predecessorTruthSha256,
    };
    malformedPredecessorEvidence.deltaId = canonicalSha256(malformedPredecessorEvidence.delta);
    expect(() => validateAcceptedChapterDeltaV1(malformedPredecessorEvidence, prior)).toThrow(/recordRef|node|kind/i);

    const invalidRetraction = accepted([{
      kind: "RETRACT_FACT", operationId: "op-0001", subject: { nodeKind: "ENTITY", nodeId: "a".repeat(64) },
      factKeyEntryId: "b".repeat(64), factSlotId: "c".repeat(64), before: { state: "ABSENT" },
      after: { state: "ABSENT" } as never, evidenceIds: ["ev-0001"],
    }]);
    expect(() => validateAcceptedChapterDeltaV1(invalidRetraction, prior)).toThrow(/RETRACT|UNKNOWN|transition/i);

    const { entityId, operation } = entityDeclaration();
    const status = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId: status.entryId });
    const unresolvedEvidence = structuredClone(accepted([operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" },
      after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], prior)) as any;
    unresolvedEvidence.delta.evidence.push({
      kind: "PREDECESSOR_TRUTH_RECORD", evidenceId: "ev-0002", recordRef: { nodeKind: "ENTITY", nodeId: entityId },
      recordSha256: "f".repeat(64), predecessorTruthSha256: unresolvedEvidence.delta.predecessorTruthSha256,
    });
    unresolvedEvidence.delta.operations[1].evidenceIds = ["ev-0001", "ev-0002"];
    unresolvedEvidence.deltaId = canonicalSha256(unresolvedEvidence.delta);
    expect(() => reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: unresolvedEvidence })).toThrow(/predecessor evidence|resolve|record/i);
  });

  it("rejects duplicate targets, SET no-ops, and forward higher-order references in accepted authority", () => {
    const prior = predecessor();
    const ada = entityDeclaration();
    const status = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: ada.entityId, factKeyEntryId: status.entryId });
    const duplicateTarget = accepted([ada.operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_FACT", operationId: "op-0003", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "ABSENT" },
      after: { state: "VALUE", value: { valueType: "STRING", value: "active" } }, evidenceIds: ["ev-0001"],
    }], prior);
    expect(() => validateAcceptedChapterDeltaV1(duplicateTarget, prior)).toThrow(/duplicate.*FactSlot|target/i);

    const stateWithFact = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: accepted([ada.operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], prior) });
    const noOp = accepted([{
      kind: "SET_FACT", operationId: "op-0001", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "ABSENT" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], stateWithFact, 2);
    expect(() => validateAcceptedChapterDeltaV1(noOp, stateWithFact)).toThrow(/no-op|before.*after/i);

    const futureRelationId = "1".repeat(64);
    const forwardReference = accepted([{
      kind: "SET_RELATION", operationId: "op-0001", relationPredicateEntryId: A, relationId: "2".repeat(64), directionality: "DIRECTED",
      subject: { nodeKind: "RELATION", nodeId: futureRelationId }, object: { nodeKind: "RELATION", nodeId: futureRelationId },
      before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION", operationId: "op-0002", relationPredicateEntryId: A, relationId: futureRelationId, directionality: "DIRECTED",
      subject: { nodeKind: "ENTITY", nodeId: A }, object: { nodeKind: "ENTITY", nodeId: B },
      before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    expect(() => validateAcceptedChapterDeltaV1(forwardReference, prior)).toThrow(/future|earlier|resolve|reference/i);
  });

  it("verifies current and carried record provenance against the accepted delta and predecessor", () => {
    const prior = predecessor();
    const ada = entityDeclaration();
    const status = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: ada.entityId, factKeyEntryId: status.entryId });
    const firstDelta = accepted([ada.operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    const first = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: firstDelta });
    expect(validateChapterDeltaTruthAuthorityV1({ predecessor: prior, acceptedDelta: firstDelta, truth: first })).toEqual(first);

    const wrongCurrentSource = structuredClone(first) as any;
    wrongCurrentSource.facts[0].source.operationId = "op-0001";
    expect(() => validateChapterDeltaTruthAuthorityV1({ predecessor: prior, acceptedDelta: firstDelta, truth: wrongCurrentSource })).toThrow(/operation|source|provenance|authority/i);

    const beaId = deriveChapterDeltaEntityId({
      bookId: "book-1", candidateSha256: A, declarationOperationId: "op-0001", entityKind: "story.character", identityKey: "bea",
    });
    const secondDelta = accepted([{
      kind: "DECLARE_ENTITY", operationId: "op-0001", before: { state: "ABSENT" }, after: {
        state: "PRESENT", definition: { definitionType: "NARRATIVE_ENTITY", entityKind: "story.character", identityKey: "bea", canonicalName: "Bea", aliases: [] },
      }, declaredEntityId: beaId, evidenceIds: ["ev-0001"],
    }], first, 2);
    const second = reduceStructuredTruthV1({ predecessor: first, acceptedDelta: secondDelta });
    expect(validateChapterDeltaTruthAuthorityV1({ predecessor: first, acceptedDelta: secondDelta, truth: second })).toEqual(second);
    const forgedHistory = structuredClone(second) as any;
    forgedHistory.facts[0].source.evidenceIds = ["ev-0002"];
    expect(() => validateChapterDeltaTruthAuthorityV1({ predecessor: first, acceptedDelta: secondDelta, truth: forgedHistory })).toThrow(/predecessor|historical|source|authority/i);
  });

  it("applies custom and higher-order relations, rejects dependent orphaning atomically, then retracts the closure", () => {
    const prior = predecessor();
    const ada = entityDeclaration();
    const beaId = deriveChapterDeltaEntityId({
      bookId: "book-1", candidateSha256: A, declarationOperationId: "op-0002",
      entityKind: "story.character", identityKey: "bea",
    });
    const beaDeclaration = {
      kind: "DECLARE_ENTITY" as const,
      operationId: "op-0002",
      before: { state: "ABSENT" as const },
      after: {
        state: "PRESENT" as const,
        definition: {
          definitionType: "NARRATIVE_ENTITY" as const,
          entityKind: "story.character" as const,
          identityKey: "bea",
          canonicalName: "Bea",
          aliases: [] as string[],
        },
      },
      declaredEntityId: beaId,
      evidenceIds: ["ev-0001"],
    };
    const mentorDefinition = {
      definitionType: "VOCABULARY_RELATION_PREDICATE" as const,
      metaKind: "system.vocabulary.relation-predicate" as const,
      canonicalName: "custom.relationship.mentors" as const,
      semanticDefinition: "The subject mentors the object.",
      subjectObjectContract: { schemaVersion: "1.0" as const, subjectKinds: ["ENTITY" as const], objectKinds: ["ENTITY" as const], allowReflexive: false },
      directionality: "DIRECTED" as const,
    };
    const mentorEntryId = deriveCustomVocabularyEntryId({ bookId: "book-1", definition: mentorDefinition });
    const mentorDeclaration = {
      kind: "DECLARE_ENTITY" as const,
      operationId: "op-0003",
      before: { state: "ABSENT" as const },
      after: { state: "PRESENT" as const, definition: mentorDefinition },
      declaredEntryId: mentorEntryId,
      evidenceIds: ["ev-0001"],
    };
    const mentor = deriveRelationIdentity({
      bookId: "book-1",
      relationPredicateEntryId: mentorEntryId,
      directionality: "DIRECTED",
      subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      object: { nodeKind: "ENTITY", nodeId: beaId },
    });
    const knowsEntry = prior.vocabulary.entries.find((entry) => entry.canonicalName === "knowledge.knows")!;
    if (knowsEntry.entryKind !== "RELATION_PREDICATE") throw new Error("bad knowledge.knows fixture");
    const higherOrder = deriveRelationIdentity({
      bookId: "book-1",
      relationPredicateEntryId: knowsEntry.entryId,
      directionality: knowsEntry.directionality,
      subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      object: { nodeKind: "RELATION", nodeId: mentor.relationId },
    });
    const firstDelta = accepted([ada.operation, beaDeclaration, mentorDeclaration, {
      kind: "SET_RELATION", operationId: "op-0004", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION", operationId: "op-0005", subject: higherOrder.subject,
      relationPredicateEntryId: knowsEntry.entryId, relationId: higherOrder.relationId, directionality: knowsEntry.directionality,
      object: higherOrder.object, before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    const first = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: firstDelta });
    expect(first.vocabulary.entries).toContainEqual(expect.objectContaining({ entryId: mentorEntryId, canonicalName: "custom.relationship.mentors" }));
    expect(first.relations.map((relation) => relation.relationId)).toEqual([mentor.relationId, higherOrder.relationId].sort());

    const relationNoOp = accepted([{
      kind: "SET_RELATION", operationId: "op-0001", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "PRESENT" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    expect(() => validateAcceptedChapterDeltaV1(relationNoOp, first)).toThrow(/SET_RELATION|no-op|before.*after/i);

    const duplicateRelationTarget = accepted([{
      kind: "SET_RELATION", operationId: "op-0001", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "PRESENT" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION", operationId: "op-0002", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "ABSENT" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    expect(() => validateAcceptedChapterDeltaV1(duplicateRelationTarget, first)).toThrow(/duplicate.*Relation|target/i);

    const orphaningDelta = accepted([{
      kind: "RETRACT_RELATION", operationId: "op-0001", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "PRESENT" }, after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    const firstBytes = canonicalJson(first);
    expect(() => validateAcceptedChapterDeltaV1(orphaningDelta, first)).toThrow(/closure|dangling|surviving|reference/i);
    expect(() => reduceStructuredTruthV1({ predecessor: first, acceptedDelta: orphaningDelta })).toThrow(/reference|exist|dangling/i);
    expect(canonicalJson(first)).toBe(firstBytes);

    const closureRetraction = accepted([{
      kind: "RETRACT_RELATION", operationId: "op-0001", subject: higherOrder.subject,
      relationPredicateEntryId: knowsEntry.entryId, relationId: higherOrder.relationId, directionality: knowsEntry.directionality,
      object: higherOrder.object, before: { state: "PRESENT" }, after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "RETRACT_RELATION", operationId: "op-0002", subject: mentor.subject,
      relationPredicateEntryId: mentorEntryId, relationId: mentor.relationId, directionality: "DIRECTED",
      object: mentor.object, before: { state: "PRESENT" }, after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    expect(validateAcceptedChapterDeltaV1(closureRetraction, first)).toEqual(closureRetraction);
    expect(reduceStructuredTruthV1({ predecessor: first, acceptedDelta: closureRetraction }).relations).toEqual([]);
  });

  it("rejects accepted preflight when a new surviving relation loses a predecessor fact endpoint", () => {
    const prior = predecessor();
    const ada = entityDeclaration();
    const status = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: ada.entityId, factKeyEntryId: status.entryId });
    const first = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: accepted([ada.operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" }, after: { state: "ABSENT" }, evidenceIds: ["ev-0001"],
    }], prior) });
    const knows = first.vocabulary.entries.find((entry) => entry.canonicalName === "knowledge.knows")!;
    if (knows.entryKind !== "RELATION_PREDICATE") throw new Error("bad knowledge.knows fixture");
    const relation = deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: knows.entryId, directionality: knows.directionality,
      subject: { nodeKind: "ENTITY", nodeId: ada.entityId }, object: { nodeKind: "FACT_SLOT", nodeId: factSlotId },
    });
    const losesEndpoint = accepted([{
      kind: "SET_RELATION", operationId: "op-0001", subject: relation.subject,
      relationPredicateEntryId: knows.entryId, relationId: relation.relationId, directionality: knows.directionality,
      object: relation.object, before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }, {
      kind: "RETRACT_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "ABSENT" }, after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001"],
    }], first, 2);
    expect(() => validateAcceptedChapterDeltaV1(losesEndpoint, first)).toThrow(/closure|dangling|surviving|reference/i);
  });

  it("rejects relation endpoint-contract and reflexivity violations atomically", () => {
    const prior = predecessor();
    const ada = entityDeclaration();
    const relatedTo = prior.vocabulary.entries.find((entry) => entry.canonicalName === "relationship.related-to")!;
    if (relatedTo.entryKind !== "RELATION_PREDICATE") throw new Error("bad relationship.related-to fixture");
    const reflexive = deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: relatedTo.entryId, directionality: relatedTo.directionality,
      subject: { nodeKind: "ENTITY", nodeId: ada.entityId }, object: { nodeKind: "ENTITY", nodeId: ada.entityId },
    });
    const reflexiveDelta = accepted([ada.operation, {
      kind: "SET_RELATION", operationId: "op-0002", subject: reflexive.subject,
      relationPredicateEntryId: relatedTo.entryId, relationId: reflexive.relationId, directionality: relatedTo.directionality,
      object: reflexive.object, before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    const priorBytes = canonicalJson(prior);
    expect(() => reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: reflexiveDelta })).toThrow(/endpoint|reflex/i);
    expect(canonicalJson(prior)).toBe(priorBytes);

    const knows = prior.vocabulary.entries.find((entry) => entry.canonicalName === "knowledge.knows")!;
    if (knows.entryKind !== "RELATION_PREDICATE") throw new Error("bad knowledge.knows fixture");
    const status = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    if (status.entryKind !== "FACT_KEY") throw new Error("bad state.status fixture");
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: ada.entityId, factKeyEntryId: status.entryId });
    const invalidEndpoint = deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: knows.entryId, directionality: knows.directionality,
      subject: { nodeKind: "FACT_SLOT", nodeId: factSlotId }, object: { nodeKind: "ENTITY", nodeId: ada.entityId },
    });
    const invalidEndpointDelta = accepted([ada.operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: ada.entityId },
      factKeyEntryId: status.entryId, factSlotId, before: { state: "UNKNOWN" },
      after: { state: "VALUE", value: { valueType: "STRING", value: "active" } }, evidenceIds: ["ev-0001"],
    }, {
      kind: "SET_RELATION", operationId: "op-0003", subject: invalidEndpoint.subject,
      relationPredicateEntryId: knows.entryId, relationId: invalidEndpoint.relationId, directionality: knows.directionality,
      object: invalidEndpoint.object, before: { state: "UNKNOWN" }, after: { state: "PRESENT" }, evidenceIds: ["ev-0001"],
    }], prior);
    expect(() => reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: invalidEndpointDelta })).toThrow(/endpoint|contract/i);
  });

  it("rejects wrong typed fact refs, out-of-range persisted ordinals, and lineage-source drift", () => {
    const prior = predecessor();
    const { entityId, operation } = entityDeclaration();
    const factKey = prior.vocabulary.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId: factKey.entryId });
    const result = reduceStructuredTruthV1({ predecessor: prior, acceptedDelta: accepted([operation, {
      kind: "SET_FACT", operationId: "op-0002", subject: { nodeKind: "ENTITY", nodeId: entityId },
      factKeyEntryId: factKey.entryId, factSlotId, before: { state: "UNKNOWN" },
      after: { state: "VALUE", value: { valueType: "STRING", value: "active" } }, evidenceIds: ["ev-0001"],
    }], prior) });

    const wrongNodeKind = structuredClone(result) as any;
    wrongNodeKind.facts[0].subject.nodeKind = "FACT_SLOT";
    expect(() => validateStructuredTruthV1(wrongNodeKind)).toThrow(/fact subject|ENTITY|typed/i);

    const outOfRange = structuredClone(result) as any;
    outOfRange.facts[0].source.operationId = "op-0257";
    outOfRange.facts[0].source.evidenceIds = ["ev-0513"];
    expect(() => validateStructuredTruthV1(outOfRange)).toThrow(/0256|0512|operation|evidence/i);

    const lineageDrift = structuredClone(result) as any;
    lineageDrift.facts[0].source.candidateSha256 = "f".repeat(64);
    expect(() => validateStructuredTruthV1(lineageDrift)).toThrow(/lineage|source|candidate|authority/i);
  });
});
