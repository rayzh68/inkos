import { randomUUID } from "node:crypto";
import { isValidProviderUsage } from "../llm/usage.js";
import { publishImmutableFile } from "../utils/atomic-file-set.js";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AcceptedChapterDeltaV1, ChapterDeltaAdmissionResultV1 } from "../models/chapter-delta.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { buildTruthExtractorMessages, type TruthExtractionRequest, type TruthRepairAuthorizationV1 } from "../agents/truth-extractor.js";
import { buildTruthValidatorMessages, parseTruthValidatorResponse, TruthValidatorArtifactError, type TruthValidationRequest, type TruthValidationVerdict } from "../agents/truth-validator.js";
import type { LLMMessage } from "../llm/provider.js";
import type { RoleTokenUsage } from "./bounded-review.js";
import { admitChapterDeltaV1, validateAcceptedChapterDeltaV1 } from "../state/chapter-delta-admission.js";
import { canonicalJson, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { buildProjectionManifestV1, type ProjectionManifestV1 } from "../state/projection-manifest.js";
import { renderStructuredTruthProjectionsV1, type ProjectionArtifactV1 } from "../state/structured-truth-projections.js";
import { reduceStructuredTruthV1 } from "../state/structured-truth-reducer.js";
import { validateStructuredTruthV1 } from "../models/structured-truth.js";
import {
  assertCanonicalTruthTerminalReviewAuthority,
  assertCurrentChapterTransactionAttempt,
  ChapterArtifactEvidenceError,
  publishOpenChapterTransaction,
} from "../production/chapter-transaction.js";

export interface CanonicalTruthExtractionArtifact {
  readonly rawProposal: string;
  readonly logicalOperationId: string;
  readonly inputFingerprint: string;
  readonly providerArtifactSha256: string;
  readonly responseContentSha256: string;
  readonly usage: RoleTokenUsage;
  readonly contextSha256?: string;
}

export interface CanonicalTruthValidationArtifact {
  readonly verdict: TruthValidationVerdict;
  readonly diagnostics: readonly string[];
  readonly rawResponse: string;
  readonly logicalOperationId: string;
  readonly inputFingerprint: string;
  readonly providerArtifactSha256: string;
  readonly responseContentSha256: string;
  readonly usage: RoleTokenUsage;
  readonly contextSha256?: string;
}

export interface CanonicalTruthExecutionIdentity {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly stream: boolean;
  readonly webSearch: boolean;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly fullRequestSha256: string;
  readonly inputFingerprint: string;
}

export interface CanonicalTruthExtractionContextRecord {
  readonly schemaVersion: "1.0";
  readonly kind: "CANONICAL_TRUTH_MODEL_CONTEXT";
  readonly baseContextSha256: string;
  readonly role: "truth-extractor";
  readonly stage: "TRUTH_EXTRACTION" | "TRUTH_EXTRACTION_REPAIR";
  readonly extractionKind: "INITIAL" | "REPAIR";
  readonly repairOrdinal: 0 | 1;
  readonly requestSha256: string;
  readonly request: TruthExtractionRequest;
  readonly execution: CanonicalTruthExecutionIdentity;
  readonly contextSha256: string;
}

export interface CanonicalTruthValidationContextRecord {
  readonly schemaVersion: "1.0";
  readonly kind: "CANONICAL_TRUTH_MODEL_CONTEXT";
  readonly baseContextSha256: string;
  readonly role: "truth-validator";
  readonly stage: "TRUTH_VALIDATION";
  readonly extractionKind: "INITIAL" | "REPAIR";
  readonly repairOrdinal: 0 | 1;
  readonly requestSha256: string;
  readonly request: TruthValidationRequest;
  readonly execution: CanonicalTruthExecutionIdentity;
  readonly contextSha256: string;
}

export interface TruthApplicationReceiptV1 {
  readonly schemaVersion: "1.0";
  readonly kind: "TRUTH_APPLICATION_RECEIPT";
  readonly transactionId: string;
  readonly attemptId: string;
  readonly candidateSha256: string;
  readonly predecessorCommitSha256: string;
  readonly predecessorTruthSha256: string;
  readonly acceptedDeltaSha256: string;
  readonly deltaId: string;
  readonly admissionSha256: string;
  readonly resultingTruthSha256: string;
  readonly operationOutcomes: readonly { readonly operationId: string; readonly status: "APPLIED" }[];
  readonly reducerId: "inkos.structured-truth.reducer.v1";
  readonly reducerVersion: "1.0";
}

export interface CanonicalTruthProviderEvidenceCheck {
  readonly role: "truth-extractor" | "truth-validator";
  readonly stage: "TRUTH_EXTRACTION" | "TRUTH_EXTRACTION_REPAIR" | "TRUTH_VALIDATION";
  readonly repairOrdinal: 0 | 1;
  readonly execution: CanonicalTruthExecutionIdentity;
  readonly artifact: CanonicalTruthExtractionArtifact | CanonicalTruthValidationArtifact;
}

interface CommonInput {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly chapterNumber: number;
  readonly candidate: string;
  readonly candidateSha256: string;
  readonly predecessorCommitSha256: string;
  readonly predecessor: StructuredTruthV1;
  readonly committedAuthority?: string;
  readonly chapterMemo?: string;
  readonly extractorExecution: (request: TruthExtractionRequest) => CanonicalTruthExecutionIdentity;
  readonly validatorExecution: (request: TruthValidationRequest, cycle: { readonly extractionKind: "INITIAL" | "REPAIR"; readonly repairOrdinal: 0 | 1 }) => CanonicalTruthExecutionIdentity;
  readonly extractor: (request: TruthExtractionRequest, execution: CanonicalTruthExecutionIdentity) => Promise<CanonicalTruthExtractionArtifact>;
  readonly validator: (request: TruthValidationRequest, execution: CanonicalTruthExecutionIdentity, cycle: { readonly extractionKind: "INITIAL" | "REPAIR"; readonly repairOrdinal: 0 | 1 }) => Promise<CanonicalTruthValidationArtifact>;
  /** The production host owns Provider artifacts and exact reservation/binding authority. */
  readonly revalidateProviderEvidence: (input: CanonicalTruthProviderEvidenceCheck) => Promise<void>;
  /** Durable transition observer used by recovery verification and fault injection. */
  readonly onDurableBoundary?: (boundary: "AFTER_DELTA_ADMISSION" | "AFTER_APPLICATION_RECEIPT" | "AFTER_VALIDATOR_COMPLETE" | "AFTER_ACCEPTED_AUTHORITY" | "AFTER_PROJECTION_REPAIR_ADMISSION") => Promise<void> | void;
}

export type CanonicalTruthTransactionResult =
  | {
    readonly status: "PASS";
    readonly acceptedDelta: AcceptedChapterDeltaV1;
    readonly deltaAdmission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>;
    readonly extractorEvidence: Pick<CanonicalTruthExtractionArtifact, "logicalOperationId" | "inputFingerprint" | "providerArtifactSha256" | "responseContentSha256"> & { readonly contextSha256: string };
    readonly applicationReceipt: TruthApplicationReceiptV1;
    readonly resultingTruth: StructuredTruthV1;
    readonly projections: readonly ProjectionArtifactV1[];
    readonly projectionManifest: ProjectionManifestV1;
    readonly semanticValidation: CanonicalTruthValidationArtifact;
    readonly extractionContext: CanonicalTruthExtractionContextRecord;
    readonly validationContext: CanonicalTruthValidationContextRecord;
    readonly contextSha256: string;
    readonly usageByRole: Readonly<Record<string, RoleTokenUsage>>;
  }
  | {
    readonly status: Exclude<TruthValidationVerdict, "PASS"> | "HOST_APPLICATION_DEFECT" | "ARTIFACT_EVIDENCE_DEFECT" | "PROJECTION_DEFECT";
    readonly repairExhausted: boolean;
    readonly diagnostics: readonly string[];
    readonly usageByRole: Readonly<Record<string, RoleTokenUsage>>;
  };

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function writeImmutableBytes(path: string, value: unknown): Promise<void> {
  const bytes = `${canonicalJson(value)}\n`;
  await publishImmutableFile(path, bytes);
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!(await exists(path))) return null;
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { throw new Error(`Immutable canonical truth artifact is unreadable at ${path}`, { cause: error }); }
}

