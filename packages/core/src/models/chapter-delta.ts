import type {
  BoundTruthNodeRefV1,
  CanonicalFactValueV1,
  EntityDefinitionV1,
  EntityId,
  EntryId,
  EvidenceId,
  FactAssertionV1,
  FactSlotId,
  OperationId,
  RelationAssertionV1,
  RelationId,
  Sha256,
} from "./structured-truth.js";

export type LocalRef = string;
export type AmbiguityId = string;

export type EntityRefV1 = { readonly refType: "ENTITY_ID"; readonly entityId: EntityId } | { readonly refType: "LOCAL_ENTITY"; readonly localRef: LocalRef };
export type FactKeyEntryRefV1 = { readonly refType: "FACT_KEY_ENTRY_ID"; readonly entryId: EntryId } | { readonly refType: "LOCAL_FACT_KEY"; readonly localRef: LocalRef };
export type RelationPredicateEntryRefV1 = { readonly refType: "RELATION_PREDICATE_ENTRY_ID"; readonly entryId: EntryId } | { readonly refType: "LOCAL_RELATION_PREDICATE"; readonly localRef: LocalRef };
export type TruthNodeRefV1 =
  | { readonly nodeKind: "ENTITY" | "FACT_SLOT" | "RELATION"; readonly refType: "NODE_ID"; readonly nodeId: Sha256 }
  | { readonly nodeKind: "ENTITY"; readonly refType: "LOCAL_ENTITY"; readonly localRef: LocalRef }
  | { readonly nodeKind: "FACT_SLOT"; readonly refType: "OPERATION_TARGET"; readonly targetOperationId: OperationId }
  | { readonly nodeKind: "RELATION"; readonly refType: "OPERATION_TARGET"; readonly targetOperationId: OperationId };

export type FactBeforeV1 = { readonly state: "UNKNOWN" } | FactAssertionV1;
export type RelationBeforeV1 = { readonly state: "UNKNOWN" } | RelationAssertionV1;
export type ProposedFactValueV1 = Exclude<CanonicalFactValueV1, { readonly valueType: "ENTITY_REF" }>
  | { readonly valueType: "ENTITY_REF"; readonly entity: EntityRefV1 };
export type ProposedFactAssertionV1 = { readonly state: "ABSENT" } | { readonly state: "VALUE"; readonly value: ProposedFactValueV1 };
export type ProposedFactBeforeV1 = { readonly state: "UNKNOWN" } | ProposedFactAssertionV1;

export interface ProposedDeclareEntityOperationV1 { readonly kind: "DECLARE_ENTITY"; readonly operationId: OperationId; readonly localRef: LocalRef; readonly before: { readonly state: "ABSENT" }; readonly after: { readonly state: "PRESENT"; readonly definition: EntityDefinitionV1 }; readonly evidenceIds: readonly EvidenceId[] }
export interface ProposedSetFactOperationV1 { readonly kind: "SET_FACT"; readonly operationId: OperationId; readonly subject: EntityRefV1; readonly factKey: FactKeyEntryRefV1; readonly before: ProposedFactBeforeV1; readonly after: ProposedFactAssertionV1; readonly evidenceIds: readonly EvidenceId[] }
export interface ProposedRetractFactOperationV1 { readonly kind: "RETRACT_FACT"; readonly operationId: OperationId; readonly subject: EntityRefV1; readonly factKey: FactKeyEntryRefV1; readonly before: ProposedFactAssertionV1; readonly after: { readonly state: "UNKNOWN" }; readonly evidenceIds: readonly EvidenceId[] }
export interface ProposedSetRelationOperationV1 { readonly kind: "SET_RELATION"; readonly operationId: OperationId; readonly subject: TruthNodeRefV1; readonly relationPredicate: RelationPredicateEntryRefV1; readonly object: TruthNodeRefV1; readonly before: RelationBeforeV1; readonly after: RelationAssertionV1; readonly evidenceIds: readonly EvidenceId[] }
export interface ProposedRetractRelationOperationV1 { readonly kind: "RETRACT_RELATION"; readonly operationId: OperationId; readonly subject: TruthNodeRefV1; readonly relationPredicate: RelationPredicateEntryRefV1; readonly object: TruthNodeRefV1; readonly before: RelationAssertionV1; readonly after: { readonly state: "UNKNOWN" }; readonly evidenceIds: readonly EvidenceId[] }
export type ProposedOperationV1 = ProposedDeclareEntityOperationV1 | ProposedSetFactOperationV1 | ProposedRetractFactOperationV1 | ProposedSetRelationOperationV1 | ProposedRetractRelationOperationV1;

export type ProposedEvidenceV1 =
  | { readonly kind: "FINAL_PROSE_SPAN"; readonly evidenceId: EvidenceId; readonly startUtf16: number; readonly endUtf16: number; readonly quote: string }
  | { readonly kind: "PREDECESSOR_TRUTH_RECORD"; readonly evidenceId: EvidenceId; readonly recordRef: BoundTruthNodeRefV1; readonly recordSha256: Sha256 };
export type EvidenceV1 =
  | (Extract<ProposedEvidenceV1, { kind: "FINAL_PROSE_SPAN" }> & { readonly candidateSha256: Sha256 })
  | (Extract<ProposedEvidenceV1, { kind: "PREDECESSOR_TRUTH_RECORD" }> & { readonly predecessorTruthSha256: Sha256 });

