import type {
  AmbiguityV1,
  BoundChapterDeltaBodyV1,
  BoundOperationV1,
  ChapterDeltaAdmissionResultV1,
  ChapterDeltaHostBindingV1,
  ChapterDeltaProposalV1,
  EntityRefV1,
  EvidenceV1,
  FactBeforeV1,
  FactKeyEntryRefV1,
  ProposedEvidenceV1,
  ProposedFactAssertionV1,
  ProposedFactBeforeV1,
  ProposedFactValueV1,
  ProposedOperationV1,
  RelationBeforeV1,
  RelationPredicateEntryRefV1,
  TruthNodeRefV1,
} from "../models/chapter-delta.js";
import {
  assertBookLocalIdentityKey,
  assertEntityKindV1,
  assertNonEmptyNfcString,
  validateNarrativeEntityDefinitionV1,
  validateStructuredTruthV1,
  type BoundTruthNodeRefV1,
  type CanonicalFactValueV1,
  type EntityDefinitionV1,
  type FactAssertionV1,
  type RelationAssertionV1,
  type StructuredTruthV1,
  type VocabularyDefinitionV1,
  type VocabularyEntryV1,
} from "../models/structured-truth.js";
import {
  assertNfcString,
  assertSafeUnsignedInteger,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  compareUnsignedUtf8,
  deepFreeze,
  parseJsonRejectingDuplicates,
  sha256Utf8,
} from "./canonical-json.js";
import {
  deriveChapterDeltaEntityId,
  deriveCustomVocabularyEntryId,
  deriveFactSlotId,
  deriveRelationIdentity,
  deriveSemanticMetadataSha256,
} from "./truth-identities.js";
import { getVocabularyEntryV1, validateVocabularyCatalogV1 } from "./truth-vocabulary.js";

const MAX_BYTES = 2_097_152;
const SHA = /^[0-9a-f]{64}$/;
const CUSTOM_NAME = /^custom\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/;
const INTEGER = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]*[1-9]$/;
const HOST_KEYS = ["transactionId", "attemptId", "bookId", "chapterNumber", "candidateSha256", "predecessorCommitSha256", "predecessorTruthSha256", "predecessorVocabularyCatalogSha256", "extractorLogicalOperationId", "extractorInputFingerprint", "providerArtifactSha256", "responseContentSha256"] as const;
const BODY_KEYS = ["schemaVersion", ...HOST_KEYS, "proposedDeltaCanonicalSha256", "evidence", "operations"] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) throw new Error(`${label} has unknown field ${extra}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${label} is missing field ${missing}`);
}

function assertSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`${label} must be a lower-case SHA-256`);
  return value;
}

function assertOrdinal(value: unknown, prefix: "op" | "ev" | "amb", ordinal: number, maximum: number): string {
  const expected = `${prefix}-${String(ordinal).padStart(4, "0")}`;
  if (typeof value !== "string" || value !== expected || ordinal < 1 || ordinal > maximum) {
    throw new Error(`${prefix} identity must equal array ordinal ${expected}`);
  }
  return value;
}

function sortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const comparison = compareUnsignedUtf8(values[index - 1]!, values[index]!);
    if (comparison === 0) throw new Error(`${label} must be unique`);
    if (comparison > 0) throw new Error(`${label} must be canonically sorted`);
  }
}

function validateEvidenceIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) throw new Error(`${label} evidenceIds must be nonempty`);
  sortedUnique(value, `${label} evidenceIds`);
  return value;
}

function validateFactValue(value: unknown): CanonicalFactValueV1 {
  const item = object(value, "fact value");
  exactKeys(item, ["valueType", "value"], "fact value");
  if (item.valueType === "STRING") assertNfcString(item.value, "STRING value");
  else if (item.valueType === "BOOLEAN") {
    if (typeof item.value !== "boolean") throw new Error("BOOLEAN value must be boolean");
  } else if (item.valueType === "INTEGER") {
    if (typeof item.value !== "string" || !INTEGER.test(item.value)) throw new Error("INTEGER value is not canonical");
  } else if (item.valueType === "DECIMAL") {
    if (typeof item.value !== "string" || !DECIMAL.test(item.value)) throw new Error("DECIMAL value is not canonical");
  } else if (item.valueType === "ENTITY_REF") {
    const ref = object(item.value, "ENTITY_REF value");
    exactKeys(ref, ["nodeKind", "nodeId"], "ENTITY_REF value");
    if (ref.nodeKind !== "ENTITY") throw new Error("ENTITY_REF must address an ENTITY");
    assertSha(ref.nodeId, "ENTITY_REF nodeId");
  } else throw new Error(`Unknown fact value type ${String(item.valueType)}`);
  return value as CanonicalFactValueV1;
}

function validateFactAssertion(value: unknown, allowUnknown: boolean): FactBeforeV1 | FactAssertionV1 {
  const item = object(value, "fact assertion");
  if (item.state === "UNKNOWN") {
    exactKeys(item, ["state"], "fact assertion");
    if (!allowUnknown) throw new Error("UNKNOWN is not a stored SET assertion");
  } else if (item.state === "ABSENT") exactKeys(item, ["state"], "fact assertion");
  else if (item.state === "VALUE") { exactKeys(item, ["state", "value"], "fact assertion"); validateFactValue(item.value); }
  else throw new Error("Invalid fact assertion state");
  return value as FactBeforeV1 | FactAssertionV1;
}

function validateProposedFactValue(value: unknown): ProposedFactValueV1 {
  const item = object(value, "proposed fact value");
  if (item.valueType === "ENTITY_REF") {
    exactKeys(item, ["valueType", "entity"], "proposed ENTITY_REF fact value");
    validateEntityRef(item.entity);
  } else validateFactValue(value);
  return value as ProposedFactValueV1;
}

function validateProposedFactAssertion(value: unknown, allowUnknown: boolean): ProposedFactBeforeV1 | ProposedFactAssertionV1 {
  const item = object(value, "proposed fact assertion");
  if (item.state === "UNKNOWN") {
    exactKeys(item, ["state"], "proposed fact assertion");
    if (!allowUnknown) throw new Error("UNKNOWN is not a proposed SET assertion");
  } else if (item.state === "ABSENT") exactKeys(item, ["state"], "proposed fact assertion");
  else if (item.state === "VALUE") { exactKeys(item, ["state", "value"], "proposed fact assertion"); validateProposedFactValue(item.value); }
  else throw new Error("Invalid proposed fact assertion state");
  return value as ProposedFactBeforeV1 | ProposedFactAssertionV1;
}

function validateRelationAssertion(value: unknown, allowUnknown: boolean): RelationBeforeV1 | RelationAssertionV1 {
  const item = object(value, "relation assertion");
  exactKeys(item, ["state"], "relation assertion");
  if (!(["PRESENT", "ABSENT"] as const).includes(item.state as "PRESENT" | "ABSENT") && !(allowUnknown && item.state === "UNKNOWN")) throw new Error("Invalid relation assertion state");
  return value as RelationBeforeV1 | RelationAssertionV1;
}

function validateEntityRef(value: unknown): EntityRefV1 {
  const item = object(value, "entity reference");
  if (item.refType === "ENTITY_ID") { exactKeys(item, ["refType", "entityId"], "entity reference"); assertSha(item.entityId, "entityId"); }
  else if (item.refType === "LOCAL_ENTITY") { exactKeys(item, ["refType", "localRef"], "entity reference"); if (typeof item.localRef !== "string") throw new Error("Invalid local entity reference"); }
  else throw new Error("Invalid entity reference type");
  return value as EntityRefV1;
}

function validateEntryRef(value: unknown, kind: "FACT" | "RELATION"): FactKeyEntryRefV1 | RelationPredicateEntryRefV1 {
  const item = object(value, `${kind} vocabulary reference`);
  const idType = kind === "FACT" ? "FACT_KEY_ENTRY_ID" : "RELATION_PREDICATE_ENTRY_ID";
  const localType = kind === "FACT" ? "LOCAL_FACT_KEY" : "LOCAL_RELATION_PREDICATE";
  if (item.refType === idType) { exactKeys(item, ["refType", "entryId"], "vocabulary reference"); assertSha(item.entryId, "EntryId"); }
  else if (item.refType === localType) { exactKeys(item, ["refType", "localRef"], "vocabulary reference"); if (typeof item.localRef !== "string") throw new Error("Invalid local vocabulary reference"); }
  else throw new Error(`Invalid ${kind.toLowerCase()} vocabulary reference type`);
  return value as FactKeyEntryRefV1 | RelationPredicateEntryRefV1;
}

