import type { ChapterDeltaProposalV1 } from "../models/chapter-delta.js";
import { canonicalJson, parseJsonRejectingDuplicates, sha256Utf8 } from "../state/canonical-json.js";
import { BaseAgent, type AgentContext } from "./base.js";
import type { TokenUsage } from "./writer.js";
import type { LLMMessage } from "../llm/provider.js";
import type { FinalProviderRequestObservation } from "../agent/worker-agent.js";
import { projectTruthSettlementContext } from "./truth-settlement-context.js";

export interface TruthExtractionRequest {
  readonly transactionId: string;
  readonly attemptId: string;
  readonly chapterNumber: number;
  readonly candidate: string;
  readonly candidateSha256: string;
  readonly predecessorTruthSha256: string;
  readonly predecessorCommitSha256: string;
  readonly vocabularyCatalogSha256: string;
  readonly extractionKind: "INITIAL" | "REPAIR";
  readonly repairOrdinal: 0 | 1;
  readonly predecessorTruthJson: string;
  readonly vocabularyCatalogJson: string;
  readonly committedAuthority: string;
  readonly chapterMemo?: string;
  readonly repairDiagnostics?: readonly string[];
  readonly repairAuthorization?: TruthRepairAuthorizationV1;
}

export interface TruthRepairAuthorizationV1 {
  readonly schemaVersion: "1.0";
  readonly kind: "CANONICAL_TRUTH_REPAIR_AUTHORIZATION";
  readonly source: "DELTA_ADMISSION" | "SEMANTIC_VALIDATION";
  readonly initialExtractionContextSha256: string;
  readonly initialExtractionArtifactSha256: string;
  readonly initialProviderResponseSha256: string;
  readonly initialDefectArtifactSha256: string;
  readonly initialValidationContextSha256?: string;
  readonly initialValidationArtifactSha256?: string;
  readonly diagnostics: readonly string[];
}

export interface TruthExtractionResponse {
  readonly rawProposal: string;
  readonly responseContentSha256: string;
  readonly usage: TokenUsage;
}

export const TRUTH_EXTRACTOR_OPTIONS = { temperature: 0.1, maxTokens: 16_384 } as const;

