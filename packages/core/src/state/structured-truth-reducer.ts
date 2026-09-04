import type { AcceptedChapterDeltaV1, BoundOperationV1 } from "../models/chapter-delta.js";
import type {
  FactAssertionRecordV1,
  NarrativeEntityRecordV1,
  RelationAssertionRecordV1,
  StructuredTruthV1,
  TruthRecordSourceV1,
  VocabularyEntryV1,
} from "../models/structured-truth.js";
import { canonicalJson, canonicalSha256, compareUnsignedUtf8, deepFreeze } from "./canonical-json.js";
import {
  deriveChapterDeltaEntityId,
  deriveCustomVocabularyEntryId,
  deriveFactSlotId,
  deriveRelationIdentity,
  deriveSemanticMetadataSha256,
} from "./truth-identities.js";
import { createVocabularyCatalogV1, validateVocabularyCatalogV1 } from "./truth-vocabulary.js";
import { validateStructuredTruthV1 } from "../models/structured-truth.js";
import { validateAcceptedChapterDeltaV1 } from "./chapter-delta-admission.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function source(delta: AcceptedChapterDeltaV1, operation: BoundOperationV1): TruthRecordSourceV1 {
  return {
    sourceKind: "CHAPTER_DELTA",
    candidateSha256: delta.delta.candidateSha256,
    deltaId: delta.deltaId,
    operationId: operation.operationId,
    evidenceIds: operation.evidenceIds,
  };
}

function assertNodeExists(
  ref: { readonly nodeKind: "ENTITY" | "FACT_SLOT" | "RELATION"; readonly nodeId: string },
  entities: ReadonlyMap<string, NarrativeEntityRecordV1>,
  facts: ReadonlyMap<string, FactAssertionRecordV1>,
  relations: ReadonlyMap<string, RelationAssertionRecordV1>,
): void {
  const exists = ref.nodeKind === "ENTITY" ? entities.has(ref.nodeId)
    : ref.nodeKind === "FACT_SLOT" ? facts.has(ref.nodeId)
      : relations.has(ref.nodeId);
  if (!exists) throw new Error(`Bound ${ref.nodeKind} reference does not exist`);
}