function validateTruthNodeRef(value: unknown): TruthNodeRefV1 {
  const item = object(value, "truth node reference");
  if (item.refType === "NODE_ID") {
    exactKeys(item, ["nodeKind", "refType", "nodeId"], "truth node reference");
    if (!(["ENTITY", "FACT_SLOT", "RELATION"] as const).includes(item.nodeKind as "ENTITY")) throw new Error("Invalid truth node kind");
    assertSha(item.nodeId, "truth node ID");
  } else if (item.refType === "LOCAL_ENTITY") {
    exactKeys(item, ["nodeKind", "refType", "localRef"], "truth node reference");
    if (item.nodeKind !== "ENTITY" || typeof item.localRef !== "string") throw new Error("Invalid LOCAL_ENTITY node reference");
  } else if (item.refType === "OPERATION_TARGET") {
    exactKeys(item, ["nodeKind", "refType", "targetOperationId"], "truth node reference");
    if (!(["FACT_SLOT", "RELATION"] as const).includes(item.nodeKind as "FACT_SLOT") || typeof item.targetOperationId !== "string") throw new Error("Invalid operation target node reference");
  } else throw new Error("Invalid truth node reference type");
  return value as TruthNodeRefV1;
}

function validateValueContract(value: unknown): void {
  const item = object(value, "value contract");
  if (item.contractType === "STRING" || item.contractType === "BOOLEAN" || item.contractType === "ENTITY_REF") exactKeys(item, ["contractType"], "value contract");
  else if (item.contractType === "INTEGER" || item.contractType === "DECIMAL") {
    exactKeys(item, ["contractType", "unit"], "value contract");
    if (item.unit !== null) assertNonEmptyNfcString(item.unit, "numeric unit");
  } else if (item.contractType === "ENUM") {
    exactKeys(item, ["contractType", "allowedValues"], "value contract");
    if (!Array.isArray(item.allowedValues) || item.allowedValues.length === 0) throw new Error("ENUM allowedValues must be nonempty");
    item.allowedValues.forEach((entry) => assertNonEmptyNfcString(entry, "enum value"));
    sortedUnique(item.allowedValues as string[], "enum values");
  } else throw new Error("Invalid fact value contract");
}

function validateDefinition(value: unknown): EntityDefinitionV1 {
  const item = object(value, "entity definition");
  if (item.definitionType === "NARRATIVE_ENTITY") return validateNarrativeEntityDefinitionV1(value);
  if (item.definitionType === "VOCABULARY_FACT_KEY") {
    exactKeys(item, ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "valueContract"], "fact-key definition");
    if (item.metaKind !== "system.vocabulary.fact-key" || typeof item.canonicalName !== "string" || !CUSTOM_NAME.test(item.canonicalName)) throw new Error("Invalid custom fact-key definition");
    assertNonEmptyNfcString(item.semanticDefinition, "semantic definition");
    validateValueContract(item.valueContract);
  } else if (item.definitionType === "VOCABULARY_RELATION_PREDICATE") {
    exactKeys(item, ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "subjectObjectContract", "directionality"], "relation-predicate definition");
    if (item.metaKind !== "system.vocabulary.relation-predicate" || typeof item.canonicalName !== "string" || !CUSTOM_NAME.test(item.canonicalName)) throw new Error("Invalid custom relation-predicate definition");
    assertNonEmptyNfcString(item.semanticDefinition, "semantic definition");
    if (item.directionality !== "DIRECTED" && item.directionality !== "SYMMETRIC") throw new Error("Invalid relation directionality");
    const contract = object(item.subjectObjectContract, "subject/object contract");
    exactKeys(contract, ["schemaVersion", "subjectKinds", "objectKinds", "allowReflexive"], "subject/object contract");
    if (contract.schemaVersion !== "1.0" || typeof contract.allowReflexive !== "boolean" || !Array.isArray(contract.subjectKinds) || !Array.isArray(contract.objectKinds)
      || contract.subjectKinds.length === 0 || contract.objectKinds.length === 0) throw new Error("Invalid relation endpoint contract");
    for (const kind of [...contract.subjectKinds, ...contract.objectKinds]) if (!(["ENTITY", "FACT_SLOT", "RELATION"] as const).includes(kind as "ENTITY")) throw new Error("Invalid relation endpoint kind");
    sortedUnique(contract.subjectKinds as string[], "subjectKinds");
    sortedUnique(contract.objectKinds as string[], "objectKinds");
    if (item.directionality === "SYMMETRIC" && canonicalJson(contract.subjectKinds) !== canonicalJson(contract.objectKinds)) throw new Error("Symmetric endpoint-kind sets must match");
  } else throw new Error("Invalid entity definition type");
  return value as EntityDefinitionV1;
}

function validateOperation(value: unknown, ordinal: number): ProposedOperationV1 {
  const item = object(value, "operation");
  assertOrdinal(item.operationId, "op", ordinal, 256);
  const evidenceIds = item.evidenceIds;
  if (item.kind === "DECLARE_ENTITY") {
    exactKeys(item, ["kind", "operationId", "localRef", "before", "after", "evidenceIds"], "DECLARE_ENTITY");
    if (item.localRef !== `local:${item.operationId}`) throw new Error("localRef must equal local:${declaringOperationId}");
    const before = object(item.before, "DECLARE_ENTITY before"); exactKeys(before, ["state"], "DECLARE_ENTITY before");
    const after = object(item.after, "DECLARE_ENTITY after"); exactKeys(after, ["state", "definition"], "DECLARE_ENTITY after");
    if (before.state !== "ABSENT" || after.state !== "PRESENT") throw new Error("Invalid DECLARE_ENTITY transition");
    validateDefinition(after.definition);
  } else if (item.kind === "SET_FACT") {
    exactKeys(item, ["kind", "operationId", "subject", "factKey", "before", "after", "evidenceIds"], "SET_FACT");
    validateEntityRef(item.subject); validateEntryRef(item.factKey, "FACT"); validateProposedFactAssertion(item.before, true); validateProposedFactAssertion(item.after, false);
  } else if (item.kind === "RETRACT_FACT") {
    exactKeys(item, ["kind", "operationId", "subject", "factKey", "before", "after", "evidenceIds"], "RETRACT_FACT");
    validateEntityRef(item.subject); validateEntryRef(item.factKey, "FACT"); validateProposedFactAssertion(item.before, false);
    const after = object(item.after, "RETRACT_FACT after"); exactKeys(after, ["state"], "RETRACT_FACT after"); if (after.state !== "UNKNOWN") throw new Error("RETRACT_FACT after must be UNKNOWN");
  } else if (item.kind === "SET_RELATION") {
    exactKeys(item, ["kind", "operationId", "subject", "relationPredicate", "object", "before", "after", "evidenceIds"], "SET_RELATION");
    validateTruthNodeRef(item.subject); validateEntryRef(item.relationPredicate, "RELATION"); validateTruthNodeRef(item.object); validateRelationAssertion(item.before, true); validateRelationAssertion(item.after, false);
  } else if (item.kind === "RETRACT_RELATION") {
    exactKeys(item, ["kind", "operationId", "subject", "relationPredicate", "object", "before", "after", "evidenceIds"], "RETRACT_RELATION");
    validateTruthNodeRef(item.subject); validateEntryRef(item.relationPredicate, "RELATION"); validateTruthNodeRef(item.object); validateRelationAssertion(item.before, false);
    const after = object(item.after, "RETRACT_RELATION after"); exactKeys(after, ["state"], "RETRACT_RELATION after"); if (after.state !== "UNKNOWN") throw new Error("RETRACT_RELATION after must be UNKNOWN");
  } else throw new Error(`Unknown operation kind ${String(item.kind)}`);
  validateEvidenceIds(evidenceIds, String(item.operationId));
  return value as ProposedOperationV1;
}

