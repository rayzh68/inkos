import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ENTITY_KINDS_V1,
  assertBookLocalIdentityKey,
  assertEntityKindV1,
  assertNonEmptyNfcString,
  validateNarrativeEntityDefinitionV1,
  validateBaselineAuthorityV1,
  validateBaselineConstructionReceiptV1,
  validateStructuredTruthV1,
  type StructuredTruthV1,
} from "../models/structured-truth.js";
import { canonicalSha256, sha256Bytes } from "../state/canonical-json.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import {
  deriveBaselineEntityId,
  deriveBaselineRecordId,
  deriveCustomVocabularyEntryId,
  deriveFactSlotId,
  deriveRelationIdentity,
  deriveSemanticMetadataSha256,
} from "../state/truth-identities.js";
import type { ChapterCommit } from "../production/chapter-transaction.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function chapterCommitFor(
  sourceManifest: { bookId: string; throughChapter: number; predecessorCommitSha256: string; sourceStateTreeSha256: string; entries: readonly { path: string; sha256: string; byteLength: number }[] },
): ChapterCommit {
  return {
    schemaVersion: 1,
    kind: "CHAPTER_COMMIT",
    bookId: sourceManifest.bookId,
    chapterNumber: sourceManifest.throughChapter,
    chapterTitle: "Baseline authority",
    language: "en",
    transactionId: "tx-baseline-authority",
    productionAuthority: "test-authority",
    previousAuthoritySha256: SHA_A,
    finalBodySha256: SHA_A,
    finalLengthCount: 1,
    lengthSpec: { target: 1, softMin: 1, softMax: 1, hardMin: 1, hardMax: 1, countingMode: "en_words" },
    boundedReviewStatus: "APPROVED",
    revisionCount: 0,
    reviewEvidenceSha256: SHA_A,
    finalCandidateSha256: SHA_A,
    stateManifestSha256: SHA_A,
    snapshotManifestSha256: SHA_A,
    stateValidationSha256: SHA_A,
    stateTreeSha256: sourceManifest.sourceStateTreeSha256,
    snapshotTreeSha256: SHA_A,
    stateFiles: sourceManifest.entries.map((entry) => ({ relativePath: entry.path, sha256: entry.sha256, bytes: entry.byteLength })),
    snapshotFiles: [],
    usageSha256: SHA_A,
    providerReferencesSha256: SHA_A,
    providerReferenceCount: 0,
    createdAt: "2026-09-04T00:00:00.000Z",
    completedAt: "2026-09-04T00:00:01.000Z",
    commitSha256: sourceManifest.predecessorCommitSha256,
  };
}