export function reduceStructuredTruthV1(input: {
  readonly predecessor: StructuredTruthV1;
  readonly acceptedDelta: AcceptedChapterDeltaV1;
}): StructuredTruthV1 {
  const predecessor = validateStructuredTruthV1(structuredClone(input.predecessor));
  validateVocabularyCatalogV1(predecessor.vocabulary);
  const accepted = validateAcceptedChapterDeltaV1(structuredClone(input.acceptedDelta), predecessor);
  const delta = accepted.delta;
  if (accepted.schemaVersion !== "1.0" || delta.schemaVersion !== "1.0" || accepted.deltaId !== canonicalSha256(delta)) {
    throw new Error("Accepted delta identity mismatch");
  }
  if (delta.bookId !== predecessor.bookId
    || delta.chapterNumber !== predecessor.throughChapter + 1
    || delta.predecessorTruthSha256 !== canonicalSha256(predecessor)
    || delta.predecessorVocabularyCatalogSha256 !== canonicalSha256(predecessor.vocabulary)) {
    throw new Error("Accepted delta has stale or mismatched predecessor authority");
  }
  for (const evidence of delta.evidence) {
    if (evidence.kind !== "PREDECESSOR_TRUTH_RECORD") continue;
    const recordValue = evidence.recordRef.nodeKind === "ENTITY"
      ? predecessor.entities.find((record) => record.entityId === evidence.recordRef.nodeId)
      : evidence.recordRef.nodeKind === "FACT_SLOT"
        ? predecessor.facts.find((record) => record.factSlotId === evidence.recordRef.nodeId)
        : predecessor.relations.find((record) => record.relationId === evidence.recordRef.nodeId);
    if (!recordValue || canonicalSha256(recordValue) !== evidence.recordSha256) throw new Error("Accepted delta predecessor evidence does not resolve to the exact predecessor record");
  }

  const entities = new Map(predecessor.entities.map((item) => [item.entityId, item]));
  const facts = new Map(predecessor.facts.map((item) => [item.factSlotId, item]));
  const relations = new Map(predecessor.relations.map((item) => [item.relationId, item]));
  const entries = new Map(predecessor.vocabulary.entries.map((item) => [item.entryId, item]));
  const entityTuples = new Set(predecessor.entities.map((item) => `${item.entityKind}\u0000${item.identityKey}`));
  const vocabularyNames = new Set(predecessor.vocabulary.entries.map((item) => item.canonicalName));

  for (const operation of delta.operations) {
    if (operation.kind === "DECLARE_ENTITY") {
      const definition = operation.after.definition;
      if (definition.definitionType === "NARRATIVE_ENTITY") {
        if (!("declaredEntityId" in operation)) throw new Error("Narrative declaration is missing declaredEntityId");
        const expectedId = deriveChapterDeltaEntityId({
          bookId: delta.bookId,
          candidateSha256: delta.candidateSha256,
          declarationOperationId: operation.operationId,
          entityKind: definition.entityKind,
          identityKey: definition.identityKey,
        });
        if (operation.declaredEntityId !== expectedId || entities.has(expectedId)) throw new Error("Declared EntityId is invalid or duplicated");
        const tuple = `${definition.entityKind}\u0000${definition.identityKey}`;
        if (entityTuples.has(tuple)) throw new Error("Entity declaration tuple is duplicated");
        entityTuples.add(tuple);
        entities.set(expectedId, {
          entityId: expectedId,
          entityKind: definition.entityKind,
          identityKey: definition.identityKey,
          canonicalName: definition.canonicalName,
          aliases: definition.aliases,
          declaredAtChapter: delta.chapterNumber,
          declarationSource: {
            origin: "CHAPTER_DELTA",
            bookId: delta.bookId,
            candidateSha256: delta.candidateSha256,
            declarationOperationId: operation.operationId,
          },
        });
      } else {
        if (!("declaredEntryId" in operation)) throw new Error("Vocabulary declaration is missing declaredEntryId");
        const expectedId = deriveCustomVocabularyEntryId({ bookId: delta.bookId, definition });
        if (operation.declaredEntryId !== expectedId || entries.has(expectedId) || vocabularyNames.has(definition.canonicalName)) {
          throw new Error("Declared vocabulary EntryId, name, or identity is invalid or duplicated");
        }
        vocabularyNames.add(definition.canonicalName);
        const definitionSource = source(accepted, operation);
        const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
        const entry: VocabularyEntryV1 = definition.definitionType === "VOCABULARY_FACT_KEY"
          ? {
            entryId: expectedId, scope: "BOOK", entryKind: "FACT_KEY", bookId: delta.bookId,
            vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName,
            semanticDefinition: definition.semanticDefinition, semanticMetadataSha256,
            valueContract: definition.valueContract, definitionSource,
          }
          : {
            entryId: expectedId, scope: "BOOK", entryKind: "RELATION_PREDICATE", bookId: delta.bookId,
            vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName,
            semanticDefinition: definition.semanticDefinition, semanticMetadataSha256,
            subjectObjectContract: definition.subjectObjectContract, directionality: definition.directionality,
            definitionSource,
          };
        entries.set(expectedId, entry);
      }
      continue;
    }

    if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
      assertNodeExists(operation.subject, entities, facts, relations);
      const entry = entries.get(operation.factKeyEntryId);
      if (!entry || entry.entryKind !== "FACT_KEY") throw new Error("Bound fact-key entry does not exist");
      const expectedId = deriveFactSlotId({ bookId: delta.bookId, subjectEntityId: operation.subject.nodeId, factKeyEntryId: operation.factKeyEntryId });
      if (operation.factSlotId !== expectedId) throw new Error("Bound FactSlotId mismatch");
      const current = facts.get(expectedId)?.assertion ?? { state: "UNKNOWN" as const };
      if (!same(current, operation.before)) throw new Error(`Fact before-value mismatch; current state is ${current.state}`);
      if (operation.kind === "SET_FACT") {
        facts.set(expectedId, {
          factSlotId: expectedId,
          subject: operation.subject,
          factKeyEntryId: operation.factKeyEntryId,
          assertion: operation.after,
          validFromChapter: delta.chapterNumber,
          lastChangedChapter: delta.chapterNumber,
          source: source(accepted, operation),
        });
      } else {
        facts.delete(expectedId);
      }
      continue;
    }

    const entry = entries.get(operation.relationPredicateEntryId);
    if (!entry || entry.entryKind !== "RELATION_PREDICATE") throw new Error("Bound relation-predicate entry does not exist");
    const identity = deriveRelationIdentity({
      bookId: delta.bookId,
      relationPredicateEntryId: operation.relationPredicateEntryId,
      directionality: entry.directionality,
      subject: operation.subject,
      object: operation.object,
    });
    if (operation.relationId !== identity.relationId || operation.directionality !== entry.directionality
      || !same(operation.subject, identity.subject) || !same(operation.object, identity.object)) {
      throw new Error("Bound relation identity mismatch");
    }
    const current = relations.get(identity.relationId)?.assertion ?? { state: "UNKNOWN" as const };
    if (!same(current, operation.before)) throw new Error(`Relation before-value mismatch; current state is ${current.state}`);
    if (operation.kind === "SET_RELATION") {
      relations.set(identity.relationId, {
        relationId: identity.relationId,
        predicateEntryId: operation.relationPredicateEntryId,
        directionality: operation.directionality,
        subject: operation.subject,
        object: operation.object,
        assertion: operation.after,
        validFromChapter: delta.chapterNumber,
        lastChangedChapter: delta.chapterNumber,
        source: source(accepted, operation),
      });
    } else {
      relations.delete(identity.relationId);
    }
  }

  for (const relation of relations.values()) {
    assertNodeExists(relation.subject, entities, facts, relations);
    assertNodeExists(relation.object, entities, facts, relations);
  }

  const customEntries = [...entries.values()].filter((entry) => entry.scope === "BOOK");
  const vocabulary = createVocabularyCatalogV1(customEntries);
  const result: StructuredTruthV1 = {
    schemaVersion: "1.0",
    kind: "STRUCTURED_TRUTH",
    bookId: predecessor.bookId,
    throughChapter: delta.chapterNumber,
    lineage: {
      kind: "CHAPTER_DELTA",
      predecessorCommitSha256: delta.predecessorCommitSha256,
      predecessorTruthSha256: delta.predecessorTruthSha256,
      predecessorVocabularyCatalogSha256: delta.predecessorVocabularyCatalogSha256,
      candidateSha256: delta.candidateSha256,
      deltaId: accepted.deltaId,
      acceptedDeltaArtifactSha256: canonicalSha256(accepted),
    },
    vocabulary,
    entities: [...entities.values()].sort((a, b) => compareUnsignedUtf8(a.entityId, b.entityId)),
    facts: [...facts.values()].sort((a, b) => compareUnsignedUtf8(a.factSlotId, b.factSlotId)),
    relations: [...relations.values()].sort((a, b) => compareUnsignedUtf8(a.relationId, b.relationId)),
    provenance: {
      schemaVersion: "1.0", producerKind: "CHAPTER_DELTA", producerId: "inkos.structured-truth.reducer.v1",
      producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
    },
  };
  validateStructuredTruthV1(result);
  validateVocabularyCatalogV1(result.vocabulary);
  validateChapterDeltaTruthAuthorityV1({ predecessor, acceptedDelta: accepted, truth: result });
  return deepFreeze(result);
}

