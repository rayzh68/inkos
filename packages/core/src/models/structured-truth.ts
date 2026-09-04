import { assertCanonicalRelativePath, assertNfcString, assertSafeUnsignedInteger, canonicalJson, canonicalSha256, compareUnsignedUtf8, sha256Bytes } from "../state/canonical-json.js";
import { validateVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import type { ChapterCommit } from "../production/chapter-transaction.js";

export type Sha256 = string;
export type BookId = string;
export type EntityId = Sha256;
export type EntryId = Sha256;
export type FactSlotId = Sha256;
export type RelationId = Sha256;
export type BaselineRecordId = Sha256;
export type OperationId = string;
export type EvidenceId = string;
export type SafeUnsignedInteger = number;
export type NonEmptyNfcString = string;
export type NfcString = string;
export type BookLocalIdentityKey = string;
export type CustomVocabularyName = string;
export type CustomEntityKindV1 = string;

export const BUILT_IN_ENTITY_KINDS_V1 = Object.freeze([
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
] as const);

export type BuiltInEntityKindV1 = typeof BUILT_IN_ENTITY_KINDS_V1[number];
export type EntityKindV1 = BuiltInEntityKindV1 | CustomEntityKindV1;
export type TruthNodeKindV1 = "ENTITY" | "FACT_SLOT" | "RELATION";

export type BoundTruthNodeRefV1 =
  | { readonly nodeKind: "ENTITY"; readonly nodeId: EntityId }
  | { readonly nodeKind: "FACT_SLOT"; readonly nodeId: FactSlotId }
  | { readonly nodeKind: "RELATION"; readonly nodeId: RelationId };

export type FactValueContractV1 =
  | { readonly contractType: "STRING" }
  | { readonly contractType: "BOOLEAN" }
  | { readonly contractType: "INTEGER"; readonly unit: NonEmptyNfcString | null }
  | { readonly contractType: "DECIMAL"; readonly unit: NonEmptyNfcString | null }
  | { readonly contractType: "ENUM"; readonly allowedValues: readonly NonEmptyNfcString[] }
  | { readonly contractType: "ENTITY_REF" };

export interface RelationEndpointContractV1 {
  readonly schemaVersion: "1.0";
  readonly subjectKinds: readonly TruthNodeKindV1[];
  readonly objectKinds: readonly TruthNodeKindV1[];
  readonly allowReflexive: boolean;
}

export interface NarrativeEntityDefinitionV1 {
  readonly definitionType: "NARRATIVE_ENTITY";
  readonly entityKind: EntityKindV1;
  readonly identityKey: BookLocalIdentityKey;
  readonly canonicalName: NonEmptyNfcString;
  readonly aliases: readonly NonEmptyNfcString[];
}

export interface VocabularyFactKeyDefinitionV1 {
  readonly definitionType: "VOCABULARY_FACT_KEY";
  readonly metaKind: "system.vocabulary.fact-key";
  readonly canonicalName: CustomVocabularyName;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly valueContract: FactValueContractV1;
}

export interface VocabularyRelationPredicateDefinitionV1 {
  readonly definitionType: "VOCABULARY_RELATION_PREDICATE";
  readonly metaKind: "system.vocabulary.relation-predicate";
  readonly canonicalName: CustomVocabularyName;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly subjectObjectContract: RelationEndpointContractV1;
  readonly directionality: "DIRECTED" | "SYMMETRIC";
}

export type VocabularyDefinitionV1 = VocabularyFactKeyDefinitionV1 | VocabularyRelationPredicateDefinitionV1;
export type EntityDefinitionV1 = NarrativeEntityDefinitionV1 | VocabularyDefinitionV1;

export type TruthRecordSourceV1 =
  | {
    readonly sourceKind: "BASELINE";
    readonly baselineSourceManifestSha256: Sha256;
    readonly baselineConstructionReceiptSha256: Sha256;
    readonly baselineRecordId: BaselineRecordId;
  }
  | {
    readonly sourceKind: "CHAPTER_DELTA";
    readonly candidateSha256: Sha256;
    readonly deltaId: Sha256;
    readonly operationId: OperationId;
    readonly evidenceIds: readonly EvidenceId[];
  };

export interface BuiltInFactKeyEntryV1 {
  readonly entryId: EntryId;
  readonly scope: "BUILT_IN";
  readonly entryKind: "FACT_KEY";
  readonly vocabularyVersion: "1.0";
  readonly canonicalName: string;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly semanticMetadataSha256: Sha256;
  readonly valueContract: FactValueContractV1;
}

export interface BuiltInRelationPredicateEntryV1 {
  readonly entryId: EntryId;
  readonly scope: "BUILT_IN";
  readonly entryKind: "RELATION_PREDICATE";
  readonly vocabularyVersion: "1.0";
  readonly canonicalName: string;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly semanticMetadataSha256: Sha256;
  readonly subjectObjectContract: RelationEndpointContractV1;
  readonly directionality: "DIRECTED" | "SYMMETRIC";
}

export interface BookFactKeyEntryV1 {
  readonly entryId: EntryId;
  readonly scope: "BOOK";
  readonly entryKind: "FACT_KEY";
  readonly bookId: BookId;
  readonly vocabularySchemaVersion: "1.0";
  readonly canonicalName: CustomVocabularyName;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly semanticMetadataSha256: Sha256;
  readonly valueContract: FactValueContractV1;
  readonly definitionSource: TruthRecordSourceV1;
}

export interface BookRelationPredicateEntryV1 {
  readonly entryId: EntryId;
  readonly scope: "BOOK";
  readonly entryKind: "RELATION_PREDICATE";
  readonly bookId: BookId;
  readonly vocabularySchemaVersion: "1.0";
  readonly canonicalName: CustomVocabularyName;
  readonly semanticDefinition: NonEmptyNfcString;
  readonly semanticMetadataSha256: Sha256;
  readonly subjectObjectContract: RelationEndpointContractV1;
  readonly directionality: "DIRECTED" | "SYMMETRIC";
  readonly definitionSource: TruthRecordSourceV1;
}

export type VocabularyEntryV1 = BuiltInFactKeyEntryV1 | BuiltInRelationPredicateEntryV1 | BookFactKeyEntryV1 | BookRelationPredicateEntryV1;
export interface VocabularyCatalogV1 { readonly schemaVersion: "1.0"; readonly coreVocabularyVersion: "1.0"; readonly entries: readonly VocabularyEntryV1[] }

export interface BaselineSourceManifestV1 { readonly schemaVersion: "1.0"; readonly kind: "BASELINE_SOURCE_MANIFEST"; readonly bookId: BookId; readonly throughChapter: SafeUnsignedInteger; readonly predecessorCommitSha256: Sha256; readonly sourceStateTreeSha256: Sha256; readonly entries: readonly { readonly path: string; readonly sha256: Sha256; readonly byteLength: SafeUnsignedInteger }[] }
export interface BaselineSourceReferenceV1 { readonly path: string; readonly fileSha256: Sha256; readonly startUtf8: SafeUnsignedInteger; readonly endUtf8: SafeUnsignedInteger; readonly quoteSha256: Sha256 }
type BaselineBindingCommonV1 = { readonly baselineRecordId: BaselineRecordId; readonly sourceReferences: readonly BaselineSourceReferenceV1[] };
export type BaselineRecordBindingV1 =
  | (BaselineBindingCommonV1 & { readonly recordKind: "ENTITY"; readonly entityId: EntityId })
  | (BaselineBindingCommonV1 & { readonly recordKind: "VOCABULARY_ENTRY"; readonly entryId: EntryId })
  | (BaselineBindingCommonV1 & { readonly recordKind: "FACT_SLOT"; readonly factSlotId: FactSlotId })
  | (BaselineBindingCommonV1 & { readonly recordKind: "RELATION"; readonly relationId: RelationId });
export interface BaselineConstructionReceiptV1 { readonly schemaVersion: "1.0"; readonly kind: "BASELINE_CONSTRUCTION_RECEIPT"; readonly bookId: BookId; readonly throughChapter: SafeUnsignedInteger; readonly predecessorCommitSha256: Sha256; readonly baselineSourceManifestSha256: Sha256; readonly seedVocabularyCatalogSha256: Sha256; readonly method: { readonly kind: "DETERMINISTIC"; readonly builderId: "inkos.truth-baseline.builder.v1"; readonly builderVersion: "1.0" } | { readonly kind: "SEMANTIC_EXTRACTION"; readonly extractorId: "inkos.truth-baseline.extractor.v1"; readonly extractorVersion: "1.0"; readonly logicalOperationId: string; readonly inputFingerprint: Sha256; readonly providerArtifactSha256: Sha256; readonly responseContentSha256: Sha256; readonly proposalCanonicalSha256: Sha256 }; readonly recordBindings: readonly BaselineRecordBindingV1[] }

export interface NarrativeEntityRecordV1 {
  readonly entityId: EntityId;
  readonly entityKind: EntityKindV1;
  readonly identityKey: BookLocalIdentityKey;
  readonly canonicalName: NonEmptyNfcString;
  readonly aliases: readonly NonEmptyNfcString[];
  readonly declaredAtChapter: SafeUnsignedInteger;
  readonly declarationSource:
    | { readonly origin: "CHAPTER_DELTA"; readonly bookId: BookId; readonly candidateSha256: Sha256; readonly declarationOperationId: OperationId }
    | { readonly origin: "BASELINE"; readonly bookId: BookId; readonly baselineSourceManifestSha256: Sha256; readonly baselineConstructionReceiptSha256: Sha256; readonly baselineRecordId: BaselineRecordId };
}

export type CanonicalFactValueV1 =
  | { readonly valueType: "STRING"; readonly value: NfcString }
  | { readonly valueType: "BOOLEAN"; readonly value: boolean }
  | { readonly valueType: "INTEGER"; readonly value: string }
  | { readonly valueType: "DECIMAL"; readonly value: string }
  | { readonly valueType: "ENTITY_REF"; readonly value: { readonly nodeKind: "ENTITY"; readonly nodeId: EntityId } };
export type FactAssertionV1 = { readonly state: "VALUE"; readonly value: CanonicalFactValueV1 } | { readonly state: "ABSENT" };
export interface FactAssertionRecordV1 {
  readonly factSlotId: FactSlotId;
  readonly subject: { readonly nodeKind: "ENTITY"; readonly nodeId: EntityId };
  readonly factKeyEntryId: EntryId;
  readonly assertion: FactAssertionV1;
  readonly validFromChapter: SafeUnsignedInteger;
  readonly lastChangedChapter: SafeUnsignedInteger;
  readonly source: TruthRecordSourceV1;
}
export type RelationAssertionV1 = { readonly state: "PRESENT" } | { readonly state: "ABSENT" };
export interface RelationAssertionRecordV1 {
  readonly relationId: RelationId;
  readonly predicateEntryId: EntryId;
  readonly directionality: "DIRECTED" | "SYMMETRIC";
  readonly subject: BoundTruthNodeRefV1;
  readonly object: BoundTruthNodeRefV1;
  readonly assertion: RelationAssertionV1;
  readonly validFromChapter: SafeUnsignedInteger;
  readonly lastChangedChapter: SafeUnsignedInteger;
  readonly source: TruthRecordSourceV1;
}

export type StructuredTruthLineageV1 =
  | { readonly kind: "BASELINE"; readonly predecessorCommitSha256: Sha256; readonly baselineSourceManifestSha256: Sha256; readonly seedVocabularyCatalogSha256: Sha256; readonly baselineMethod: "DETERMINISTIC" | "SEMANTIC_EXTRACTION"; readonly baselineConstructionReceiptSha256: Sha256 }
  | { readonly kind: "CHAPTER_DELTA"; readonly predecessorCommitSha256: Sha256; readonly predecessorTruthSha256: Sha256; readonly predecessorVocabularyCatalogSha256: Sha256; readonly candidateSha256: Sha256; readonly deltaId: Sha256; readonly acceptedDeltaArtifactSha256: Sha256 };

export type StructuredTruthProvenanceV1 =
  | { readonly schemaVersion: "1.0"; readonly producerKind: "BASELINE"; readonly producerId: "inkos.truth-baseline.builder.v1" | "inkos.truth-baseline.extractor.v1"; readonly producerVersion: "1.0"; readonly canonicalizationId: "inkos.jcs-ijson.v1"; readonly truthSchemaVersion: "1.0"; readonly vocabularySchemaVersion: "1.0"; readonly coreVocabularyVersion: "1.0" }
  | { readonly schemaVersion: "1.0"; readonly producerKind: "CHAPTER_DELTA"; readonly producerId: "inkos.structured-truth.reducer.v1"; readonly producerVersion: "1.0"; readonly canonicalizationId: "inkos.jcs-ijson.v1"; readonly truthSchemaVersion: "1.0"; readonly vocabularySchemaVersion: "1.0"; readonly coreVocabularyVersion: "1.0" };

export interface StructuredTruthV1 {
  readonly schemaVersion: "1.0";
  readonly kind: "STRUCTURED_TRUTH";
  readonly bookId: BookId;
  readonly throughChapter: SafeUnsignedInteger;
  readonly lineage: StructuredTruthLineageV1;
  readonly vocabulary: VocabularyCatalogV1;
  readonly entities: readonly NarrativeEntityRecordV1[];
  readonly facts: readonly FactAssertionRecordV1[];
  readonly relations: readonly RelationAssertionRecordV1[];
  readonly provenance: StructuredTruthProvenanceV1;
}

const SHA = /^[0-9a-f]{64}$/;
const IDENTITY_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const CUSTOM_ENTITY_KIND = /^custom\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/;
const NON_EMPTY_WHITESPACE = /[^\u0009\u000a\u000d\u0020]/u;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9]$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (extra.length > 0) throw new Error(`${label} has unknown field ${extra[0]}`);
  if (missing.length > 0) throw new Error(`${label} is missing field ${missing[0]}`);
}

function assertSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be lower-case SHA-256`);
  return value;
}

function assertOperationId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^op-[0-9]{4}$/.test(value) || Number(value.slice(3)) < 1 || Number(value.slice(3)) > 256) throw new Error(`${label} must be op-0001..op-0256`);
  return value;
}

function assertEvidenceId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^ev-[0-9]{4}$/.test(value) || Number(value.slice(3)) < 1 || Number(value.slice(3)) > 512) throw new Error(`${label} must be ev-0001..ev-0512`);
  return value;
}

function assertSortedUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) {
      const comparison = compareUnsignedUtf8(key(values[index - 1]!), key(values[index]!));
      if (comparison === 0) throw new Error(`${label} must be unique`);
      if (comparison > 0) throw new Error(`${label} must be sorted by unsigned UTF-8 bytes`);
    }
  }
}

export function assertEntityKindV1(value: unknown): EntityKindV1 {
  if (typeof value !== "string" || (!BUILT_IN_ENTITY_KINDS_V1.includes(value as BuiltInEntityKindV1) && !CUSTOM_ENTITY_KIND.test(value))) {
    throw new Error(`Invalid Entity kind: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertBookLocalIdentityKey(value: unknown): BookLocalIdentityKey {
  if (typeof value !== "string" || !IDENTITY_KEY.test(value)) throw new Error(`Invalid book-local identity key: ${JSON.stringify(value)}`);
  return value;
}

