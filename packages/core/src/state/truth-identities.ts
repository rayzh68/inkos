import type { VocabularyDefinitionV1, BoundTruthNodeRefV1, EntityKindV1 } from "../models/structured-truth.js";
import { assertNfcString, canonicalJson, canonicalSha256, compareUnsignedUtf8 } from "./canonical-json.js";

const SHA256 = /^[0-9a-f]{64}$/;
const CUSTOM_NAME = /^custom\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/;
const IDENTITY_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const CUSTOM_ENTITY_KIND = /^custom\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/;
const BUILT_IN_ENTITY_KINDS = new Set([
  "system.chapter", "story.character", "story.place", "story.object", "story.organization", "story.resource",
  "narrative.hook", "narrative.goal", "narrative.commitment", "narrative.subplot", "narrative.evidence",
]);
const TRUTH_NODE_KINDS = new Set(["ENTITY", "FACT_SLOT", "RELATION"]);
const NON_EMPTY = /[^\u0009\u000a\u000d\u0020]/u;
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains an unknown or missing field`);
}
function nonempty(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value) throw new Error(`${label} must be nonempty`); assertNfcString(value, label); }
function lockedNonempty(value: unknown, label: string): asserts value is string { nonempty(value, label); if (!NON_EMPTY.test(value)) throw new Error(`${label} must be non-empty outside the locked whitespace set`); }
function sha(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lower-case SHA-256`); }
function ordinal(value: unknown): void { if (typeof value !== "string" || !/^op-[0-9]{4}$/.test(value) || Number(value.slice(3)) < 1 || Number(value.slice(3)) > 256) throw new Error("operationId must be op-0001..op-0256"); }
function node(value: BoundTruthNodeRefV1): void { const item = record(value, "truth node"); exactKeys(item, ["nodeKind", "nodeId"], "truth node"); if (!TRUTH_NODE_KINDS.has(value.nodeKind)) throw new Error("Invalid truth node kind"); sha(value.nodeId, "truth node ID"); }
function entityKind(value: unknown): asserts value is EntityKindV1 { if (typeof value !== "string" || (!BUILT_IN_ENTITY_KINDS.has(value) && !CUSTOM_ENTITY_KIND.test(value))) throw new Error("Invalid entity kind"); }
function identityKey(value: unknown): asserts value is string { if (typeof value !== "string" || !IDENTITY_KEY.test(value)) throw new Error("Invalid book-local identity key"); }
function valueContract(value: unknown): void {
  const contract = record(value, "fact value contract");
  if (contract.contractType === "STRING" || contract.contractType === "BOOLEAN" || contract.contractType === "ENTITY_REF") {
    exactKeys(contract, ["contractType"], "fact value contract"); return;
  }
  if (contract.contractType === "INTEGER" || contract.contractType === "DECIMAL") {
    exactKeys(contract, ["contractType", "unit"], "fact value contract");
    if (contract.unit !== null) lockedNonempty(contract.unit, "numeric unit");
    return;
  }
  if (contract.contractType === "ENUM") {
    exactKeys(contract, ["contractType", "allowedValues"], "fact value contract");
    if (!Array.isArray(contract.allowedValues) || contract.allowedValues.length === 0) throw new Error("Invalid enum value contract");
    let previous: string | undefined;
    for (const item of contract.allowedValues) { lockedNonempty(item, "enum value"); if (previous !== undefined && compareUnsignedUtf8(previous, item) >= 0) throw new Error("Enum values must be unique and sorted"); previous = item; }
    return;
  }
  throw new Error("Invalid fact value contract discriminator");
}
function endpointContract(value: unknown, directionality: unknown): void {
  const contract = record(value, "relation endpoint contract");
  exactKeys(contract, ["schemaVersion", "subjectKinds", "objectKinds", "allowReflexive"], "relation endpoint contract");
  if (contract.schemaVersion !== "1.0" || !Array.isArray(contract.subjectKinds) || !Array.isArray(contract.objectKinds) || contract.subjectKinds.length === 0 || contract.objectKinds.length === 0 || typeof contract.allowReflexive !== "boolean") throw new Error("Invalid relation endpoint contract");
  for (const kinds of [contract.subjectKinds, contract.objectKinds]) {
    let previous: string | undefined;
    for (const kind of kinds) { if (typeof kind !== "string" || !TRUTH_NODE_KINDS.has(kind)) throw new Error("Invalid relation endpoint kind"); if (previous !== undefined && compareUnsignedUtf8(previous, kind) >= 0) throw new Error("Relation endpoint kinds must be unique and sorted"); previous = kind; }
  }
  if (directionality !== "DIRECTED" && directionality !== "SYMMETRIC") throw new Error("Invalid relation directionality");
  if (directionality === "SYMMETRIC" && canonicalJson(contract.subjectKinds) !== canonicalJson(contract.objectKinds)) throw new Error("Symmetric relation endpoint kinds must match");
}
function validateDefinition(value: VocabularyDefinitionV1): void {
  const item = record(value, "vocabulary definition");
  if (!CUSTOM_NAME.test(value.canonicalName)) throw new Error("Invalid custom vocabulary name");
  lockedNonempty(value.semanticDefinition, "semantic definition");
  if (value.definitionType === "VOCABULARY_FACT_KEY") {
    exactKeys(item, ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "valueContract"], "fact vocabulary definition");
    if (value.metaKind !== "system.vocabulary.fact-key") throw new Error("Invalid fact vocabulary metaKind");
    valueContract(value.valueContract); return;
  }
  if (value.definitionType === "VOCABULARY_RELATION_PREDICATE") {
    exactKeys(item, ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "subjectObjectContract", "directionality"], "relation vocabulary definition");
    if (value.metaKind !== "system.vocabulary.relation-predicate") throw new Error("Invalid relation vocabulary metaKind");
    endpointContract(value.subjectObjectContract, value.directionality); return;
  }
  throw new Error("Invalid vocabulary definition discriminator");
}