function validateEvidence(value: unknown, ordinal: number, candidate: string, predecessor: StructuredTruthV1): ProposedEvidenceV1 {
  const item = object(value, "evidence");
  assertOrdinal(item.evidenceId, "ev", ordinal, 512);
  if (item.kind === "FINAL_PROSE_SPAN") {
    exactKeys(item, ["kind", "evidenceId", "startUtf16", "endUtf16", "quote"], "FINAL_PROSE_SPAN evidence");
    const start = assertSafeUnsignedInteger(item.startUtf16, "startUtf16");
    const end = assertSafeUnsignedInteger(item.endUtf16, "endUtf16");
    if (start >= end || end > candidate.length) throw new Error("Invalid evidence UTF-16 range");
    if (start > 0 && /[\ud800-\udbff]/.test(candidate[start - 1]!) && /[\udc00-\udfff]/.test(candidate[start]!)) throw new Error("Evidence boundary splits a surrogate pair");
    if (end > 0 && end < candidate.length && /[\ud800-\udbff]/.test(candidate[end - 1]!) && /[\udc00-\udfff]/.test(candidate[end]!)) throw new Error("Evidence boundary splits a surrogate pair");
    if (typeof item.quote !== "string" || item.quote.length > 4096 || item.quote !== candidate.slice(start, end)) throw new Error("Evidence quote mismatch or exceeds 4096 UTF-16 code units");
  } else if (item.kind === "PREDECESSOR_TRUTH_RECORD") {
    exactKeys(item, ["kind", "evidenceId", "recordRef", "recordSha256"], "PREDECESSOR_TRUTH_RECORD evidence");
    const ref = object(item.recordRef, "predecessor record ref"); exactKeys(ref, ["nodeKind", "nodeId"], "predecessor record ref");
    if (!( ["ENTITY", "FACT_SLOT", "RELATION"] as const).includes(ref.nodeKind as "ENTITY")) throw new Error("Invalid predecessor record node kind");
    assertSha(ref.nodeId, "record nodeId");
    const recordValue = findPredecessorNode(predecessor, ref as unknown as BoundTruthNodeRefV1);
    if (!recordValue || canonicalSha256(recordValue) !== item.recordSha256) throw new Error("Predecessor evidence record hash mismatch");
  } else throw new Error("Invalid evidence kind");
  return value as ProposedEvidenceV1;
}

function validateAmbiguity(value: unknown, ordinal: number): AmbiguityV1 {
  const item = object(value, "ambiguity");
  exactKeys(item, ["ambiguityId", "classification", "description", "proseEvidenceIds", "predecessorEvidenceIds", "relatedOperationIds", "relatedNodeRefs"], "ambiguity");
  assertOrdinal(item.ambiguityId, "amb", ordinal, 512);
  const classifications = ["PROSE_SEMANTICS_UNRESOLVED", "PREDECESSOR_AUTHORITY_CONFLICT", "ENTITY_IDENTITY_UNRESOLVED", "VOCABULARY_MAPPING_UNRESOLVED", "EVIDENCE_INSUFFICIENT"];
  if (!classifications.includes(String(item.classification))) throw new Error("Invalid ambiguity classification");
  assertNonEmptyNfcString(item.description, "ambiguity description");
  for (const key of ["proseEvidenceIds", "predecessorEvidenceIds", "relatedOperationIds", "relatedNodeRefs"] as const) if (!Array.isArray(item[key])) throw new Error(`ambiguity ${key} must be an array`);
  const prose = item.proseEvidenceIds as string[]; const prior = item.predecessorEvidenceIds as string[];
  if (prose.length + prior.length === 0) throw new Error("Ambiguity evidence references must be nonempty");
  if (item.classification === "PROSE_SEMANTICS_UNRESOLVED" && prose.length === 0) throw new Error("Prose ambiguity requires prose evidence");
  if (item.classification === "PREDECESSOR_AUTHORITY_CONFLICT" && prior.length === 0) throw new Error("Predecessor conflict requires predecessor evidence");
  sortedUnique(prose, "ambiguity prose evidence"); sortedUnique(prior, "ambiguity predecessor evidence"); sortedUnique(item.relatedOperationIds as string[], "ambiguity operations");
  for (const ref of item.relatedNodeRefs as unknown[]) { const node = object(ref, "related node"); exactKeys(node, ["nodeKind", "nodeId"], "related node"); if (!( ["ENTITY", "FACT_SLOT", "RELATION"] as const).includes(node.nodeKind as "ENTITY")) throw new Error("Invalid ambiguity related node kind; expected ENTITY, FACT_SLOT, or RELATION"); assertSha(node.nodeId, "related nodeId"); }
  return value as AmbiguityV1;
}

function validateProposal(input: unknown, candidate: string, predecessor: StructuredTruthV1): ChapterDeltaProposalV1 {
  const value = object(input, "ChapterDeltaProposalV1");
  exactKeys(value, ["schemaVersion", "kind", "status", "operations", "evidence", "ambiguities"], "ChapterDeltaProposalV1");
  if (value.schemaVersion !== "1.0" || value.kind !== "CHAPTER_DELTA_PROPOSAL" || (value.status !== "READY" && value.status !== "AMBIGUOUS")) throw new Error("Invalid ChapterDeltaProposalV1 root");
  if (!Array.isArray(value.operations) || value.operations.length > 256) throw new Error("operations must contain 0..256 records");
  if (!Array.isArray(value.evidence) || value.evidence.length > 512) throw new Error("evidence must contain 0..512 records");
  if (!Array.isArray(value.ambiguities) || value.ambiguities.length > 512 || (value.status === "READY" ? value.ambiguities.length !== 0 : value.ambiguities.length === 0)) throw new Error("Proposal status/ambiguities mismatch");
  value.operations.forEach((operation, index) => validateOperation(operation, index + 1));
  value.evidence.forEach((evidence, index) => validateEvidence(evidence, index + 1, candidate, predecessor));
  value.ambiguities.forEach((ambiguity, index) => validateAmbiguity(ambiguity, index + 1));
  const proposal = input as ChapterDeltaProposalV1;
  const evidence = new Map(proposal.evidence.map((item) => [item.evidenceId, item]));
  const operations = new Set(proposal.operations.map((item) => item.operationId));
  for (const ambiguity of proposal.ambiguities) {
    for (const evidenceId of ambiguity.proseEvidenceIds) if (evidence.get(evidenceId)?.kind !== "FINAL_PROSE_SPAN") throw new Error("Ambiguity prose evidence must resolve to FINAL_PROSE_SPAN");
    for (const evidenceId of ambiguity.predecessorEvidenceIds) if (evidence.get(evidenceId)?.kind !== "PREDECESSOR_TRUTH_RECORD") throw new Error("Ambiguity predecessor evidence must resolve to PREDECESSOR_TRUTH_RECORD");
    for (const operationId of ambiguity.relatedOperationIds) if (!operations.has(operationId)) throw new Error("Ambiguity related operation must resolve within the proposal");
    const nodeKeys = ambiguity.relatedNodeRefs.map((ref) => {
      if (!findPredecessorNode(predecessor, ref)) throw new Error("Ambiguity related node must resolve to predecessor truth");
      return canonicalJson(ref);
    });
    sortedUnique(nodeKeys, "ambiguity related nodes");
  }
  return proposal;
}

function findPredecessorNode(predecessor: StructuredTruthV1, ref: BoundTruthNodeRefV1): unknown {
  if (ref.nodeKind === "ENTITY") return predecessor.entities.find((entry) => entry.entityId === ref.nodeId);
  if (ref.nodeKind === "FACT_SLOT") return predecessor.facts.find((entry) => entry.factSlotId === ref.nodeId);
  return predecessor.relations.find((entry) => entry.relationId === ref.nodeId);
}

function resolveEntity(ref: EntityRefV1, ordinal: number, predecessor: StructuredTruthV1, declarations: Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>): BoundTruthNodeRefV1 {
  if (ref.refType === "ENTITY_ID") {
    if (!predecessor.entities.some((entry) => entry.entityId === ref.entityId)) throw new Error(`Unknown predecessor entity ${ref.entityId}`);
    return { nodeKind: "ENTITY", nodeId: ref.entityId };
  }
  const binding = declarations.get(ref.localRef);
  if (!binding || binding.ordinal >= ordinal || binding.node.nodeKind !== "ENTITY") throw new Error("LOCAL_ENTITY must resolve to exactly one earlier entity declaration");
  return binding.node;
}