export function assertNonEmptyNfcString(value: unknown, label = "non-empty string"): NonEmptyNfcString {
  const text = assertNfcString(value, label);
  if (!text || !NON_EMPTY_WHITESPACE.test(text)) throw new Error(`${label} must be non-empty outside the locked whitespace set`);
  return text;
}

export function validateNarrativeEntityDefinitionV1(input: unknown): NarrativeEntityDefinitionV1 {
  const value = record(input, "narrative entity definition");
  exactKeys(value, ["definitionType", "entityKind", "identityKey", "canonicalName", "aliases"], "narrative entity definition");
  if (value.definitionType !== "NARRATIVE_ENTITY") throw new Error("Invalid narrative entity definition type");
  assertEntityKindV1(value.entityKind);
  assertBookLocalIdentityKey(value.identityKey);
  const name = assertNonEmptyNfcString(value.canonicalName, "canonical name");
  if (!Array.isArray(value.aliases)) throw new Error("aliases must be an array");
  for (const alias of value.aliases) assertNonEmptyNfcString(alias, "alias");
  if (value.aliases.includes(name)) throw new Error("alias cannot equal canonical name");
  assertSortedUnique(value.aliases, (alias) => String(alias), "aliases");
  return input as NarrativeEntityDefinitionV1;
}

function validateEntityRecord(value: NarrativeEntityRecordV1, bookId: string, throughChapter: number): void {
  const item = record(value, "entity record");
  exactKeys(item, ["entityId", "entityKind", "identityKey", "canonicalName", "aliases", "declaredAtChapter", "declarationSource"], "entity record");
  assertSha(value.entityId, "entityId");
  validateNarrativeEntityDefinitionV1({ definitionType: "NARRATIVE_ENTITY", entityKind: value.entityKind, identityKey: value.identityKey, canonicalName: value.canonicalName, aliases: value.aliases });
  const chapter = assertSafeUnsignedInteger(value.declaredAtChapter, "declaredAtChapter");
  if (chapter > throughChapter) throw new Error("entity chronology exceeds throughChapter");
  const declaration = record(value.declarationSource, "entity declaration source");
  if (value.declarationSource.origin === "BASELINE") {
    exactKeys(declaration, ["origin", "bookId", "baselineSourceManifestSha256", "baselineConstructionReceiptSha256", "baselineRecordId"], "baseline entity declaration source");
    assertSha(value.declarationSource.baselineSourceManifestSha256, "baseline source manifest SHA");
    assertSha(value.declarationSource.baselineConstructionReceiptSha256, "baseline construction receipt SHA");
    assertSha(value.declarationSource.baselineRecordId, "baseline record ID");
  } else if (value.declarationSource.origin === "CHAPTER_DELTA") {
    exactKeys(declaration, ["origin", "bookId", "candidateSha256", "declarationOperationId"], "delta entity declaration source");
    assertSha(value.declarationSource.candidateSha256, "candidate SHA");
    assertOperationId(value.declarationSource.declarationOperationId, "declaration operation ID");
  } else throw new Error("Invalid entity declaration source branch");
  if (value.declarationSource.bookId !== bookId) throw new Error("entity declaration bookId mismatch");
  if (value.declarationSource.origin === "BASELINE" && chapter !== 0) throw new Error("baseline entity chronology must begin at 0");
  if (value.declarationSource.origin === "CHAPTER_DELTA" && chapter === 0) throw new Error("delta entity chronology must begin after baseline");
}