export function deriveChapterDeltaEntityId(input: {
  readonly bookId: string;
  readonly candidateSha256: string;
  readonly declarationOperationId: string;
  readonly entityKind: EntityKindV1;
  readonly identityKey: string;
}): string {
  exactKeys(record(input, "chapter entity identity preimage"), ["bookId", "candidateSha256", "declarationOperationId", "entityKind", "identityKey"], "chapter entity identity preimage");
  nonempty(input.bookId, "bookId"); sha(input.candidateSha256, "candidateSha256"); ordinal(input.declarationOperationId); entityKind(input.entityKind); identityKey(input.identityKey);
  return canonicalSha256({
    domain: "inkos.entity.v1",
    bookId: input.bookId,
    origin: "CHAPTER_DELTA",
    candidateSha256: input.candidateSha256,
    declarationOperationId: input.declarationOperationId,
    entityKind: input.entityKind,
    identityKey: input.identityKey,
  });
}

export function deriveBaselineEntityId(input: {
  readonly bookId: string;
  readonly baselineSourceManifestSha256: string;
  readonly entityKind: EntityKindV1;
  readonly identityKey: string;
}): string {
  exactKeys(record(input, "baseline entity identity preimage"), ["bookId", "baselineSourceManifestSha256", "entityKind", "identityKey"], "baseline entity identity preimage");
  nonempty(input.bookId, "bookId"); sha(input.baselineSourceManifestSha256, "baselineSourceManifestSha256"); entityKind(input.entityKind); identityKey(input.identityKey);
  return canonicalSha256({
    domain: "inkos.entity.v1",
    bookId: input.bookId,
    origin: "BASELINE",
    baselineSourceManifestSha256: input.baselineSourceManifestSha256,
    entityKind: input.entityKind,
    identityKey: input.identityKey,
  });
}

export function deriveFactSlotId(input: {
  readonly bookId: string;
  readonly subjectEntityId: string;
  readonly factKeyEntryId: string;
}): string {
  exactKeys(record(input, "fact-slot identity preimage"), ["bookId", "subjectEntityId", "factKeyEntryId"], "fact-slot identity preimage");
  nonempty(input.bookId, "bookId"); sha(input.subjectEntityId, "subjectEntityId"); sha(input.factKeyEntryId, "factKeyEntryId");
  return canonicalSha256({
    domain: "inkos.fact-slot.v1",
    bookId: input.bookId,
    subjectEntityId: input.subjectEntityId,
    factKeyEntryId: input.factKeyEntryId,
  });
}

export function deriveSemanticMetadataSha256(definition: VocabularyDefinitionV1 | {
  readonly semanticDefinition: string;
  readonly valueContract?: unknown;
  readonly subjectObjectContract?: unknown;
  readonly directionality?: unknown;
}): string {
  const value = record(definition, "semantic metadata preimage");
  if ("definitionType" in value) validateDefinition(value as unknown as VocabularyDefinitionV1);
  else if ("valueContract" in value) {
    exactKeys(value, ["semanticDefinition", "valueContract"], "fact semantic metadata preimage");
    lockedNonempty(value.semanticDefinition, "semanticDefinition"); valueContract(value.valueContract);
  } else {
    exactKeys(value, ["semanticDefinition", "subjectObjectContract", "directionality"], "relation semantic metadata preimage");
    lockedNonempty(value.semanticDefinition, "semanticDefinition"); endpointContract(value.subjectObjectContract, value.directionality);
  }
  if ("valueContract" in value) {
    return canonicalSha256({ semanticDefinition: value.semanticDefinition, valueContract: value.valueContract });
  }
  return canonicalSha256({
    semanticDefinition: value.semanticDefinition,
    subjectObjectContract: value.subjectObjectContract,
    directionality: value.directionality,
  });
}