function bindProposedFactAssertion(
  assertion: ProposedFactBeforeV1 | ProposedFactAssertionV1,
  ordinal: number,
  predecessor: StructuredTruthV1,
  declarations: Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>,
): FactBeforeV1 | FactAssertionV1 {
  if (assertion.state !== "VALUE" || assertion.value.valueType !== "ENTITY_REF") return assertion as FactBeforeV1 | FactAssertionV1;
  const entity = resolveEntity(assertion.value.entity, ordinal, predecessor, declarations) as Extract<BoundTruthNodeRefV1, { nodeKind: "ENTITY" }>;
  return { state: "VALUE", value: { valueType: "ENTITY_REF", value: entity } };
}

function resolveEntry(ref: FactKeyEntryRefV1 | RelationPredicateEntryRefV1, ordinal: number, expectedKind: "FACT_KEY" | "RELATION_PREDICATE", entries: Map<string, VocabularyEntryV1>, declarations: Map<string, { ordinal: number; entry: VocabularyEntryV1 }>): VocabularyEntryV1 {
  if ("entryId" in ref) {
    const entry = entries.get(ref.entryId);
    if (!entry || entry.entryKind !== expectedKind) throw new Error(`Unknown or wrong-kind ${expectedKind} EntryId`);
    return entry;
  }
  const binding = declarations.get(ref.localRef);
  if (!binding || binding.ordinal >= ordinal || binding.entry.entryKind !== expectedKind) throw new Error(`Local vocabulary reference must resolve to an earlier ${expectedKind} declaration`);
  return binding.entry;
}

function resolveNode(ref: TruthNodeRefV1, ordinal: number, predecessor: StructuredTruthV1, declarations: Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>, targets: Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>): BoundTruthNodeRefV1 {
  if (ref.refType === "NODE_ID") {
    const bound = { nodeKind: ref.nodeKind, nodeId: ref.nodeId } as BoundTruthNodeRefV1;
    if (!findPredecessorNode(predecessor, bound)) throw new Error("NODE_ID must resolve to predecessor truth");
    return bound;
  }
  if (ref.refType === "LOCAL_ENTITY") {
    const binding = declarations.get(ref.localRef);
    if (!binding || binding.ordinal >= ordinal || binding.node.nodeKind !== "ENTITY") throw new Error("LOCAL_ENTITY must resolve to an earlier declaration");
    return binding.node;
  }
  const binding = targets.get(ref.targetOperationId);
  if (!binding || binding.ordinal >= ordinal || binding.node.nodeKind !== ref.nodeKind) throw new Error("OPERATION_TARGET must resolve to an earlier successful SET operation target of the same kind");
  return binding.node;
}

function assertFactContract(value: CanonicalFactValueV1, entry: VocabularyEntryV1, knownEntities: Set<string>): void {
  if (entry.entryKind !== "FACT_KEY") throw new Error("Resolved entry is not a fact key");
  const contract = entry.valueContract;
  if (contract.contractType === "STRING" && value.valueType !== "STRING") throw new Error("Fact value violates STRING contract");
  if (contract.contractType === "BOOLEAN" && value.valueType !== "BOOLEAN") throw new Error("Fact value violates BOOLEAN contract");
  if (contract.contractType === "INTEGER" && value.valueType !== "INTEGER") throw new Error("Fact value violates INTEGER contract");
  if (contract.contractType === "DECIMAL" && value.valueType !== "INTEGER" && value.valueType !== "DECIMAL") throw new Error("Fact value violates DECIMAL contract");
  if (contract.contractType === "ENUM" && (value.valueType !== "STRING" || !contract.allowedValues.includes(value.value))) throw new Error("Fact value violates ENUM contract");
  if (contract.contractType === "ENTITY_REF") {
    if (value.valueType !== "ENTITY_REF" || !knownEntities.has(value.value.nodeId)) throw new Error("Fact value violates ENTITY_REF contract");
  }
}

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

function assertOperationEvidence(operation: ProposedOperationV1, evidence: Map<string, ProposedEvidenceV1>): void {
  const resolved = operation.evidenceIds.map((id) => {
    const item = evidence.get(id); if (!item) throw new Error(`Unknown evidence ${id}`); return item;
  });
  if (!resolved.some((item) => item.kind === "FINAL_PROSE_SPAN")) throw new Error(`${operation.operationId} requires final-prose evidence`);
  if (operation.kind === "DECLARE_ENTITY" && resolved.some((item) => item.kind === "PREDECESSOR_TRUTH_RECORD")) throw new Error("Declarations cannot cite predecessor evidence");
}

function assertPredecessorEvidenceCompatibility(
  operation: BoundOperationV1,
  proposed: ProposedOperationV1,
  evidence: ReadonlyMap<string, ProposedEvidenceV1>,
): void {
  const permitted = new Set<string>();
  if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
    permitted.add(canonicalJson(operation.subject));
    permitted.add(canonicalJson({ nodeKind: "FACT_SLOT", nodeId: operation.factSlotId }));
  } else if (operation.kind === "SET_RELATION" || operation.kind === "RETRACT_RELATION") {
    permitted.add(canonicalJson(operation.subject));
    permitted.add(canonicalJson(operation.object));
    permitted.add(canonicalJson({ nodeKind: "RELATION", nodeId: operation.relationId }));
  }
  for (const evidenceId of proposed.evidenceIds) {
    const item = evidence.get(evidenceId)!;
    if (item.kind === "PREDECESSOR_TRUTH_RECORD" && !permitted.has(canonicalJson(item.recordRef))) {
      throw new Error("Predecessor evidence must equal the operation target, subject, or object");
    }
  }
  assertRequiredTargetPredecessorEvidence(operation, proposed.evidenceIds.map((evidenceId) => evidence.get(evidenceId)!));
}

function assertRequiredTargetPredecessorEvidence(
  operation: BoundOperationV1,
  cited: readonly { readonly kind: string; readonly recordRef?: unknown }[],
): void {
  const replacement = (operation.kind === "SET_FACT" || operation.kind === "SET_RELATION") && operation.before.state !== "UNKNOWN";
  const retraction = operation.kind === "RETRACT_FACT" || operation.kind === "RETRACT_RELATION";
  if (!replacement && !retraction) return;
  const target = operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT"
    ? { nodeKind: "FACT_SLOT", nodeId: operation.factSlotId }
    : { nodeKind: "RELATION", nodeId: operation.relationId };
  if (!cited.some((evidence) => evidence.kind === "PREDECESSOR_TRUTH_RECORD" && canonicalJson(evidence.recordRef) === canonicalJson(target))) {
    throw new Error("Replacement or retraction requires exact target predecessor evidence");
  }
}