function validateNodeRef(value: BoundTruthNodeRefV1, label: string): void {
  const item = record(value, label);
  exactKeys(item, ["nodeKind", "nodeId"], label);
  if (value.nodeKind !== "ENTITY" && value.nodeKind !== "FACT_SLOT" && value.nodeKind !== "RELATION") throw new Error(`Invalid ${label} kind`);
  assertSha(value.nodeId, `${label} ID`);
}

function validateSource(value: TruthRecordSourceV1): void {
  const item = record(value, "truth record source");
  if (value.sourceKind === "BASELINE") {
    exactKeys(item, ["sourceKind", "baselineSourceManifestSha256", "baselineConstructionReceiptSha256", "baselineRecordId"], "baseline truth record source");
    assertSha(value.baselineSourceManifestSha256, "baseline source manifest SHA");
    assertSha(value.baselineConstructionReceiptSha256, "baseline receipt SHA");
    assertSha(value.baselineRecordId, "baseline record ID");
  } else if (value.sourceKind === "CHAPTER_DELTA") {
    exactKeys(item, ["sourceKind", "candidateSha256", "deltaId", "operationId", "evidenceIds"], "delta truth record source");
    assertSha(value.candidateSha256, "candidate SHA");
    assertSha(value.deltaId, "delta ID");
    assertOperationId(value.operationId, "truth record operation ID");
    if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0) throw new Error("Invalid delta truth record source");
    assertSortedUnique(value.evidenceIds, (id) => {
      return assertEvidenceId(id, "truth record evidence ID");
    }, "truth record evidence IDs");
  } else throw new Error("Invalid truth record source branch");
}

function validateFactAssertion(value: FactAssertionV1): void {
  const assertion = record(value, "fact assertion");
  if (value.state === "ABSENT") { exactKeys(assertion, ["state"], "fact assertion"); return; }
  if (value.state !== "VALUE") throw new Error("Stored fact assertion must be VALUE or ABSENT");
  exactKeys(assertion, ["state", "value"], "fact assertion");
  const factValue = record(value.value, "canonical fact value");
  exactKeys(factValue, ["valueType", "value"], "canonical fact value");
  if (value.value.valueType === "STRING") assertNfcString(value.value.value, "STRING fact value");
  else if (value.value.valueType === "BOOLEAN") {
    if (typeof value.value.value !== "boolean") throw new Error("BOOLEAN fact value must be boolean");
  } else if (value.value.valueType === "INTEGER") {
    if (!INTEGER.test(value.value.value)) throw new Error("INTEGER fact value is not canonical");
  } else if (value.value.valueType === "DECIMAL") {
    if (!DECIMAL.test(value.value.value)) throw new Error("DECIMAL fact value is not canonical");
  } else if (value.value.valueType === "ENTITY_REF") validateNodeRef(value.value.value, "ENTITY_REF fact value");
  else throw new Error("Invalid canonical fact value type");
}

function validateLineage(value: StructuredTruthLineageV1): void {
  const lineage = record(value, "lineage");
  if (value.kind === "BASELINE") {
    exactKeys(lineage, ["kind", "predecessorCommitSha256", "baselineSourceManifestSha256", "seedVocabularyCatalogSha256", "baselineMethod", "baselineConstructionReceiptSha256"], "baseline lineage");
    if (value.baselineMethod !== "DETERMINISTIC" && value.baselineMethod !== "SEMANTIC_EXTRACTION") throw new Error("Invalid baseline method");
    for (const sha of [value.predecessorCommitSha256, value.baselineSourceManifestSha256, value.seedVocabularyCatalogSha256, value.baselineConstructionReceiptSha256]) assertSha(sha, "baseline lineage SHA");
  } else if (value.kind === "CHAPTER_DELTA") {
    exactKeys(lineage, ["kind", "predecessorCommitSha256", "predecessorTruthSha256", "predecessorVocabularyCatalogSha256", "candidateSha256", "deltaId", "acceptedDeltaArtifactSha256"], "chapter-delta lineage");
    for (const sha of [value.predecessorCommitSha256, value.predecessorTruthSha256, value.predecessorVocabularyCatalogSha256, value.candidateSha256, value.deltaId, value.acceptedDeltaArtifactSha256]) assertSha(sha, "chapter-delta lineage SHA");
  } else throw new Error("Invalid lineage branch");
}

function validateProvenance(value: StructuredTruthProvenanceV1): void {
  const item = record(value, "provenance");
  exactKeys(item, ["schemaVersion", "producerKind", "producerId", "producerVersion", "canonicalizationId", "truthSchemaVersion", "vocabularySchemaVersion", "coreVocabularyVersion"], "provenance");
  if (value.schemaVersion !== "1.0" || value.producerVersion !== "1.0" || value.canonicalizationId !== "inkos.jcs-ijson.v1"
    || value.truthSchemaVersion !== "1.0" || value.vocabularySchemaVersion !== "1.0" || value.coreVocabularyVersion !== "1.0") throw new Error("Invalid provenance version or canonicalization identity");
  if (value.producerKind === "BASELINE") {
    if (value.producerId !== "inkos.truth-baseline.builder.v1" && value.producerId !== "inkos.truth-baseline.extractor.v1") throw new Error("Invalid baseline producer");
  } else if (value.producerKind === "CHAPTER_DELTA") {
    if (value.producerId !== "inkos.structured-truth.reducer.v1") throw new Error("Invalid chapter-delta producer");
  } else throw new Error("Invalid producer kind");
}