async function resolveAcceptedCycle(
  root: string,
  acceptedDelta: AcceptedChapterDeltaV1,
): Promise<{
  readonly extractionKind: "INITIAL" | "REPAIR";
  readonly repairOrdinal: 0 | 1;
  readonly repairDiagnostics?: readonly string[];
  readonly repairAuthorization?: TruthRepairAuthorizationV1;
  readonly admission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>;
}> {
  const matches: Array<{
    extractionKind: "INITIAL" | "REPAIR";
    repairOrdinal: 0 | 1;
    admission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>;
  }> = [];
  for (const cycle of [
    { extractionKind: "INITIAL" as const, repairOrdinal: 0 as const },
    { extractionKind: "REPAIR" as const, repairOrdinal: 1 as const },
  ]) {
    const admission = await readJsonIfExists<ChapterDeltaAdmissionResultV1>(
      join(root, cycle.extractionKind.toLowerCase(), "delta-admission.json"),
    );
    if (admission?.status === "ACCEPTED"
      && canonicalJson(admission.acceptedDelta) === canonicalJson(acceptedDelta)) {
      matches.push({ ...cycle, admission });
    }
  }
  if (matches.length !== 1) throw new Error("Immutable accepted delta cycle authority mismatch");
  const match = matches[0]!;
  if (match.extractionKind === "INITIAL") return match;
  const repairAuthorization = await loadRepairAuthorization(root);
  return { ...match, repairDiagnostics: repairAuthorization.diagnostics, repairAuthorization };
}

function evidenceRoot(input: CommonInput): string {
  const chapterRoot = join(input.bookDir, "story", "runtime", "chapter-transactions", `chapter-${String(input.chapterNumber).padStart(4, "0")}`);
  const attemptRoot = input.attemptNumber === 1 ? chapterRoot : join(chapterRoot, "attempts", `attempt-${String(input.attemptNumber).padStart(4, "0")}`);
  return join(attemptRoot, "staging", "evidence", "truth");
}

function immutableBaseContext(input: CommonInput) {
  return {
    schemaVersion: "1.0" as const,
    kind: "CANONICAL_TRUTH_CONTEXT" as const,
    transactionId: input.transactionId,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    chapterNumber: input.chapterNumber,
    candidateSha256: input.candidateSha256,
    predecessorCommitSha256: input.predecessorCommitSha256,
    predecessorTruthSha256: canonicalSha256(input.predecessor),
    predecessorVocabularyCatalogSha256: canonicalSha256(input.predecessor.vocabulary),
    committedAuthoritySha256: sha256Utf8(input.committedAuthority ?? ""),
    chapterMemoSha256: sha256Utf8(input.chapterMemo ?? ""),
    extractorPromptVersion: "inkos.truth-extractor.prompt.v1",
    extractorSchemaVersion: "ChapterDeltaProposalV1/1.0",
    validatorPromptVersion: "inkos.truth-validator.prompt.v1",
    validatorSchemaVersion: "TruthValidationResult/1.0",
  };
}

function buildExtractionRequest(
  input: CommonInput,
  extractionKind: "INITIAL" | "REPAIR",
  repairOrdinal: 0 | 1,
  repairDiagnostics?: readonly string[],
  repairAuthorization?: TruthRepairAuthorizationV1,
): TruthExtractionRequest {
  return {
    transactionId: input.transactionId, attemptId: input.attemptId, chapterNumber: input.chapterNumber,
    candidate: input.candidate, candidateSha256: input.candidateSha256,
    predecessorTruthSha256: canonicalSha256(input.predecessor), predecessorCommitSha256: input.predecessorCommitSha256,
    vocabularyCatalogSha256: canonicalSha256(input.predecessor.vocabulary), extractionKind, repairOrdinal,
    predecessorTruthJson: canonicalJson(input.predecessor), vocabularyCatalogJson: canonicalJson(input.predecessor.vocabulary),
    committedAuthority: input.committedAuthority ?? "",
    ...(input.chapterMemo !== undefined ? { chapterMemo: input.chapterMemo } : {}),
    ...(repairDiagnostics ? { repairDiagnostics } : {}),
    ...(repairAuthorization ? { repairAuthorization } : {}),
  };
}

function executionFingerprint(
  execution: Omit<CanonicalTruthExecutionIdentity, "inputFingerprint">,
  messages: readonly LLMMessage[] = execution.messages,
): string {
  return sha256Utf8(JSON.stringify({
    provider: execution.provider,
    model: execution.model,
    messages,
    temperature: execution.temperature,
    maxTokens: execution.maxTokens,
    stream: execution.stream,
  }));
}