export const FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR = {
  schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", unknownFields: "FORBIDDEN",
  envelope: {
    READY: { exactFields: ["schemaVersion", "kind", "status", "operations", "evidence", "ambiguities"], status: "READY", ambiguities: "EXACT_EMPTY_ARRAY" },
    AMBIGUOUS: { exactFields: ["schemaVersion", "kind", "status", "operations", "evidence", "ambiguities"], status: "AMBIGUOUS", ambiguities: "NON_EMPTY_ARRAY" },
  },
  definitions: {
    entityDefinition: [
      { definitionType: "NARRATIVE_ENTITY", exactFields: ["definitionType", "entityKind", "identityKey", "canonicalName", "aliases"] },
      { definitionType: "VOCABULARY_FACT_KEY", exactFields: ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "valueContract"], metaKind: "system.vocabulary.fact-key" },
      { definitionType: "VOCABULARY_RELATION_PREDICATE", exactFields: ["definitionType", "metaKind", "canonicalName", "semanticDefinition", "subjectObjectContract", "directionality"], metaKind: "system.vocabulary.relation-predicate", directionality: ["DIRECTED", "SYMMETRIC"] },
    ],
    subjectObjectContract: {
      exactFields: ["schemaVersion", "subjectKinds", "objectKinds", "allowReflexive"],
      schemaVersion: "1.0",
      subjectKinds: ["ENTITY", "FACT_SLOT", "RELATION"],
      objectKinds: ["ENTITY", "FACT_SLOT", "RELATION"],
      allowReflexive: "BOOLEAN",
    },
    factValueContract: [
      { contractType: "STRING", exactFields: ["contractType"] }, { contractType: "BOOLEAN", exactFields: ["contractType"] },
      { contractType: "INTEGER", exactFields: ["contractType", "unit"], unit: "NON_EMPTY_NFC_STRING_OR_NULL" },
      { contractType: "DECIMAL", exactFields: ["contractType", "unit"], unit: "NON_EMPTY_NFC_STRING_OR_NULL" },
      { contractType: "ENUM", exactFields: ["contractType", "allowedValues"], allowedValues: "NON_EMPTY_NFC_STRING_ARRAY" },
      { contractType: "ENTITY_REF", exactFields: ["contractType"] },
    ],
    proposedFactValue: [
      { valueType: "STRING", exactFields: ["valueType", "value"], value: "NFC_STRING" },
      { valueType: "BOOLEAN", exactFields: ["valueType", "value"], value: "BOOLEAN" },
      { valueType: "INTEGER", exactFields: ["valueType", "value"], value: "CANONICAL_INTEGER_STRING" },
      { valueType: "DECIMAL", exactFields: ["valueType", "value"], value: "CANONICAL_DECIMAL_STRING" },
      { valueType: "ENTITY_REF", exactFields: ["valueType", "entity"], entity: "ENTITY_REF" },
    ],
    entityRef: [{ refType: "ENTITY_ID", exactFields: ["refType", "entityId"] }, { refType: "LOCAL_ENTITY", exactFields: ["refType", "localRef"] }],
    factKeyRef: [{ refType: "FACT_KEY_ENTRY_ID", exactFields: ["refType", "entryId"] }, { refType: "LOCAL_FACT_KEY", exactFields: ["refType", "localRef"] }],
    relationPredicateRef: [{ refType: "RELATION_PREDICATE_ENTRY_ID", exactFields: ["refType", "entryId"] }, { refType: "LOCAL_RELATION_PREDICATE", exactFields: ["refType", "localRef"] }],
    truthNodeRef: [
      { refType: "NODE_ID", exactFields: ["nodeKind", "refType", "nodeId"], nodeKind: ["ENTITY", "FACT_SLOT", "RELATION"] },
      { refType: "LOCAL_ENTITY", exactFields: ["nodeKind", "refType", "localRef"], nodeKind: "ENTITY" },
      { refType: "OPERATION_TARGET", exactFields: ["nodeKind", "refType", "targetOperationId"], nodeKind: ["FACT_SLOT", "RELATION"] },
    ],
    factAssertion: [{ state: "ABSENT", exactFields: ["state"] }, { state: "VALUE", exactFields: ["state", "value"], value: "PROPOSED_FACT_VALUE" }],
    factBefore: [{ state: "UNKNOWN", exactFields: ["state"] }, { state: "ABSENT", exactFields: ["state"] }, { state: "VALUE", exactFields: ["state", "value"], value: "PROPOSED_FACT_VALUE" }],
    relationAssertion: [{ state: "PRESENT", exactFields: ["state"] }, { state: "ABSENT", exactFields: ["state"] }],
    relationBefore: [{ state: "UNKNOWN", exactFields: ["state"] }, { state: "PRESENT", exactFields: ["state"] }, { state: "ABSENT", exactFields: ["state"] }],
    operations: [
      { kind: "DECLARE_ENTITY", exactFields: ["kind", "operationId", "localRef", "before", "after", "evidenceIds"], before: { state: "ABSENT" }, after: { state: "PRESENT", definition: "ENTITY_DEFINITION" } },
      { kind: "SET_FACT", exactFields: ["kind", "operationId", "subject", "factKey", "before", "after", "evidenceIds"], subject: "ENTITY_REF", factKey: "FACT_KEY_REF", before: "FACT_BEFORE", after: "FACT_ASSERTION" },
      { kind: "RETRACT_FACT", exactFields: ["kind", "operationId", "subject", "factKey", "before", "after", "evidenceIds"], subject: "ENTITY_REF", factKey: "FACT_KEY_REF", before: "FACT_ASSERTION", after: { state: "UNKNOWN" } },
      { kind: "SET_RELATION", exactFields: ["kind", "operationId", "subject", "relationPredicate", "object", "before", "after", "evidenceIds"], subject: "TRUTH_NODE_REF", relationPredicate: "RELATION_PREDICATE_REF", object: "TRUTH_NODE_REF", before: "RELATION_BEFORE", after: "RELATION_ASSERTION" },
      { kind: "RETRACT_RELATION", exactFields: ["kind", "operationId", "subject", "relationPredicate", "object", "before", "after", "evidenceIds"], subject: "TRUTH_NODE_REF", relationPredicate: "RELATION_PREDICATE_REF", object: "TRUTH_NODE_REF", before: "RELATION_ASSERTION", after: { state: "UNKNOWN" } },
    ],
    evidence: [
      { kind: "FINAL_PROSE_SPAN", exactFields: ["kind", "evidenceId", "startUtf16", "endUtf16", "quote"] },
      { kind: "PREDECESSOR_TRUTH_RECORD", exactFields: ["kind", "evidenceId", "recordRef", "recordSha256"], recordRef: { exactFields: ["nodeKind", "nodeId"], nodeKind: ["ENTITY", "FACT_SLOT", "RELATION"] } },
    ],
    ambiguity: {
      exactFields: ["ambiguityId", "classification", "description", "proseEvidenceIds", "predecessorEvidenceIds", "relatedOperationIds", "relatedNodeRefs"],
      classification: ["PROSE_SEMANTICS_UNRESOLVED", "PREDECESSOR_AUTHORITY_CONFLICT", "ENTITY_IDENTITY_UNRESOLVED", "VOCABULARY_MAPPING_UNRESOLVED", "EVIDENCE_INSUFFICIENT"],
      relatedNodeRefs: { exactFields: ["nodeKind", "nodeId"], nodeKind: ["ENTITY", "FACT_SLOT", "RELATION"] },
    },
  },
} as const;