function validateChronology(recordValue: { readonly validFromChapter: number; readonly lastChangedChapter: number }, throughChapter: number): void {
  const from = assertSafeUnsignedInteger(recordValue.validFromChapter, "validFromChapter");
  const changed = assertSafeUnsignedInteger(recordValue.lastChangedChapter, "lastChangedChapter");
  if (from > changed || changed > throughChapter) throw new Error("Invalid truth record chronology");
}

export function validateStructuredTruthV1(input: unknown): StructuredTruthV1 {
  const value = record(input, "StructuredTruthV1");
  exactKeys(value, ["schemaVersion", "kind", "bookId", "throughChapter", "lineage", "vocabulary", "entities", "facts", "relations", "provenance"], "StructuredTruthV1");
  if (value.schemaVersion !== "1.0" || value.kind !== "STRUCTURED_TRUTH" || typeof value.bookId !== "string" || !value.bookId) throw new Error("Invalid StructuredTruthV1 root");
  const throughChapter = assertSafeUnsignedInteger(value.throughChapter, "throughChapter");
  if (!Array.isArray(value.entities) || !Array.isArray(value.facts) || !Array.isArray(value.relations)) throw new Error("StructuredTruthV1 record collections must be arrays");
  const truth = input as StructuredTruthV1;
  exactKeys(record(truth.vocabulary, "vocabulary"), ["schemaVersion", "coreVocabularyVersion", "entries"], "vocabulary");
  if (truth.vocabulary.schemaVersion !== "1.0" || truth.vocabulary.coreVocabularyVersion !== "1.0" || !Array.isArray(truth.vocabulary.entries)) throw new Error("Invalid vocabulary catalog root");
  validateVocabularyCatalogV1(truth.vocabulary);
  validateLineage(truth.lineage);
  validateProvenance(truth.provenance);
  if ((truth.lineage.kind === "BASELINE") !== (truth.provenance.producerKind === "BASELINE")) throw new Error("lineage and producer branch disagree");
  for (const entity of truth.entities) validateEntityRecord(entity, truth.bookId, throughChapter);
  for (const fact of truth.facts) {
    exactKeys(record(fact, "fact record"), ["factSlotId", "subject", "factKeyEntryId", "assertion", "validFromChapter", "lastChangedChapter", "source"], "fact record");
    assertSha(fact.factSlotId, "factSlotId"); assertSha(fact.factKeyEntryId, "fact-key EntryId");
    validateNodeRef(fact.subject, "fact subject"); if (fact.subject.nodeKind !== "ENTITY") throw new Error("fact subject must be a typed ENTITY reference"); validateFactAssertion(fact.assertion); validateSource(fact.source); validateChronology(fact, throughChapter);
  }
  for (const relation of truth.relations) {
    exactKeys(record(relation, "relation record"), ["relationId", "predicateEntryId", "directionality", "subject", "object", "assertion", "validFromChapter", "lastChangedChapter", "source"], "relation record");
    assertSha(relation.relationId, "relationId"); assertSha(relation.predicateEntryId, "relation predicate EntryId");
    if (relation.directionality !== "DIRECTED" && relation.directionality !== "SYMMETRIC") throw new Error("Invalid relation directionality");
    validateNodeRef(relation.subject, "relation subject"); validateNodeRef(relation.object, "relation object");
    exactKeys(record(relation.assertion, "relation assertion"), ["state"], "relation assertion");
    if (relation.assertion.state !== "PRESENT" && relation.assertion.state !== "ABSENT") throw new Error("Invalid stored relation assertion");
    validateSource(relation.source); validateChronology(relation, throughChapter);
  }
  assertSortedUnique(truth.entities, (item) => item.entityId, "entities");
  assertSortedUnique(truth.facts, (item) => item.factSlotId, "facts");
  assertSortedUnique(truth.relations, (item) => item.relationId, "relations");
  const tuples = new Set<string>(); const entityIds = new Set(truth.entities.map((entity) => entity.entityId));
  for (const entity of truth.entities) {
    const tuple = `${entity.entityKind}\u0000${entity.identityKey}`; if (tuples.has(tuple)) throw new Error("Duplicate entity identity tuple"); tuples.add(tuple);
    const expected = entity.declarationSource.origin === "BASELINE"
      ? canonicalSha256({ domain: "inkos.entity.v1", bookId: truth.bookId, origin: "BASELINE", baselineSourceManifestSha256: entity.declarationSource.baselineSourceManifestSha256, entityKind: entity.entityKind, identityKey: entity.identityKey })
      : canonicalSha256({ domain: "inkos.entity.v1", bookId: truth.bookId, origin: "CHAPTER_DELTA", candidateSha256: entity.declarationSource.candidateSha256, declarationOperationId: entity.declarationSource.declarationOperationId, entityKind: entity.entityKind, identityKey: entity.identityKey });
    if (entity.entityId !== expected) throw new Error("EntityId preimage mismatch or collision");
    if (entity.declarationSource.origin === "CHAPTER_DELTA" && entity.declaredAtChapter === throughChapter && (truth.lineage.kind !== "CHAPTER_DELTA" || entity.declarationSource.candidateSha256 !== truth.lineage.candidateSha256)) throw new Error("Current entity source does not match chapter-delta lineage authority");
  }
  const entries = new Map(truth.vocabulary.entries.map((entry) => [entry.entryId, entry]));
  for (const entry of truth.vocabulary.entries) if (entry.scope === "BOOK" && entry.bookId !== truth.bookId) throw new Error("Book vocabulary entry does not match root bookId");
  const factIds = new Set(truth.facts.map((fact) => fact.factSlotId)); const relationIds = new Set(truth.relations.map((relation) => relation.relationId));
  for (const fact of truth.facts) {
    if (!entityIds.has(fact.subject.nodeId)) throw new Error("Dangling fact subject");
    const entry = entries.get(fact.factKeyEntryId); if (!entry || entry.entryKind !== "FACT_KEY") throw new Error("Fact must reference a fact-key entry");
    const expected = canonicalSha256({ domain: "inkos.fact-slot.v1", bookId: truth.bookId, subjectEntityId: fact.subject.nodeId, factKeyEntryId: fact.factKeyEntryId }); if (fact.factSlotId !== expected) throw new Error("FactSlotId preimage mismatch");
    if (fact.source.sourceKind === "CHAPTER_DELTA" && fact.lastChangedChapter === throughChapter && (truth.lineage.kind !== "CHAPTER_DELTA" || fact.source.candidateSha256 !== truth.lineage.candidateSha256 || fact.source.deltaId !== truth.lineage.deltaId)) throw new Error("Current fact source does not match chapter-delta lineage authority");
    if (fact.assertion.state === "VALUE") {
      const value = fact.assertion.value; const contract = entry.valueContract;
      if ((contract.contractType === "STRING" && value.valueType !== "STRING") || (contract.contractType === "BOOLEAN" && value.valueType !== "BOOLEAN") || (contract.contractType === "INTEGER" && value.valueType !== "INTEGER") || (contract.contractType === "DECIMAL" && value.valueType !== "INTEGER" && value.valueType !== "DECIMAL") || (contract.contractType === "ENUM" && (value.valueType !== "STRING" || !contract.allowedValues.includes(value.value))) || (contract.contractType === "ENTITY_REF" && (value.valueType !== "ENTITY_REF" || value.value.nodeKind !== "ENTITY" || !entityIds.has(value.value.nodeId)))) throw new Error("Fact value contract mismatch");
    }
  }
  const nodeExists = (ref: BoundTruthNodeRefV1) => ref.nodeKind === "ENTITY" ? entityIds.has(ref.nodeId) : ref.nodeKind === "FACT_SLOT" ? factIds.has(ref.nodeId) : relationIds.has(ref.nodeId);
  for (const relation of truth.relations) {
    const entry = entries.get(relation.predicateEntryId); if (!entry || entry.entryKind !== "RELATION_PREDICATE") throw new Error("Relation must reference a relation-predicate entry");
    if (!nodeExists(relation.subject) || !nodeExists(relation.object)) throw new Error("Dangling relation endpoint");
    if (relation.source.sourceKind === "CHAPTER_DELTA" && relation.lastChangedChapter === throughChapter && (truth.lineage.kind !== "CHAPTER_DELTA" || relation.source.candidateSha256 !== truth.lineage.candidateSha256 || relation.source.deltaId !== truth.lineage.deltaId)) throw new Error("Current relation source does not match chapter-delta lineage authority");
    if (relation.directionality !== entry.directionality || !entry.subjectObjectContract.subjectKinds.includes(relation.subject.nodeKind) || !entry.subjectObjectContract.objectKinds.includes(relation.object.nodeKind) || (!entry.subjectObjectContract.allowReflexive && canonicalJson(relation.subject) === canonicalJson(relation.object))) throw new Error("Relation endpoint or directionality contract mismatch");
    let subject = relation.subject; let objectRef = relation.object;
    if (entry.directionality === "SYMMETRIC" && compareUnsignedUtf8(canonicalJson(subject), canonicalJson(objectRef)) > 0) [subject, objectRef] = [objectRef, subject];
    const endpoints = entry.directionality === "DIRECTED" ? { subject, object: objectRef } : { endpointA: subject, endpointB: objectRef };
    const expected = canonicalSha256({ domain: "inkos.relation.v1", bookId: truth.bookId, relationPredicateEntryId: relation.predicateEntryId, directionality: entry.directionality, endpoints });
    if (relation.relationId !== expected || canonicalJson(subject) !== canonicalJson(relation.subject) || canonicalJson(objectRef) !== canonicalJson(relation.object)) throw new Error("RelationId preimage or symmetric normalization mismatch");
  }
  return truth;
}