function fullExecutionFingerprint(execution: Omit<CanonicalTruthExecutionIdentity, "fullRequestSha256" | "inputFingerprint">): string {
  return canonicalSha256({
    provider: execution.provider,
    model: execution.model,
    messages: execution.messages,
    temperature: execution.temperature,
    maxTokens: execution.maxTokens,
    stream: execution.stream,
    webSearch: execution.webSearch,
    extra: execution.extra,
  });
}

function assertExecutionIdentity(
  execution: CanonicalTruthExecutionIdentity,
  expectedMessages: readonly LLMMessage[],
  label: string,
): void {
  if (!execution.provider.trim() || !execution.model.trim()
    || !Number.isFinite(execution.temperature) || !Number.isSafeInteger(execution.maxTokens) || execution.maxTokens <= 0
    || typeof execution.stream !== "boolean"
    || typeof execution.webSearch !== "boolean"
    || !execution.extra || typeof execution.extra !== "object" || Array.isArray(execution.extra)
    || canonicalJson(execution.messages) !== canonicalJson(expectedMessages)
    || execution.fullRequestSha256 !== fullExecutionFingerprint(execution)
    || execution.inputFingerprint !== executionFingerprint(execution, expectedMessages)) {
    throw new Error(`${label} frozen execution identity mismatch`);
  }
}

function buildExtractionContext(
  baseContextSha256: string,
  request: TruthExtractionRequest,
  execution: CanonicalTruthExecutionIdentity,
): Omit<CanonicalTruthExtractionContextRecord, "contextSha256"> {
  assertExecutionIdentity(execution, buildTruthExtractorMessages(request), "Truth Extractor");
  return {
    schemaVersion: "1.0", kind: "CANONICAL_TRUTH_MODEL_CONTEXT", baseContextSha256,
    role: "truth-extractor", stage: request.extractionKind === "INITIAL" ? "TRUTH_EXTRACTION" : "TRUTH_EXTRACTION_REPAIR",
    extractionKind: request.extractionKind, repairOrdinal: request.repairOrdinal,
    requestSha256: canonicalSha256(request), request,
    execution,
  };
}

function buildValidationRequest(
  input: CommonInput,
  derived: ReturnType<typeof deriveArtifacts>,
): TruthValidationRequest {
  return {
    candidate: input.candidate, candidateSha256: input.candidateSha256,
    predecessorTruthJson: canonicalJson(input.predecessor), predecessorTruthSha256: canonicalSha256(input.predecessor),
    acceptedDeltaJson: canonicalJson(derived.acceptedDelta), acceptedDeltaSha256: canonicalSha256(derived.acceptedDelta),
    resultingTruthJson: canonicalJson(derived.resultingTruth), resultingTruthSha256: canonicalSha256(derived.resultingTruth),
    committedAuthority: input.committedAuthority ?? "", applicationReceiptSha256: canonicalSha256(derived.applicationReceipt),
    projectionManifestSha256: canonicalSha256(derived.projectionManifest),
  };
}

function buildValidationContext(
  baseContextSha256: string,
  extractionKind: "INITIAL" | "REPAIR",
  repairOrdinal: 0 | 1,
  request: TruthValidationRequest,
  execution: CanonicalTruthExecutionIdentity,
): Omit<CanonicalTruthValidationContextRecord, "contextSha256"> {
  assertExecutionIdentity(execution, buildTruthValidatorMessages(request), "Truth Validator");
  return {
    schemaVersion: "1.0", kind: "CANONICAL_TRUTH_MODEL_CONTEXT", baseContextSha256,
    role: "truth-validator", stage: "TRUTH_VALIDATION", extractionKind, repairOrdinal,
    requestSha256: canonicalSha256(request), request,
    execution,
  };
}

async function assertCurrentAttempt(input: CommonInput): Promise<void> {
  await assertCurrentChapterTransactionAttempt({
    bookDir: input.bookDir, transactionId: input.transactionId, attemptId: input.attemptId,
    attemptNumber: input.attemptNumber, chapterNumber: input.chapterNumber,
    predecessorCommitSha256: input.predecessorCommitSha256,
  });
}

function assertInput(input: CommonInput): void {
  validateStructuredTruthV1(input.predecessor);
  if (sha256Utf8(input.candidate) !== input.candidateSha256) throw new Error("Canonical truth candidate SHA mismatch");
  if (input.predecessor.bookId === "" || input.predecessor.throughChapter + 1 !== input.chapterNumber) throw new Error("Canonical truth predecessor chapter mismatch");
}

function assertEvidenceIdentity(
  evidence: Pick<CanonicalTruthExtractionArtifact, "logicalOperationId" | "inputFingerprint" | "providerArtifactSha256" | "responseContentSha256">,
  label: string,
): void {
  if (!evidence.logicalOperationId.trim() || !/^[a-f0-9]{64}$/u.test(evidence.inputFingerprint)
    || !/^[a-f0-9]{64}$/u.test(evidence.providerArtifactSha256)
    || !/^[a-f0-9]{64}$/u.test(evidence.responseContentSha256)) {
    throw new Error(`${label} Provider evidence identity is invalid`);
  }
}

function addUsage(left: RoleTokenUsage, right: RoleTokenUsage): RoleTokenUsage {
  const hasCost = left.actualCostUsd !== undefined || right.actualCostUsd !== undefined;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(hasCost ? { actualCostUsd: (left.actualCostUsd ?? 0) + (right.actualCostUsd ?? 0) } : {}),
  };
}

function assertUsage(usage: RoleTokenUsage, label: string): void {
  if (!isValidProviderUsage(usage)) {
    throw new Error(`${label} usage is invalid`);
  }
}

function assertSemanticValidation(artifact: CanonicalTruthValidationArtifact): void {
  assertEvidenceIdentity(artifact, "Truth validation");
  assertUsage(artifact.usage, "Truth validation");
  if (sha256Utf8(artifact.rawResponse) !== artifact.responseContentSha256) {
    throw new Error("Truth validation response hash mismatch");
  }
  const parsed = parseTruthValidatorResponse(artifact.rawResponse);
  if (canonicalJson(parsed) !== canonicalJson({ verdict: artifact.verdict, diagnostics: artifact.diagnostics })) {
    throw new Error("Truth validation raw response does not match the semantic artifact");
  }
}