/** The exact immutable message preimage used by the Truth Extractor transport. */
export function buildTruthExtractorMessages(input: TruthExtractionRequest): readonly LLMMessage[] {
  const context = projectTruthSettlementContext(input);
  return [
    {
      role: "system",
      content: [
        "You are InkOS's sole model-facing Truth Extractor.",
        "Return exactly one ChapterDeltaProposalV1 JSON object and nothing else.",
        "BEGIN_FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR",
        canonicalJson(FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR),
        "END_FROZEN_CHAPTER_DELTA_PROPOSAL_V1_GRAMMAR",
        "You may emit only schemaVersion, kind, status, operations, evidence, and ambiguities.",
        "The frozen operation grammar contains exactly five kinds: DECLARE_ENTITY, SET_FACT, RETRACT_FACT, SET_RELATION, RETRACT_RELATION.",
        "DECLARE_ENTITY uses operationId, localRef=local:${operationId}, before={state:ABSENT}, after={state:PRESENT,definition}, and nonempty evidenceIds.",
        "SET_FACT and RETRACT_FACT use subject ENTITY_ID or LOCAL_ENTITY plus factKey FACT_KEY_ENTRY_ID or LOCAL_FACT_KEY; include exact before, after, and nonempty evidenceIds.",
        "SET_RELATION and RETRACT_RELATION use subject/object NODE_ID, LOCAL_ENTITY, or OPERATION_TARGET plus relationPredicate RELATION_PREDICATE_ENTRY_ID or LOCAL_RELATION_PREDICATE; include exact before, after, and nonempty evidenceIds.",
        "Every operationId/evidenceId/ambiguityId is the canonical ordinal op-0001/ev-0001/amb-0001 and all references must resolve without guessing.",
        "FINAL_PROSE_SPAN evidence requires exact UTF-16 start/end offsets and quote from the approved candidate.",
        "PREDECESSOR_TRUTH_RECORD evidence requires the exact bound record reference and record SHA-256; replacements and retractions require it in addition to prose evidence.",
        "Use status=AMBIGUOUS with a typed nonempty ambiguities array whenever entity identity, vocabulary mapping, predecessor authority, prose meaning, or evidence is unresolved; never guess or silently coerce.",
        "READY requires an empty ambiguities array and every before/after transition and evidenceIds binding to be fully supported.",
        "Never emit complete truth, projection bytes, prose revisions, validation, or commit decisions.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `transactionId=${input.transactionId}`,
        `attemptId=${input.attemptId}`,
        `chapterNumber=${input.chapterNumber}`,
        `candidateSha256=${input.candidateSha256}`,
        `predecessorTruthSha256=${input.predecessorTruthSha256}`,
        `predecessorCommitSha256=${input.predecessorCommitSha256}`,
        `vocabularyCatalogSha256=${input.vocabularyCatalogSha256}`,
        `extractionKind=${input.extractionKind}`,
        `repairOrdinal=${input.repairOrdinal}`,
        input.repairDiagnostics?.length ? `repairDiagnostics=${canonicalJson(input.repairDiagnostics)}` : undefined,
        input.repairAuthorization ? `repairAuthorization=${canonicalJson(input.repairAuthorization)}` : undefined,
        "## Exact approved candidate",
        input.candidate,
        "## Verified predecessor StructuredTruthV1",
        input.predecessorTruthJson,
        "## Verified vocabulary catalog",
        context.vocabularyCatalogJson,
        "## Verified committed authority",
        context.committedAuthority,
        "## Non-authorizing chapter memo",
        context.chapterMemo ?? "(none)",
      ].filter((part): part is string => part !== undefined).join("\n\n"),
    },
  ];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const locked = [...expected].sort();
  if (actual.length !== locked.length || actual.some((key, index) => key !== locked[index])) {
    throw new Error("Truth Extractor response contains an unknown field or omits an exact field");
  }
}