function bindProposal(proposal: ChapterDeltaProposalV1, predecessor: StructuredTruthV1, host: ChapterDeltaHostBindingV1, evidence: readonly EvidenceV1[]): BoundOperationV1[] {
  const narrativeDeclarations = new Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>();
  const vocabularyDeclarations = new Map<string, { ordinal: number; entry: VocabularyEntryV1 }>();
  const vocabularyEntries = new Map(predecessor.vocabulary.entries.map((entry) => [entry.entryId, entry]));
  const vocabularyNames = new Set(predecessor.vocabulary.entries.map((entry) => entry.canonicalName));
  const entityTuples = new Set(predecessor.entities.map((entry) => `${entry.entityKind}\u0000${entry.identityKey}`));
  const entityPreimages = new Map(predecessor.entities.map((entry) => [entry.entityId, `${entry.entityKind}\u0000${entry.identityKey}`]));
  const evidenceMap = new Map(proposal.evidence.map((item) => [item.evidenceId, item]));

  for (let index = 0; index < proposal.operations.length; index += 1) {
    const operation = proposal.operations[index]!;
    if (operation.kind !== "DECLARE_ENTITY") continue;
    const ordinal = index + 1;
    const definition = operation.after.definition;
    if (definition.definitionType === "NARRATIVE_ENTITY") {
      const tuple = `${definition.entityKind}\u0000${definition.identityKey}`;
      if (entityTuples.has(tuple)) throw new Error("Duplicate book-scoped entity declaration tuple");
      entityTuples.add(tuple);
      const node = { nodeKind: "ENTITY" as const, nodeId: deriveChapterDeltaEntityId({ bookId: host.bookId, candidateSha256: host.candidateSha256, declarationOperationId: operation.operationId, entityKind: definition.entityKind, identityKey: definition.identityKey }) };
      const collidingPreimage = entityPreimages.get(node.nodeId);
      if (collidingPreimage !== undefined) throw new Error(`EntityId collision with ${collidingPreimage === tuple ? "duplicate" : "different"} identity preimage`);
      entityPreimages.set(node.nodeId, tuple);
      narrativeDeclarations.set(operation.localRef, { ordinal, node });
    } else {
      const entryId = deriveCustomVocabularyEntryId({ bookId: host.bookId, definition });
      if (vocabularyNames.has(definition.canonicalName) || vocabularyEntries.has(entryId)) throw new Error("Duplicate or colliding vocabulary declaration");
      vocabularyNames.add(definition.canonicalName);
      const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
      const placeholderSource = { sourceKind: "CHAPTER_DELTA" as const, candidateSha256: host.candidateSha256, deltaId: "0".repeat(64), operationId: operation.operationId, evidenceIds: operation.evidenceIds };
      const entry: VocabularyEntryV1 = definition.definitionType === "VOCABULARY_FACT_KEY"
        ? { entryId, scope: "BOOK", entryKind: "FACT_KEY", bookId: host.bookId, vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition, semanticMetadataSha256, valueContract: definition.valueContract, definitionSource: placeholderSource }
        : { entryId, scope: "BOOK", entryKind: "RELATION_PREDICATE", bookId: host.bookId, vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition, semanticMetadataSha256, subjectObjectContract: definition.subjectObjectContract, directionality: definition.directionality, definitionSource: placeholderSource };
      vocabularyEntries.set(entryId, entry);
      vocabularyDeclarations.set(operation.localRef, { ordinal, entry });
    }
  }

  const knownEntities = new Set(predecessor.entities.map((entry) => entry.entityId));
  for (const binding of narrativeDeclarations.values()) knownEntities.add(binding.node.nodeId);
  const facts = new Map(predecessor.facts.map((entry) => [entry.factSlotId, entry]));
  const relations = new Map(predecessor.relations.map((entry) => [entry.relationId, entry]));
  const targets = new Map<string, { ordinal: number; node: BoundTruthNodeRefV1 }>();
  const mutated = new Set<string>();
  const bound: BoundOperationV1[] = [];

  for (let index = 0; index < proposal.operations.length; index += 1) {
    const operation = proposal.operations[index]!;
    const ordinal = index + 1;
    assertOperationEvidence(operation, evidenceMap);
    if (operation.kind === "DECLARE_ENTITY") {
      const definition = operation.after.definition;
      if (definition.definitionType === "NARRATIVE_ENTITY") bound.push({
        kind: operation.kind, operationId: operation.operationId, before: operation.before,
        after: { state: "PRESENT", definition },
        declaredEntityId: narrativeDeclarations.get(operation.localRef)!.node.nodeId,
        evidenceIds: operation.evidenceIds,
      });
      else bound.push({
        kind: operation.kind, operationId: operation.operationId, before: operation.before,
        after: { state: "PRESENT", definition },
        declaredEntryId: vocabularyDeclarations.get(operation.localRef)!.entry.entryId,
        evidenceIds: operation.evidenceIds,
      });
      continue;
    }
    if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
      const subject = resolveEntity(operation.subject, ordinal, predecessor, narrativeDeclarations) as Extract<BoundTruthNodeRefV1, { nodeKind: "ENTITY" }>;
      const entry = resolveEntry(operation.factKey, ordinal, "FACT_KEY", vocabularyEntries, vocabularyDeclarations);
      const before = bindProposedFactAssertion(operation.before, ordinal, predecessor, narrativeDeclarations);
      const after: FactAssertionV1 | undefined = operation.kind === "SET_FACT"
        ? bindProposedFactAssertion(operation.after, ordinal, predecessor, narrativeDeclarations) as FactAssertionV1
        : undefined;
      const factSlotId = deriveFactSlotId({ bookId: host.bookId, subjectEntityId: subject.nodeId, factKeyEntryId: entry.entryId });
      const key = `FACT_SLOT:${factSlotId}`;
      if (mutated.has(key)) throw new Error("Duplicate target: a bound fact slot may be mutated only once");
      mutated.add(key);
      const current = facts.get(factSlotId)?.assertion ?? { state: "UNKNOWN" as const };
      if (before.state === "VALUE") assertFactContract(before.value, entry, knownEntities);
      if (!same(current, before)) throw new Error(`Fact before-value mismatch: expected ${current.state}`);
      if (operation.kind === "SET_FACT") {
        if (!after) throw new Error("SET_FACT bound assertion is missing");
        if (after.state === "VALUE") assertFactContract(after.value, entry, knownEntities);
        if (same(before, after)) throw new Error("SET_FACT cannot be a no-op");
        facts.set(factSlotId, {
          factSlotId,
          subject,
          factKeyEntryId: entry.entryId,
          assertion: after,
          validFromChapter: host.chapterNumber,
          lastChangedChapter: host.chapterNumber,
          source: { sourceKind: "CHAPTER_DELTA", candidateSha256: host.candidateSha256, deltaId: "0".repeat(64), operationId: operation.operationId, evidenceIds: operation.evidenceIds },
        });
        targets.set(operation.operationId, { ordinal, node: { nodeKind: "FACT_SLOT", nodeId: factSlotId } });
        const boundOperation: BoundOperationV1 = { kind: operation.kind, operationId: operation.operationId, subject, factKeyEntryId: entry.entryId, factSlotId, before, after, evidenceIds: operation.evidenceIds };
        assertPredecessorEvidenceCompatibility(boundOperation, operation, evidenceMap);
        bound.push(boundOperation);
      } else {
        facts.delete(factSlotId);
        const boundOperation: BoundOperationV1 = { kind: operation.kind, operationId: operation.operationId, subject, factKeyEntryId: entry.entryId, factSlotId, before: before as FactAssertionV1, after: operation.after, evidenceIds: operation.evidenceIds };
        assertPredecessorEvidenceCompatibility(boundOperation, operation, evidenceMap);
        bound.push(boundOperation);
      }
      continue;
    }
    const subject = resolveNode(operation.subject, ordinal, predecessor, narrativeDeclarations, targets);
    const objectNode = resolveNode(operation.object, ordinal, predecessor, narrativeDeclarations, targets);
    const entry = resolveEntry(operation.relationPredicate, ordinal, "RELATION_PREDICATE", vocabularyEntries, vocabularyDeclarations);
    if (entry.entryKind !== "RELATION_PREDICATE") throw new Error("Resolved entry is not a relation predicate");
    if (!entry.subjectObjectContract.subjectKinds.includes(subject.nodeKind) || !entry.subjectObjectContract.objectKinds.includes(objectNode.nodeKind)) throw new Error("Relation endpoint-kind contract mismatch");
    if (!entry.subjectObjectContract.allowReflexive && same(subject, objectNode)) throw new Error("Reflexive relation is forbidden");
    const identity = deriveRelationIdentity({ bookId: host.bookId, relationPredicateEntryId: entry.entryId, directionality: entry.directionality, subject, object: objectNode });
    const key = `RELATION:${identity.relationId}`;
    if (mutated.has(key)) throw new Error("Duplicate target: a bound relation may be mutated only once");
    mutated.add(key);
    const current = relations.get(identity.relationId)?.assertion ?? { state: "UNKNOWN" as const };
    if (!same(current, operation.before)) throw new Error(`Relation before-value mismatch: expected ${current.state}`);
    if (operation.kind === "SET_RELATION") {
      if (same(operation.before, operation.after)) throw new Error("SET_RELATION cannot be a no-op");
      relations.set(identity.relationId, {
        relationId: identity.relationId,
        predicateEntryId: entry.entryId,
        directionality: entry.directionality,
        subject: identity.subject,
        object: identity.object,
        assertion: operation.after,
        validFromChapter: host.chapterNumber,
        lastChangedChapter: host.chapterNumber,
        source: { sourceKind: "CHAPTER_DELTA", candidateSha256: host.candidateSha256, deltaId: "0".repeat(64), operationId: operation.operationId, evidenceIds: operation.evidenceIds },
      });
      targets.set(operation.operationId, { ordinal, node: { nodeKind: "RELATION", nodeId: identity.relationId } });
      const boundOperation: BoundOperationV1 = { kind: operation.kind, operationId: operation.operationId, subject: identity.subject, relationPredicateEntryId: entry.entryId, relationId: identity.relationId, directionality: entry.directionality, object: identity.object, before: operation.before, after: operation.after, evidenceIds: operation.evidenceIds };
      assertPredecessorEvidenceCompatibility(boundOperation, operation, evidenceMap);
      bound.push(boundOperation);
    } else {
      relations.delete(identity.relationId);
      const boundOperation: BoundOperationV1 = { kind: operation.kind, operationId: operation.operationId, subject: identity.subject, relationPredicateEntryId: entry.entryId, relationId: identity.relationId, directionality: entry.directionality, object: identity.object, before: operation.before, after: operation.after, evidenceIds: operation.evidenceIds };
      assertPredecessorEvidenceCompatibility(boundOperation, operation, evidenceMap);
      bound.push(boundOperation);
    }
  }

  const existingNodes = new Set<string>([...knownEntities].map((id) => `ENTITY:${id}`));
  for (const id of facts.keys()) existingNodes.add(`FACT_SLOT:${id}`);
  for (const id of relations.keys()) existingNodes.add(`RELATION:${id}`);
  for (const relation of relations.values()) if (!existingNodes.has(`${relation.subject.nodeKind}:${relation.subject.nodeId}`) || !existingNodes.has(`${relation.object.nodeKind}:${relation.object.nodeId}`)) throw new Error("Final relation referential integrity failed; dependent relations must be removed atomically");

  const usedEvidence = new Set<string>();
  for (const operation of proposal.operations) operation.evidenceIds.forEach((id) => usedEvidence.add(id));
  for (const ambiguity of proposal.ambiguities) [...ambiguity.proseEvidenceIds, ...ambiguity.predecessorEvidenceIds].forEach((id) => usedEvidence.add(id));
  for (const item of proposal.evidence) if (!usedEvidence.has(item.evidenceId)) throw new Error(`Unreferenced evidence ${item.evidenceId}`);
  const payloads = new Set<string>();
  for (const item of proposal.evidence) {
    const { evidenceId: _evidenceId, ...payload } = item;
    const bytes = canonicalJson(payload);
    if (payloads.has(bytes)) throw new Error("Duplicate evidence payload under different IDs");
    payloads.add(bytes);
  }
  void evidence;
  return bound;
}