function buildRepairAuthorization(input: {
  readonly source: "DELTA_ADMISSION" | "SEMANTIC_VALIDATION";
  readonly extractionContext: CanonicalTruthExtractionContextRecord;
  readonly extraction: CanonicalTruthExtractionArtifact;
  readonly diagnostics: readonly string[];
  readonly defectArtifact: unknown;
  readonly validationContext?: CanonicalTruthValidationContextRecord;
  readonly validation?: CanonicalTruthValidationArtifact;
}): TruthRepairAuthorizationV1 {
  const providerResponseSha = input.source === "DELTA_ADMISSION"
    ? input.extraction.responseContentSha256
    : input.validation?.responseContentSha256;
  if (!providerResponseSha) throw new Error("INITIAL repair Provider response authority is missing");
  return {
    schemaVersion: "1.0",
    kind: "CANONICAL_TRUTH_REPAIR_AUTHORIZATION",
    source: input.source,
    initialExtractionContextSha256: input.extractionContext.contextSha256,
    initialExtractionArtifactSha256: canonicalSha256(input.extraction),
    initialProviderResponseSha256: providerResponseSha,
    initialDefectArtifactSha256: canonicalSha256(input.defectArtifact),
    ...(input.validationContext ? { initialValidationContextSha256: input.validationContext.contextSha256 } : {}),
    ...(input.validation ? { initialValidationArtifactSha256: canonicalSha256(input.validation) } : {}),
    diagnostics: input.diagnostics,
  };
}

async function loadRepairAuthorization(root: string): Promise<TruthRepairAuthorizationV1> {
  const stored = await readJsonIfExists<TruthRepairAuthorizationV1>(join(root, "repair-authorization.json"));
  if (!stored) throw new Error("Immutable repair authorization is missing");
  const initialRoot = join(root, "initial");
  const extractionContext = await readJsonIfExists<CanonicalTruthExtractionContextRecord>(join(initialRoot, "extraction-context.json"));
  const extraction = await readJsonIfExists<CanonicalTruthExtractionArtifact>(join(initialRoot, "extraction.json"));
  if (!extractionContext || !extraction) throw new Error("Immutable INITIAL repair authority is missing");
  let expected: TruthRepairAuthorizationV1;
  if (stored.source === "DELTA_ADMISSION") {
    const defect = await readJsonIfExists<{ readonly status?: string; readonly diagnostics?: readonly string[] }>(join(initialRoot, "delta-admission-defect.json"));
    if (defect?.status !== "DELTA_EXTRACTION_DEFECT" || !Array.isArray(defect.diagnostics)) throw new Error("Immutable INITIAL delta defect authority is missing");
    expected = buildRepairAuthorization({ source: stored.source, extractionContext, extraction, diagnostics: defect.diagnostics, defectArtifact: defect });
  } else if (stored.source === "SEMANTIC_VALIDATION") {
    const validationContext = await readJsonIfExists<CanonicalTruthValidationContextRecord>(join(initialRoot, "validation-context.json"));
    const validation = await readJsonIfExists<CanonicalTruthValidationArtifact>(join(initialRoot, "semantic-validation.json"));
    if (!validationContext || !validation || validation.verdict !== "DELTA_EXTRACTION_DEFECT") throw new Error("Immutable INITIAL semantic defect authority is missing");
    assertSemanticValidation(validation);
    expected = buildRepairAuthorization({ source: stored.source, extractionContext, extraction, diagnostics: validation.diagnostics, defectArtifact: validation, validationContext, validation });
  } else {
    throw new Error("Immutable repair authorization source is invalid");
  }
  if (canonicalJson(stored) !== canonicalJson(expected)) throw new Error("Immutable repair authorization binding mismatch");
  return stored;
}

function assertModelContextRecord<T extends CanonicalTruthExtractionContextRecord | CanonicalTruthValidationContextRecord>(
  record: T,
  expected: Omit<T, "contextSha256">,
  artifactContextSha256: string | undefined,
  label: string,
): void {
  const { contextSha256, ...unsigned } = record;
  if (!/^[a-f0-9]{64}$/u.test(contextSha256)
    || contextSha256 !== artifactContextSha256
    || contextSha256 !== canonicalSha256(unsigned)
    || record.requestSha256 !== canonicalSha256(record.request)
    || canonicalJson(unsigned) !== canonicalJson(expected)) {
    throw new Error(`Immutable ${label} model context mismatch`);
  }
}

async function loadAndAssertModelContext<T extends CanonicalTruthExtractionContextRecord | CanonicalTruthValidationContextRecord>(
  path: string,
  expected: Omit<T, "contextSha256">,
  artifactContextSha256: string | undefined,
  label: string,
): Promise<T> {
  const record = await readJsonIfExists<T>(path);
  if (!record) throw new Error(`Immutable ${label} model context is missing`);
  assertModelContextRecord(record, expected, artifactContextSha256, label);
  return record;
}

async function writeProjectionSet(root: string, projections: readonly ProjectionArtifactV1[]): Promise<void> {
  for (const projection of projections) {
    const path = join(root, "accepted", "projections", ...projection.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, projection.bytes);
  }
}

async function tryCreateProjectionRepairMarker(path: string, value: unknown): Promise<boolean> {
  const bytes = `${canonicalJson(value)}\n`;
  try {
    return await publishImmutableFile(path, bytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("IMMUTABLE_CONFLICT:")) return false;
    throw error;
  }
}

async function verifyOrRepairProjectionSet(
  root: string,
  projections: readonly ProjectionArtifactV1[],
  input: CommonInput,
  onRepairAdmitted?: () => Promise<void> | void,
): Promise<"VALID" | "REPAIRED" | "EXHAUSTED"> {
  const mismatches: ProjectionArtifactV1[] = [];
  for (const projection of projections) {
    const path = join(root, "accepted", "projections", ...projection.path.split("/"));
    if (!(await exists(path)) || !Buffer.from(await readFile(path)).equals(Buffer.from(projection.bytes))) mismatches.push(projection);
  }
  if (mismatches.length === 0) return "VALID";
  const markerPath = join(root, "accepted", "projection-repair.json");
  if (await exists(markerPath)) return "EXHAUSTED";
  const markerCreated = await publishOpenChapterTransaction(input, () => tryCreateProjectionRepairMarker(markerPath, {
    schemaVersion: "1.0", kind: "PROJECTION_REPAIR", repairedPaths: mismatches.map((entry) => entry.path).sort(),
  }));
  if (!markerCreated) return "EXHAUSTED";
  await onRepairAdmitted?.();
  await publishOpenChapterTransaction(input, () => writeProjectionSet(root, projections));
  return "REPAIRED";
}

