import type {
  BookFactKeyEntryV1,
  BookRelationPredicateEntryV1,
  FactValueContractV1,
  RelationEndpointContractV1,
  VocabularyCatalogV1,
  VocabularyEntryV1,
} from "../models/structured-truth.js";
import { assertNfcString, canonicalJson, compareUnsignedUtf8, deepFreeze } from "./canonical-json.js";
import {
  deriveBuiltInVocabularyEntryId,
  deriveCustomVocabularyEntryId,
  deriveSemanticMetadataSha256,
} from "./truth-identities.js";

const CUSTOM_NAME = /^custom\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/;
const TRUTH_NODE_KINDS = new Set(["ENTITY", "FACT_SLOT", "RELATION"]);
const SHA256 = /^[0-9a-f]{64}$/;
const NON_EMPTY = /[^\u0009\u000a\u000d\u0020]/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (extra) throw new Error(`${label} has unknown field ${extra}`);
  if (missing) throw new Error(`${label} is missing field ${missing}`);
}

function assertSha(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lower-case SHA-256`);
}

function assertPersistedOperationId(value: unknown): void {
  if (typeof value !== "string" || !/^op-[0-9]{4}$/.test(value) || Number(value.slice(3)) < 1 || Number(value.slice(3)) > 256) throw new Error("Persisted operation ID must be op-0001..op-0256");
}

function assertPersistedEvidenceId(value: unknown): string {
  if (typeof value !== "string" || !/^ev-[0-9]{4}$/.test(value) || Number(value.slice(3)) < 1 || Number(value.slice(3)) > 512) throw new Error("Persisted evidence ID must be ev-0001..ev-0512");
  return value;
}

const S = { contractType: "STRING" } as const;
const B = { contractType: "BOOLEAN" } as const;
const IC = { contractType: "INTEGER", unit: "chapter" } as const;
const IN = { contractType: "INTEGER", unit: null } as const;
const DN = { contractType: "DECIMAL", unit: null } as const;
const HS = { contractType: "ENUM", allowedValues: ["deferred", "open", "progressing", "resolved"] } as const;
const HT = { contractType: "ENUM", allowedValues: ["endgame", "immediate", "mid-arc", "near-term", "slow-burn"] } as const;
const EE_D = { schemaVersion: "1.0", subjectKinds: ["ENTITY"], objectKinds: ["ENTITY"], allowReflexive: false } as const;
const EF_D = { schemaVersion: "1.0", subjectKinds: ["ENTITY"], objectKinds: ["FACT_SLOT", "RELATION"], allowReflexive: false } as const;
const EE_S = { schemaVersion: "1.0", subjectKinds: ["ENTITY"], objectKinds: ["ENTITY"], allowReflexive: false } as const;

const FACT_DEFINITIONS: readonly [string, string, FactValueContractV1][] = [
  ["identity.name", "The current display name of a narrative entity.", S],
  ["lifecycle.type", "The canonical narrative lifecycle classification of a narrative entity.", S],
  ["lifecycle.status", "The current lifecycle status of a narrative entity.", HS],
  ["lifecycle.started_chapter", "The chapter in which a narrative entity first became active.", IC],
  ["lifecycle.last_advanced_chapter", "The latest chapter in which a narrative entity materially advanced.", IC],
  ["lifecycle.expected_payoff", "The expected narrative payoff of a hook, goal, commitment, or subplot.", S],
  ["lifecycle.payoff_timing", "The planned timing class for a narrative payoff.", HT],
  ["lifecycle.notes", "Canonical supporting notes for a narrative lifecycle record.", S],
  ["lifecycle.pays_off_in_arc", "The canonical arc identifier in which a narrative payoff is planned.", S],
  ["lifecycle.core", "Whether the narrative entity is designated as core.", B],
  ["lifecycle.half_life_chapters", "The maximum intended chapters between meaningful advances of a narrative entity.", IC],
  ["lifecycle.advanced_count", "The number of chapters in which the narrative entity has materially advanced.", IN],
  ["summary.chapter_number", "The canonical chapter number represented by a chapter entity.", IC],
  ["summary.title", "The title of a chapter.", S],
  ["summary.characters", "A canonical prose summary of characters materially present in a chapter.", S],
  ["summary.events", "A canonical prose summary of material events in a chapter.", S],
  ["summary.state_changes", "A canonical prose summary of durable state changes in a chapter.", S],
  ["summary.hook_activity", "A canonical prose summary of hook activity in a chapter.", S],
  ["summary.mood", "The canonical prose description of a chapter mood.", S],
  ["summary.chapter_type", "The canonical prose classification of a chapter type.", S],
  ["state.status", "The current durable narrative status of an entity when no lifecycle status contract applies.", S],
  ["resource.amount", "The current absolute quantity associated with a resource entity.", DN],
  ["emotion.state", "The current named emotional state associated with a narrative entity.", S],
];

const RELATION_DEFINITIONS: readonly [string, string, RelationEndpointContractV1, "DIRECTED" | "SYMMETRIC"][] = [
  ["causality.depends-on", "The subject narrative entity depends causally on the object narrative entity.", EE_D, "DIRECTED"],
  ["location.at", "The subject narrative entity is located at the object narrative entity.", EE_D, "DIRECTED"],
  ["ownership.owns", "The subject narrative entity owns the object narrative entity.", EE_D, "DIRECTED"],
  ["possession.holds", "The subject narrative entity physically possesses the object narrative entity.", EE_D, "DIRECTED"],
  ["knowledge.knows", "The subject narrative entity knows the asserted fact or relation represented by the object truth node.", EF_D, "DIRECTED"],
  ["epistemic.believes", "The subject narrative entity believes the asserted fact or relation represented by the object truth node.", EF_D, "DIRECTED"],
  ["epistemic.supports", "The subject evidence entity supports the asserted fact or relation represented by the object truth node.", EF_D, "DIRECTED"],
  ["relationship.related-to", "The subject and object narrative entities have a durable narrative relationship.", EE_S, "SYMMETRIC"],
  ["participation.in", "The subject narrative entity participates in the object narrative entity.", EE_D, "DIRECTED"],
];

function builtInFact(canonicalName: string, semanticDefinition: string, valueContract: FactValueContractV1): VocabularyEntryV1 {
  const definition = { semanticDefinition, valueContract };
  const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
  return {
    entryId: deriveBuiltInVocabularyEntryId({ entryKind: "FACT_KEY", canonicalName, semanticMetadataSha256 }),
    scope: "BUILT_IN", entryKind: "FACT_KEY", vocabularyVersion: "1.0", canonicalName,
    semanticDefinition, semanticMetadataSha256, valueContract,
  };
}

function builtInRelation(canonicalName: string, semanticDefinition: string, subjectObjectContract: RelationEndpointContractV1, directionality: "DIRECTED" | "SYMMETRIC"): VocabularyEntryV1 {
  const definition = { semanticDefinition, subjectObjectContract, directionality };
  const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
  return {
    entryId: deriveBuiltInVocabularyEntryId({ entryKind: "RELATION_PREDICATE", canonicalName, semanticMetadataSha256 }),
    scope: "BUILT_IN", entryKind: "RELATION_PREDICATE", vocabularyVersion: "1.0", canonicalName,
    semanticDefinition, semanticMetadataSha256, subjectObjectContract, directionality,
  };
}

export const BUILT_IN_TRUTH_VOCABULARY_V1: readonly VocabularyEntryV1[] = deepFreeze([
  ...FACT_DEFINITIONS.map(([name, definition, contract]) => builtInFact(name, definition, contract)),
  ...RELATION_DEFINITIONS.map(([name, definition, contract, directionality]) => builtInRelation(name, definition, contract, directionality)),
].sort((left, right) => compareUnsignedUtf8(left.entryId, right.entryId)));

export const BUILT_IN_ENTRY_IDS_BY_NAME_V1: Readonly<Record<string, string>> = deepFreeze(Object.fromEntries(
  BUILT_IN_TRUTH_VOCABULARY_V1.map((entry) => [entry.canonicalName, entry.entryId]),
));

function validateValueContract(contract: FactValueContractV1): void {
  const value = object(contract, "fact value contract");
  if (contract.contractType === "STRING" || contract.contractType === "BOOLEAN" || contract.contractType === "ENTITY_REF") {
    exactKeys(value, ["contractType"], "fact value contract");
    return;
  }
  if (contract.contractType === "INTEGER" || contract.contractType === "DECIMAL") {
    exactKeys(value, ["contractType", "unit"], "fact value contract");
    if (contract.unit !== null) { assertNfcString(contract.unit, "numeric unit"); if (!NON_EMPTY.test(contract.unit)) throw new Error("numeric unit must be nonempty"); }
    return;
  }
  exactKeys(value, ["contractType", "allowedValues"], "fact value contract");
  if (contract.contractType !== "ENUM" || contract.allowedValues.length === 0) throw new Error("Invalid fact value contract");
  for (const value of contract.allowedValues) { assertNfcString(value, "enum value"); if (!NON_EMPTY.test(value)) throw new Error("enum value must be nonempty"); }
  assertSortedUniqueStrings(contract.allowedValues, "enum values");
}

function assertSortedUniqueStrings(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const comparison = compareUnsignedUtf8(values[index - 1]!, values[index]!);
    if (comparison === 0) throw new Error(`${label} must be unique`);
    if (comparison > 0) throw new Error(`${label} must be sorted`);
  }
}

function validateEndpointContract(contract: RelationEndpointContractV1, directionality: "DIRECTED" | "SYMMETRIC"): void {
  exactKeys(object(contract, "relation endpoint contract"), ["schemaVersion", "subjectKinds", "objectKinds", "allowReflexive"], "relation endpoint contract");
  if (contract.schemaVersion !== "1.0" || contract.subjectKinds.length === 0 || contract.objectKinds.length === 0) throw new Error("Invalid relation endpoint contract");
  if (!Array.isArray(contract.subjectKinds) || !Array.isArray(contract.objectKinds) || typeof contract.allowReflexive !== "boolean") throw new Error("Invalid relation endpoint contract");
  if (contract.subjectKinds.some((kind) => !TRUTH_NODE_KINDS.has(kind)) || contract.objectKinds.some((kind) => !TRUTH_NODE_KINDS.has(kind))) throw new Error("Unknown relation endpoint kind");
  assertSortedUniqueStrings(contract.subjectKinds, "subjectKinds");
  assertSortedUniqueStrings(contract.objectKinds, "objectKinds");
  if (directionality === "SYMMETRIC" && canonicalJson(contract.subjectKinds) !== canonicalJson(contract.objectKinds)) throw new Error("Symmetric endpoint kind sets must match");
}

function validateCustomEntry(entry: BookFactKeyEntryV1 | BookRelationPredicateEntryV1): void {
  const value = object(entry, "book vocabulary entry");
  exactKeys(value, entry.entryKind === "FACT_KEY"
    ? ["entryId", "scope", "entryKind", "bookId", "vocabularySchemaVersion", "canonicalName", "semanticDefinition", "semanticMetadataSha256", "valueContract", "definitionSource"]
    : ["entryId", "scope", "entryKind", "bookId", "vocabularySchemaVersion", "canonicalName", "semanticDefinition", "semanticMetadataSha256", "subjectObjectContract", "directionality", "definitionSource"], "book vocabulary entry");
  if (entry.scope !== "BOOK" || (entry.entryKind !== "FACT_KEY" && entry.entryKind !== "RELATION_PREDICATE") || entry.vocabularySchemaVersion !== "1.0" || typeof entry.bookId !== "string" || !entry.bookId) throw new Error("Invalid book vocabulary entry root");
  if (!CUSTOM_NAME.test(entry.canonicalName)) throw new Error(`Invalid custom vocabulary name: ${entry.canonicalName}`);
  assertNfcString(entry.semanticDefinition, "semantic definition");
  if (!NON_EMPTY.test(entry.semanticDefinition)) throw new Error("semantic definition must be nonempty");
  assertSha(entry.entryId, "custom EntryId");
  assertSha(entry.semanticMetadataSha256, "semantic metadata SHA");
  const definitionSource = object(entry.definitionSource, "vocabulary definition source");
  if (entry.definitionSource.sourceKind === "BASELINE") {
    exactKeys(definitionSource, ["sourceKind", "baselineSourceManifestSha256", "baselineConstructionReceiptSha256", "baselineRecordId"], "baseline vocabulary definition source");
    assertSha(entry.definitionSource.baselineSourceManifestSha256, "baseline source manifest SHA");
    assertSha(entry.definitionSource.baselineConstructionReceiptSha256, "baseline construction receipt SHA");
    assertSha(entry.definitionSource.baselineRecordId, "baseline record ID");
  } else if (entry.definitionSource.sourceKind === "CHAPTER_DELTA") {
    exactKeys(definitionSource, ["sourceKind", "candidateSha256", "deltaId", "operationId", "evidenceIds"], "delta vocabulary definition source");
    assertSha(entry.definitionSource.candidateSha256, "candidate SHA");
    assertSha(entry.definitionSource.deltaId, "delta ID");
    assertPersistedOperationId(entry.definitionSource.operationId);
    if (!Array.isArray(entry.definitionSource.evidenceIds) || entry.definitionSource.evidenceIds.length === 0) throw new Error("Invalid delta vocabulary definition source");
    for (const evidenceId of entry.definitionSource.evidenceIds) assertPersistedEvidenceId(evidenceId);
    assertSortedUniqueStrings(entry.definitionSource.evidenceIds, "definition evidence IDs");
  } else throw new Error("Invalid vocabulary definition source kind");
  const definition = entry.entryKind === "FACT_KEY"
    ? { definitionType: "VOCABULARY_FACT_KEY" as const, metaKind: "system.vocabulary.fact-key" as const, canonicalName: entry.canonicalName, semanticDefinition: entry.semanticDefinition, valueContract: entry.valueContract }
    : { definitionType: "VOCABULARY_RELATION_PREDICATE" as const, metaKind: "system.vocabulary.relation-predicate" as const, canonicalName: entry.canonicalName, semanticDefinition: entry.semanticDefinition, subjectObjectContract: entry.subjectObjectContract, directionality: entry.directionality };
  if (entry.entryKind === "FACT_KEY") validateValueContract(entry.valueContract);
  else { if (entry.directionality !== "DIRECTED" && entry.directionality !== "SYMMETRIC") throw new Error("Invalid relation directionality"); validateEndpointContract(entry.subjectObjectContract, entry.directionality); }
  const metadata = deriveSemanticMetadataSha256(definition);
  if (metadata !== entry.semanticMetadataSha256) throw new Error(`Custom vocabulary metadata hash mismatch for ${entry.canonicalName}`);
  if (deriveCustomVocabularyEntryId({ bookId: entry.bookId, definition }) !== entry.entryId) throw new Error(`Custom vocabulary EntryId mismatch for ${entry.canonicalName}`);
}

export function validateVocabularyCatalogV1(catalog: VocabularyCatalogV1): VocabularyCatalogV1 {
  exactKeys(object(catalog, "VocabularyCatalogV1"), ["schemaVersion", "coreVocabularyVersion", "entries"], "VocabularyCatalogV1");
  if (catalog.schemaVersion !== "1.0" || catalog.coreVocabularyVersion !== "1.0" || !Array.isArray(catalog.entries)) throw new Error("Invalid VocabularyCatalogV1");
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const entry of catalog.entries) {
    if ((entry.scope !== "BUILT_IN" && entry.scope !== "BOOK") || (entry.entryKind !== "FACT_KEY" && entry.entryKind !== "RELATION_PREDICATE")) throw new Error("Vocabulary entry must match the exact four-way union");
    if (seenIds.has(entry.entryId) || seenNames.has(entry.canonicalName)) throw new Error("Vocabulary entries must be duplicate-free and unique");
    seenIds.add(entry.entryId);
    seenNames.add(entry.canonicalName);
  }
  assertSortedUniqueStrings(catalog.entries.map((entry) => entry.entryId), "vocabulary entries");
  const builtIns = catalog.entries.filter((entry) => entry.scope === "BUILT_IN");
  if (canonicalJson(builtIns) !== canonicalJson(BUILT_IN_TRUTH_VOCABULARY_V1)) throw new Error("Built-in vocabulary manifest mismatch");
  const bookIds = new Set<string>();
  for (const entry of catalog.entries) {
    if (entry.scope === "BOOK") { bookIds.add(entry.bookId); validateCustomEntry(entry); }
  }
  if (bookIds.size > 1) throw new Error("Custom vocabulary entries must share one bookId");
  return catalog;
}

export function createVocabularyCatalogV1(customEntries: readonly (BookFactKeyEntryV1 | BookRelationPredicateEntryV1)[]): VocabularyCatalogV1 {
  const catalog: VocabularyCatalogV1 = {
    schemaVersion: "1.0",
    coreVocabularyVersion: "1.0",
    entries: structuredClone([...BUILT_IN_TRUTH_VOCABULARY_V1, ...customEntries]).sort((left, right) => compareUnsignedUtf8(left.entryId, right.entryId)),
  };
  validateVocabularyCatalogV1(catalog);
  return deepFreeze(catalog);
}

export function getVocabularyEntryV1(catalog: VocabularyCatalogV1, entryId: string): VocabularyEntryV1 {
  const entry = catalog.entries.find((candidate) => candidate.entryId === entryId);
  if (!entry) throw new Error(`Unknown vocabulary EntryId: ${entryId}`);
  return entry;
}