function bindEvidence(proposal: ChapterDeltaProposalV1, host: ChapterDeltaHostBindingV1): EvidenceV1[] {
  return proposal.evidence.map((item) => item.kind === "FINAL_PROSE_SPAN"
    ? { ...item, candidateSha256: host.candidateSha256 }
    : { ...item, predecessorTruthSha256: host.predecessorTruthSha256 });
}

export function admitChapterDeltaV1(input: {
  readonly rawProposal: string;
  readonly candidate: string;
  readonly predecessor: StructuredTruthV1;
  readonly host: ChapterDeltaHostBindingV1;
}): ChapterDeltaAdmissionResultV1 {
  if (new TextEncoder().encode(input.rawProposal).byteLength > MAX_BYTES) throw new Error("Raw proposal exceeds 2,097,152 byte limit");
  const hostObject = object(input.host, "host binding");
  exactKeys(hostObject, HOST_KEYS, "host binding");
  validateStructuredTruthV1(input.predecessor);
  validateVocabularyCatalogV1(input.predecessor.vocabulary);
  if (input.host.bookId !== input.predecessor.bookId || input.host.chapterNumber !== input.predecessor.throughChapter + 1) throw new Error("Host chapter/book predecessor authority mismatch");
  if (input.host.candidateSha256 !== sha256Utf8(input.candidate)) throw new Error("Host candidate SHA mismatch");
  if (input.host.predecessorTruthSha256 !== canonicalSha256(input.predecessor)) throw new Error("Host predecessor truth SHA mismatch");
  if (input.host.predecessorVocabularyCatalogSha256 !== canonicalSha256(input.predecessor.vocabulary)) throw new Error("Host predecessor vocabulary catalog SHA mismatch");
  for (const [key, value] of Object.entries(input.host)) {
    if (key.endsWith("Sha256") || key.endsWith("Fingerprint")) assertSha(value, key);
    else if (key === "chapterNumber") assertSafeUnsignedInteger(value, key);
    else if (typeof value !== "string" || !value) throw new Error(`Invalid host field ${key}`);
  }
  const parsed = parseJsonRejectingDuplicates(input.rawProposal);
  const proposal = validateProposal(parsed, input.candidate, input.predecessor);
  const proposalBytes = canonicalJsonBytes(proposal);
  if (proposalBytes.byteLength > MAX_BYTES) throw new Error("Canonical proposed JCS exceeds 2,097,152 byte limit");
  const canonicalProposalSha256 = canonicalSha256(proposal);
  const evidence = bindEvidence(proposal, input.host);
  const operations = bindProposal(proposal, input.predecessor, input.host, evidence);
  const boundDelta: BoundChapterDeltaBodyV1 = {
    schemaVersion: "1.0",
    ...input.host,
    proposedDeltaCanonicalSha256: canonicalProposalSha256,
    evidence,
    operations,
  };
  if (canonicalJsonBytes(boundDelta).byteLength > MAX_BYTES) throw new Error("Canonical bound JCS exceeds 2,097,152 byte limit");
  if (proposal.status === "AMBIGUOUS") return deepFreeze({ status: "AMBIGUOUS", canonicalProposalSha256, hostBinding: { ...input.host }, ambiguities: proposal.ambiguities });
  validateBoundChapterDeltaBodyV1(boundDelta);
  const acceptedDelta = { schemaVersion: "1.0" as const, deltaId: canonicalSha256(boundDelta), delta: boundDelta };
  validateAcceptedChapterDeltaV1(acceptedDelta, input.predecessor);
  return deepFreeze({ status: "ACCEPTED", canonicalProposalSha256, acceptedDelta });
}