export function validateBaselineSourceManifestV1(input: unknown, sourceFiles: Readonly<Record<string, Uint8Array>>): BaselineSourceManifestV1 {
  const value = record(input, "BaselineSourceManifestV1");
  exactKeys(value, ["schemaVersion", "kind", "bookId", "throughChapter", "predecessorCommitSha256", "sourceStateTreeSha256", "entries"], "BaselineSourceManifestV1");
  if (value.schemaVersion !== "1.0" || value.kind !== "BASELINE_SOURCE_MANIFEST" || typeof value.bookId !== "string" || !value.bookId || !Array.isArray(value.entries)) throw new Error("Invalid baseline source manifest");
  assertSafeUnsignedInteger(value.throughChapter, "manifest throughChapter"); assertSha(value.predecessorCommitSha256, "manifest predecessor commit"); assertSha(value.sourceStateTreeSha256, "source state tree");
  const manifest = input as BaselineSourceManifestV1;
  for (const entry of manifest.entries) {
    exactKeys(record(entry, "manifest entry"), ["path", "sha256", "byteLength"], "manifest entry");
    assertCanonicalRelativePath(entry.path); assertSha(entry.sha256, "manifest entry SHA"); assertSafeUnsignedInteger(entry.byteLength, "manifest byteLength");
    const bytes = sourceFiles[entry.path];
    if (!bytes || bytes.byteLength !== entry.byteLength || sha256Bytes(bytes) !== entry.sha256) throw new Error("Manifest source file hash or length mismatch");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Manifest source file ${entry.path} is not valid UTF-8`);
    }
  }
  assertSortedUnique(manifest.entries, (entry) => entry.path, "manifest entries");
  if (Object.keys(sourceFiles).length !== manifest.entries.length) throw new Error("Manifest must equal the complete source file set");
  return manifest;
}

function bindingIdentity(binding: BaselineRecordBindingV1): string {
  if (binding.recordKind === "ENTITY") return binding.entityId;
  if (binding.recordKind === "VOCABULARY_ENTRY") return binding.entryId;
  if (binding.recordKind === "FACT_SLOT") return binding.factSlotId;
  return binding.relationId;
}

export function validateBaselineConstructionReceiptV1(input: unknown, manifest: BaselineSourceManifestV1, sourceFiles: Readonly<Record<string, Uint8Array>>): BaselineConstructionReceiptV1 {
  validateBaselineSourceManifestV1(manifest, sourceFiles);
  const value = record(input, "BaselineConstructionReceiptV1");
  exactKeys(value, ["schemaVersion", "kind", "bookId", "throughChapter", "predecessorCommitSha256", "baselineSourceManifestSha256", "seedVocabularyCatalogSha256", "method", "recordBindings"], "BaselineConstructionReceiptV1");
  if (value.schemaVersion !== "1.0" || value.kind !== "BASELINE_CONSTRUCTION_RECEIPT" || !Array.isArray(value.recordBindings)) throw new Error("Invalid baseline construction receipt");
  const receipt = input as BaselineConstructionReceiptV1;
  if (receipt.bookId !== manifest.bookId || receipt.throughChapter !== manifest.throughChapter || receipt.predecessorCommitSha256 !== manifest.predecessorCommitSha256 || receipt.baselineSourceManifestSha256 !== canonicalSha256(manifest)) throw new Error("Baseline manifest/receipt authority mismatch");
  assertSha(receipt.seedVocabularyCatalogSha256, "seed vocabulary catalog SHA");
  const method = record(receipt.method, "baseline method");
  if (receipt.method.kind === "DETERMINISTIC") {
    exactKeys(method, ["kind", "builderId", "builderVersion"], "deterministic baseline method");
    if (receipt.method.builderId !== "inkos.truth-baseline.builder.v1" || receipt.method.builderVersion !== "1.0") throw new Error("Invalid deterministic baseline builder method");
  } else if (receipt.method.kind === "SEMANTIC_EXTRACTION") {
    exactKeys(method, ["kind", "extractorId", "extractorVersion", "logicalOperationId", "inputFingerprint", "providerArtifactSha256", "responseContentSha256", "proposalCanonicalSha256"], "semantic baseline method");
    if (receipt.method.extractorId !== "inkos.truth-baseline.extractor.v1" || receipt.method.extractorVersion !== "1.0" || typeof receipt.method.logicalOperationId !== "string") throw new Error("Invalid semantic baseline extractor method");
    for (const sha of [receipt.method.inputFingerprint, receipt.method.providerArtifactSha256, receipt.method.responseContentSha256, receipt.method.proposalCanonicalSha256]) assertSha(sha, "semantic baseline SHA");
  }
  else throw new Error("Invalid baseline method branch");
  for (const binding of receipt.recordBindings) {
    const identityKey = binding.recordKind === "ENTITY" ? "entityId" : binding.recordKind === "VOCABULARY_ENTRY" ? "entryId" : binding.recordKind === "FACT_SLOT" ? "factSlotId" : binding.recordKind === "RELATION" ? "relationId" : "";
    if (!identityKey) throw new Error("Invalid baseline binding kind");
    exactKeys(record(binding, "baseline binding"), ["recordKind", "baselineRecordId", identityKey, "sourceReferences"], "baseline binding");
    assertSha(binding.baselineRecordId, "baselineRecordId"); assertSha(bindingIdentity(binding), "bound record ID");
    const expectedBaselineRecordId = canonicalSha256({
      domain: "inkos.baseline-record.v1",
      baselineSourceManifestSha256: receipt.baselineSourceManifestSha256,
      recordKind: binding.recordKind,
      recordIdentity: bindingIdentity(binding),
    });
    if (binding.baselineRecordId !== expectedBaselineRecordId) throw new Error("baselineRecordId derived preimage mismatch");
    if (!Array.isArray(binding.sourceReferences) || binding.sourceReferences.length === 0) throw new Error("Baseline binding source references must be nonempty");
    let previous: BaselineSourceReferenceV1 | undefined;
    for (const reference of binding.sourceReferences) {
      exactKeys(record(reference, "baseline source reference"), ["path", "fileSha256", "startUtf8", "endUtf8", "quoteSha256"], "baseline source reference");
      const bytes = sourceFiles[assertCanonicalRelativePath(reference.path)]; const start = assertSafeUnsignedInteger(reference.startUtf8, "startUtf8"); const end = assertSafeUnsignedInteger(reference.endUtf8, "endUtf8");
      if (!bytes || start >= end || end > bytes.length || (start > 0 && (bytes[start]! & 0xc0) === 0x80) || (end < bytes.length && (bytes[end]! & 0xc0) === 0x80)) throw new Error("Invalid UTF-8 source range or boundary");
      if (sha256Bytes(bytes) !== reference.fileSha256 || sha256Bytes(bytes.slice(start, end)) !== reference.quoteSha256) throw new Error("Baseline source reference hash mismatch");
      if (previous) {
        const pathOrder = compareUnsignedUtf8(previous.path, reference.path);
        const quoteOrder = compareUnsignedUtf8(previous.quoteSha256, reference.quoteSha256);
        const strictlyIncreasing = pathOrder < 0
          || (pathOrder === 0 && (previous.startUtf8 < start
            || (previous.startUtf8 === start && (previous.endUtf8 < end
              || (previous.endUtf8 === end && quoteOrder < 0)))));
        if (!strictlyIncreasing) throw new Error("Baseline source references must be unique and sorted");
      }
      previous = reference;
    }
  }
  assertSortedUnique(receipt.recordBindings, (binding) => `${binding.recordKind}:${bindingIdentity(binding)}`, "baseline record bindings");
  return receipt;
}

export function validateBaselineAuthorityV1(input: { readonly truth: StructuredTruthV1; readonly sourceManifest: BaselineSourceManifestV1; readonly receipt: BaselineConstructionReceiptV1; readonly sourceFiles: Readonly<Record<string, Uint8Array>>; readonly chapterCommit: ChapterCommit }): StructuredTruthV1 {
  const truth = validateStructuredTruthV1(input.truth); const manifest = validateBaselineSourceManifestV1(input.sourceManifest, input.sourceFiles); const receipt = validateBaselineConstructionReceiptV1(input.receipt, manifest, input.sourceFiles);
  const manifestSha = canonicalSha256(manifest); const receiptSha = canonicalSha256(receipt);
  if (truth.lineage.kind !== "BASELINE" || truth.bookId !== manifest.bookId || truth.throughChapter !== manifest.throughChapter || truth.lineage.predecessorCommitSha256 !== manifest.predecessorCommitSha256 || truth.lineage.baselineSourceManifestSha256 !== manifestSha || truth.lineage.baselineConstructionReceiptSha256 !== receiptSha || truth.lineage.seedVocabularyCatalogSha256 !== receipt.seedVocabularyCatalogSha256 || truth.lineage.baselineMethod !== receipt.method.kind) throw new Error("Baseline truth authority crosscheck failed");
  const commit = input.chapterCommit;
  if (commit.schemaVersion !== 1 || commit.kind !== "CHAPTER_COMMIT" || commit.bookId !== truth.bookId || commit.chapterNumber !== truth.throughChapter) throw new Error("Baseline ChapterCommit book or chapter authority mismatch");
  assertSha(commit.commitSha256, "ChapterCommit commit SHA"); assertSha(commit.previousAuthoritySha256, "ChapterCommit predecessor authority SHA"); assertSha(commit.stateTreeSha256, "ChapterCommit state tree SHA");
  if (manifest.predecessorCommitSha256 !== commit.commitSha256 || manifest.sourceStateTreeSha256 !== commit.stateTreeSha256) throw new Error("Baseline manifest does not match ChapterCommit predecessor or stateTree authority");
  if (!Array.isArray(commit.stateFiles) || commit.stateFiles.length !== manifest.entries.length) throw new Error("Baseline manifest must equal the complete ChapterCommit stateFiles set");
  const commitStateFiles = new Map<string, { readonly sha256: string; readonly bytes: number }>();
  for (const entry of commit.stateFiles) {
    const path = assertCanonicalRelativePath(entry.relativePath); assertSha(entry.sha256, "ChapterCommit state file SHA"); assertSafeUnsignedInteger(entry.bytes, "ChapterCommit state file bytes");
    if (commitStateFiles.has(path)) throw new Error("ChapterCommit stateFiles paths must be unique");
    commitStateFiles.set(path, entry);
  }
  for (const entry of manifest.entries) {
    const committed = commitStateFiles.get(entry.path);
    if (!committed || committed.sha256 !== entry.sha256 || committed.bytes !== entry.byteLength) throw new Error("Baseline manifest path/hash/bytes do not match complete ChapterCommit stateFiles authority");
  }
  const expectedProducerId = receipt.method.kind === "DETERMINISTIC" ? "inkos.truth-baseline.builder.v1" : "inkos.truth-baseline.extractor.v1";
  if (truth.provenance.producerKind !== "BASELINE" || truth.provenance.producerId !== expectedProducerId) throw new Error("Baseline producer and construction method authority mismatch");
  const seedCatalog = { schemaVersion: "1.0", coreVocabularyVersion: "1.0", entries: truth.vocabulary.entries.filter((entry) => entry.scope === "BUILT_IN") };
  if (canonicalSha256(seedCatalog) !== receipt.seedVocabularyCatalogSha256) throw new Error("Baseline seed vocabulary catalog hash mismatch");
  const expected = new Set<string>([...truth.entities.map((x) => `ENTITY:${x.entityId}`), ...truth.vocabulary.entries.filter((x) => x.scope === "BOOK").map((x) => `VOCABULARY_ENTRY:${x.entryId}`), ...truth.facts.map((x) => `FACT_SLOT:${x.factSlotId}`), ...truth.relations.map((x) => `RELATION:${x.relationId}`)]);
  const actual = new Set(receipt.recordBindings.map((x) => `${x.recordKind}:${bindingIdentity(x)}`));
  if (expected.size !== actual.size || [...expected].some((x) => !actual.has(x))) throw new Error("Baseline record binding coverage has missing or extra records");
  const bindings = new Map(receipt.recordBindings.map((binding) => [`${binding.recordKind}:${bindingIdentity(binding)}`, binding]));
  const validateBoundSource = (recordKind: BaselineRecordBindingV1["recordKind"], recordIdentity: string, sourceValue: TruthRecordSourceV1): void => {
    if (sourceValue.sourceKind !== "BASELINE" || sourceValue.baselineSourceManifestSha256 !== manifestSha || sourceValue.baselineConstructionReceiptSha256 !== receiptSha || sourceValue.baselineRecordId !== bindings.get(`${recordKind}:${recordIdentity}`)?.baselineRecordId) throw new Error("Baseline truth record source does not match its receipt binding authority");
  };
  for (const entity of truth.entities) {
    const sourceValue = entity.declarationSource;
    if (sourceValue.origin !== "BASELINE" || sourceValue.baselineSourceManifestSha256 !== manifestSha || sourceValue.baselineConstructionReceiptSha256 !== receiptSha || sourceValue.baselineRecordId !== bindings.get(`ENTITY:${entity.entityId}`)?.baselineRecordId) throw new Error("Baseline entity source does not match its receipt binding authority");
  }
  for (const entry of truth.vocabulary.entries) if (entry.scope === "BOOK") validateBoundSource("VOCABULARY_ENTRY", entry.entryId, entry.definitionSource);
  for (const fact of truth.facts) validateBoundSource("FACT_SLOT", fact.factSlotId, fact.source);
  for (const relation of truth.relations) validateBoundSource("RELATION", relation.relationId, relation.source);
  return truth;
}