function deriveArtifacts(admission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>, predecessor: StructuredTruthV1, input: CommonInput) {
  const acceptedDelta = validateAcceptedChapterDeltaV1(admission.acceptedDelta, predecessor);
  const resultingTruth = reduceStructuredTruthV1({ predecessor, acceptedDelta });
  const projections = renderStructuredTruthProjectionsV1(resultingTruth);
  const projectionManifest = buildProjectionManifestV1({ truthSha256: canonicalSha256(resultingTruth), projections });
  const applicationReceipt: TruthApplicationReceiptV1 = {
    schemaVersion: "1.0", kind: "TRUTH_APPLICATION_RECEIPT", transactionId: input.transactionId,
    attemptId: input.attemptId, candidateSha256: input.candidateSha256,
    predecessorCommitSha256: input.predecessorCommitSha256,
    predecessorTruthSha256: canonicalSha256(predecessor), acceptedDeltaSha256: canonicalSha256(acceptedDelta),
    deltaId: acceptedDelta.deltaId,
    admissionSha256: canonicalSha256({ status: admission.status, canonicalProposalSha256: admission.canonicalProposalSha256, acceptedDelta }),
    resultingTruthSha256: canonicalSha256(resultingTruth),
    operationOutcomes: acceptedDelta.delta.operations.map((operation) => ({ operationId: operation.operationId, status: "APPLIED" as const })),
    reducerId: "inkos.structured-truth.reducer.v1", reducerVersion: "1.0",
  };
  const extractorEvidence = {
    logicalOperationId: acceptedDelta.delta.extractorLogicalOperationId,
    inputFingerprint: acceptedDelta.delta.extractorInputFingerprint,
    providerArtifactSha256: acceptedDelta.delta.providerArtifactSha256,
    responseContentSha256: acceptedDelta.delta.responseContentSha256,
  };
  return { acceptedDelta, deltaAdmission: admission, extractorEvidence, resultingTruth, projections, projectionManifest, applicationReceipt };
}