export function validateBoundChapterDeltaBodyV1(input: unknown): BoundChapterDeltaBodyV1 {
  const value = object(input, "BoundChapterDeltaBodyV1");
  if (canonicalJsonBytes(value).byteLength > MAX_BYTES) throw new Error("Canonical bound JCS exceeds 2,097,152 byte limit");
  exactKeys(value, BODY_KEYS, "BoundChapterDeltaBodyV1");
  if (value.schemaVersion !== "1.0") throw new Error("Invalid bound delta schemaVersion");
  const host = Object.fromEntries(HOST_KEYS.map((key) => [key, value[key]]));
  exactKeys(host, HOST_KEYS, "bound delta host fields");
  for (const [key, field] of Object.entries(host)) {
    if (key.endsWith("Sha256") || key.endsWith("Fingerprint")) assertSha(field, key);
    else if (key === "chapterNumber") assertSafeUnsignedInteger(field, key);
    else if (typeof field !== "string" || !field) throw new Error(`Invalid bound delta ${key}`);
  }
  assertSha(value.proposedDeltaCanonicalSha256, "proposedDeltaCanonicalSha256");
  if (!Array.isArray(value.operations) || value.operations.length > 256 || !Array.isArray(value.evidence) || value.evidence.length > 512) throw new Error("Invalid bound delta collection limit");
  value.operations.forEach((operation, index) => {
    const item = object(operation, "bound operation");
    assertOrdinal(item.operationId, "op", index + 1, 256);
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) throw new Error("Bound operation evidenceIds must be nonempty");
    for (const evidenceId of item.evidenceIds) {
      if (typeof evidenceId !== "string" || !/^ev-[0-9]{4}$/.test(evidenceId) || Number(evidenceId.slice(3)) < 1 || Number(evidenceId.slice(3)) > 512) throw new Error("Bound operation evidence ID must be ev-0001..ev-0512");
    }
    sortedUnique(item.evidenceIds as string[], "bound operation evidenceIds");
    if (item.kind === "DECLARE_ENTITY") {
      const after = object(item.after, "bound declaration after"); const definition = validateDefinition(after.definition);
      exactKeys(item, definition.definitionType === "NARRATIVE_ENTITY" ? ["kind", "operationId", "before", "after", "declaredEntityId", "evidenceIds"] : ["kind", "operationId", "before", "after", "declaredEntryId", "evidenceIds"], "bound declaration");
      const before = object(item.before, "bound declaration before"); exactKeys(before, ["state"], "bound declaration before"); exactKeys(after, ["state", "definition"], "bound declaration after"); if (before.state !== "ABSENT" || after.state !== "PRESENT") throw new Error("Invalid bound declaration transition"); assertSha(definition.definitionType === "NARRATIVE_ENTITY" ? item.declaredEntityId : item.declaredEntryId, "declared ID");
    } else if (item.kind === "SET_FACT" || item.kind === "RETRACT_FACT") {
      exactKeys(item, ["kind", "operationId", "subject", "factKeyEntryId", "factSlotId", "before", "after", "evidenceIds"], "bound fact operation");
      const subject = object(item.subject, "bound fact subject"); exactKeys(subject, ["nodeKind", "nodeId"], "bound fact subject"); if (subject.nodeKind !== "ENTITY") throw new Error("Bound fact subject must be ENTITY"); assertSha(subject.nodeId, "bound fact subject ID"); assertSha(item.factKeyEntryId, "factKeyEntryId"); assertSha(item.factSlotId, "factSlotId"); validateFactAssertion(item.before, item.kind === "SET_FACT"); validateFactAssertion(item.after, item.kind === "RETRACT_FACT");
      if (item.kind === "RETRACT_FACT" && object(item.after, "RETRACT_FACT after").state !== "UNKNOWN") throw new Error("RETRACT_FACT after must be UNKNOWN");
    } else if (item.kind === "SET_RELATION" || item.kind === "RETRACT_RELATION") {
      exactKeys(item, ["kind", "operationId", "subject", "relationPredicateEntryId", "relationId", "directionality", "object", "before", "after", "evidenceIds"], "bound relation operation");
      for (const endpoint of [item.subject, item.object]) { const ref = object(endpoint, "bound relation endpoint"); exactKeys(ref, ["nodeKind", "nodeId"], "bound relation endpoint"); if (!["ENTITY", "FACT_SLOT", "RELATION"].includes(String(ref.nodeKind))) throw new Error("Invalid bound node kind"); assertSha(ref.nodeId, "bound node ID"); }
      assertSha(item.relationPredicateEntryId, "relationPredicateEntryId"); assertSha(item.relationId, "relationId"); if (item.directionality !== "DIRECTED" && item.directionality !== "SYMMETRIC") throw new Error("Invalid bound directionality"); validateRelationAssertion(item.before, item.kind === "SET_RELATION"); validateRelationAssertion(item.after, item.kind === "RETRACT_RELATION");
      if (item.kind === "RETRACT_RELATION" && object(item.after, "RETRACT_RELATION after").state !== "UNKNOWN") throw new Error("RETRACT_RELATION after must be UNKNOWN");
    } else throw new Error("Unknown bound operation kind");
  });
  value.evidence.forEach((evidence, index) => {
    const item = object(evidence, "bound evidence");
    assertOrdinal(item.evidenceId, "ev", index + 1, 512);
    if (item.kind === "FINAL_PROSE_SPAN") {
      exactKeys(item, ["kind", "evidenceId", "startUtf16", "endUtf16", "quote", "candidateSha256"], "bound prose evidence");
      const start = assertSafeUnsignedInteger(item.startUtf16, "startUtf16"); const end = assertSafeUnsignedInteger(item.endUtf16, "endUtf16");
      if (start >= end || typeof item.quote !== "string" || item.quote.length < 1 || item.quote.length > 4096 || item.quote.length !== end - start) throw new Error("Invalid bound quote or UTF-16 range");
      assertSha(item.candidateSha256, "bound candidate SHA"); if (item.candidateSha256 !== value.candidateSha256) throw new Error("Bound prose evidence candidate binding mismatch");
    }
    else if (item.kind === "PREDECESSOR_TRUTH_RECORD") {
      exactKeys(item, ["kind", "evidenceId", "recordRef", "recordSha256", "predecessorTruthSha256"], "bound predecessor evidence");
      const ref = object(item.recordRef, "bound predecessor recordRef"); exactKeys(ref, ["nodeKind", "nodeId"], "bound predecessor recordRef");
      if (!["ENTITY", "FACT_SLOT", "RELATION"].includes(String(ref.nodeKind))) throw new Error("Invalid bound predecessor recordRef node kind"); assertSha(ref.nodeId, "bound predecessor recordRef node ID");
      assertSha(item.recordSha256, "recordSha256"); assertSha(item.predecessorTruthSha256, "predecessorTruthSha256"); if (item.predecessorTruthSha256 !== value.predecessorTruthSha256) throw new Error("Bound predecessor evidence authority mismatch");
    }
    else throw new Error("Unknown bound evidence kind");
  });
  const evidenceIds = new Set((value.evidence as Array<{ evidenceId: string }>).map((item) => item.evidenceId));
  for (const operation of value.operations as Array<{ evidenceIds: string[] }>) for (const id of operation.evidenceIds) if (!evidenceIds.has(id)) throw new Error("Bound operation evidence does not resolve");
  const boundEvidence = new Map((value.evidence as Array<Record<string, unknown>>).map((evidence) => [evidence.evidenceId as string, evidence]));
  for (const operation of value.operations as Array<Record<string, unknown> & { evidenceIds: string[] }>) {
    const cited = operation.evidenceIds.map((evidenceId) => boundEvidence.get(evidenceId)!);
    if (!cited.some((evidence) => evidence.kind === "FINAL_PROSE_SPAN")) throw new Error("Every bound operation requires final-prose evidence");
    if (operation.kind === "DECLARE_ENTITY" && cited.some((evidence) => evidence.kind === "PREDECESSOR_TRUTH_RECORD")) throw new Error("Bound declarations cannot cite predecessor evidence");
    if (operation.kind !== "DECLARE_ENTITY") {
      const permitted = new Set<string>();
      if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
        permitted.add(canonicalJson(operation.subject)); permitted.add(canonicalJson({ nodeKind: "FACT_SLOT", nodeId: operation.factSlotId }));
      } else {
        permitted.add(canonicalJson(operation.subject)); permitted.add(canonicalJson(operation.object)); permitted.add(canonicalJson({ nodeKind: "RELATION", nodeId: operation.relationId }));
      }
      for (const evidence of cited) if (evidence.kind === "PREDECESSOR_TRUTH_RECORD" && !permitted.has(canonicalJson(evidence.recordRef))) throw new Error("Bound predecessor evidence must equal the operation target, subject, or object");
      assertRequiredTargetPredecessorEvidence(operation as BoundOperationV1, cited);
    }
  }
  const usedEvidenceIds = new Set((value.operations as Array<{ evidenceIds: string[] }>).flatMap((operation) => operation.evidenceIds));
  for (const evidenceId of evidenceIds) if (!usedEvidenceIds.has(evidenceId)) throw new Error("Bound evidence must be referenced by an operation");
  const evidencePayloads = new Set<string>();
  for (const evidence of value.evidence as Array<Record<string, unknown>>) {
    const { evidenceId: _evidenceId, ...payload } = evidence;
    const canonicalPayload = canonicalJson(payload);
    if (evidencePayloads.has(canonicalPayload)) throw new Error("Duplicate bound evidence payload under different IDs");
    evidencePayloads.add(canonicalPayload);
  }
  return input as BoundChapterDeltaBodyV1;
}