export function parseTruthExtractorResponse(raw: string): ChapterDeltaProposalV1 {
  const parsed = parseJsonRejectingDuplicates(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Truth Extractor response must be one JSON object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "kind", "status", "operations", "evidence", "ambiguities"]);
  if (value.schemaVersion !== "1.0" || value.kind !== "CHAPTER_DELTA_PROPOSAL"
    || (value.status !== "READY" && value.status !== "AMBIGUOUS")
    || !Array.isArray(value.operations) || !Array.isArray(value.evidence) || !Array.isArray(value.ambiguities)) {
    throw new Error("Truth Extractor response is not an exact ChapterDeltaProposalV1 envelope");
  }
  if (value.status === "READY" && value.ambiguities.length !== 0) throw new Error("READY proposal cannot contain ambiguities");
  if (value.status === "AMBIGUOUS" && value.ambiguities.length === 0) throw new Error("AMBIGUOUS proposal requires ambiguity evidence");
  return parsed as ChapterDeltaProposalV1;
}

export class TruthExtractorAgent extends BaseAgent {
  constructor(ctx: AgentContext) { super(ctx); }

  get name(): string { return "truth-extractor"; }

  async extract(
    input: TruthExtractionRequest,
    onFinalProviderRequest?: (request: FinalProviderRequestObservation) => void | Promise<void>,
  ): Promise<TruthExtractionResponse> {
    if (sha256Utf8(input.candidate) !== input.candidateSha256) throw new Error("Truth Extractor candidate SHA mismatch");
    if ((input.extractionKind === "INITIAL" && input.repairOrdinal !== 0)
      || (input.extractionKind === "REPAIR" && input.repairOrdinal !== 1)) {
      throw new Error("Truth Extractor repair identity mismatch");
    }
    const response = await this.chat(buildTruthExtractorMessages(input), { ...TRUTH_EXTRACTOR_OPTIONS, onFinalProviderRequest });
    return { rawProposal: response.content, responseContentSha256: sha256Utf8(response.content), usage: response.usage };
  }
}