export async function runCanonicalTruthTransaction(input: CommonInput): Promise<CanonicalTruthTransactionResult> {
  const usageByRole: Record<string, RoleTokenUsage> = {
    "truth-extractor": { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    "truth-validator": { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  try {
    assertInput(input);
    await assertCurrentAttempt(input);
    await assertCanonicalTruthTerminalReviewAuthority({
      bookDir: input.bookDir,
      transactionId: input.transactionId,
      candidateSha256: input.candidateSha256,
    });
  } catch (error) {
    return {
      status: error instanceof ChapterArtifactEvidenceError ? "ARTIFACT_EVIDENCE_DEFECT" : "HOST_APPLICATION_DEFECT",
      repairExhausted: false,
      diagnostics: [error instanceof Error ? error.message : String(error)],
      usageByRole,
    };
  }
  const root = join(evidenceRoot(input), input.candidateSha256);
  const writeImmutable = (path: string, value: unknown) => publishOpenChapterTransaction(input, () => writeImmutableBytes(path, value));
  const baseContext = immutableBaseContext(input);
  const contextSha256 = canonicalSha256(baseContext);
  await writeImmutable(join(root, "context.json"), { ...baseContext, contextSha256 });
  const acceptedPath = join(root, "accepted", "accepted-delta.json");
  const acceptedAuthorityPath = join(root, "accepted", "accepted-authority.json");
  const resultPath = join(root, "accepted", "result.json");
  const persistedResult = await readJsonIfExists<{
    readonly transactionId: string; readonly attemptId: string; readonly candidateSha256: string;
    readonly acceptedDeltaSha256: string; readonly applicationReceipt: TruthApplicationReceiptV1;
    readonly resultingTruth: StructuredTruthV1; readonly projectionManifest: ProjectionManifestV1;
    readonly semanticValidation: CanonicalTruthValidationArtifact;
    readonly usageByRole: Readonly<Record<string, RoleTokenUsage>>;
    readonly contextSha256: string;
    readonly extractionContext: CanonicalTruthExtractionContextRecord;
    readonly validationContext: CanonicalTruthValidationContextRecord;
  } & { readonly extractorEvidence: Pick<CanonicalTruthExtractionArtifact, "logicalOperationId" | "inputFingerprint" | "providerArtifactSha256" | "responseContentSha256"> & { readonly contextSha256: string } }>(resultPath);
  if (persistedResult) {
    if (persistedResult.transactionId !== input.transactionId || persistedResult.attemptId !== input.attemptId || persistedResult.candidateSha256 !== input.candidateSha256
      || persistedResult.contextSha256 !== contextSha256) {
      throw new Error("Immutable canonical truth result identity mismatch");
    }
    try {
      assertSemanticValidation(persistedResult.semanticValidation);
      if (persistedResult.semanticValidation.verdict !== "PASS") throw new Error("Accepted result requires semantic PASS");
    } catch (error) {
      return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false, diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
    }
    const acceptedDelta = await readJsonIfExists<AcceptedChapterDeltaV1>(acceptedPath);
    if (!acceptedDelta || canonicalSha256(acceptedDelta) !== persistedResult.acceptedDeltaSha256) throw new Error("Immutable accepted delta authority mismatch");
    const validatedDelta = validateAcceptedChapterDeltaV1(acceptedDelta, input.predecessor);
    const derived = deriveArtifacts({ status: "ACCEPTED", canonicalProposalSha256: validatedDelta.delta.proposedDeltaCanonicalSha256, acceptedDelta: validatedDelta }, input.predecessor, input);
    const cycle = await resolveAcceptedCycle(root, acceptedDelta);
    if (canonicalJson(cycle.admission) !== canonicalJson(derived.deltaAdmission)) {
      throw new Error("Immutable durable delta admission authority mismatch");
    }
    const extractionRequest = buildExtractionRequest(input, cycle.extractionKind, cycle.repairOrdinal, cycle.repairDiagnostics, cycle.repairAuthorization);
    const extractionExecution = input.extractorExecution(extractionRequest);
    const extractionExpected = buildExtractionContext(contextSha256, extractionRequest, extractionExecution);
    const validationRequest = buildValidationRequest(input, derived);
    const validationExecution = input.validatorExecution(validationRequest, cycle);
    const validationExpected = buildValidationContext(contextSha256, cycle.extractionKind, cycle.repairOrdinal, validationRequest, validationExecution);
    const cycleRoot = join(root, cycle.extractionKind.toLowerCase());
    const extractionContext = await loadAndAssertModelContext<CanonicalTruthExtractionContextRecord>(
      join(cycleRoot, "extraction-context.json"), extractionExpected, persistedResult.extractorEvidence.contextSha256, "Truth Extractor",
    );
    const validationContext = await loadAndAssertModelContext<CanonicalTruthValidationContextRecord>(
      join(cycleRoot, "validation-context.json"), validationExpected, persistedResult.semanticValidation.contextSha256, "Truth Validator",
    );
    if (canonicalJson(derived.applicationReceipt) !== canonicalJson(persistedResult.applicationReceipt)
      || canonicalJson(derived.resultingTruth) !== canonicalJson(persistedResult.resultingTruth)
      || canonicalJson(derived.projectionManifest) !== canonicalJson(persistedResult.projectionManifest)
      || persistedResult.semanticValidation.verdict !== "PASS") {
      throw new Error("Immutable canonical truth result authority mismatch");
    }
    const projectionStatus = await verifyOrRepairProjectionSet(
      root,
      derived.projections,
      input,
      () => input.onDurableBoundary?.("AFTER_PROJECTION_REPAIR_ADMISSION"),
    );
    if (projectionStatus === "EXHAUSTED") {
      return { status: "PROJECTION_DEFECT", repairExhausted: true, diagnostics: ["Deterministic projection regeneration already exhausted"], usageByRole: persistedResult.usageByRole };
    }
    return { status: "PASS", ...derived, extractorEvidence: persistedResult.extractorEvidence, semanticValidation: persistedResult.semanticValidation, extractionContext, validationContext, usageByRole: persistedResult.usageByRole, contextSha256 };
  }

  const acceptedAuthority = await readJsonIfExists<{
    readonly transactionId: string;
    readonly attemptId: string;
    readonly candidateSha256: string;
    readonly acceptedDelta: AcceptedChapterDeltaV1;
    readonly deltaAdmission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>;
    readonly semanticValidation: CanonicalTruthValidationArtifact;
    readonly usageByRole: Readonly<Record<string, RoleTokenUsage>>;
    readonly contextSha256: string;
    readonly extractionContext: CanonicalTruthExtractionContextRecord;
    readonly validationContext: CanonicalTruthValidationContextRecord;
    readonly extractorEvidence: Pick<CanonicalTruthExtractionArtifact, "logicalOperationId" | "inputFingerprint" | "providerArtifactSha256" | "responseContentSha256"> & { readonly contextSha256: string };
  }>(acceptedAuthorityPath);
  if (acceptedAuthority) {
    if (acceptedAuthority.transactionId !== input.transactionId || acceptedAuthority.attemptId !== input.attemptId
      || acceptedAuthority.candidateSha256 !== input.candidateSha256 || acceptedAuthority.contextSha256 !== contextSha256) {
      throw new Error("Immutable accepted truth authority identity mismatch");
    }
    const acceptedDelta = await readJsonIfExists<AcceptedChapterDeltaV1>(acceptedPath);
    if (!acceptedDelta || canonicalJson(acceptedDelta) !== canonicalJson(acceptedAuthority.acceptedDelta)) {
      throw new Error("Immutable accepted delta authority mismatch");
    }
    try {
      assertSemanticValidation(acceptedAuthority.semanticValidation);
      if (acceptedAuthority.semanticValidation.verdict !== "PASS") throw new Error("Accepted authority requires semantic PASS");
    } catch (error) {
      return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false, diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
    }
    const derived = deriveArtifacts(acceptedAuthority.deltaAdmission, input.predecessor, input);
    const cycle = await resolveAcceptedCycle(root, acceptedDelta);
    if (canonicalJson(cycle.admission) !== canonicalJson(acceptedAuthority.deltaAdmission)
      || canonicalJson(cycle.admission) !== canonicalJson(derived.deltaAdmission)) {
      throw new Error("Immutable durable delta admission authority mismatch");
    }
    const extractionRequest = buildExtractionRequest(input, cycle.extractionKind, cycle.repairOrdinal, cycle.repairDiagnostics, cycle.repairAuthorization);
    const extractionExecution = input.extractorExecution(extractionRequest);
    const extractionExpected = buildExtractionContext(contextSha256, extractionRequest, extractionExecution);
    const validationRequest = buildValidationRequest(input, derived);
    const validationExecution = input.validatorExecution(validationRequest, cycle);
    const validationExpected = buildValidationContext(contextSha256, cycle.extractionKind, cycle.repairOrdinal, validationRequest, validationExecution);
    const cycleRoot = join(root, cycle.extractionKind.toLowerCase());
    const extractionContext = await loadAndAssertModelContext<CanonicalTruthExtractionContextRecord>(
      join(cycleRoot, "extraction-context.json"), extractionExpected, acceptedAuthority.extractorEvidence.contextSha256, "Truth Extractor",
    );
    const validationContext = await loadAndAssertModelContext<CanonicalTruthValidationContextRecord>(
      join(cycleRoot, "validation-context.json"), validationExpected, acceptedAuthority.semanticValidation.contextSha256, "Truth Validator",
    );
    if (canonicalJson(derived.acceptedDelta) !== canonicalJson(acceptedDelta)) {
      throw new Error("Immutable accepted delta replay mismatch");
    }
    const projectionStatus = await verifyOrRepairProjectionSet(
      root,
      derived.projections,
      input,
      () => input.onDurableBoundary?.("AFTER_PROJECTION_REPAIR_ADMISSION"),
    );
    if (projectionStatus === "EXHAUSTED") {
      return { status: "PROJECTION_DEFECT", repairExhausted: true, diagnostics: ["Deterministic projection regeneration already exhausted"], usageByRole: acceptedAuthority.usageByRole };
    }
    await writeImmutable(resultPath, {
      transactionId: input.transactionId, attemptId: input.attemptId, candidateSha256: input.candidateSha256,
      acceptedDeltaSha256: canonicalSha256(derived.acceptedDelta), applicationReceipt: derived.applicationReceipt,
      resultingTruth: derived.resultingTruth, projectionManifest: derived.projectionManifest,
      semanticValidation: acceptedAuthority.semanticValidation, usageByRole: acceptedAuthority.usageByRole,
      extractorEvidence: acceptedAuthority.extractorEvidence,
      extractionContext, validationContext,
      contextSha256,
    });
    return { status: "PASS", ...derived, extractorEvidence: acceptedAuthority.extractorEvidence, semanticValidation: acceptedAuthority.semanticValidation, extractionContext, validationContext, usageByRole: acceptedAuthority.usageByRole, contextSha256 };
  }

  let repairDiagnostics: readonly string[] | undefined;
  let repairAuthorization: TruthRepairAuthorizationV1 | undefined;
  for (const repairOrdinal of [0, 1] as const) {
    const extractionKind = repairOrdinal === 0 ? "INITIAL" as const : "REPAIR" as const;
    const cycleRoot = join(root, extractionKind.toLowerCase());
    const extractionRequest = buildExtractionRequest(input, extractionKind, repairOrdinal, repairDiagnostics, repairAuthorization);
    const extractionExecution = input.extractorExecution(extractionRequest);
    const extractionContext = buildExtractionContext(contextSha256, extractionRequest, extractionExecution);
    const extractionContextSha256 = canonicalSha256(extractionContext);
    await writeImmutable(join(cycleRoot, "extraction-context.json"), { ...extractionContext, contextSha256: extractionContextSha256 });
    let extraction = await readJsonIfExists<CanonicalTruthExtractionArtifact>(join(cycleRoot, "extraction.json"));
    const cachedExtraction = extraction !== null;
    if (!extraction) {
      await assertCurrentAttempt(input);
      const modelExtraction = await input.extractor(extractionRequest, extractionExecution);
      await assertCurrentAttempt(input);
      extraction = { ...modelExtraction, contextSha256: extractionContextSha256 };
      if (sha256Utf8(extraction.rawProposal) !== extraction.responseContentSha256) throw new Error("Truth extraction response hash mismatch");
      await writeImmutable(join(cycleRoot, "extraction.json"), extraction);
    }
    const extractionContextRecord = await loadAndAssertModelContext<CanonicalTruthExtractionContextRecord>(
      join(cycleRoot, "extraction-context.json"), extractionContext, extraction.contextSha256, "Truth Extractor",
    );
    assertEvidenceIdentity(extraction, "Truth extraction");
    if (extraction.inputFingerprint !== extractionExecution.inputFingerprint) throw new Error("Truth extraction Provider input fingerprint does not match frozen execution identity");
    assertUsage(extraction.usage, "Truth extraction");
    usageByRole["truth-extractor"] = addUsage(usageByRole["truth-extractor"]!, extraction.usage);
    if (sha256Utf8(extraction.rawProposal) !== extraction.responseContentSha256) throw new Error("Truth extraction response hash mismatch");
    if (cachedExtraction) {
      try {
        await input.revalidateProviderEvidence({ role: "truth-extractor",
          stage: extractionKind === "INITIAL" ? "TRUTH_EXTRACTION" : "TRUTH_EXTRACTION_REPAIR",
          repairOrdinal, execution: extractionExecution, artifact: extraction });
      } catch (error) {
        return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false,
          diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
      }
    }
    const admissionPath = join(cycleRoot, "delta-admission.json");
    let admission = await readJsonIfExists<ChapterDeltaAdmissionResultV1>(admissionPath);
    if (admission) {
      if (admission.status === "ACCEPTED") {
        const validated = validateAcceptedChapterDeltaV1(admission.acceptedDelta, input.predecessor);
        const delta = validated.delta;
        if (canonicalJson(validated) !== canonicalJson(admission.acceptedDelta)
          || admission.canonicalProposalSha256 !== delta.proposedDeltaCanonicalSha256
          || delta.transactionId !== input.transactionId || delta.attemptId !== input.attemptId
          || delta.bookId !== input.predecessor.bookId || delta.chapterNumber !== input.chapterNumber
          || delta.candidateSha256 !== input.candidateSha256
          || delta.predecessorCommitSha256 !== input.predecessorCommitSha256
          || delta.predecessorTruthSha256 !== canonicalSha256(input.predecessor)
          || delta.predecessorVocabularyCatalogSha256 !== canonicalSha256(input.predecessor.vocabulary)
          || delta.extractorLogicalOperationId !== extraction.logicalOperationId
          || delta.extractorInputFingerprint !== extraction.inputFingerprint
          || delta.providerArtifactSha256 !== extraction.providerArtifactSha256
          || delta.responseContentSha256 !== extraction.responseContentSha256) {
          throw new Error("Immutable durable delta admission identity mismatch");
        }
      } else if (admission.status !== "AMBIGUOUS") {
        throw new Error("Immutable durable delta admission is invalid");
      }
    } else {
      try {
        admission = admitChapterDeltaV1({
          rawProposal: extraction.rawProposal, candidate: input.candidate, predecessor: input.predecessor,
          host: {
            transactionId: input.transactionId, attemptId: input.attemptId, bookId: input.predecessor.bookId,
            chapterNumber: input.chapterNumber, candidateSha256: input.candidateSha256,
            predecessorCommitSha256: input.predecessorCommitSha256, predecessorTruthSha256: canonicalSha256(input.predecessor),
            predecessorVocabularyCatalogSha256: canonicalSha256(input.predecessor.vocabulary),
            extractorLogicalOperationId: extraction.logicalOperationId, extractorInputFingerprint: extraction.inputFingerprint,
            providerArtifactSha256: extraction.providerArtifactSha256, responseContentSha256: extraction.responseContentSha256,
          },
        });
      } catch (error) {
        const diagnostics = [error instanceof Error ? error.message : String(error)];
        const defectArtifact = { status: "DELTA_EXTRACTION_DEFECT" as const, diagnostics };
        await writeImmutable(join(cycleRoot, "delta-admission-defect.json"), defectArtifact);
        if (repairOrdinal === 1) return { status: "DELTA_EXTRACTION_DEFECT", repairExhausted: true, diagnostics, usageByRole };
        repairDiagnostics = diagnostics;
        repairAuthorization = buildRepairAuthorization({
          source: "DELTA_ADMISSION", extractionContext: extractionContextRecord,
          extraction, diagnostics, defectArtifact,
        });
        await writeImmutable(join(root, "repair-authorization.json"), repairAuthorization);
        continue;
      }
      await writeImmutable(admissionPath, admission);
      await input.onDurableBoundary?.("AFTER_DELTA_ADMISSION");
    }
    if (admission.status === "AMBIGUOUS") {
      return { status: "AUTHORITY_AMBIGUITY", repairExhausted: false, diagnostics: admission.ambiguities.map((item) => item.description), usageByRole };
    }
    let derived: ReturnType<typeof deriveArtifacts>;
    try {
      derived = deriveArtifacts(admission, input.predecessor, input);
    } catch (error) {
      return { status: "HOST_APPLICATION_DEFECT", repairExhausted: false, diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
    }
    await writeImmutable(join(cycleRoot, "truth-application.json"), derived.applicationReceipt);
    await input.onDurableBoundary?.("AFTER_APPLICATION_RECEIPT");
    await writeImmutable(join(cycleRoot, "resulting-truth.json"), derived.resultingTruth);
    await writeImmutable(join(cycleRoot, "projection-manifest.json"), derived.projectionManifest);
    const validationRequest = buildValidationRequest(input, derived);
    const validationCycle = { extractionKind, repairOrdinal } as const;
    const validationExecution = input.validatorExecution(validationRequest, validationCycle);
    const validationContext = buildValidationContext(contextSha256, extractionKind, repairOrdinal, validationRequest, validationExecution);
    const validationContextSha256 = canonicalSha256(validationContext);
    await writeImmutable(join(cycleRoot, "validation-context.json"), { ...validationContext, contextSha256: validationContextSha256 });
    let semanticValidation = await readJsonIfExists<CanonicalTruthValidationArtifact>(join(cycleRoot, "semantic-validation.json"));
    const cachedSemanticValidation = semanticValidation !== null;
    if (!semanticValidation) {
      await assertCurrentAttempt(input);
      let modelValidation: CanonicalTruthValidationArtifact;
      try { modelValidation = await input.validator(validationRequest, validationExecution, validationCycle); }
      catch (error) {
        if (!(error instanceof TruthValidatorArtifactError)) throw error;
        usageByRole["truth-validator"] = addUsage(usageByRole["truth-validator"]!, error.usage);
        return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false, diagnostics: [error.message], usageByRole };
      }
      await assertCurrentAttempt(input);
      semanticValidation = { ...modelValidation, contextSha256: validationContextSha256 };
      await input.onDurableBoundary?.("AFTER_VALIDATOR_COMPLETE");
      await writeImmutable(join(cycleRoot, "semantic-validation.json"), semanticValidation);
    }
    const validationContextRecord = await loadAndAssertModelContext<CanonicalTruthValidationContextRecord>(
      join(cycleRoot, "validation-context.json"), validationContext, semanticValidation.contextSha256, "Truth Validator",
    );
    try { assertSemanticValidation(semanticValidation); }
    catch (error) {
      return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false, diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
    }
    if (semanticValidation.inputFingerprint !== validationExecution.inputFingerprint) throw new Error("Truth validation Provider input fingerprint does not match frozen execution identity");
    usageByRole["truth-validator"] = addUsage(usageByRole["truth-validator"]!, semanticValidation.usage);
    if (cachedSemanticValidation && (semanticValidation.verdict === "PROSE_CONTENT_DEFECT"
      || semanticValidation.verdict === "DELTA_EXTRACTION_DEFECT" && repairOrdinal === 0)) {
      // Both defect branches can authorize a new model effect (Reviser or
      // repair Extractor), so cached evidence requires the same host authority.
      try {
        await input.revalidateProviderEvidence({ role: "truth-validator", stage: "TRUTH_VALIDATION",
          repairOrdinal, execution: validationExecution, artifact: semanticValidation });
      } catch (error) {
        return { status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false,
          diagnostics: [error instanceof Error ? error.message : String(error)], usageByRole };
      }
    }
    if (semanticValidation.verdict === "DELTA_EXTRACTION_DEFECT") {
      if (repairOrdinal === 1) return { status: "DELTA_EXTRACTION_DEFECT", repairExhausted: true, diagnostics: semanticValidation.diagnostics, usageByRole };
      repairDiagnostics = semanticValidation.diagnostics;
      repairAuthorization = buildRepairAuthorization({
        source: "SEMANTIC_VALIDATION", extractionContext: extractionContextRecord,
        extraction, diagnostics: semanticValidation.diagnostics, defectArtifact: semanticValidation,
        validationContext: validationContextRecord, validation: semanticValidation,
      });
      await writeImmutable(join(root, "repair-authorization.json"), repairAuthorization);
      continue;
    }
    if (semanticValidation.verdict !== "PASS") return { status: semanticValidation.verdict, repairExhausted: false, diagnostics: semanticValidation.diagnostics, usageByRole };
    await writeImmutable(acceptedPath, derived.acceptedDelta);
    const extractorEvidence = { ...derived.extractorEvidence, contextSha256: extraction.contextSha256! };
    await writeImmutable(acceptedAuthorityPath, {
      transactionId: input.transactionId,
      attemptId: input.attemptId,
      candidateSha256: input.candidateSha256,
      acceptedDelta: derived.acceptedDelta,
      deltaAdmission: derived.deltaAdmission,
      semanticValidation,
      extractorEvidence,
      extractionContext: extractionContextRecord,
      validationContext: validationContextRecord,
      usageByRole,
      contextSha256,
    });
    await input.onDurableBoundary?.("AFTER_ACCEPTED_AUTHORITY");
    await publishOpenChapterTransaction(input, () => writeProjectionSet(root, derived.projections));
    await writeImmutable(resultPath, {
      transactionId: input.transactionId, attemptId: input.attemptId, candidateSha256: input.candidateSha256,
      acceptedDeltaSha256: canonicalSha256(derived.acceptedDelta), applicationReceipt: derived.applicationReceipt,
      resultingTruth: derived.resultingTruth, projectionManifest: derived.projectionManifest, semanticValidation, usageByRole,
      extractorEvidence,
      extractionContext: extractionContextRecord,
      validationContext: validationContextRecord,
      contextSha256,
    });
    return { status: "PASS", ...derived, extractorEvidence, semanticValidation, extractionContext: extractionContextRecord, validationContext: validationContextRecord, usageByRole, contextSha256 };
  }
  throw new Error("Unreachable canonical truth repair state");
}