export function deriveBuiltInVocabularyEntryId(input: {
  readonly entryKind: "FACT_KEY" | "RELATION_PREDICATE";
  readonly canonicalName: string;
  readonly semanticMetadataSha256: string;
}): string {
  exactKeys(record(input, "built-in vocabulary identity preimage"), ["entryKind", "canonicalName", "semanticMetadataSha256"], "built-in vocabulary identity preimage");
  if (input.entryKind !== "FACT_KEY" && input.entryKind !== "RELATION_PREDICATE") throw new Error("Invalid vocabulary entry kind");
  nonempty(input.canonicalName, "canonicalName"); sha(input.semanticMetadataSha256, "semanticMetadataSha256");
  return canonicalSha256({
    domain: "inkos.vocabulary-entry.v1",
    scope: "BUILT_IN",
    vocabularyVersion: "1.0",
    entryKind: input.entryKind,
    canonicalName: input.canonicalName,
    semanticMetadataSha256: input.semanticMetadataSha256,
  });
}

export function deriveCustomVocabularyEntryId(input: {
  readonly bookId: string;
  readonly definition: VocabularyDefinitionV1;
}): string {
  exactKeys(record(input, "custom vocabulary identity preimage"), ["bookId", "definition"], "custom vocabulary identity preimage");
  nonempty(input.bookId, "bookId"); validateDefinition(input.definition);
  const entryKind = input.definition.definitionType === "VOCABULARY_FACT_KEY" ? "FACT_KEY" : "RELATION_PREDICATE";
  return canonicalSha256({
    domain: "inkos.vocabulary-entry.v1",
    scope: "BOOK",
    bookId: input.bookId,
    vocabularySchemaVersion: "1.0",
    entryKind,
    canonicalName: input.definition.canonicalName,
    semanticMetadataSha256: deriveSemanticMetadataSha256(input.definition),
  });
}

export function deriveRelationIdentity(input: {
  readonly bookId: string;
  readonly relationPredicateEntryId: string;
  readonly directionality: "DIRECTED" | "SYMMETRIC";
  readonly subject: BoundTruthNodeRefV1;
  readonly object: BoundTruthNodeRefV1;
}): { readonly relationId: string; readonly subject: BoundTruthNodeRefV1; readonly object: BoundTruthNodeRefV1 } {
  exactKeys(record(input, "relation identity preimage"), ["bookId", "relationPredicateEntryId", "directionality", "subject", "object"], "relation identity preimage");
  nonempty(input.bookId, "bookId"); sha(input.relationPredicateEntryId, "relationPredicateEntryId"); node(input.subject); node(input.object);
  if (input.directionality !== "DIRECTED" && input.directionality !== "SYMMETRIC") throw new Error("Invalid relation directionality");
  if (input.directionality === "DIRECTED") {
    return {
      subject: input.subject,
      object: input.object,
      relationId: canonicalSha256({
        domain: "inkos.relation.v1",
        bookId: input.bookId,
        relationPredicateEntryId: input.relationPredicateEntryId,
        directionality: "DIRECTED",
        endpoints: { subject: input.subject, object: input.object },
      }),
    };
  }
  const [subject, object] = compareUnsignedUtf8(canonicalJson(input.subject), canonicalJson(input.object)) <= 0
    ? [input.subject, input.object]
    : [input.object, input.subject];
  return {
    subject,
    object,
    relationId: canonicalSha256({
      domain: "inkos.relation.v1",
      bookId: input.bookId,
      relationPredicateEntryId: input.relationPredicateEntryId,
      directionality: "SYMMETRIC",
      endpoints: { endpointA: subject, endpointB: object },
    }),
  };
}

export function deriveBaselineRecordId(input: {
  readonly baselineSourceManifestSha256: string;
  readonly recordKind: "ENTITY" | "VOCABULARY_ENTRY" | "FACT_SLOT" | "RELATION";
  readonly recordIdentity: string;
}): string {
  exactKeys(record(input, "baseline record identity preimage"), ["baselineSourceManifestSha256", "recordKind", "recordIdentity"], "baseline record identity preimage");
  sha(input.baselineSourceManifestSha256, "baselineSourceManifestSha256"); sha(input.recordIdentity, "recordIdentity");
  if (!["ENTITY", "VOCABULARY_ENTRY", "FACT_SLOT", "RELATION"].includes(input.recordKind)) throw new Error("Invalid baseline record kind");
  return canonicalSha256({
    domain: "inkos.baseline-record.v1",
    baselineSourceManifestSha256: input.baselineSourceManifestSha256,
    recordKind: input.recordKind,
    recordIdentity: input.recordIdentity,
  });
}