export function validateChapterDeltaTruthAuthorityV1(input: {
  readonly predecessor: StructuredTruthV1;
  readonly acceptedDelta: AcceptedChapterDeltaV1;
  readonly truth: StructuredTruthV1;
}): StructuredTruthV1 {
  const predecessor = validateStructuredTruthV1(structuredClone(input.predecessor));
  const accepted = validateAcceptedChapterDeltaV1(structuredClone(input.acceptedDelta), predecessor);
  const truth = validateStructuredTruthV1(input.truth);
  const delta = accepted.delta;
  const entities = new Map(predecessor.entities.map((record) => [record.entityId, record]));
  const entries = new Map(predecessor.vocabulary.entries.map((entry) => [entry.entryId, entry]));
  const facts = new Map(predecessor.facts.map((record) => [record.factSlotId, record]));
  const relations = new Map(predecessor.relations.map((record) => [record.relationId, record]));

  for (const operation of delta.operations) {
    if (operation.kind === "DECLARE_ENTITY") {
      const definition = operation.after.definition;
      if (definition.definitionType === "NARRATIVE_ENTITY") {
        if (!("declaredEntityId" in operation)) throw new Error("Chapter-delta entity declaration authority is missing its target");
        const entityId = deriveChapterDeltaEntityId({
          bookId: delta.bookId, candidateSha256: delta.candidateSha256, declarationOperationId: operation.operationId,
          entityKind: definition.entityKind, identityKey: definition.identityKey,
        });
        if (operation.declaredEntityId !== entityId) throw new Error("Chapter-delta declaration target authority mismatch");
        entities.set(entityId, {
          entityId, entityKind: definition.entityKind, identityKey: definition.identityKey,
          canonicalName: definition.canonicalName, aliases: definition.aliases, declaredAtChapter: delta.chapterNumber,
          declarationSource: { origin: "CHAPTER_DELTA", bookId: delta.bookId, candidateSha256: delta.candidateSha256, declarationOperationId: operation.operationId },
        });
      } else {
        if (!("declaredEntryId" in operation)) throw new Error("Chapter-delta vocabulary declaration authority is missing its target");
        const entryId = deriveCustomVocabularyEntryId({ bookId: delta.bookId, definition });
        if (operation.declaredEntryId !== entryId) throw new Error("Chapter-delta vocabulary declaration target authority mismatch");
        const definitionSource = source(accepted, operation);
        const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
        const entry: VocabularyEntryV1 = definition.definitionType === "VOCABULARY_FACT_KEY"
          ? {
            entryId, scope: "BOOK", entryKind: "FACT_KEY", bookId: delta.bookId, vocabularySchemaVersion: "1.0",
            canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition,
            semanticMetadataSha256, valueContract: definition.valueContract, definitionSource,
          }
          : {
            entryId, scope: "BOOK", entryKind: "RELATION_PREDICATE", bookId: delta.bookId, vocabularySchemaVersion: "1.0",
            canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition,
            semanticMetadataSha256, subjectObjectContract: definition.subjectObjectContract,
            directionality: definition.directionality, definitionSource,
          };
        entries.set(entryId, entry);
      }
      continue;
    }
    if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
      const factSlotId = deriveFactSlotId({ bookId: delta.bookId, subjectEntityId: operation.subject.nodeId, factKeyEntryId: operation.factKeyEntryId });
      if (operation.factSlotId !== factSlotId) throw new Error("Chapter-delta fact target authority mismatch");
      if (operation.kind === "SET_FACT") {
        facts.set(factSlotId, {
          factSlotId, subject: operation.subject, factKeyEntryId: operation.factKeyEntryId, assertion: operation.after,
          validFromChapter: delta.chapterNumber, lastChangedChapter: delta.chapterNumber, source: source(accepted, operation),
        });
      } else facts.delete(factSlotId);
      continue;
    }
    const relationIdentity = deriveRelationIdentity({
      bookId: delta.bookId, relationPredicateEntryId: operation.relationPredicateEntryId,
      directionality: operation.directionality, subject: operation.subject, object: operation.object,
    });
    if (operation.relationId !== relationIdentity.relationId || !same(operation.subject, relationIdentity.subject) || !same(operation.object, relationIdentity.object)) throw new Error("Chapter-delta relation target authority mismatch");
    if (operation.kind === "SET_RELATION") {
      relations.set(operation.relationId, {
        relationId: operation.relationId, predicateEntryId: operation.relationPredicateEntryId,
        directionality: operation.directionality, subject: operation.subject, object: operation.object,
        assertion: operation.after, validFromChapter: delta.chapterNumber, lastChangedChapter: delta.chapterNumber,
        source: source(accepted, operation),
      });
    } else relations.delete(operation.relationId);
  }

  const expected: StructuredTruthV1 = {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: predecessor.bookId, throughChapter: delta.chapterNumber,
    lineage: {
      kind: "CHAPTER_DELTA", predecessorCommitSha256: delta.predecessorCommitSha256,
      predecessorTruthSha256: delta.predecessorTruthSha256,
      predecessorVocabularyCatalogSha256: delta.predecessorVocabularyCatalogSha256,
      candidateSha256: delta.candidateSha256, deltaId: accepted.deltaId,
      acceptedDeltaArtifactSha256: canonicalSha256(accepted),
    },
    vocabulary: createVocabularyCatalogV1([...entries.values()].filter((entry) => entry.scope === "BOOK")),
    entities: [...entities.values()].sort((left, right) => compareUnsignedUtf8(left.entityId, right.entityId)),
    facts: [...facts.values()].sort((left, right) => compareUnsignedUtf8(left.factSlotId, right.factSlotId)),
    relations: [...relations.values()].sort((left, right) => compareUnsignedUtf8(left.relationId, right.relationId)),
    provenance: {
      schemaVersion: "1.0", producerKind: "CHAPTER_DELTA", producerId: "inkos.structured-truth.reducer.v1",
      producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
    },
  };
  if (!same(truth, expected)) throw new Error("Structured truth record source, operation, or predecessor history authority mismatch");
  return truth;
}