function emptyBaselineTruth(): StructuredTruthV1 {
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

describe("canonical truth models", () => {
  it("accepts only the eleven built-in kinds or the locked custom syntax", () => {
    expect(BUILT_IN_ENTITY_KINDS_V1).toEqual([
      "system.chapter",
      "story.character",
      "story.place",
      "story.object",
      "story.organization",
      "story.resource",
      "narrative.hook",
      "narrative.goal",
      "narrative.commitment",
      "narrative.subplot",
      "narrative.evidence",
    ]);
    expect(assertEntityKindV1("custom.relationship.mentor-debt")).toBe("custom.relationship.mentor-debt");
    for (const invalid of [
      "story.unknown",
      "custom.A.name",
      "custom.domain.with_underscore",
      "custom.domain",
      `custom.${"a".repeat(33)}.term`,
      `custom.domain.${"a".repeat(65)}`,
    ]) {
      expect(() => assertEntityKindV1(invalid)).toThrow(/entity kind/i);
    }
  });

  it("validates rather than normalizes identity and semantic strings", () => {
    expect(assertBookLocalIdentityKey("mentor-debt")).toBe("mentor-debt");
    expect(assertNonEmptyNfcString("雪")).toBe("雪");
    for (const invalid of [" Mentor", "mentor_debt", "Mentor", "a".repeat(65)]) {
      expect(() => assertBookLocalIdentityKey(invalid)).toThrow(/identity key/i);
    }
    for (const invalid of ["", " \t\r\n", "e\u0301"]) {
      expect(() => assertNonEmptyNfcString(invalid)).toThrow(/NFC|non-empty/i);
    }
  });

  it("requires declaration aliases to be NFC, byte-unique, sorted, and different from the canonical name", () => {
    const base = {
      definitionType: "NARRATIVE_ENTITY" as const,
      entityKind: "story.character" as const,
      identityKey: "ada",
      canonicalName: "Ada",
      aliases: ["A", "B|C", "`D`", "雪"],
    };
    expect(validateNarrativeEntityDefinitionV1(base)).toEqual(base);
    expect(() => validateNarrativeEntityDefinitionV1({ ...base, aliases: ["雪", "A"] })).toThrow(/sorted/i);
    expect(() => validateNarrativeEntityDefinitionV1({ ...base, aliases: ["A", "A"] })).toThrow(/unique/i);
    expect(() => validateNarrativeEntityDefinitionV1({ ...base, aliases: ["Ada"] })).toThrow(/canonical name/i);
  });

  it("accepts an empty baseline truth but rejects producer/lineage disagreement", () => {
    expect(validateStructuredTruthV1(emptyBaselineTruth())).toEqual(emptyBaselineTruth());
    expect(() => validateStructuredTruthV1({
      ...emptyBaselineTruth(),
      provenance: {
        ...emptyBaselineTruth().provenance,
        producerKind: "CHAPTER_DELTA",
        producerId: "inkos.structured-truth.reducer.v1",
      },
    })).toThrow(/lineage|producer/i);
  });

  it("strictly validates every vocabulary catalog entry as part of the truth authority graph", () => {
    const truth = emptyBaselineTruth();
    const malformed = structuredClone(truth) as any;
    malformed.vocabulary.entries[0].extra = true;
    expect(() => validateStructuredTruthV1(malformed)).toThrow(/unknown|field|vocabulary|manifest/i);
    const unknownScope = structuredClone(truth) as any;
    unknownScope.vocabulary.entries[0].scope = "MODEL_CHOSEN";
    expect(() => validateStructuredTruthV1(unknownScope)).toThrow(/scope|vocabulary|manifest/i);
    const wrongId = structuredClone(truth) as any;
    wrongId.vocabulary.entries[0].entryId = "f".repeat(64);
    expect(() => validateStructuredTruthV1(wrongId)).toThrow(/entryId|identity|vocabulary|manifest/i);
  });

  it("rejects unknown fields, unsafe chronology, duplicates, and unsorted root arrays", () => {
    expect(() => validateStructuredTruthV1({ ...emptyBaselineTruth(), extra: true })).toThrow(/unknown field/i);
    const entity = {
      entityId: SHA_B,
      entityKind: "story.character" as const,
      identityKey: "ada",
      canonicalName: "Ada",
      aliases: [] as string[],
      declaredAtChapter: 0,
      declarationSource: {
        origin: "BASELINE" as const,
        bookId: "book-1",
        baselineSourceManifestSha256: SHA_B,
        baselineConstructionReceiptSha256: SHA_D,
        baselineRecordId: SHA_C,
      },
    };
    const fact = {
      factSlotId: SHA_C,
      subject: { nodeKind: "ENTITY" as const, nodeId: SHA_B },
      factKeyEntryId: SHA_A,
      assertion: { state: "ABSENT" as const },
      validFromChapter: 1,
      lastChangedChapter: 0,
      source: {
        sourceKind: "BASELINE" as const,
        baselineSourceManifestSha256: SHA_B,
        baselineConstructionReceiptSha256: SHA_D,
        baselineRecordId: SHA_C,
      },
    };
    expect(() => validateStructuredTruthV1({
      ...emptyBaselineTruth(),
      entities: [entity, entity],
    })).toThrow(/unique|sorted/i);
    expect(() => validateStructuredTruthV1({
      ...emptyBaselineTruth(),
      throughChapter: 1,
      entities: [entity],
      facts: [fact],
    })).toThrow(/chronology/i);
  });

  it("validates the closed baseline manifest/receipt authority graph and exact record coverage", () => {
    const bytes = new TextEncoder().encode("seed");
    const sourceManifest = {
      schemaVersion: "1.0" as const, kind: "BASELINE_SOURCE_MANIFEST" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, sourceStateTreeSha256: SHA_B,
      entries: [{ path: "current_state.md", sha256: sha256Bytes(bytes), byteLength: bytes.byteLength }],
    };
    const receipt = {
      schemaVersion: "1.0" as const, kind: "BASELINE_CONSTRUCTION_RECEIPT" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
      seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])),
      method: { kind: "DETERMINISTIC" as const, builderId: "inkos.truth-baseline.builder.v1" as const, builderVersion: "1.0" as const },
      recordBindings: [],
    };
    const truth = { ...emptyBaselineTruth(), lineage: { ...emptyBaselineTruth().lineage, baselineSourceManifestSha256: canonicalSha256(sourceManifest), baselineConstructionReceiptSha256: canonicalSha256(receipt), seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])) } };
    const chapterCommit = chapterCommitFor(sourceManifest);
    expect(validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles: { "current_state.md": bytes }, chapterCommit })).toEqual(truth);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest: { ...sourceManifest, extra: true } as never, receipt, sourceFiles: { "current_state.md": bytes }, chapterCommit })).toThrow(/unknown|field/i);
    const extraReceipt = { ...receipt, recordBindings: [{ recordKind: "ENTITY" as const, baselineRecordId: deriveBaselineRecordId({ baselineSourceManifestSha256: canonicalSha256(sourceManifest), recordKind: "ENTITY", recordIdentity: SHA_B }), entityId: SHA_B, sourceReferences: [{ path: "current_state.md", fileSha256: sha256Bytes(bytes), startUtf8: 0, endUtf8: 4, quoteSha256: sha256Bytes(bytes) }] }] };
    const extraTruth = { ...truth, lineage: { ...truth.lineage, baselineConstructionReceiptSha256: canonicalSha256(extraReceipt) } };
    expect(() => validateBaselineAuthorityV1({ truth: extraTruth, sourceManifest, receipt: extraReceipt, sourceFiles: { "current_state.md": bytes }, chapterCommit })).toThrow(/coverage|extra/i);
  });

  it("binds baseline authority to the complete verified ChapterCommit state-file authority", () => {
    const bytes = new TextEncoder().encode("seed");
    const sourceFiles = { "state/current_state.json": bytes };
    const sourceManifest = {
      schemaVersion: "1.0" as const, kind: "BASELINE_SOURCE_MANIFEST" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, sourceStateTreeSha256: SHA_B,
      entries: [{ path: "state/current_state.json", sha256: sha256Bytes(bytes), byteLength: bytes.byteLength }],
    };
    const receipt = {
      schemaVersion: "1.0" as const, kind: "BASELINE_CONSTRUCTION_RECEIPT" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
      seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])),
      method: { kind: "DETERMINISTIC" as const, builderId: "inkos.truth-baseline.builder.v1" as const, builderVersion: "1.0" as const },
      recordBindings: [],
    };
    const truth = {
      ...emptyBaselineTruth(),
      lineage: {
        ...emptyBaselineTruth().lineage,
        predecessorCommitSha256: SHA_A,
        baselineSourceManifestSha256: canonicalSha256(sourceManifest),
        baselineConstructionReceiptSha256: canonicalSha256(receipt),
        seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])),
      },
    };
    const chapterCommit = chapterCommitFor(sourceManifest);
    expect(validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit })).toEqual(truth);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, bookId: "other-book" } })).toThrow(/commit|book/i);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, chapterNumber: 1 } })).toThrow(/commit|chapter/i);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, commitSha256: SHA_D } })).toThrow(/commit|predecessor/i);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, stateTreeSha256: SHA_D } })).toThrow(/stateTree|tree/i);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, stateFiles: [] } })).toThrow(/stateFiles|complete|file/i);
    expect(() => validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: { ...chapterCommit, stateFiles: [{ ...chapterCommit.stateFiles[0]!, bytes: 5 }] } })).toThrow(/stateFiles|bytes|file/i);
    const extractorTruth = structuredClone(truth) as any;
    extractorTruth.provenance.producerId = "inkos.truth-baseline.extractor.v1";
    expect(() => validateBaselineAuthorityV1({ truth: extractorTruth, sourceManifest, receipt, sourceFiles, chapterCommit })).toThrow(/producer|method/i);
  });

  it("validates all four baseline binding branches, derived record IDs, numeric source ordering, and exact method literals", () => {
    const bytes = new TextEncoder().encode("0123456789abcdef");
    const sourceFiles = { "state/current_state.json": bytes };
    const sourceManifest = {
      schemaVersion: "1.0" as const, kind: "BASELINE_SOURCE_MANIFEST" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, sourceStateTreeSha256: SHA_B,
      entries: [{ path: "state/current_state.json", sha256: sha256Bytes(bytes), byteLength: bytes.byteLength }],
    };
    const manifestSha = canonicalSha256(sourceManifest);
    const reference = (startUtf8: number, endUtf8: number) => ({
      path: "state/current_state.json", fileSha256: sha256Bytes(bytes), startUtf8, endUtf8,
      quoteSha256: sha256Bytes(bytes.slice(startUtf8, endUtf8)),
    });
    const identities = {
      ENTITY: SHA_A,
      FACT_SLOT: SHA_B,
      RELATION: SHA_C,
      VOCABULARY_ENTRY: SHA_D,
    } as const;
    const identityField = { ENTITY: "entityId", FACT_SLOT: "factSlotId", RELATION: "relationId", VOCABULARY_ENTRY: "entryId" } as const;
    const recordBindings = (Object.keys(identities) as Array<keyof typeof identities>).map((recordKind, index) => ({
      recordKind,
      baselineRecordId: deriveBaselineRecordId({ baselineSourceManifestSha256: manifestSha, recordKind, recordIdentity: identities[recordKind] }),
      [identityField[recordKind]]: identities[recordKind],
      sourceReferences: index === 0 ? [reference(2, 3), reference(10, 11)] : [reference(index, index + 1)],
    }));
    const receipt = {
      schemaVersion: "1.0" as const, kind: "BASELINE_CONSTRUCTION_RECEIPT" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: manifestSha,
      seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])),
      method: { kind: "DETERMINISTIC" as const, builderId: "inkos.truth-baseline.builder.v1" as const, builderVersion: "1.0" as const },
      recordBindings,
    };
    expect(validateBaselineConstructionReceiptV1(receipt as never, sourceManifest, sourceFiles).recordBindings).toHaveLength(4);

    const wrongRecordId = structuredClone(receipt) as any;
    wrongRecordId.recordBindings[0].baselineRecordId = "f".repeat(64);
    expect(() => validateBaselineConstructionReceiptV1(wrongRecordId, sourceManifest, sourceFiles)).toThrow(/baselineRecordId|derived|preimage/i);

    const wrongMethod = { ...receipt, method: { ...receipt.method, builderId: "wrong" } };
    expect(() => validateBaselineConstructionReceiptV1(wrongMethod as never, sourceManifest, sourceFiles)).toThrow(/builder|method/i);
  });

  it("crosschecks every baseline record source against its exact binding and root authority", () => {
    const bytes = new TextEncoder().encode("entity vocabulary fact relation");
    const sourceFiles = { "state/current_state.json": bytes };
    const seedCatalog = createVocabularyCatalogV1([]);
    const sourceManifest = {
      schemaVersion: "1.0" as const, kind: "BASELINE_SOURCE_MANIFEST" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, sourceStateTreeSha256: SHA_B,
      entries: [{ path: "state/current_state.json", sha256: sha256Bytes(bytes), byteLength: bytes.byteLength }],
    };
    const manifestSha = canonicalSha256(sourceManifest);
    const entityId = deriveBaselineEntityId({ bookId: "book-1", baselineSourceManifestSha256: manifestSha, entityKind: "story.character", identityKey: "ada" });
    const definition = {
      definitionType: "VOCABULARY_FACT_KEY" as const, metaKind: "system.vocabulary.fact-key" as const,
      canonicalName: "custom.identity.title" as const, semanticDefinition: "The current formal title.", valueContract: { contractType: "STRING" as const },
    };
    const entryId = deriveCustomVocabularyEntryId({ bookId: "book-1", definition });
    const factKey = seedCatalog.entries.find((entry) => entry.canonicalName === "state.status")!;
    const factSlotId = deriveFactSlotId({ bookId: "book-1", subjectEntityId: entityId, factKeyEntryId: factKey.entryId });
    const predicate = seedCatalog.entries.find((entry) => entry.canonicalName === "knowledge.knows")!;
    if (predicate.entryKind !== "RELATION_PREDICATE") throw new Error("bad knowledge.knows fixture");
    const relation = deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: predicate.entryId, directionality: predicate.directionality,
      subject: { nodeKind: "ENTITY", nodeId: entityId }, object: { nodeKind: "FACT_SLOT", nodeId: factSlotId },
    });
    const identities = [
      ["ENTITY", "entityId", entityId],
      ["FACT_SLOT", "factSlotId", factSlotId],
      ["RELATION", "relationId", relation.relationId],
      ["VOCABULARY_ENTRY", "entryId", entryId],
    ] as const;
    const reference = { path: "state/current_state.json", fileSha256: sha256Bytes(bytes), startUtf8: 0, endUtf8: 6, quoteSha256: sha256Bytes(bytes.slice(0, 6)) };
    const recordBindings = identities.map(([recordKind, field, recordIdentity]) => ({
      recordKind,
      baselineRecordId: deriveBaselineRecordId({ baselineSourceManifestSha256: manifestSha, recordKind, recordIdentity }),
      [field]: recordIdentity,
      sourceReferences: [reference],
    }));
    const receipt = {
      schemaVersion: "1.0" as const, kind: "BASELINE_CONSTRUCTION_RECEIPT" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: manifestSha,
      seedVocabularyCatalogSha256: canonicalSha256(seedCatalog),
      method: { kind: "DETERMINISTIC" as const, builderId: "inkos.truth-baseline.builder.v1" as const, builderVersion: "1.0" as const },
      recordBindings,
    };
    const receiptSha = canonicalSha256(receipt);
    const bindingId = (recordKind: typeof identities[number][0]) => recordBindings.find((item) => item.recordKind === recordKind)!.baselineRecordId;
    const baselineSource = (recordKind: typeof identities[number][0]) => ({
      sourceKind: "BASELINE" as const, baselineSourceManifestSha256: manifestSha,
      baselineConstructionReceiptSha256: receiptSha, baselineRecordId: bindingId(recordKind),
    });
    const truth: StructuredTruthV1 = {
      ...emptyBaselineTruth(),
      lineage: {
        kind: "BASELINE", predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: manifestSha,
        seedVocabularyCatalogSha256: canonicalSha256(seedCatalog), baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: receiptSha,
      },
      vocabulary: createVocabularyCatalogV1([{
        entryId, scope: "BOOK", entryKind: "FACT_KEY", bookId: "book-1", vocabularySchemaVersion: "1.0",
        canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition,
        semanticMetadataSha256: deriveSemanticMetadataSha256(definition), valueContract: definition.valueContract,
        definitionSource: baselineSource("VOCABULARY_ENTRY"),
      }]),
      entities: [{
        entityId, entityKind: "story.character", identityKey: "ada", canonicalName: "Ada", aliases: [], declaredAtChapter: 0,
        declarationSource: {
          origin: "BASELINE", bookId: "book-1", baselineSourceManifestSha256: manifestSha,
          baselineConstructionReceiptSha256: receiptSha, baselineRecordId: bindingId("ENTITY"),
        },
      }],
      facts: [{
        factSlotId, subject: { nodeKind: "ENTITY", nodeId: entityId }, factKeyEntryId: factKey.entryId,
        assertion: { state: "ABSENT" }, validFromChapter: 0, lastChangedChapter: 0, source: baselineSource("FACT_SLOT"),
      }],
      relations: [{
        relationId: relation.relationId, predicateEntryId: predicate.entryId, directionality: predicate.directionality,
        subject: relation.subject, object: relation.object, assertion: { state: "PRESENT" }, validFromChapter: 0, lastChangedChapter: 0,
        source: baselineSource("RELATION"),
      }],
    };
    const chapterCommit = chapterCommitFor(sourceManifest);
    expect(validateBaselineAuthorityV1({ truth, sourceManifest, receipt: receipt as never, sourceFiles, chapterCommit })).toEqual(truth);
    const wrongFactSource = structuredClone(truth) as any;
    wrongFactSource.facts[0].source.baselineRecordId = bindingId("ENTITY");
    expect(() => validateBaselineAuthorityV1({ truth: wrongFactSource, sourceManifest, receipt: receipt as never, sourceFiles, chapterCommit })).toThrow(/binding|record|authority/i);
  });

  it("rejects malformed UTF-8 before checking baseline source-reference boundaries", () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    const sourceFiles = { "state/current_state.json": bytes };
    const sourceManifest = {
      schemaVersion: "1.0" as const, kind: "BASELINE_SOURCE_MANIFEST" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, sourceStateTreeSha256: SHA_B,
      entries: [{ path: "state/current_state.json", sha256: sha256Bytes(bytes), byteLength: bytes.byteLength }],
    };
    const receipt = {
      schemaVersion: "1.0" as const, kind: "BASELINE_CONSTRUCTION_RECEIPT" as const, bookId: "book-1", throughChapter: 0,
      predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
      seedVocabularyCatalogSha256: canonicalSha256(createVocabularyCatalogV1([])),
      method: { kind: "DETERMINISTIC" as const, builderId: "inkos.truth-baseline.builder.v1" as const, builderVersion: "1.0" as const },
      recordBindings: [],
    };
    expect(() => validateBaselineConstructionReceiptV1(receipt, sourceManifest, sourceFiles)).toThrow(/UTF-8/i);

    const validBytes = new TextEncoder().encode("雪a");
    const validFiles = { "state/current_state.json": validBytes };
    const validManifest = {
      ...sourceManifest,
      entries: [{ path: "state/current_state.json", sha256: sha256Bytes(validBytes), byteLength: validBytes.byteLength }],
    };
    const validManifestSha = canonicalSha256(validManifest);
    const validReceipt = {
      ...receipt,
      baselineSourceManifestSha256: validManifestSha,
      recordBindings: [{
        recordKind: "ENTITY" as const,
        baselineRecordId: deriveBaselineRecordId({ baselineSourceManifestSha256: validManifestSha, recordKind: "ENTITY", recordIdentity: SHA_C }),
        entityId: SHA_C,
        sourceReferences: [{ path: "state/current_state.json", fileSha256: sha256Bytes(validBytes), startUtf8: 0, endUtf8: 3, quoteSha256: sha256Bytes(validBytes.slice(0, 3)) }],
      }],
    };
    expect(validateBaselineConstructionReceiptV1(validReceipt, validManifest, validFiles)).toEqual(validReceipt);
    const splitCodePoint = structuredClone(validReceipt) as any;
    splitCodePoint.recordBindings[0].sourceReferences[0].startUtf8 = 1;
    splitCodePoint.recordBindings[0].sourceReferences[0].quoteSha256 = sha256Bytes(validBytes.slice(1, 3));
    expect(() => validateBaselineConstructionReceiptV1(splitCodePoint, validManifest, validFiles)).toThrow(/UTF-8|boundary/i);
  });
});