export interface AmbiguityV1 {
  readonly ambiguityId: AmbiguityId;
  readonly classification: "PROSE_SEMANTICS_UNRESOLVED" | "PREDECESSOR_AUTHORITY_CONFLICT" | "ENTITY_IDENTITY_UNRESOLVED" | "VOCABULARY_MAPPING_UNRESOLVED" | "EVIDENCE_INSUFFICIENT";
  readonly description: string;
  readonly proseEvidenceIds: readonly EvidenceId[];
  readonly predecessorEvidenceIds: readonly EvidenceId[];
  readonly relatedOperationIds: readonly OperationId[];
  readonly relatedNodeRefs: readonly BoundTruthNodeRefV1[];
}

export type ChapterDeltaProposalV1 =
  | { readonly schemaVersion: "1.0"; readonly kind: "CHAPTER_DELTA_PROPOSAL"; readonly status: "READY"; readonly operations: readonly ProposedOperationV1[]; readonly evidence: readonly ProposedEvidenceV1[]; readonly ambiguities: readonly [] }
  | { readonly schemaVersion: "1.0"; readonly kind: "CHAPTER_DELTA_PROPOSAL"; readonly status: "AMBIGUOUS"; readonly operations: readonly ProposedOperationV1[]; readonly evidence: readonly ProposedEvidenceV1[]; readonly ambiguities: readonly [AmbiguityV1, ...AmbiguityV1[]] };

export type BoundDeclareEntityOperationV1 =
  | { readonly kind: "DECLARE_ENTITY"; readonly operationId: OperationId; readonly before: { readonly state: "ABSENT" }; readonly after: { readonly state: "PRESENT"; readonly definition: Extract<EntityDefinitionV1, { definitionType: "NARRATIVE_ENTITY" }> }; readonly declaredEntityId: EntityId; readonly evidenceIds: readonly EvidenceId[] }
  | { readonly kind: "DECLARE_ENTITY"; readonly operationId: OperationId; readonly before: { readonly state: "ABSENT" }; readonly after: { readonly state: "PRESENT"; readonly definition: Exclude<EntityDefinitionV1, { definitionType: "NARRATIVE_ENTITY" }> }; readonly declaredEntryId: EntryId; readonly evidenceIds: readonly EvidenceId[] };
export interface BoundSetFactOperationV1 { readonly kind: "SET_FACT"; readonly operationId: OperationId; readonly subject: Extract<BoundTruthNodeRefV1, { nodeKind: "ENTITY" }>; readonly factKeyEntryId: EntryId; readonly factSlotId: FactSlotId; readonly before: FactBeforeV1; readonly after: FactAssertionV1; readonly evidenceIds: readonly EvidenceId[] }
export interface BoundRetractFactOperationV1 { readonly kind: "RETRACT_FACT"; readonly operationId: OperationId; readonly subject: Extract<BoundTruthNodeRefV1, { nodeKind: "ENTITY" }>; readonly factKeyEntryId: EntryId; readonly factSlotId: FactSlotId; readonly before: FactAssertionV1; readonly after: { readonly state: "UNKNOWN" }; readonly evidenceIds: readonly EvidenceId[] }
export interface BoundSetRelationOperationV1 { readonly kind: "SET_RELATION"; readonly operationId: OperationId; readonly subject: BoundTruthNodeRefV1; readonly relationPredicateEntryId: EntryId; readonly relationId: RelationId; readonly directionality: "DIRECTED" | "SYMMETRIC"; readonly object: BoundTruthNodeRefV1; readonly before: RelationBeforeV1; readonly after: RelationAssertionV1; readonly evidenceIds: readonly EvidenceId[] }
export interface BoundRetractRelationOperationV1 { readonly kind: "RETRACT_RELATION"; readonly operationId: OperationId; readonly subject: BoundTruthNodeRefV1; readonly relationPredicateEntryId: EntryId; readonly relationId: RelationId; readonly directionality: "DIRECTED" | "SYMMETRIC"; readonly object: BoundTruthNodeRefV1; readonly before: RelationAssertionV1; readonly after: { readonly state: "UNKNOWN" }; readonly evidenceIds: readonly EvidenceId[] }
export type BoundOperationV1 = BoundDeclareEntityOperationV1 | BoundSetFactOperationV1 | BoundRetractFactOperationV1 | BoundSetRelationOperationV1 | BoundRetractRelationOperationV1;

export interface BoundChapterDeltaBodyV1 {
  readonly schemaVersion: "1.0";
  readonly transactionId: string;
  readonly attemptId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly candidateSha256: Sha256;
  readonly predecessorCommitSha256: Sha256;
  readonly predecessorTruthSha256: Sha256;
  readonly predecessorVocabularyCatalogSha256: Sha256;
  readonly extractorLogicalOperationId: string;
  readonly extractorInputFingerprint: Sha256;
  readonly providerArtifactSha256: Sha256;
  readonly responseContentSha256: Sha256;
  readonly proposedDeltaCanonicalSha256: Sha256;
  readonly evidence: readonly EvidenceV1[];
  readonly operations: readonly BoundOperationV1[];
}
export interface AcceptedChapterDeltaV1 { readonly schemaVersion: "1.0"; readonly deltaId: Sha256; readonly delta: BoundChapterDeltaBodyV1 }

export interface ChapterDeltaHostBindingV1 extends Omit<BoundChapterDeltaBodyV1, "schemaVersion" | "proposedDeltaCanonicalSha256" | "evidence" | "operations"> {}

export type ChapterDeltaAdmissionResultV1 =
  | { readonly status: "ACCEPTED"; readonly canonicalProposalSha256: Sha256; readonly acceptedDelta: AcceptedChapterDeltaV1 }
  | { readonly status: "AMBIGUOUS"; readonly canonicalProposalSha256: Sha256; readonly hostBinding: ChapterDeltaHostBindingV1; readonly ambiguities: readonly AmbiguityV1[] };

export type { CanonicalFactValueV1 };