export function validateAcceptedChapterDeltaV1(input: unknown, predecessorInput: StructuredTruthV1): import("../models/chapter-delta.js").AcceptedChapterDeltaV1 {
  const value = object(input, "AcceptedChapterDeltaV1");
  exactKeys(value, ["schemaVersion", "deltaId", "delta"], "AcceptedChapterDeltaV1");
  if (value.schemaVersion !== "1.0") throw new Error("Invalid accepted delta schemaVersion");
  assertSha(value.deltaId, "deltaId");
  const delta = validateBoundChapterDeltaBodyV1(value.delta);
  if (value.deltaId !== canonicalSha256(delta)) throw new Error("Accepted delta identity mismatch");
  const predecessor = validateStructuredTruthV1(predecessorInput);
  if (delta.bookId !== predecessor.bookId || delta.chapterNumber !== predecessor.throughChapter + 1
    || delta.predecessorTruthSha256 !== canonicalSha256(predecessor)
    || delta.predecessorVocabularyCatalogSha256 !== canonicalSha256(predecessor.vocabulary)) {
    throw new Error("Accepted delta predecessor authority mismatch");
  }
  const entityIds = new Set(predecessor.entities.map((record) => record.entityId));
  const entityTuples = new Set(predecessor.entities.map((record) => `${record.entityKind}\u0000${record.identityKey}`));
  const vocabularyEntries = new Map(predecessor.vocabulary.entries.map((entry) => [entry.entryId, entry]));
  const vocabularyNames = new Set(predecessor.vocabulary.entries.map((entry) => entry.canonicalName));
  const factAssertions = new Map(predecessor.facts.map((record) => [record.factSlotId, record.assertion]));
  const relationAssertions = new Map(predecessor.relations.map((record) => [record.relationId, record.assertion]));
  const relationEndpoints = new Map(predecessor.relations.map((record) => [record.relationId, { subject: record.subject, object: record.object }]));
  const targetedFactSlots = new Set<string>(); const targetedRelations = new Set<string>();
  for (const evidence of delta.evidence) {
    if (evidence.kind !== "PREDECESSOR_TRUTH_RECORD") continue;
    const recordValue = evidence.recordRef.nodeKind === "ENTITY"
      ? predecessor.entities.find((record) => record.entityId === evidence.recordRef.nodeId)
      : evidence.recordRef.nodeKind === "FACT_SLOT"
        ? predecessor.facts.find((record) => record.factSlotId === evidence.recordRef.nodeId)
        : predecessor.relations.find((record) => record.relationId === evidence.recordRef.nodeId);
    if (!recordValue || canonicalSha256(recordValue) !== evidence.recordSha256) throw new Error("Accepted predecessor evidence does not resolve to the exact predecessor record");
  }
  const assertResolved = (ref: BoundTruthNodeRefV1): void => {
    const resolved = ref.nodeKind === "ENTITY" ? entityIds.has(ref.nodeId)
      : ref.nodeKind === "FACT_SLOT" ? factAssertions.has(ref.nodeId)
        : relationAssertions.has(ref.nodeId);
    if (!resolved) throw new Error(`Higher-order ${ref.nodeKind} reference must resolve from predecessor or an earlier successful SET target`);
  };
  for (const operation of delta.operations) {
    if (operation.kind === "DECLARE_ENTITY") {
      const definition = operation.after.definition;
      if (definition.definitionType === "NARRATIVE_ENTITY") {
        if (!("declaredEntityId" in operation)) throw new Error("Narrative declaration target is missing");
        const expectedId = deriveChapterDeltaEntityId({ bookId: delta.bookId, candidateSha256: delta.candidateSha256, declarationOperationId: operation.operationId, entityKind: definition.entityKind, identityKey: definition.identityKey });
        const tuple = `${definition.entityKind}\u0000${definition.identityKey}`;
        if (operation.declaredEntityId !== expectedId || entityIds.has(expectedId) || entityTuples.has(tuple)) throw new Error("Declared entity identity is duplicated, colliding, or has the wrong preimage");
        entityIds.add(expectedId); entityTuples.add(tuple);
      } else {
        if (!("declaredEntryId" in operation)) throw new Error("Vocabulary declaration target is missing");
        const expectedId = deriveCustomVocabularyEntryId({ bookId: delta.bookId, definition });
        if (operation.declaredEntryId !== expectedId || vocabularyEntries.has(expectedId) || vocabularyNames.has(definition.canonicalName)) throw new Error("Declared vocabulary identity is duplicated, colliding, or has the wrong preimage");
        const definitionSource = { sourceKind: "CHAPTER_DELTA" as const, candidateSha256: delta.candidateSha256, deltaId: value.deltaId as string, operationId: operation.operationId, evidenceIds: operation.evidenceIds };
        const semanticMetadataSha256 = deriveSemanticMetadataSha256(definition);
        const entry: VocabularyEntryV1 = definition.definitionType === "VOCABULARY_FACT_KEY"
          ? { entryId: expectedId, scope: "BOOK", entryKind: "FACT_KEY", bookId: delta.bookId, vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition, semanticMetadataSha256, valueContract: definition.valueContract, definitionSource }
          : { entryId: expectedId, scope: "BOOK", entryKind: "RELATION_PREDICATE", bookId: delta.bookId, vocabularySchemaVersion: "1.0", canonicalName: definition.canonicalName, semanticDefinition: definition.semanticDefinition, semanticMetadataSha256, subjectObjectContract: definition.subjectObjectContract, directionality: definition.directionality, definitionSource };
        vocabularyEntries.set(expectedId, entry); vocabularyNames.add(definition.canonicalName);
      }
      continue;
    }
    if (operation.kind === "SET_FACT" || operation.kind === "RETRACT_FACT") {
      if (targetedFactSlots.has(operation.factSlotId)) throw new Error("Duplicate FactSlotId operation target in accepted delta");
      targetedFactSlots.add(operation.factSlotId); assertResolved(operation.subject);
      const entry = vocabularyEntries.get(operation.factKeyEntryId);
      if (!entry || entry.entryKind !== "FACT_KEY") throw new Error("Accepted fact-key entry reference does not resolve");
      const expectedId = deriveFactSlotId({ bookId: delta.bookId, subjectEntityId: operation.subject.nodeId, factKeyEntryId: operation.factKeyEntryId });
      if (operation.factSlotId !== expectedId) throw new Error("Accepted FactSlotId target preimage mismatch");
      const current = factAssertions.get(operation.factSlotId) ?? { state: "UNKNOWN" as const };
      if (canonicalJson(current) !== canonicalJson(operation.before)) throw new Error("Accepted fact before-value does not match predecessor or earlier state");
      if (operation.kind === "SET_FACT") {
        if (canonicalJson(operation.before) === canonicalJson(operation.after)) throw new Error("SET_FACT before/after no-op is forbidden");
        if (operation.after.state === "VALUE") assertFactContract(operation.after.value, entry, entityIds);
        factAssertions.set(operation.factSlotId, operation.after);
      } else factAssertions.delete(operation.factSlotId);
      continue;
    }
    if (targetedRelations.has(operation.relationId)) throw new Error("Duplicate RelationId operation target in accepted delta");
    targetedRelations.add(operation.relationId); assertResolved(operation.subject); assertResolved(operation.object);
    const entry = vocabularyEntries.get(operation.relationPredicateEntryId);
    if (!entry || entry.entryKind !== "RELATION_PREDICATE") throw new Error("Accepted relation-predicate entry reference does not resolve");
    if (operation.directionality !== entry.directionality
      || !entry.subjectObjectContract.subjectKinds.includes(operation.subject.nodeKind)
      || !entry.subjectObjectContract.objectKinds.includes(operation.object.nodeKind)
      || (!entry.subjectObjectContract.allowReflexive && canonicalJson(operation.subject) === canonicalJson(operation.object))) throw new Error("Accepted relation endpoint or directionality contract mismatch");
    const identity = deriveRelationIdentity({ bookId: delta.bookId, relationPredicateEntryId: operation.relationPredicateEntryId, directionality: entry.directionality, subject: operation.subject, object: operation.object });
    if (operation.relationId !== identity.relationId || canonicalJson(operation.subject) !== canonicalJson(identity.subject) || canonicalJson(operation.object) !== canonicalJson(identity.object)) throw new Error("Accepted relation identity or symmetric normalization mismatch");
    const current = relationAssertions.get(operation.relationId) ?? { state: "UNKNOWN" as const };
    if (canonicalJson(current) !== canonicalJson(operation.before)) throw new Error("Accepted relation before-value does not match predecessor or earlier state");
    if (operation.kind === "SET_RELATION") {
      if (canonicalJson(operation.before) === canonicalJson(operation.after)) throw new Error("SET_RELATION before/after no-op is forbidden");
      relationAssertions.set(operation.relationId, operation.after);
      relationEndpoints.set(operation.relationId, { subject: operation.subject, object: operation.object });
    } else { relationAssertions.delete(operation.relationId); relationEndpoints.delete(operation.relationId); }
  }
  const finalNodeExists = (ref: BoundTruthNodeRefV1): boolean => ref.nodeKind === "ENTITY" ? entityIds.has(ref.nodeId)
    : ref.nodeKind === "FACT_SLOT" ? factAssertions.has(ref.nodeId)
      : relationAssertions.has(ref.nodeId);
  for (const endpoints of relationEndpoints.values()) {
    if (!finalNodeExists(endpoints.subject) || !finalNodeExists(endpoints.object)) throw new Error("Accepted delta final referential closure contains a dangling surviving relation endpoint");
  }
  return input as import("../models/chapter-delta.js").AcceptedChapterDeltaV1;
}
