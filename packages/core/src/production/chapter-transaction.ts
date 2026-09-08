import { createHash, randomUUID } from "node:crypto";
import { isValidProviderUsage } from "../llm/usage.js";
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { LengthSpec } from "../models/length-governance.js";
import { commitAtomicFileSet, publishImmutableFile, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";
import type { AcceptedChapterDeltaV1, ChapterDeltaAdmissionResultV1 } from "../models/chapter-delta.js";
import type { BaselineSourceManifestV1, BaselineConstructionReceiptV1, StructuredTruthV1 } from "../models/structured-truth.js";
import { validateBaselineAuthorityV1, validateStructuredTruthV1 } from "../models/structured-truth.js";
import { admitChapterDeltaV1, validateAcceptedChapterDeltaV1 } from "../state/chapter-delta-admission.js";
import { canonicalJson as canonicalJsonV2, canonicalSha256 } from "../state/canonical-json.js";
import type { ProjectionManifestV1 } from "../state/projection-manifest.js";
import { buildProjectionManifestV1 } from "../state/projection-manifest.js";
import type { ProjectionArtifactV1 } from "../state/structured-truth-projections.js";
import { renderStructuredTruthProjectionsV1 } from "../state/structured-truth-projections.js";
import { reduceStructuredTruthV1 } from "../state/structured-truth-reducer.js";
import type { CanonicalTruthExtractionArtifact, CanonicalTruthExtractionContextRecord, CanonicalTruthValidationArtifact, CanonicalTruthValidationContextRecord, TruthApplicationReceiptV1 } from "../pipeline/canonical-truth-transaction.js";
import { buildTruthValidatorMessages, parseTruthValidatorResponse } from "../agents/truth-validator.js";
import { buildTruthExtractorMessages, type TruthRepairAuthorizationV1 } from "../agents/truth-extractor.js";
import { parseContinuityAuditResponse } from "../agents/continuity.js";
import { fingerprintReviewProviderRequest, parseCommercialReaderResponse, type ReviewProviderRequestEvidence } from "../agents/commercial-reader.js";
import { scoredLogicReviewFromAudit, type ScoredReview } from "../pipeline/bounded-review.js";
import type { LLMMessage } from "../llm/provider.js";
import { safeMutationPath } from "../utils/path-safety.js";
import { withChapterTransactionPublicationGuard } from "./bounded-autonomous-controller.js";
import type { AutonomousRunProgress } from "./bounded-autonomous-controller.js";
import { buildFirstV2Baseline } from "./first-v2-baseline.js";

export type ChapterAuthorityState = "NOT_STARTED" | "STAGING" | "COMMITTED";
export type ChapterCommitReviewStatus = "APPROVED" | "ACCEPTED_WITH_FINDINGS";

export class ChapterArtifactEvidenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ChapterArtifactEvidenceError";
  }
}

function asChapterArtifactEvidenceError(label: string, error: unknown): ChapterArtifactEvidenceError {
  if (error instanceof ChapterArtifactEvidenceError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: ${label}: ${detail}`, error);
}

export interface ChapterCommitReviewerAuthority {
  readonly reviewerRole: "logic-canon-auditor" | "commercial-reader";
  readonly provider: string;
  readonly model: string;
  readonly totalScore: number;
  readonly dimensionScores: Readonly<Record<string, number>>;
  readonly decision: "APPROVED" | "APPROVED_WITH_NOTES";
  readonly findings: ReadonlyArray<unknown>;
  readonly reviewedCandidateSha: string;
}

export interface ChapterCommitReviewAuthority {
  readonly status: ChapterCommitReviewStatus;
  readonly grade: "A" | "B" | "C" | "D" | "E";
  readonly revisionCount: 0 | 1 | 2;
  readonly finalCandidateSha256: string;
  readonly findings: ReadonlyArray<{ readonly severity?: string; readonly blocking?: boolean }>;
  readonly reviewerEvidence: readonly [ChapterCommitReviewerAuthority, ChapterCommitReviewerAuthority];
}

export interface ChapterStateValidationAuthority {
  readonly chapterNumber: number;
  readonly finalCandidateSha256: string;
  readonly previousAuthoritySha256: string;
  readonly passed: true;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly summary?: string;
  readonly providerLogicalOperationId?: string;
}

export interface ChapterProviderReference {
  readonly transactionId: string;
  readonly logicalOperationId: string;
  readonly chapterNumber: number;
  readonly role: string;
  readonly stage: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly inputFingerprint: string;
  readonly artifactRelativePath: string;
  readonly artifactSha256: string;
  readonly responseContentSha256: string;
  readonly responseArtifactStatus: "COMPLETE";
}

export interface TreeEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ChapterGenesis {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_GENESIS";
  readonly bookId: string;
  readonly lastTrustedChapter: number;
  readonly trustedSnapshotSha256: string;
  readonly trustedSnapshotFiles: ReadonlyArray<TreeEntry>;
  readonly legacyChapterTreeSha256: string;
  readonly legacyChapterFiles: ReadonlyArray<TreeEntry>;
  readonly legacyIndex: ReadonlyArray<Record<string, unknown>>;
  readonly createdAt: string;
  readonly genesisSha256: string;
}

export interface ChapterTransactionRecord {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_TRANSACTION";
  readonly transactionId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly previousAuthoritySha256: string;
  readonly productionAuthority: string;
  readonly state: "STAGING";
  readonly createdAt: string;
  /** Legacy single-directory transactions are attempt 1 when this field is absent. */
  readonly attemptNumber?: number;
  readonly truthMode?: "LEGACY_V1" | "CANONICAL_V2";
  readonly firstV2BaselineSha256?: string;
}

export interface ChapterAttemptAbandonment {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_ATTEMPT_ABANDONMENT";
  readonly transactionId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly attemptNumber: number;
  readonly previousAuthoritySha256: string;
  readonly reason: "OPERATOR_DISCARDED_STAGING_ATTEMPT";
  readonly abandonedBy: "operator/product-action";
  readonly runtimeSnapshotSha256: string;
  readonly abandonedAt: string;
}

export interface LegacyChapterCommitV1 {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_COMMIT";
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly language: "zh" | "en";
  readonly transactionId: string;
  readonly productionAuthority: string;
  readonly previousAuthoritySha256: string;
  readonly finalBodySha256: string;
  readonly finalLengthCount: number;
  readonly lengthSpec: LengthSpec;
  readonly boundedReviewStatus: ChapterCommitReviewStatus;
  readonly revisionCount: 0 | 1 | 2;
  readonly reviewEvidenceSha256: string;
  readonly finalCandidateSha256: string;
  readonly stateManifestSha256: string;
  readonly snapshotManifestSha256: string;
  readonly stateValidationSha256: string;
  readonly stateTreeSha256: string;
  readonly snapshotTreeSha256: string;
  readonly stateFiles: ReadonlyArray<TreeEntry>;
  readonly snapshotFiles: ReadonlyArray<TreeEntry>;
  readonly usageSha256: string;
  readonly providerReferencesSha256: string;
  readonly providerReferenceCount: number;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly commitSha256: string;
}

interface ChapterAttemptTerminal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly attemptNumber: number;
  readonly previousAuthoritySha256: string;
  readonly outcome: "ABANDONED" | "COMMIT_SELECTED";
  readonly runtimeSnapshotSha256?: string;
  readonly commitKind?: ChapterCommit["kind"];
  readonly commitSha256?: string;
}

async function selectAttemptTerminal(bookDir: string, transaction: LocatedChapterTransaction, claim:
  | { readonly outcome: "ABANDONED"; readonly runtimeSnapshotSha256: string }
  | { readonly outcome: "COMMIT_SELECTED"; readonly commitKind: ChapterCommit["kind"]; readonly commitSha256: string }
): Promise<void> {
  const terminal: ChapterAttemptTerminal = {
    schemaVersion: 1, transactionId: transaction.record.transactionId, bookId: transaction.record.bookId,
    chapterNumber: transaction.record.chapterNumber, attemptNumber: transaction.attemptNumber,
    previousAuthoritySha256: transaction.record.previousAuthoritySha256, ...claim,
  };
  await withChapterTransactionPublicationGuard(bookDir, () =>
    publishImmutableFile(join(transaction.root, "terminal-outcome.json"), canonicalTextV2(terminal)));
}

export interface ChapterProviderRequestAuthority {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_PROVIDER_REQUEST_RESERVATION";
  readonly reservationId: string;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly candidateSha256: string;
  readonly role: string;
  readonly stage: string;
  readonly requestOrdinal: number;
  readonly reviewLanguage?: "zh" | "en";
  readonly request: {
    readonly provider: string;
    readonly model: string;
    readonly messages: readonly LLMMessage[];
    readonly temperature: number;
    readonly maxTokens: number;
    readonly stream: boolean;
    readonly webSearch: boolean;
    readonly extra: Readonly<Record<string, unknown>>;
  };
  readonly requestSha256: string;
  readonly fullRequestSha256: string;
  readonly providerInputFingerprint: string;
}

export interface ChapterProviderRequestBinding {
  readonly schemaVersion: 1;
  readonly kind: "CHAPTER_PROVIDER_REQUEST_BINDING";
  readonly reservationId: string;
  readonly transactionId: string;
  readonly logicalOperationId: string;
  readonly providerArtifactSha256: string;
  readonly providerReference: ChapterProviderReference;
}

export interface TruthChapterCommitV2 {
  readonly bundlePayloadFiles: ReadonlyArray<TreeEntry>;
  readonly bundlePayloadTreeSha256: string;
  readonly schemaVersion: 2;
  readonly kind: "TRUTH_CHAPTER_COMMIT";
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly language: "zh" | "en";
  readonly transactionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly productionAuthority: string;
  readonly previousAuthoritySha256: string;
  readonly predecessorCommitSha256: string;
  readonly predecessorTruthSha256: string;
  readonly predecessorVocabularyCatalogSha256: string;
  readonly finalBodySha256: string;
  readonly finalLengthCount: number;
  readonly lengthSpec: LengthSpec;
  readonly boundedReviewStatus: ChapterCommitReviewStatus;
  readonly revisionCount: 0 | 1 | 2;
  readonly reviewEvidenceSha256: string;
  readonly logicReviewRecordSha256: string;
  readonly commercialReviewRecordSha256: string;
  readonly logicReviewRequestReservationSha256: string;
  readonly logicReviewRequestBindingSha256: string;
  readonly commercialReviewRequestReservationSha256: string;
  readonly commercialReviewRequestBindingSha256: string;
  readonly truthExtractorRequestReservationSha256: string;
  readonly truthExtractorRequestBindingSha256: string;
  readonly truthValidatorRequestReservationSha256: string;
  readonly truthValidatorRequestBindingSha256: string;
  readonly finalCandidateSha256: string;
  readonly deltaId: string;
  readonly acceptedDeltaArtifactSha256: string;
  readonly deltaAdmissionSha256: string;
  readonly truthApplicationSha256: string;
  readonly semanticValidationSha256: string;
  readonly stateValidationSha256: string;
  readonly truthSha256: string;
  readonly projectionManifestSha256: string;
  readonly projectionTreeSha256: string;
  readonly extractorEvidenceSha256: string;
  readonly validatorEvidenceSha256: string;
  readonly truthUsageSha256: string;
  readonly truthContextSha256: string;
  readonly truthContextIdentitySha256: string;
  readonly extractionContextSha256: string;
  readonly validationContextSha256: string;
  readonly repairAuthorityManifestSha256?: string;
  readonly stateTreeSha256: string;
  readonly stateFiles: ReadonlyArray<TreeEntry>;
  readonly snapshotTreeSha256: string;
  readonly snapshotFiles: ReadonlyArray<TreeEntry>;
  readonly usageSha256: string;
  readonly providerReferencesSha256: string;
  readonly providerReferenceCount: number;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly commitSha256: string;
}

interface RepairAuthorityManifestV1 {
  readonly schemaVersion: "1.0";
  readonly kind: "CANONICAL_TRUTH_REPAIR_AUTHORITY_MANIFEST";
  readonly source: "DELTA_ADMISSION" | "SEMANTIC_VALIDATION";
  readonly files: ReadonlyArray<TreeEntry>;
}

interface RepairAuthorityBundle {
  readonly manifest: RepairAuthorityManifestV1;
  readonly manifestBytes: Buffer;
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly content: Buffer }>;
}

export type ChapterCommit = LegacyChapterCommitV1 | TruthChapterCommitV2;

export interface FirstV2BaselineContext {
  readonly previousAuthoritySha256: string;
  readonly truth: StructuredTruthV1;
  readonly truthSha256: string;
  readonly vocabularyCatalogSha256: string;
  readonly predecessorChapterBody: string;
  readonly predecessorChapterBodySha256: string;
  readonly sourceManifest: BaselineSourceManifestV1;
  readonly receipt: BaselineConstructionReceiptV1;
  /** Descriptive caller metadata only; host validation determines authority. */
  readonly verified?: boolean;
}

export interface TruthChapterCommitArtifactsV2 {
  readonly contextSha256: string;
  readonly predecessor: StructuredTruthV1;
  readonly acceptedDelta: AcceptedChapterDeltaV1;
  readonly deltaAdmission: Extract<ChapterDeltaAdmissionResultV1, { status: "ACCEPTED" }>;
  readonly applicationReceipt: TruthApplicationReceiptV1;
  readonly semanticValidation: CanonicalTruthValidationArtifact;
  readonly extractionContext: CanonicalTruthExtractionContextRecord;
  readonly validationContext: CanonicalTruthValidationContextRecord;
  readonly resultingTruth: StructuredTruthV1;
  readonly projections: readonly ProjectionArtifactV1[];
  readonly projectionManifest: ProjectionManifestV1;
  readonly usageByRole: Readonly<Record<string, { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number }>>;
  readonly extractorEvidence: {
    readonly logicalOperationId: string; readonly inputFingerprint: string;
    readonly providerArtifactSha256: string; readonly responseContentSha256: string;
    readonly contextSha256: string;
  };
  readonly validatorEvidence: {
    readonly logicalOperationId: string; readonly inputFingerprint: string;
    readonly providerArtifactSha256: string; readonly responseContentSha256: string;
    readonly contextSha256: string;
  };
}

export interface ChapterTransactionHandle extends ChapterTransactionRecord {
  readonly completedOperations: ReadonlyArray<string>;
  readonly hash: (content: string | Uint8Array) => string;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function authorityRoot(bookDir: string): string {
  return join(bookDir, "story", "commits");
}

function transactionRoot(bookDir: string, chapterNumber: number): string {
  return join(bookDir, "story", "runtime", "chapter-transactions", `chapter-${String(chapterNumber).padStart(4, "0")}`);
}

function transactionAttemptRoot(bookDir: string, chapterNumber: number, attemptNumber: number): string {
  const chapterRoot = transactionRoot(bookDir, chapterNumber);
  return attemptNumber === 1
    ? chapterRoot
    : join(chapterRoot, "attempts", `attempt-${String(attemptNumber).padStart(4, "0")}`);
}

function commitRoot(bookDir: string, chapterNumber: number): string {
  return join(authorityRoot(bookDir), `chapter-${String(chapterNumber).padStart(4, "0")}`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupSiblingTemps(path: string): Promise<void> {
  const parent = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  for (const name of await readdir(parent).catch(() => [])) {
    if (name.startsWith(prefix)) await rm(join(parent, name), { recursive: true, force: true });
  }
}

async function writeJsonExclusive(path: string, value: unknown, canonicalMode = false): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (canonicalMode) { await publishImmutableFile(path, content); return; }
  await mkdir(dirname(path), { recursive: true });
  await cleanupSiblingTemps(path);
  if (await exists(path)) {
    const current = await readFile(path, "utf-8");
    if (current === content) return;
    try {
      JSON.parse(current);
      throw new Error(`Immutable authority conflict at ${path}`);
    } catch (error) {
      if (error instanceof SyntaxError) await rm(path, { force: true });
      else throw error;
    }
  }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf-8", flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    if (await exists(path) && await readFile(path, "utf-8") === content) return;
    throw error;
  }
}

async function writeBytesExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (await exists(path)) {
    if (await readFile(path, "utf-8") === content) return;
    throw new Error(`Immutable authority conflict at ${path}`);
  }
  await writeFile(path, content, { encoding: "utf-8", flag: "wx" });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

async function listFiles(root: string): Promise<ReadonlyArray<{ relativePath: string; content: Uint8Array }>> {
  const output: Array<{ relativePath: string; content: Uint8Array }> = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push({ relativePath: relative(root, path).split(sep).join("/"), content: await readFile(path) });
    }
  };
  await visit(root);
  return output;
}

function entriesFor(files: ReadonlyArray<{ relativePath: string; content: Uint8Array }>): ReadonlyArray<TreeEntry> {
  return files.map((file) => ({ relativePath: file.relativePath, sha256: sha256(file.content), bytes: file.content.byteLength }));
}

function treeSha(entries: ReadonlyArray<TreeEntry>): string {
  return sha256(canonical(entries));
}

function isSafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/");
  return path.length > 0
    && !isAbsolute(path)
    && !/^[a-z]:/iu.test(path)
    && !normalized.split("/").includes("..");
}

async function verifyTree(root: string, expected: ReadonlyArray<TreeEntry>, label: string): Promise<void> {
  const actual = entriesFor(await listFiles(root));
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label} tree hash mismatch`);
}

async function verifySelectedFiles(root: string, expected: ReadonlyArray<TreeEntry>, label: string): Promise<void> {
  for (const entry of expected) {
    const content = await readFile(join(root, entry.relativePath));
    if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new Error(`${label} tree hash mismatch`);
  }
}

function parseStateManifest(raw: string, chapterNumber: number, candidateSha: string, previousAuthoritySha256: string, label: string): void {
  let manifest: { readonly schemaVersion?: unknown; readonly lastAppliedChapter?: unknown; readonly candidateSha256?: unknown; readonly previousAuthoritySha256?: unknown };
  try { manifest = JSON.parse(raw) as typeof manifest; } catch { throw new Error(`${label} manifest is invalid JSON`); }
  if (manifest.schemaVersion !== 2 || manifest.lastAppliedChapter !== chapterNumber || manifest.candidateSha256 !== candidateSha
    || manifest.previousAuthoritySha256 !== previousAuthoritySha256) {
    throw new Error(`${label} manifest is not bound to the final candidate`);
  }
}

export async function createChapterGenesis(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly lastTrustedChapter: number;
  readonly trustedSnapshotDir: string;
  readonly createdAt?: string;
}): Promise<ChapterGenesis> {
  if (!Number.isInteger(input.lastTrustedChapter) || input.lastTrustedChapter < 0) throw new Error("Genesis chapter must be a non-negative integer");
  const snapshotFiles = entriesFor(await listFiles(input.trustedSnapshotDir));
  if (snapshotFiles.length === 0) throw new Error("Genesis trusted snapshot is empty");
  const legacyChapterSources = (await listFiles(join(input.bookDir, "chapters")).catch(() => []))
    .filter((file) => {
      const match = file.relativePath.match(/^(\d+)[_-].*\.md$/u);
      return match !== null && Number(match[1]) <= input.lastTrustedChapter;
    });
  const legacyChapterFiles = entriesFor(legacyChapterSources);
  if (input.lastTrustedChapter > 0) {
    const chapterNumbers = legacyChapterSources.map((file) => Number(file.relativePath.match(/^(\d+)/u)?.[1])).sort((left, right) => left - right);
    if (chapterNumbers.length !== input.lastTrustedChapter || chapterNumbers.some((chapter, index) => chapter !== index + 1)) {
      throw new Error("Genesis legacy chapter authority is not contiguous");
    }
  }
  const index = await readJson<unknown>(join(input.bookDir, "chapters", "index.json")).catch(() => []);
  const legacyIndex = Array.isArray(index)
    ? index.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && Number((entry as { number?: unknown }).number) <= input.lastTrustedChapter))
    : [];
  if (input.lastTrustedChapter > 0) {
    const indexNumbers = legacyIndex.map((entry) => Number(entry.number)).sort((left, right) => left - right);
    if (indexNumbers.length !== input.lastTrustedChapter || indexNumbers.some((chapter, offset) => chapter !== offset + 1)) {
      throw new Error("Genesis legacy index authority is not contiguous");
    }
  }
  const unsigned = {
    schemaVersion: 1 as const, kind: "CHAPTER_GENESIS" as const, bookId: input.bookId,
    lastTrustedChapter: input.lastTrustedChapter,
    trustedSnapshotSha256: treeSha(snapshotFiles), trustedSnapshotFiles: snapshotFiles, legacyIndex,
    legacyChapterTreeSha256: treeSha(legacyChapterFiles), legacyChapterFiles,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const genesis: ChapterGenesis = { ...unsigned, genesisSha256: sha256(canonical(unsigned)) };
  const path = join(authorityRoot(input.bookDir), "genesis.json");
  if (await exists(path)) {
    const current = await loadChapterGenesis(input.bookDir).catch((error) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    if (!current) {
      await writeJsonExclusive(path, genesis);
      return genesis;
    }
    if (!current || current.bookId !== input.bookId || current.lastTrustedChapter !== input.lastTrustedChapter
      || current.trustedSnapshotSha256 !== genesis.trustedSnapshotSha256
      || canonical(current.trustedSnapshotFiles) !== canonical(genesis.trustedSnapshotFiles)
      || current.legacyChapterTreeSha256 !== genesis.legacyChapterTreeSha256
      || canonical(current.legacyChapterFiles) !== canonical(genesis.legacyChapterFiles)
      || canonical(current.legacyIndex) !== canonical(genesis.legacyIndex)) throw new Error("Chapter genesis already exists with different authority");
    return current;
  }
  await writeJsonExclusive(path, genesis);
  return genesis;
}

export async function loadChapterGenesis(bookDir: string): Promise<ChapterGenesis | null> {
  const path = join(authorityRoot(bookDir), "genesis.json");
  if (!(await exists(path))) return null;
  const genesis = await readJson<ChapterGenesis>(path);
  const { genesisSha256, ...unsigned } = genesis;
  if (genesis.kind !== "CHAPTER_GENESIS" || genesis.schemaVersion !== 1 || sha256(canonical(unsigned)) !== genesisSha256) {
    throw new Error("Chapter genesis integrity mismatch");
  }
  return genesis;
}

async function completedOperations(root: string): Promise<ReadonlyArray<string>> {
  const operationsDir = join(root, "operations");
  if (!(await exists(operationsDir))) return [];
  const files = (await readdir(operationsDir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => (await readJson<{ logicalOperationId: string }>(join(operationsDir, file))).logicalOperationId));
}

export async function beginChapterTransaction(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly productionAuthority: string;
  readonly createdAt?: string;
  readonly truthMode?: "LEGACY_V1" | "CANONICAL_V2";
  readonly firstV2Baseline?: FirstV2BaselineContext;
}): Promise<ChapterTransactionHandle> {
  return withChapterTransactionPublicationGuard(input.bookDir, () => beginChapterTransactionUnderGuard(input));
}

async function buildCommittedLegacyBaseline(bookDir: string, chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>) {
  const latest = chain.commits.at(-1);
  if (latest?.kind !== "CHAPTER_COMMIT") throw new Error("FIRST_V2_REQUIRES_VERIFIED_LEGACY_COMMIT");
  const root = commitRoot(bookDir, latest.chapterNumber);
  const sourceFiles = Object.fromEntries((await listFiles(join(root, "state"))).map((file) => [file.relativePath, file.content]));
  return buildFirstV2Baseline({ chapterCommit: latest, sourceFiles, predecessorChapterBody: await readFile(join(root, "chapter.md"), "utf8") });
}

/** Called under the existing book/job lock, before any production model admission. */
export async function prepareFirstV2Cutover(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly productionAuthority: string;
  readonly runtimeSnapshot?: string;
}): Promise<ChapterTransactionHandle | undefined> {
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.bookId !== input.bookId) throw new Error("FIRST_V2_CUTOVER_BOOK_MISMATCH");
  if (chain.commits.length === 0 || chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")) return undefined;
  const chapterNumber = chain.latestChapter + 1;
  const durableBaseline = await loadDurableFirstV2BaselineFromVerifiedChain(input.bookDir, chapterNumber, chain).catch((error: unknown) => {
    if (error instanceof Error && error.message === "FIRST_V2_BASELINE_TRANSACTION_MISSING") return undefined;
    throw error;
  });
  if (durableBaseline) return beginChapterTransaction({ bookDir: input.bookDir, bookId: input.bookId, chapterNumber,
    productionAuthority: input.productionAuthority, truthMode: "CANONICAL_V2", firstV2Baseline: durableBaseline });
  const firstV2Baseline = await buildCommittedLegacyBaseline(input.bookDir, chain);
  const request = { ...input, chapterNumber, truthMode: "CANONICAL_V2" as const, firstV2Baseline };
  const attempts = await listChapterTransactions(input.bookDir, chapterNumber).catch(async (error: unknown) => {
    if (!(error instanceof Error) || error.message !== "FIRST_V2_BASELINE_TRANSACTION_MISSING") throw error;
    const orphan = await verifyRecoverableBaselineOrphan(request);
    return listChapterTransactions(input.bookDir, chapterNumber, orphan.root);
  });
  const active = attempts.filter((attempt) => !attempt.abandoned);
  if (active.length > 1) throw new Error("MULTIPLE_ACTIVE_CHAPTER_ATTEMPTS");
  for (const attempt of attempts) {
    if (attempt.abandoned && attempt.terminal?.outcome === "ABANDONED" && !(await exists(join(attempt.root, "abandonment.json")))) {
      await abandonChapterTransactionAttempt({ ...input, chapterNumber, transactionId: attempt.record.transactionId,
        runtimeSnapshot: await readFile(join(attempt.root, "runtime-at-abandon.json"), "utf8") });
    }
  }
  const old = active[0];
  if (old && old.record.truthMode !== "CANONICAL_V2") {
    if (old.terminal) throw new Error("FIRST_V2_LEGACY_TERMINAL_ALREADY_SELECTED");
    const snapshot = input.runtimeSnapshot ?? await readFile(join(input.bookDir, "story/runtime/bounded-autonomous/production-state.json"), "utf8");
    const runtime = JSON.parse(snapshot) as Partial<AutonomousRunProgress>;
    if (runtime.nextChapter !== chapterNumber || !Array.isArray(runtime.providerAttemptHistory)) throw new Error("FIRST_V2_LEGACY_PROVIDER_HISTORY_MISSING");
    const history = runtime.providerAttemptHistory.filter((entry) => entry.chapterNumber === chapterNumber || entry.transactionId === old.record.transactionId);
    if (history.some((entry) => entry.chapterNumber !== chapterNumber || entry.transactionId !== old.record.transactionId || entry.classification !== "SUCCESS"
      || !entry.transportStarted || !entry.transportReturned)) throw new Error("FIRST_V2_LEGACY_PROVIDER_OUTCOME_UNRESOLVED");
    const references = await collectProviderReferences(input.bookDir, chapterNumber, old.record.transactionId);
    if (references.length !== new Set(history.map((entry) => entry.logicalStepId)).size
      || references.some((reference) => !history.some((entry) => entry.logicalStepId === reference.logicalOperationId
        && entry.role === reference.role && entry.provider === reference.provider && entry.requestedModel === reference.requestedModel))) {
      throw new Error("FIRST_V2_LEGACY_PROVIDER_HISTORY_MISMATCH");
    }
    await abandonChapterTransactionAttempt({ ...input, chapterNumber, transactionId: old.record.transactionId, runtimeSnapshot: snapshot });
  }
  return beginChapterTransaction(request);
}

async function beginChapterTransactionUnderGuard(input: Parameters<typeof beginChapterTransaction>[0]): Promise<ChapterTransactionHandle> {
  let recoverableOrphanRoot: string | undefined;
  let chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  const authority = await inspectChapterAuthorityFromVerifiedChain({ bookDir: input.bookDir }, chain).catch(async (error: unknown) => {
    if (!(error instanceof Error) || error.message !== "FIRST_V2_BASELINE_TRANSACTION_MISSING") throw error;
    const recovered = await verifyRecoverableBaselineOrphan(input);
    recoverableOrphanRoot = recovered.root;
    chain = recovered.chain;
    return { bookId: recovered.chain.bookId, nextChapter: recovered.chain.latestChapter + 1,
      latestAuthoritySha256: recovered.chain.latestAuthoritySha256, activeTransactionId: undefined };
  });
  const truthMode = input.truthMode ?? "LEGACY_V1";
  const hasV2 = chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT");
  if (hasV2 && truthMode !== "CANONICAL_V2") throw new Error("V1 after V2 transaction authority mismatch");
  let firstV2BaselineSha256: string | undefined;
  let firstV2Baseline = input.firstV2Baseline;
  if (truthMode === "CANONICAL_V2" && !hasV2) {
    firstV2Baseline ??= await loadDurableFirstV2BaselineFromVerifiedChain(input.bookDir, input.chapterNumber, chain);
    await loadCommittedV2PredecessorAuthorityFromVerifiedChain({ bookDir: input.bookDir, chapterNumber: input.chapterNumber, firstV2Baseline }, chain);
    firstV2BaselineSha256 = canonicalSha256(firstV2Baseline!);
  }
  if (authority.bookId !== input.bookId || authority.nextChapter !== input.chapterNumber) throw new Error("Chapter transaction does not match authoritative next chapter");
  if (authority.activeTransactionId) {
    const active = await findTransaction(input.bookDir, authority.activeTransactionId);
    if (active.record.bookId !== input.bookId || active.record.chapterNumber !== input.chapterNumber
      || active.record.previousAuthoritySha256 !== authority.latestAuthoritySha256
      || active.record.productionAuthority !== input.productionAuthority
      || (active.record.truthMode ?? "LEGACY_V1") !== truthMode
      || active.record.firstV2BaselineSha256 !== firstV2BaselineSha256) {
      throw new Error("Existing chapter transaction authority mismatch");
    }
    return transactionHandle(active);
  }
  const attempts = await listChapterTransactions(input.bookDir, input.chapterNumber, recoverableOrphanRoot);
  const attemptNumber = attempts.reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNumber), 0) + 1;
  const legacyIdentity = attemptNumber === 1
    ? { bookId: input.bookId, chapterNumber: input.chapterNumber, previousAuthoritySha256: authority.latestAuthoritySha256, productionAuthority: input.productionAuthority }
    : { schemaVersion: 2, bookId: input.bookId, chapterNumber: input.chapterNumber, previousAuthoritySha256: authority.latestAuthoritySha256, productionAuthority: input.productionAuthority, attemptNumber };
  const transactionIdentity = truthMode === "CANONICAL_V2"
    ? { ...legacyIdentity, truthMode, ...(firstV2BaselineSha256 ? { firstV2BaselineSha256 } : {}) } : legacyIdentity;
  const transactionId = `chapter-txn-${sha256(canonical(transactionIdentity)).slice(0, 40)}`;
  const root = transactionAttemptRoot(input.bookDir, input.chapterNumber, attemptNumber);
  if (recoverableOrphanRoot && root !== recoverableOrphanRoot) throw new Error("FIRST_V2_BASELINE_ORPHAN_ATTEMPT_MISMATCH");
  const path = join(root, "transaction.json");
  const expected: ChapterTransactionRecord = {
    schemaVersion: 1, kind: "CHAPTER_TRANSACTION", transactionId, bookId: input.bookId,
    chapterNumber: input.chapterNumber, previousAuthoritySha256: authority.latestAuthoritySha256,
    productionAuthority: input.productionAuthority, state: "STAGING", createdAt: input.createdAt ?? new Date().toISOString(),
    ...(attemptNumber > 1 ? { attemptNumber } : {}),
    truthMode,
    ...(firstV2BaselineSha256 ? { firstV2BaselineSha256 } : {}),
  };
  if (firstV2BaselineSha256) await publishImmutableFile(join(root, "first-v2-baseline.json"), canonicalJsonV2(firstV2Baseline!));
  if (truthMode === "CANONICAL_V2") {
    let record = expected;
    try { await writeJsonExclusive(path, expected, true); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("IMMUTABLE_CONFLICT:")) throw error;
      record = await readJson<ChapterTransactionRecord>(path);
      if (canonical({ ...record, createdAt: expected.createdAt }) !== canonical(expected)) throw new Error("Existing chapter transaction authority mismatch");
    }
    return transactionHandle({ record, root, attemptNumber, abandoned: false });
  }
  let transaction: ChapterTransactionRecord;
  if (await exists(path)) {
    try {
      transaction = await readJson<ChapterTransactionRecord>(path);
      const stable = { ...transaction, createdAt: expected.createdAt };
      if (canonical(stable) !== canonical(expected)) throw new Error("Existing chapter transaction authority mismatch");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await writeJsonExclusive(path, expected);
      transaction = expected;
    }
  } else {
    await writeJsonExclusive(path, expected);
    transaction = expected;
  }
  return transactionHandle({ record: transaction, root, attemptNumber, abandoned: false });
}

interface LocatedChapterTransaction {
  readonly record: ChapterTransactionRecord;
  readonly root: string;
  readonly attemptNumber: number;
  readonly abandoned: boolean;
  readonly terminal?: ChapterAttemptTerminal;
}

export async function assertChapterTransactionOpen(input: { readonly bookDir: string; readonly transactionId: string; readonly chapterNumber?: number }): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  if (input.chapterNumber !== undefined && transaction.record.chapterNumber !== input.chapterNumber) throw new Error("CHAPTER_TRANSACTION_ADMISSION_CHAPTER_MISMATCH");
}

/** Recheck inside the same short guard used by terminal selection and transport admission. */
export async function publishOpenChapterTransaction<T>(input: { readonly bookDir: string; readonly transactionId: string }, publish: () => Promise<T>): Promise<T> {
  return withChapterTransactionPublicationGuard(input.bookDir, async () => {
    await assertChapterTransactionOpen(input);
    return publish();
  });
}

async function transactionHandle(transaction: LocatedChapterTransaction): Promise<ChapterTransactionHandle> {
  return {
    ...transaction.record,
    attemptNumber: transaction.attemptNumber,
    completedOperations: await completedOperations(transaction.root),
    hash: sha256,
  };
}

export async function recordChapterTransactionOperation(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly logicalOperationId: string;
  readonly stage: string;
  readonly inputFingerprint: string;
  readonly responseArtifactStatus: "COMPLETE";
  readonly responseSha256: string;
}): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const record = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    logicalOperationId: input.logicalOperationId,
    chapterNumber: transaction.record.chapterNumber,
    stage: input.stage,
    inputFingerprint: input.inputFingerprint,
    responseArtifactStatus: input.responseArtifactStatus,
    responseSha256: input.responseSha256,
  };
  const path = join(transaction.root, "operations", `${sha256(input.logicalOperationId)}.json`);
  try {
    await publishOpenChapterTransaction(input, () => writeJsonExclusive(path, record, transaction.record.truthMode === "CANONICAL_V2"));
  } catch (error) {
    throw new Error("Completed Provider operation is immutable", { cause: error });
  }
}

export async function recordChapterTransactionCandidate(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly label: "INITIAL" | "REVISION_1" | "REVISION_2";
  readonly content: string;
  readonly sha256: string;
}): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  if (sha256(input.content) !== input.sha256) throw new Error("Staged candidate hash mismatch");
  const root = join(transaction.root, "staging", "evidence", "candidates");
  const target = join(root, input.label);
  const bodyPath = join(target, "body.md");
  const metadataPath = join(target, "metadata.json");
  const metadata = { schemaVersion: 1, label: input.label, sha256: input.sha256 };
  if (transaction.record.truthMode === "CANONICAL_V2") {
    await publishOpenChapterTransaction(input, async () => {
      await publishImmutableFile(bodyPath, input.content);
      await writeJsonExclusive(metadataPath, metadata, true);
    });
    return;
  }
  await mkdir(root, { recursive: true });
  await publishOpenChapterTransaction(input, () => cleanupSiblingTemps(target));
  if (await exists(target)) {
    try {
      const [body, persisted] = await Promise.all([readFile(bodyPath, "utf-8"), readJson(metadataPath)]);
      if (body === input.content && canonical(persisted) === canonical(metadata)) return;
      throw new Error(`Staged candidate ${input.label} is immutable`);
    } catch (error) {
      const incomplete = (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError;
      if (!incomplete) throw error;
      await publishOpenChapterTransaction(input, () => rm(target, { recursive: true, force: true }));
    }
  }
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temp, { recursive: false });
  try {
    await writeFile(join(temp, "body.md"), input.content, { encoding: "utf-8", flag: "wx" });
    await writeFile(join(temp, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
    await publishOpenChapterTransaction(input, () => rename(temp, target));
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function recordChapterTransactionReviewEvidence(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly candidateSha256: string;
  readonly reviewerRole: string;
  readonly evidence: unknown;
  readonly providerEvidence?: ChapterProviderReference;
  readonly expectedInputFingerprint?: string;
  readonly providerRequest?: ReviewProviderRequestEvidence;
}): Promise<string> {
  try {
  if (!/^[a-f0-9]{64}$/u.test(input.candidateSha256)) throw new Error("Review candidate SHA is invalid");
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const reviewer = input.reviewerRole.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  let rawResponse: string | undefined;
  let parsedStableReview: Omit<ScoredReview, "reviewedAt" | "tokenUsage"> | undefined;
  if (input.providerEvidence) {
    if (input.expectedInputFingerprint !== undefined && input.providerEvidence.inputFingerprint !== input.expectedInputFingerprint) {
      throw new Error("Reviewer Provider input fingerprint does not match the candidate request");
    }
    rawResponse = await verifyProviderReference(input.bookDir, transaction.record, input.providerEvidence);
    parsedStableReview = parseStableProviderReview(
      rawResponse,
      input.reviewerRole,
      input.candidateSha256,
      input.providerEvidence,
      input.providerRequest?.reviewLanguage ?? "en",
    );
    if (canonical(parsedStableReview) !== canonical(input.evidence)) {
      throw new Error("Reviewer raw response parsed review binding mismatch");
    }
  }
  if (input.providerRequest) {
    const request = input.providerRequest;
    if ((request.reviewLanguage !== "zh" && request.reviewLanguage !== "en")
      || input.reviewerRole === "commercial-reader" && request.reviewLanguage !== "en"
      || typeof request.webSearch !== "boolean"
      || !request.extra || typeof request.extra !== "object" || Array.isArray(request.extra)) {
      throw new Error("Reviewer exact review language binding mismatch");
    }
    const fingerprint = fingerprintReviewProviderRequest(request);
    const candidatesRoot = join(transaction.root, "staging", "evidence", "candidates");
    const matchingBodies = new Set<string>();
    for (const name of await readdir(candidatesRoot).catch(() => [])) {
      const candidateBody = await readFile(join(candidatesRoot, name, "body.md"), "utf8").catch(() => null);
      if (candidateBody !== null && sha256(candidateBody) === input.candidateSha256) matchingBodies.add(candidateBody);
    }
    const body = matchingBodies.size === 1 ? [...matchingBodies][0]! : null;
    const candidateMarker = input.reviewerRole === "logic-canon-auditor"
      ? `${request.reviewLanguage === "zh" ? "## 待审章节内容" : "## Chapter Content Under Review"}\n${body ?? ""}`
      : `Candidate:\n${body ?? ""}`;
    const userMessage = request.messages.at(-1);
    if (!body) throw new Error("Reviewer exact candidate body binding mismatch");
    if (fingerprint !== request.inputFingerprint) {
      throw new Error("Reviewer exact candidate request fingerprint mismatch");
    }
    if (input.providerEvidence && request.inputFingerprint !== input.providerEvidence.inputFingerprint) {
      throw new Error("Reviewer exact candidate Provider fingerprint mismatch");
    }
    if (input.providerEvidence
      && (request.provider !== input.providerEvidence.provider || request.model !== input.providerEvidence.requestedModel)) {
      throw new Error("Reviewer exact candidate Provider identity mismatch");
    }
    if (userMessage?.role !== "user" || !userMessage.content.endsWith(candidateMarker)) {
      throw new Error("Reviewer exact candidate prompt binding mismatch");
    }
  }
  const evidenceSha256 = sha256(canonical(input.evidence));
  const path = join(
    transaction.root,
    "staging", "evidence", "reviews", input.candidateSha256, reviewer, `${evidenceSha256}.json`,
  );
  if (input.providerEvidence) {
    const reference = input.providerEvidence;
    const expectedRole = input.reviewerRole === "logic-canon-auditor" ? "logic-canon-auditor" : input.reviewerRole;
    const expectedStage = input.reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
    if (reference.transactionId !== input.transactionId
      || reference.chapterNumber !== transaction.record.chapterNumber
      || reference.role !== expectedRole || reference.stage !== expectedStage
      || reference.provider !== (input.evidence as { readonly provider?: unknown })?.provider
      || reference.requestedModel !== (input.evidence as { readonly model?: unknown })?.model) {
      throw new Error("Reviewer Provider evidence identity mismatch");
    }
  }
  const record = {
    schemaVersion: input.providerRequest ? 3 : input.providerEvidence ? 2 : 1,
    transactionId: input.transactionId,
    chapterNumber: transaction.record.chapterNumber,
    candidateSha256: input.candidateSha256,
    reviewerRole: input.reviewerRole,
    evidenceSha256,
    evidence: input.evidence,
    ...(input.providerEvidence ? {
      providerEvidence: input.providerEvidence,
      rawResponse,
      rawResponseSha256: sha256(rawResponse!),
      parsedStableReviewSha256: sha256(canonical(parsedStableReview)),
      ...(input.providerRequest ? { providerRequest: input.providerRequest } : {}),
    } : {}),
  };
  try { await publishOpenChapterTransaction(input, () => writeJsonExclusive(path, record, transaction.record.truthMode === "CANONICAL_V2")); }
  catch (error) { throw new Error("Staged reviewer evidence is immutable", { cause: error }); }
  return path;
  } catch (error) {
    throw asChapterArtifactEvidenceError("terminal review record/provider/raw/request/hash/stable-review validation failed", error);
  }
}

async function verifyRecoverableBaselineOrphan(input: Parameters<typeof beginChapterTransaction>[0]) {
  if (input.truthMode !== "CANONICAL_V2" || !input.firstV2Baseline) throw new Error("FIRST_V2_BASELINE_ORPHAN_REQUIRES_EXACT_INPUT");
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.bookId !== input.bookId || chain.latestChapter + 1 !== input.chapterNumber
    || chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")) throw new Error("FIRST_V2_BASELINE_ORPHAN_CHAIN_MISMATCH");
  await loadCommittedV2PredecessorAuthorityFromVerifiedChain({ bookDir: input.bookDir, chapterNumber: input.chapterNumber, firstV2Baseline: input.firstV2Baseline }, chain);
  const chapterRoot = transactionRoot(input.bookDir, input.chapterNumber);
  const attemptsRoot = await safeMutationPath(chapterRoot, "attempts");
  const entries = await readdir(attemptsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const roots = [chapterRoot];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^attempt-\d{4}$/u.test(entry.name)) throw new Error("FIRST_V2_BASELINE_ORPHAN_ATTEMPT_DEFECT");
    roots.push(await safeMutationPath(attemptsRoot, entry.name));
  }
  const orphans: string[] = [];
  for (const root of roots) {
    await safeMutationPath(root, "transaction.json");
    await safeMutationPath(root, "first-v2-baseline.json");
    if (!(await exists(join(root, "transaction.json"))) && await exists(join(root, "first-v2-baseline.json"))) orphans.push(root);
  }
  if (orphans.length !== 1) throw new Error("FIRST_V2_BASELINE_ORPHAN_AMBIGUOUS");
  const root = orphans[0]!;
  const names = await readdir(root);
  if (names.length !== 1 || names[0] !== "first-v2-baseline.json") throw new Error("FIRST_V2_BASELINE_ORPHAN_CONFLICTING_EVIDENCE");
  const bytes = await readFile(join(root, "first-v2-baseline.json"), "utf8");
  if (bytes !== canonicalJsonV2(input.firstV2Baseline)) throw new Error("FIRST_V2_BASELINE_ORPHAN_BYTES_MISMATCH");
  const attempts = await listChapterTransactions(input.bookDir, input.chapterNumber, root);
  if (attempts.some((attempt) => !attempt.abandoned)) throw new Error("FIRST_V2_BASELINE_ORPHAN_ACTIVE_CONFLICT");
  const nextAttempt = attempts.reduce((maximum, attempt) => Math.max(maximum, attempt.attemptNumber), 0) + 1;
  if (root !== transactionAttemptRoot(input.bookDir, input.chapterNumber, nextAttempt)) throw new Error("FIRST_V2_BASELINE_ORPHAN_ATTEMPT_MISMATCH");
  return { root, chain };
}

/** Verified durable discriminator; public mutation policy maps it to A/B/C. */
export async function loadActiveCanonicalTruthTransaction(bookDir: string): Promise<ChapterTransactionRecord | null> {
  const chain = await verifyChapterCommitChain({ bookDir });
  return loadActiveCanonicalTruthTransactionFromVerifiedChain(bookDir, chain);
}

/** One internally verified observation for the central cutover policy; never cached. */
export async function loadCanonicalTruthAuthorityObservation(bookDir: string): Promise<{
  readonly chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>;
  readonly activeTransaction: ChapterTransactionRecord | null;
}> {
  const chain = await verifyChapterCommitChain({ bookDir });
  const activeTransaction = chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")
    ? null
    : await loadActiveCanonicalTruthTransactionFromVerifiedChain(bookDir, chain);
  return { chain, activeTransaction };
}

async function loadActiveCanonicalTruthTransactionFromVerifiedChain(
  bookDir: string,
  chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>,
): Promise<ChapterTransactionRecord | null> {
  const active = (await listChapterTransactions(bookDir, chain.latestChapter + 1)).filter((attempt) => !attempt.abandoned);
  if (active.length > 1) throw new Error("MULTIPLE_ACTIVE_CHAPTER_ATTEMPTS");
  const entry = active[0];
  if (!entry) return null;
  const record = entry.record;
  if (record.truthMode !== undefined && record.truthMode !== "LEGACY_V1" && record.truthMode !== "CANONICAL_V2") throw new Error("INVALID_TRUTH_MODE");
  if (record.bookId !== chain.bookId || record.chapterNumber !== chain.latestChapter + 1
    || record.previousAuthoritySha256 !== chain.latestAuthoritySha256) throw new Error("CANONICAL_TRANSACTION_AUTHORITY_MISMATCH");
  const legacyIdentity = entry.attemptNumber === 1
    ? { bookId: record.bookId, chapterNumber: record.chapterNumber, previousAuthoritySha256: record.previousAuthoritySha256, productionAuthority: record.productionAuthority }
    : { schemaVersion: 2, bookId: record.bookId, chapterNumber: record.chapterNumber, previousAuthoritySha256: record.previousAuthoritySha256, productionAuthority: record.productionAuthority, attemptNumber: entry.attemptNumber };
  const identity = record.truthMode === "CANONICAL_V2"
    ? { ...legacyIdentity, truthMode: record.truthMode, ...(record.firstV2BaselineSha256 ? { firstV2BaselineSha256: record.firstV2BaselineSha256 } : {}) } : legacyIdentity;
  if (record.transactionId !== `chapter-txn-${sha256(canonical(identity)).slice(0, 40)}`) throw new Error("CANONICAL_TRANSACTION_IDENTITY_MISMATCH");
  if (record.truthMode !== "CANONICAL_V2") {
    if (record.firstV2BaselineSha256 !== undefined || await exists(join(entry.root, "first-v2-baseline.json"))) throw new Error("FIRST_V2_BASELINE_DISCRIMINATOR_MISMATCH");
    return null;
  }
  if (!chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")) {
    let baseline: FirstV2BaselineContext;
    try { baseline = await readJson<FirstV2BaselineContext>(join(entry.root, "first-v2-baseline.json")); }
    catch (cause) { throw new Error("FIRST_V2_BASELINE_EVIDENCE_DEFECT", { cause }); }
    if (canonicalSha256(baseline) !== record.firstV2BaselineSha256) throw new Error("FIRST_V2_BASELINE_HASH_MISMATCH");
    await loadCommittedV2PredecessorAuthorityFromVerifiedChain({ bookDir, chapterNumber: record.chapterNumber, firstV2Baseline: baseline }, chain);
  }
  return record;
}

async function loadDurableFirstV2BaselineFromVerifiedChain(
  bookDir: string,
  chapterNumber: number,
  chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>,
): Promise<FirstV2BaselineContext | undefined> {
  const record = await loadActiveCanonicalTruthTransactionFromVerifiedChain(bookDir, chain);
  if (!record || record.chapterNumber !== chapterNumber || !record.firstV2BaselineSha256) return undefined;
  const path = await safeMutationPath(transactionAttemptRoot(bookDir, chapterNumber, record.attemptNumber ?? 1), "first-v2-baseline.json");
  const baseline = await readJson<FirstV2BaselineContext>(path);
  if (canonicalSha256(baseline) !== record.firstV2BaselineSha256) throw new Error("FIRST_V2_BASELINE_HASH_MISMATCH");
  return baseline;
}

function normalizedProviderRequest(
  request: ChapterProviderRequestAuthority["request"],
): ChapterProviderRequestAuthority["request"] {
  if (!request || typeof request !== "object"
    || typeof request.provider !== "string" || !request.provider.trim()
    || typeof request.model !== "string" || !request.model.trim()
    || !Array.isArray(request.messages) || request.messages.length === 0
    || request.messages.some((message) => !message || typeof message !== "object"
      || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")
    || !Number.isFinite(request.temperature)
    || !Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0
    || typeof request.stream !== "boolean" || typeof request.webSearch !== "boolean"
    || !request.extra || typeof request.extra !== "object" || Array.isArray(request.extra)) {
    throw new Error("Chapter Provider request authority is invalid");
  }
  return {
    provider: request.provider,
    model: request.model,
    messages: structuredClone(request.messages),
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    stream: request.stream,
    webSearch: request.webSearch,
    extra: JSON.parse(canonicalJsonV2(request.extra)) as Record<string, unknown>,
  };
}

function providerRequestFingerprint(request: ChapterProviderRequestAuthority["request"]): string {
  return sha256(JSON.stringify({
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    stream: request.stream,
  }));
}

function fullProviderRequestFingerprint(request: ChapterProviderRequestAuthority["request"]): string {
  return canonicalSha256({
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    stream: request.stream,
    webSearch: request.webSearch,
    extra: request.extra,
  });
}

function providerRequestFromTruthExecution(
  execution: CanonicalTruthExtractionContextRecord["execution"],
): ChapterProviderRequestAuthority["request"] {
  return normalizedProviderRequest({
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

function providerRequestReservationIdentity(input: Pick<ChapterProviderRequestAuthority,
  "transactionId" | "chapterNumber" | "candidateSha256" | "role" | "stage" | "requestOrdinal" | "reviewLanguage"
>): Record<string, unknown> {
  return {
    transactionId: input.transactionId,
    chapterNumber: input.chapterNumber,
    candidateSha256: input.candidateSha256,
    role: input.role,
    stage: input.stage,
    requestOrdinal: input.requestOrdinal,
    ...(input.reviewLanguage ? { reviewLanguage: input.reviewLanguage } : {}),
  };
}

async function loadUniqueCandidateBody(transaction: LocatedChapterTransaction, candidateSha256: string): Promise<string> {
  const candidateBodies = new Set<string>();
  const candidatesRoot = join(transaction.root, "staging", "evidence", "candidates");
  let candidateNames: string[];
  try { candidateNames = await readdir(candidatesRoot); }
  catch (error) { throw new Error("Chapter Provider request candidate authority is missing", { cause: error }); }
  for (const name of candidateNames) {
    const body = await readFile(join(candidatesRoot, name, "body.md"), "utf8");
    if (sha256(body) === candidateSha256) candidateBodies.add(body);
  }
  if (candidateBodies.size !== 1) throw new Error("Chapter Provider request candidate authority is missing or ambiguous");
  return [...candidateBodies][0]!;
}

function assertCandidateBoundProviderMessages(
  reservation: Pick<ChapterProviderRequestAuthority, "role" | "stage" | "reviewLanguage" | "request">,
  candidateBody: string,
): void {
  const userContents = reservation.request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  let exactFragment: string;
  if (reservation.role === "logic-canon-auditor" && reservation.stage === "LOGIC_REVIEW") {
    if (!reservation.reviewLanguage) throw new Error("Logic Provider request review language is missing");
    exactFragment = `${reservation.reviewLanguage === "zh" ? "## 待审章节内容" : "## Chapter Content Under Review"}\n${candidateBody}`;
  } else if (reservation.role === "commercial-reader" && reservation.stage === "READER_REVIEW") {
    if (reservation.reviewLanguage !== "en") throw new Error("Commercial Reader Provider request language must be en");
    exactFragment = `Candidate:\n${candidateBody}`;
  } else if (reservation.role === "truth-extractor"
    && ["TRUTH_EXTRACTION", "TRUTH_EXTRACTION_REPAIR"].includes(reservation.stage)
    || reservation.role === "truth-validator" && reservation.stage === "TRUTH_VALIDATION") {
    if (reservation.reviewLanguage !== undefined) throw new Error("Truth Provider request cannot nominate a review language");
    exactFragment = `## Exact approved candidate\n\n${candidateBody}\n\n## Verified predecessor StructuredTruthV1`;
  } else {
    throw new Error("Chapter Provider request role/stage is unsupported");
  }
  if (!userContents.some((content) => content.includes(exactFragment))) {
    throw new Error("Chapter Provider request messages do not bind the exact candidate bytes");
  }
}

async function validateProviderRequestReservation(input: {
  readonly transaction: LocatedChapterTransaction;
  readonly reservation: ChapterProviderRequestAuthority;
  readonly fileName?: string;
  readonly candidateBody?: string;
}): Promise<void> {
  const reservation = input.reservation;
  if (!reservation || reservation.schemaVersion !== 1 || reservation.kind !== "CHAPTER_PROVIDER_REQUEST_RESERVATION"
    || reservation.transactionId !== input.transaction.record.transactionId
    || reservation.chapterNumber !== input.transaction.record.chapterNumber
    || !/^[a-f0-9]{64}$/u.test(reservation.candidateSha256)
    || !isValidProviderIdentity(reservation.role) || !isValidProviderIdentity(reservation.stage)
    || !Number.isSafeInteger(reservation.requestOrdinal) || reservation.requestOrdinal < 0
    || reservation.reviewLanguage !== undefined && !(["zh", "en"] as const).includes(reservation.reviewLanguage)) {
    throw new Error("Chapter Provider request reservation identity is invalid");
  }
  const request = normalizedProviderRequest(reservation.request);
  const reservationId = `provider-request-${sha256(canonical(providerRequestReservationIdentity(reservation)))}`;
  if (reservation.reservationId !== reservationId
    || input.fileName !== undefined && input.fileName !== `${reservationId}.json`
    || canonical(reservation.request) !== canonical(request)
    || reservation.requestSha256 !== sha256(JSON.stringify(request))
    || reservation.fullRequestSha256 !== fullProviderRequestFingerprint(request)
    || reservation.providerInputFingerprint !== providerRequestFingerprint(request)) {
    throw new Error("Chapter Provider request reservation hash or fingerprint mismatch");
  }
  const candidateBody = input.candidateBody ?? await loadUniqueCandidateBody(input.transaction, reservation.candidateSha256);
  if (sha256(candidateBody) !== reservation.candidateSha256) throw new Error("Chapter Provider request candidate bytes mismatch");
  assertCandidateBoundProviderMessages(reservation, candidateBody);
}

async function validateProviderRequestBinding(input: {
  readonly bookDir: string;
  readonly transaction: LocatedChapterTransaction;
  readonly reservation: ChapterProviderRequestAuthority;
  readonly binding: ChapterProviderRequestBinding;
}): Promise<void> {
  const { reservation, binding, transaction } = input;
  const reference = binding.providerReference;
  if (!binding || binding.schemaVersion !== 1 || binding.kind !== "CHAPTER_PROVIDER_REQUEST_BINDING"
    || binding.reservationId !== reservation.reservationId || binding.transactionId !== transaction.record.transactionId
    || binding.logicalOperationId !== reference?.logicalOperationId
    || binding.providerArtifactSha256 !== reference?.artifactSha256
    || reference.transactionId !== transaction.record.transactionId
    || reference.chapterNumber !== reservation.chapterNumber
    || reference.role !== reservation.role || reference.stage !== reservation.stage
    || reference.provider !== reservation.request.provider || reference.requestedModel !== reservation.request.model
    || reference.inputFingerprint !== reservation.providerInputFingerprint) {
    throw new Error("Chapter Provider request binding identity mismatch");
  }
  await verifyProviderReference(input.bookDir, transaction.record, reference);
}

function requestAuthorityRoot(transaction: LocatedChapterTransaction): string {
  return join(transaction.root, "staging", "evidence", "provider-requests");
}

export async function reserveChapterTransactionProviderRequest(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly candidateSha256: string;
  readonly role: string;
  readonly stage: string;
  readonly requestOrdinal: number;
  readonly reviewLanguage?: "zh" | "en";
  readonly request: ChapterProviderRequestAuthority["request"];
}): Promise<ChapterProviderRequestAuthority> {
  try {
    if (!/^[a-f0-9]{64}$/u.test(input.candidateSha256)
      || !isValidProviderIdentity(input.role) || !isValidProviderIdentity(input.stage)
      || !Number.isSafeInteger(input.requestOrdinal) || input.requestOrdinal < 0) {
      throw new Error("Chapter Provider request reservation identity is invalid");
    }
    const transaction = await findTransaction(input.bookDir, input.transactionId);
    if (transaction.record.chapterNumber !== input.chapterNumber) throw new Error("Chapter Provider request reservation chapter mismatch");
    const candidateBody = await loadUniqueCandidateBody(transaction, input.candidateSha256);
    const request = normalizedProviderRequest(input.request);
    const reservationIdentity = providerRequestReservationIdentity({
      transactionId: input.transactionId,
      chapterNumber: input.chapterNumber,
      candidateSha256: input.candidateSha256,
      role: input.role,
      stage: input.stage,
      requestOrdinal: input.requestOrdinal,
      ...(input.reviewLanguage ? { reviewLanguage: input.reviewLanguage } : {}),
    });
    const reservationId = `provider-request-${sha256(canonical(reservationIdentity))}`;
    const record: ChapterProviderRequestAuthority = {
      schemaVersion: 1,
      kind: "CHAPTER_PROVIDER_REQUEST_RESERVATION",
      reservationId,
      transactionId: input.transactionId,
      chapterNumber: input.chapterNumber,
      candidateSha256: input.candidateSha256,
      role: input.role,
      stage: input.stage,
      requestOrdinal: input.requestOrdinal,
      ...(input.reviewLanguage ? { reviewLanguage: input.reviewLanguage } : {}),
      request,
      requestSha256: sha256(JSON.stringify(request)),
      fullRequestSha256: fullProviderRequestFingerprint(request),
      providerInputFingerprint: providerRequestFingerprint(request),
    };
    await validateProviderRequestReservation({ transaction, reservation: record, candidateBody });
    const root = requestAuthorityRoot(transaction);
    const path = join(root, "reservations", `${reservationId}.json`);
    await mkdir(dirname(path), { recursive: true });
    if (await exists(path)) {
      const existing = await readJson<ChapterProviderRequestAuthority>(path);
      await validateProviderRequestReservation({ transaction, reservation: existing, fileName: `${reservationId}.json`, candidateBody });
      if (canonical(existing) !== canonical(record)) throw new Error("Chapter Provider request reservation drift");
      return existing;
    }
    await publishOpenChapterTransaction(input, () => writeJsonExclusive(path, record, transaction.record.truthMode === "CANONICAL_V2"));
    return record;
  } catch (error) {
    throw asChapterArtifactEvidenceError("Chapter Provider request reservation failed", error);
  }
}

export async function bindChapterTransactionProviderRequest(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly reservationId: string;
  readonly providerReference: ChapterProviderReference;
}): Promise<ChapterProviderRequestBinding> {
  try {
    const transaction = await findTransaction(input.bookDir, input.transactionId);
    const root = requestAuthorityRoot(transaction);
    const reservation = await readJson<ChapterProviderRequestAuthority>(join(root, "reservations", `${input.reservationId}.json`));
    await validateProviderRequestReservation({ transaction, reservation, fileName: `${input.reservationId}.json` });
    const reference = input.providerReference;
    const binding: ChapterProviderRequestBinding = {
      schemaVersion: 1,
      kind: "CHAPTER_PROVIDER_REQUEST_BINDING",
      reservationId: reservation.reservationId,
      transactionId: input.transactionId,
      logicalOperationId: reference.logicalOperationId,
      providerArtifactSha256: reference.artifactSha256,
      providerReference: reference,
    };
    await validateProviderRequestBinding({ bookDir: input.bookDir, transaction, reservation, binding });
    const path = join(root, "bindings", `${reservation.reservationId}.json`);
    await mkdir(dirname(path), { recursive: true });
    if (await exists(path)) {
      const existing = await readJson<ChapterProviderRequestBinding>(path);
      await validateProviderRequestBinding({ bookDir: input.bookDir, transaction, reservation, binding: existing });
      if (canonical(existing) !== canonical(binding)) throw new Error("Chapter Provider request binding is immutable");
      return existing;
    }
    await publishOpenChapterTransaction(input, () => writeJsonExclusive(path, binding, transaction.record.truthMode === "CANONICAL_V2"));
    return binding;
  } catch (error) {
    throw asChapterArtifactEvidenceError("Chapter Provider request binding failed", error);
  }
}

export async function collectBoundChapterProviderRequests(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly candidateSha256: string;
  readonly role: string;
  readonly stage: string;
}): Promise<ReadonlyArray<{ readonly reservation: ChapterProviderRequestAuthority; readonly binding: ChapterProviderRequestBinding }>> {
  try {
    const transaction = await findTransaction(input.bookDir, input.transactionId);
    if (transaction.record.chapterNumber !== input.chapterNumber) throw new Error("Bound Provider request chapter mismatch");
    const root = requestAuthorityRoot(transaction);
    let names: string[];
    try { names = await readdir(join(root, "reservations")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const matches: Array<{ reservation: ChapterProviderRequestAuthority; binding: ChapterProviderRequestBinding }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const reservation = await readJson<ChapterProviderRequestAuthority>(join(root, "reservations", name));
      await validateProviderRequestReservation({ transaction, reservation, fileName: name });
      if (reservation.transactionId !== input.transactionId || reservation.chapterNumber !== input.chapterNumber
        || reservation.candidateSha256 !== input.candidateSha256 || reservation.role !== input.role || reservation.stage !== input.stage) continue;
      const bindingPath = join(root, "bindings", `${reservation.reservationId}.json`);
      let binding: ChapterProviderRequestBinding;
      try { binding = await readJson<ChapterProviderRequestBinding>(bindingPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await validateProviderRequestBinding({ bookDir: input.bookDir, transaction, reservation, binding });
      matches.push({ reservation, binding });
    }
    return matches.sort((left, right) => left.reservation.requestOrdinal - right.reservation.requestOrdinal);
  } catch (error) {
    throw asChapterArtifactEvidenceError("Bound Chapter Provider request collection failed", error);
  }
}

interface DurableProviderRequestAuthority {
  readonly reservation: ChapterProviderRequestAuthority;
  readonly binding: ChapterProviderRequestBinding;
  readonly reservationBytes: Buffer;
  readonly bindingBytes: Buffer;
}

export async function revalidateCanonicalTruthProviderEvidence(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly candidate: string;
  readonly evidence: import("../pipeline/canonical-truth-transaction.js").CanonicalTruthProviderEvidenceCheck;
}): Promise<void> {
  try {
    const transaction = await findTransaction(input.bookDir, input.transactionId);
    if (transaction.record.chapterNumber !== input.chapterNumber) throw new Error("Cached truth Provider chapter mismatch");
    const { artifact, execution, role, stage, repairOrdinal } = input.evidence;
    const reference: ChapterProviderReference = {
      transactionId: input.transactionId, chapterNumber: input.chapterNumber, role, stage,
      provider: execution.provider, requestedModel: execution.model,
      logicalOperationId: artifact.logicalOperationId, inputFingerprint: execution.inputFingerprint,
      artifactRelativePath: `story/runtime/bounded-autonomous/provider-responses/${artifact.logicalOperationId}.json`,
      artifactSha256: artifact.providerArtifactSha256, responseContentSha256: artifact.responseContentSha256,
      responseArtifactStatus: "COMPLETE",
    };
    if (artifact.inputFingerprint !== execution.inputFingerprint) throw new Error("Cached truth Provider fingerprint mismatch");
    await loadExactBoundProviderRequest({ bookDir: input.bookDir, transaction, candidateBody: input.candidate,
      role, stage, reference, requestOrdinal: repairOrdinal, request: providerRequestFromTruthExecution(execution) });
    const verified = await verifyProviderArtifact(input.bookDir, transaction.record, reference);
    const content = "rawProposal" in artifact ? artifact.rawProposal : artifact.rawResponse;
    if (verified.responseContent !== content || canonical(verified.usage) !== canonical(artifact.usage)) {
      throw new Error("Cached truth Provider response/usage mismatch");
    }
  } catch (error) {
    throw asChapterArtifactEvidenceError("Cached truth Provider authority revalidation failed", error);
  }
}

async function loadExactBoundProviderRequest(input: {
  readonly bookDir: string;
  readonly transaction: LocatedChapterTransaction;
  readonly candidateBody: string;
  readonly role: string;
  readonly stage: string;
  readonly reference: ChapterProviderReference;
  readonly request: ChapterProviderRequestAuthority["request"];
  readonly reviewLanguage?: "zh" | "en";
  readonly requestOrdinal?: number;
}): Promise<DurableProviderRequestAuthority> {
  const matches = await collectBoundChapterProviderRequests({
    bookDir: input.bookDir,
    transactionId: input.transaction.record.transactionId,
    chapterNumber: input.transaction.record.chapterNumber,
    candidateSha256: sha256(input.candidateBody),
    role: input.role,
    stage: input.stage,
  });
  const exact = matches.filter(({ binding }) => binding.logicalOperationId === input.reference.logicalOperationId);
  if (exact.length !== 1) throw new ChapterArtifactEvidenceError(
    "ARTIFACT_EVIDENCE_DEFECT: exact bound Provider request authority is missing or ambiguous",
    { role: input.role, stage: input.stage, logicalOperationId: input.reference.logicalOperationId },
  );
  const { reservation, binding } = exact[0]!;
  if (reservation.reviewLanguage !== input.reviewLanguage
    || input.requestOrdinal !== undefined && reservation.requestOrdinal !== input.requestOrdinal
    || canonical(reservation.request) !== canonical(normalizedProviderRequest(input.request))
    || canonical(binding.providerReference) !== canonical(input.reference)) {
    throw new ChapterArtifactEvidenceError(
      "ARTIFACT_EVIDENCE_DEFECT: exact bound Provider request differs from frozen execution authority",
      { reservation, reference: input.reference },
    );
  }
  const root = requestAuthorityRoot(input.transaction);
  const [reservationBytes, bindingBytes] = await Promise.all([
    readFile(join(root, "reservations", `${reservation.reservationId}.json`)),
    readFile(join(root, "bindings", `${reservation.reservationId}.json`)),
  ]);
  if (reservationBytes.toString("utf8") !== `${JSON.stringify(reservation, null, 2)}\n`
    || bindingBytes.toString("utf8") !== `${JSON.stringify(binding, null, 2)}\n`) {
    throw new ChapterArtifactEvidenceError("ARTIFACT_EVIDENCE_DEFECT: bound Provider request bytes are not canonical", reservation);
  }
  return { reservation, binding, reservationBytes, bindingBytes };
}

async function validateCommittedProviderRequestAuthority(input: {
  readonly bookDir: string;
  readonly transaction: LocatedChapterTransaction;
  readonly candidateBody: string;
  readonly reservationBytes: Buffer;
  readonly bindingBytes: Buffer;
  readonly role: string;
  readonly stage: string;
  readonly reference: ChapterProviderReference;
  readonly reviewLanguage?: "zh" | "en";
  readonly requestOrdinal?: number;
  readonly request: ChapterProviderRequestAuthority["request"];
}): Promise<void> {
  try {
    const reservation = JSON.parse(input.reservationBytes.toString("utf8")) as ChapterProviderRequestAuthority;
    const binding = JSON.parse(input.bindingBytes.toString("utf8")) as ChapterProviderRequestBinding;
    if (input.reservationBytes.toString("utf8") !== `${JSON.stringify(reservation, null, 2)}\n`
      || input.bindingBytes.toString("utf8") !== `${JSON.stringify(binding, null, 2)}\n`
      || reservation.role !== input.role || reservation.stage !== input.stage
      || reservation.reviewLanguage !== input.reviewLanguage
      || input.requestOrdinal !== undefined && reservation.requestOrdinal !== input.requestOrdinal
      || canonical(reservation.request) !== canonical(normalizedProviderRequest(input.request))
      || canonical(binding.providerReference) !== canonical(input.reference)) {
      throw new Error("Committed terminal Provider request authority identity or bytes mismatch");
    }
    await validateProviderRequestReservation({
      transaction: input.transaction,
      reservation,
      candidateBody: input.candidateBody,
    });
    await validateProviderRequestBinding({
      bookDir: input.bookDir,
      transaction: input.transaction,
      reservation,
      binding,
    });
  } catch (error) {
    throw asChapterArtifactEvidenceError("committed terminal Provider request authority validation failed", error);
  }
}

export async function recordChapterTransactionReviewResult(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly result: unknown;
}): Promise<string> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const path = join(transaction.root, "staging", "evidence", "review-result.json");
  const record = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    chapterNumber: transaction.record.chapterNumber,
    result: input.result,
  };
  try { await publishOpenChapterTransaction(input, () => writeJsonExclusive(path, record, transaction.record.truthMode === "CANONICAL_V2")); }
  catch (error) { throw new Error("Staged bounded-review result is immutable", { cause: error }); }
  return path;
}

async function listChapterTransactions(bookDir: string, chapterNumber: number, recoverableOrphanRoot?: string): Promise<ReadonlyArray<LocatedChapterTransaction>> {
  const chapterRoot = transactionRoot(bookDir, chapterNumber);
  await safeMutationPath(chapterRoot, "transaction.json");
  const roots = [chapterRoot];
  const attemptsRoot = join(chapterRoot, "attempts");
  for (const entry of await readdir(attemptsRoot, { withFileTypes: true }).catch(() => [])) {
    await safeMutationPath(attemptsRoot, entry.name);
    if (entry.isDirectory() && /^attempt-\d+$/u.test(entry.name)) roots.push(join(attemptsRoot, entry.name));
  }
  const output: LocatedChapterTransaction[] = [];
  for (const root of roots) {
    const record = await readJson<ChapterTransactionRecord>(join(root, "transaction.json")).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError && !(await exists(join(root, "first-v2-baseline.json")))) return null;
      throw error;
    });
    if (!record) {
      if (root === recoverableOrphanRoot) continue;
      if (await exists(join(root, "first-v2-baseline.json"))) throw new Error("FIRST_V2_BASELINE_TRANSACTION_MISSING");
      if (await exists(join(root, "abandonment.json"))) throw new Error("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
      continue;
    }
    const encodedAttempt = Number(basename(root).match(/^attempt-(\d+)$/u)?.[1] ?? 1);
    const attemptNumber = record.attemptNumber ?? encodedAttempt;
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || (record.attemptNumber !== undefined && record.attemptNumber !== encodedAttempt)) {
      throw new Error("Chapter transaction attempt identity mismatch");
    }
    const abandonmentPath = join(root, "abandonment.json");
    let abandoned = false;
    const terminal = await readJson<ChapterAttemptTerminal>(join(root, "terminal-outcome.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (terminal) {
      if (terminal.schemaVersion !== 1 || terminal.transactionId !== record.transactionId || terminal.bookId !== record.bookId
        || terminal.chapterNumber !== record.chapterNumber || terminal.attemptNumber !== attemptNumber
        || terminal.previousAuthoritySha256 !== record.previousAuthoritySha256
        || !["ABANDONED", "COMMIT_SELECTED"].includes(terminal.outcome)) throw new Error("CHAPTER_TERMINAL_IDENTITY_MISMATCH");
      if (terminal.outcome === "ABANDONED") {
        if (terminal.runtimeSnapshotSha256 !== sha256(await readFile(join(root, "runtime-at-abandon.json")))) throw new Error("CHAPTER_TERMINAL_SNAPSHOT_MISMATCH");
        abandoned = true;
      } else if (!/^[a-f0-9]{64}$/u.test(terminal.commitSha256 ?? "")
        || !["CHAPTER_COMMIT", "TRUTH_CHAPTER_COMMIT"].includes(terminal.commitKind ?? "")) throw new Error("CHAPTER_TERMINAL_COMMIT_MISMATCH");
    }
    if (await exists(abandonmentPath)) {
      if (terminal?.outcome === "COMMIT_SELECTED") throw new Error("CHAPTER_TERMINAL_CONFLICT");
      const abandonment = await readJson<ChapterAttemptAbandonment>(abandonmentPath);
      const runtimeSnapshot = await readFile(join(root, "runtime-at-abandon.json"));
      if (abandonment.schemaVersion !== 1 || abandonment.kind !== "CHAPTER_ATTEMPT_ABANDONMENT"
        || abandonment.transactionId !== record.transactionId || abandonment.bookId !== record.bookId
        || abandonment.chapterNumber !== record.chapterNumber || abandonment.attemptNumber !== attemptNumber
        || abandonment.previousAuthoritySha256 !== record.previousAuthoritySha256
        || abandonment.reason !== "OPERATOR_DISCARDED_STAGING_ATTEMPT" || abandonment.abandonedBy !== "operator/product-action"
        || abandonment.runtimeSnapshotSha256 !== sha256(runtimeSnapshot)) {
        throw new Error("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
      }
      abandoned = true;
    }
    output.push({ record, root, attemptNumber, abandoned, ...(terminal ? { terminal } : {}) });
  }
  return output.sort((left, right) => left.attemptNumber - right.attemptNumber);
}

async function findTransaction(bookDir: string, transactionId: string, options?: { readonly allowAbandoned?: boolean; readonly allowCommitSelected?: boolean }): Promise<LocatedChapterTransaction> {
  const base = join(bookDir, "story", "runtime", "chapter-transactions");
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^chapter-\d+$/u.test(entry.name)) continue;
    const chapterNumber = Number(entry.name.slice("chapter-".length));
    for (const transaction of await listChapterTransactions(bookDir, chapterNumber)) {
      if (transaction.record.transactionId !== transactionId) continue;
      if (transaction.abandoned && !options?.allowAbandoned) throw new Error("CHAPTER_ATTEMPT_ABANDONED");
      if (transaction.terminal?.outcome === "COMMIT_SELECTED" && !options?.allowCommitSelected) throw new Error("CHAPTER_ATTEMPT_COMMIT_SELECTED");
      return transaction;
    }
  }
  throw new Error(`Unknown chapter transaction: ${transactionId}`);
}

export async function abandonChapterTransactionAttempt(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly transactionId: string;
  readonly runtimeSnapshot: string;
  readonly abandonedAt?: string;
}): Promise<ChapterAttemptAbandonment> {
  const transaction = await findTransaction(input.bookDir, input.transactionId, { allowAbandoned: true }).catch(async (error) => {
    if (!(error instanceof Error) || !error.message.startsWith("Unknown chapter transaction:")) throw error;
    const authority = await inspectChapterAuthority({ bookDir: input.bookDir });
    if (authority.bookId !== input.bookId || input.chapterNumber <= authority.latestChapter) throw new Error("CHAPTER_ATTEMPT_ABANDON_NOT_ALLOWED");
    throw error;
  });
  const runtimeSnapshotSha256 = sha256(input.runtimeSnapshot);
  if (transaction.record.bookId !== input.bookId || transaction.record.chapterNumber !== input.chapterNumber) throw new Error("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
  if (transaction.abandoned) {
    if (sha256(await readFile(join(transaction.root, "runtime-at-abandon.json"))) !== runtimeSnapshotSha256) throw new Error("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
    const recorded = await readJson<ChapterAttemptAbandonment>(join(transaction.root, "abandonment.json")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (recorded) return recorded;
  } else {
    if (await exists(join(commitRoot(input.bookDir, input.chapterNumber), "commit.json"))) throw new Error("CHAPTER_ALREADY_COMMITTED");
    const authority = await inspectChapterAuthority({ bookDir: input.bookDir });
    if (authority.bookId !== input.bookId || input.chapterNumber <= authority.latestChapter) throw new Error("CHAPTER_ATTEMPT_ABANDON_NOT_ALLOWED");
    if (authority.activeTransactionId !== input.transactionId || authority.nextChapter !== input.chapterNumber) throw new Error("CHAPTER_ATTEMPT_ABANDON_NOT_ACTIVE");
  }
  const abandonment: ChapterAttemptAbandonment = {
    schemaVersion: 1,
    kind: "CHAPTER_ATTEMPT_ABANDONMENT",
    transactionId: transaction.record.transactionId,
    bookId: transaction.record.bookId,
    chapterNumber: transaction.record.chapterNumber,
    attemptNumber: transaction.attemptNumber,
    previousAuthoritySha256: transaction.record.previousAuthoritySha256,
    reason: "OPERATOR_DISCARDED_STAGING_ATTEMPT",
    abandonedBy: "operator/product-action",
    runtimeSnapshotSha256,
    abandonedAt: input.abandonedAt ?? new Date().toISOString(),
  };
  await withChapterTransactionPublicationGuard(input.bookDir, async () => {
    const current = await findTransaction(input.bookDir, input.transactionId, { allowAbandoned: true });
    const snapshotPath = join(transaction.root, "runtime-at-abandon.json");
    if (current.abandoned) {
      if (!(await readFile(snapshotPath)).equals(Buffer.from(input.runtimeSnapshot))) throw new Error("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
      return;
    }
    await publishImmutableFile(snapshotPath, input.runtimeSnapshot);
  });
  await selectAttemptTerminal(input.bookDir, transaction, { outcome: "ABANDONED", runtimeSnapshotSha256 });
  try {
    await publishImmutableFile(join(transaction.root, "abandonment.json"), canonicalTextV2(abandonment));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("IMMUTABLE_CONFLICT")) throw error;
    // The timestamp is descriptive, not part of the terminal claim. A concurrent
    // identical claim adopts the already published and fully verified marker.
    await findTransaction(input.bookDir, input.transactionId, { allowAbandoned: true });
    const recorded = await readJson<ChapterAttemptAbandonment>(join(transaction.root, "abandonment.json"));
    if (recorded.runtimeSnapshotSha256 !== runtimeSnapshotSha256) throw error;
    return recorded;
  }
  return abandonment;
}

export function resolveChapterProviderOperation(input: {
  readonly transportStarted: boolean;
  readonly transportReturned: boolean;
  readonly responseArtifactStatus: "NONE" | "COMPLETE";
}): "EXECUTE" | "REPLAY_COMPLETE" | "PAUSE_AMBIGUOUS" {
  if (input.responseArtifactStatus === "COMPLETE" && input.transportReturned) return "REPLAY_COMPLETE";
  if (!input.transportStarted) return "EXECUTE";
  return "PAUSE_AMBIGUOUS";
}

async function writeTree(root: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<ReadonlyArray<TreeEntry>> {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  for (const [relativePath, content] of entries) {
    if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe staged artifact path: ${relativePath}`);
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return entriesFor(await listFiles(root));
}

function isValidProviderIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/^(unknown|null|invalid)$/iu.test(value.trim());
}

function validateReviewAuthority(review: ChapterCommitReviewAuthority, bodySha: string): void {
  if (review.status !== "APPROVED" && review.status !== "ACCEPTED_WITH_FINDINGS") throw new Error("Chapter commit requires terminal review authority");
  if (review.finalCandidateSha256 !== bodySha) throw new Error("Review evidence is not bound to final candidate hash");
  if (!Number.isInteger(review.revisionCount) || review.revisionCount < 0 || review.revisionCount > 2) throw new Error("Chapter commit revision count is invalid");
  if (!Array.isArray(review.reviewerEvidence) || review.reviewerEvidence.length !== 2) throw new Error("Chapter commit requires exactly two final reviewer authorities");
  for (const role of ["logic-canon-auditor", "commercial-reader"] as const) {
    const matches = review.reviewerEvidence.filter((entry) => entry.reviewerRole === role);
    if (matches.length !== 1) throw new Error(`Chapter commit requires exactly one ${role} authority`);
    const authority = matches[0]!;
    const dimensions = Object.values(authority.dimensionScores ?? {});
    if (authority.reviewedCandidateSha !== bodySha || !isValidProviderIdentity(authority.provider) || !isValidProviderIdentity(authority.model)
      || !["APPROVED", "APPROVED_WITH_NOTES"].includes(authority.decision)
      || !Number.isFinite(authority.totalScore) || authority.totalScore < 0 || authority.totalScore > 100
      || dimensions.length === 0 || dimensions.some((score) => !Number.isFinite(score) || score < 0 || score > 100)
      || !Array.isArray(authority.findings)) {
      throw new Error(`Chapter commit ${role} authority is invalid`);
    }
    if (authority.findings.some((finding) => {
      const detail = finding as { readonly blocking?: unknown; readonly severity?: unknown };
      return detail.blocking === true || ["CRITICAL", "MAJOR", "critical", "major"].includes(String(detail.severity ?? ""));
    })) {
      throw new Error(`Chapter commit ${role} authority has unresolved blocking findings`);
    }
  }
  if (review.findings.some((finding) => finding.blocking || ["CRITICAL", "MAJOR", "critical", "major"].includes(finding.severity ?? ""))) {
    throw new Error("Chapter commit has unresolved blocking findings");
  }
}

function validateStateValidationAuthority(
  evidence: ChapterStateValidationAuthority,
  chapterNumber: number,
  bodySha: string,
  previousAuthoritySha256: string,
): void {
  if (evidence.passed !== true || evidence.chapterNumber !== chapterNumber || evidence.finalCandidateSha256 !== bodySha
    || evidence.previousAuthoritySha256 !== previousAuthoritySha256) {
    throw new Error("State validation authority is not bound to the final candidate");
  }
}

interface VerifiedProviderArtifact {
  readonly responseContent: string;
  readonly usage: unknown;
}

async function verifyProviderArtifact(
  bookDir: string,
  transaction: ChapterTransactionRecord,
  reference: ChapterProviderReference,
): Promise<VerifiedProviderArtifact> {
  try {
    if (reference.transactionId !== transaction.transactionId || reference.chapterNumber !== transaction.chapterNumber
    || reference.responseArtifactStatus !== "COMPLETE" || !isValidProviderIdentity(reference.provider)
    || !/^provider-step-[a-f0-9]{64}$/u.test(reference.logicalOperationId)
    || !isValidProviderIdentity(reference.requestedModel) || !isValidProviderIdentity(reference.role)
    || !isValidProviderIdentity(reference.stage) || !/^[a-f0-9]{64}$/u.test(reference.inputFingerprint)
    || !/^[a-f0-9]{64}$/u.test(reference.artifactSha256) || !/^[a-f0-9]{64}$/u.test(reference.responseContentSha256)
    || !isSafeRelativePath(reference.artifactRelativePath)) {
    throw new Error("Chapter commit has unresolved ambiguous Provider evidence");
  }
  const bytes = await readFile(join(bookDir, reference.artifactRelativePath));
  if (sha256(bytes) !== reference.artifactSha256) throw new Error("Chapter transaction Provider artifact hash mismatch");
  let artifact: {
    readonly schema_version?: unknown; readonly transaction_id?: unknown; readonly logical_step_id?: unknown;
    readonly usage_identity?: unknown; readonly chapter_number?: unknown; readonly role?: unknown; readonly stage?: unknown;
    readonly provider?: unknown; readonly requested_model?: unknown; readonly input_fingerprint?: unknown;
    readonly response_artifact_status?: unknown; readonly content_sha256?: unknown;
    readonly response?: { readonly content?: unknown; readonly usage?: unknown };
  };
  try { artifact = JSON.parse(bytes.toString("utf-8")) as typeof artifact; }
  catch (error) { throw new Error("Chapter transaction Provider artifact is invalid JSON", { cause: error }); }
  if (artifact.schema_version !== "1.0" || artifact.transaction_id !== reference.transactionId
    || artifact.logical_step_id !== reference.logicalOperationId || artifact.usage_identity !== reference.logicalOperationId
    || artifact.chapter_number !== reference.chapterNumber || artifact.role !== reference.role || artifact.stage !== reference.stage
    || artifact.provider !== reference.provider || artifact.requested_model !== reference.requestedModel
    || artifact.input_fingerprint !== reference.inputFingerprint || artifact.response_artifact_status !== "COMPLETE"
    || artifact.content_sha256 !== reference.responseContentSha256 || typeof artifact.response?.content !== "string"
    || sha256(artifact.response.content) !== reference.responseContentSha256) {
    throw new Error("Chapter transaction Provider artifact identity mismatch");
  }
    return { responseContent: artifact.response.content, usage: artifact.response.usage };
  } catch (error) {
    if (error instanceof ChapterArtifactEvidenceError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Chapter transaction Provider artifact read/parse/validation failed: ${detail}`, error);
  }
}

async function verifyProviderReference(bookDir: string, transaction: ChapterTransactionRecord, reference: ChapterProviderReference): Promise<string> {
  return (await verifyProviderArtifact(bookDir, transaction, reference)).responseContent;
}

interface ProviderUsageAuthority {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly actualCostUsd?: number;
}

function validateProviderUsage(value: unknown, label: string): ProviderUsageAuthority {
  const usage = value as Partial<ProviderUsageAuthority> | null;
  if (!isValidProviderUsage(usage)) {
    throw new Error(`${label} Provider response usage is invalid`);
  }
  return {
    promptTokens: usage.promptTokens!,
    completionTokens: usage.completionTokens!,
    totalTokens: usage.totalTokens!,
    ...(usage.actualCostUsd !== undefined ? { actualCostUsd: usage.actualCostUsd } : {}),
  };
}

function addProviderUsage(left: ProviderUsageAuthority, right: ProviderUsageAuthority): ProviderUsageAuthority {
  const hasCost = left.actualCostUsd !== undefined || right.actualCostUsd !== undefined;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(hasCost ? { actualCostUsd: (left.actualCostUsd ?? 0) + (right.actualCostUsd ?? 0) } : {}),
  };
}

async function providerUsageForReference(
  bookDir: string,
  transaction: ChapterTransactionRecord,
  reference: ChapterProviderReference,
): Promise<ProviderUsageAuthority> {
  const artifact = await verifyProviderArtifact(bookDir, transaction, reference);
  return validateProviderUsage(artifact.usage, reference.role);
}

function assertUniqueProviderReferences(references: ReadonlyArray<ChapterProviderReference>): void {
  try {
    const logicalOperationIds = new Set<string>();
    const artifactPaths = new Set<string>();
    const artifactIdentities = new Set<string>();
    const completeReferences = new Set<string>();
    for (const reference of references) {
      const completeReference = canonicalJsonV2(reference);
      if (logicalOperationIds.has(reference.logicalOperationId)
        || artifactPaths.has(reference.artifactRelativePath)
        || artifactIdentities.has(reference.artifactSha256)
        || completeReferences.has(completeReference)) {
        throw new Error(`Commit V2 duplicate Provider reference authority for ${reference.logicalOperationId}`);
      }
      logicalOperationIds.add(reference.logicalOperationId);
      artifactPaths.add(reference.artifactRelativePath);
      artifactIdentities.add(reference.artifactSha256);
      completeReferences.add(completeReference);
    }
  } catch (error) {
    throw asChapterArtifactEvidenceError("Commit V2 unique Provider reference validation failed", error);
  }
}

async function assertProviderUsageAuthority(
  bookDir: string,
  transaction: ChapterTransactionRecord,
  references: ReadonlyArray<ChapterProviderReference>,
  committedUsage: unknown,
): Promise<Map<string, ProviderUsageAuthority>> {
  assertUniqueProviderReferences(references);
  const usageRecord = committedUsage as {
    readonly totalUsage?: ProviderUsageAuthority;
    readonly roleUsage?: Readonly<Record<string, ProviderUsageAuthority>>;
  };
  if (!usageRecord?.roleUsage || !usageRecord.totalUsage) throw new Error("Commit V2 Provider usage authority is missing");
  const totals = new Map<string, ProviderUsageAuthority>();
  for (const reference of references) {
    const usage = await providerUsageForReference(bookDir, transaction, reference);
    const current = totals.get(reference.role) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    totals.set(reference.role, addProviderUsage(current, usage));
  }
  for (const [role, usage] of totals) {
    const committedRoleUsage = usageRecord.roleUsage[role];
    if (!committedRoleUsage || canonicalJsonV2(committedRoleUsage) !== canonicalJsonV2(usage)) {
      throw new Error(`Commit V2 ${role} Provider response usage does not match aggregated role usage`);
    }
  }
  const committedRoles = Object.entries(usageRecord.roleUsage).map(([role, rawUsage]) => {
    const usage = validateProviderUsage(rawUsage, `Committed ${role}`);
    if ((usage.promptTokens !== 0 || usage.completionTokens !== 0 || usage.totalTokens !== 0
      || usage.actualCostUsd !== undefined && usage.actualCostUsd !== 0) && !totals.has(role)) {
      throw new Error(`Commit V2 ${role} has nonzero role usage without durable Provider evidence`);
    }
    return usage;
  });
  const summed = committedRoles.reduce<ProviderUsageAuthority>(addProviderUsage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  if (canonicalJsonV2(summed) !== canonicalJsonV2(validateProviderUsage(usageRecord.totalUsage, "Committed total"))) {
    throw new Error("Commit V2 Provider response usage does not match committed total usage");
  }
  return totals;
}

/** Derive the exact token and actual-cost authority from every durable Provider reference in one transaction. */
export async function deriveChapterProviderUsage(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly references: ReadonlyArray<ChapterProviderReference>;
}): Promise<{
  readonly totalUsage: ProviderUsageAuthority;
  readonly roleUsage: Readonly<Record<string, ProviderUsageAuthority>>;
}> {
  try {
    const transaction = await findTransaction(input.bookDir, input.transactionId);
    assertUniqueProviderReferences(input.references);
    const totals = new Map<string, ProviderUsageAuthority>();
    for (const reference of input.references) {
      if (reference.transactionId !== input.transactionId || reference.chapterNumber !== transaction.record.chapterNumber) {
        throw new Error("Provider usage reference transaction identity mismatch");
      }
      const usage = await providerUsageForReference(input.bookDir, transaction.record, reference);
      totals.set(reference.role, addProviderUsage(
        totals.get(reference.role) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        usage,
      ));
    }
    const roleUsage = Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const totalUsage = Object.values(roleUsage).reduce<ProviderUsageAuthority>(
      addProviderUsage,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
    return { totalUsage, roleUsage };
  } catch (error) {
    throw asChapterArtifactEvidenceError("Chapter Provider usage derivation failed", error);
  }
}

function assertTerminalProviderReferencePrechecks(
  review: ChapterCommitReviewAuthority,
  references: ReadonlyArray<ChapterProviderReference>,
): void {
  try {
    if (references.length === 0) throw new Error("Commit V2 requires Provider operation authority");
    for (const reviewer of review.reviewerEvidence) {
      const expectedStage = reviewer.reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
      if (!references.some((reference) => reference.role === reviewer.reviewerRole
        && reference.stage === expectedStage && reference.provider === reviewer.provider
        && reference.requestedModel === reviewer.model)) {
        throw new Error(`Commit V2 ${reviewer.reviewerRole} Provider authority is missing`);
      }
    }
  } catch (error) {
    throw asChapterArtifactEvidenceError("Commit V2 terminal Provider reference precheck failed", error);
  }
}

interface BoundReviewEvidenceRecord {
  readonly schemaVersion: 2 | 3;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly candidateSha256: string;
  readonly reviewerRole: string;
  readonly evidenceSha256: string;
  readonly evidence: ChapterCommitReviewerAuthority;
  readonly providerEvidence: ChapterProviderReference;
  readonly rawResponse: string;
  readonly rawResponseSha256: string;
  readonly parsedStableReviewSha256: string;
  readonly providerRequest?: ReviewProviderRequestEvidence;
}

function parseStableProviderReview(
  rawResponse: string,
  reviewerRole: string,
  candidateSha256: string,
  reference: Pick<ChapterProviderReference, "provider" | "requestedModel">,
  reviewLanguage: "zh" | "en" = "en",
): Omit<ScoredReview, "reviewedAt" | "tokenUsage"> {
  const parsed = reviewerRole === "logic-canon-auditor"
    ? scoredLogicReviewFromAudit(parseContinuityAuditResponse(rawResponse, reviewLanguage), {
      candidateSha: candidateSha256, provider: reference.provider, model: reference.requestedModel,
    })
    : reviewerRole === "commercial-reader"
      ? parseCommercialReaderResponse(rawResponse, {
        candidateSha: candidateSha256, provider: reference.provider, model: reference.requestedModel,
      })
      : null;
  if (!parsed) throw new Error("Reviewer raw response role is unsupported");
  const { reviewedAt: _reviewedAt, tokenUsage: _tokenUsage, ...stable } = parsed;
  return stable;
}

function assertBoundReviewRawBinding(record: BoundReviewEvidenceRecord, candidateBody?: string): void {
  try {
  const reviewLanguage = record.schemaVersion === 3 ? record.providerRequest?.reviewLanguage : "en";
  if (!reviewLanguage || !(["zh", "en"] as const).includes(reviewLanguage)
    || record.reviewerRole === "commercial-reader" && reviewLanguage !== "en") {
    throw new Error(`Commit V2 ${record.reviewerRole} exact review language binding mismatch`);
  }
  const stable = parseStableProviderReview(record.rawResponse, record.reviewerRole, record.candidateSha256, record.providerEvidence, reviewLanguage);
  if (record.rawResponseSha256 !== sha256(record.rawResponse)
    || record.rawResponseSha256 !== record.providerEvidence.responseContentSha256
    || record.parsedStableReviewSha256 !== sha256(canonical(stable))
    || canonical(stable) !== canonical(record.evidence)
    || record.evidenceSha256 !== sha256(canonical(stable))) {
    throw new Error(`Commit V2 ${record.reviewerRole} raw response parsed review binding mismatch`);
  }
  if (record.schemaVersion === 3) {
    const request = record.providerRequest;
    const marker = record.reviewerRole === "logic-canon-auditor"
      ? `${reviewLanguage === "zh" ? "## 待审章节内容" : "## Chapter Content Under Review"}\n${candidateBody ?? ""}`
      : `Candidate:\n${candidateBody ?? ""}`;
    if (!request || candidateBody === undefined || sha256(candidateBody) !== record.candidateSha256
      || fingerprintReviewProviderRequest(request) !== request.inputFingerprint
      || request.inputFingerprint !== record.providerEvidence.inputFingerprint
      || request.provider !== record.providerEvidence.provider || request.model !== record.providerEvidence.requestedModel
      || request.messages.at(-1)?.role !== "user" || !request.messages.at(-1)?.content.endsWith(marker)) {
      throw new Error(`Commit V2 ${record.reviewerRole} exact candidate request binding mismatch`);
    }
  }
  } catch (error) {
    throw asChapterArtifactEvidenceError(`Commit V2 ${record.reviewerRole} terminal review binding failed`, error);
  }
}

async function loadBoundReviewEvidenceRecord(
  bookDir: string,
  transaction: LocatedChapterTransaction,
  reviewer: ChapterCommitReviewerAuthority,
  candidateBody: string,
): Promise<{ readonly record: BoundReviewEvidenceRecord; readonly bytes: Buffer }> {
  try {
  const reviewerKey = reviewer.reviewerRole.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  const evidenceSha256 = sha256(canonical(reviewer));
  const path = join(transaction.root, "staging", "evidence", "reviews", reviewer.reviewedCandidateSha, reviewerKey, `${evidenceSha256}.json`);
  const bytes = await readFile(path).catch((error) => {
    throw new Error(`Commit V2 ${reviewer.reviewerRole} candidate-bound review evidence is missing`, { cause: error });
  });
  let record: BoundReviewEvidenceRecord;
  try { record = JSON.parse(bytes.toString("utf8")) as BoundReviewEvidenceRecord; }
  catch (error) { throw new Error(`Commit V2 ${reviewer.reviewerRole} review evidence is invalid JSON`, { cause: error }); }
  const reference = record.providerEvidence;
  const acceptedRoles = reviewer.reviewerRole === "logic-canon-auditor" ? ["logic-canon-auditor"] : ["commercial-reader"];
  const expectedStage = reviewer.reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
  if (record.schemaVersion !== 3 || record.transactionId !== transaction.record.transactionId
    || record.chapterNumber !== transaction.record.chapterNumber || record.candidateSha256 !== reviewer.reviewedCandidateSha
    || record.reviewerRole !== reviewer.reviewerRole || record.evidenceSha256 !== evidenceSha256
    || canonical(record.evidence) !== canonical(reviewer) || !reference
    || reference.transactionId !== transaction.record.transactionId || reference.chapterNumber !== transaction.record.chapterNumber
    || !acceptedRoles.includes(reference.role) || reference.stage !== expectedStage
    || reference.provider !== reviewer.provider || reference.requestedModel !== reviewer.model) {
    throw new Error(`Commit V2 ${reviewer.reviewerRole} candidate/Provider review binding mismatch`);
  }
  const rawResponse = await verifyProviderReference(bookDir, transaction.record, reference);
  if (rawResponse !== record.rawResponse) throw new Error(`Commit V2 ${reviewer.reviewerRole} raw response Provider binding mismatch`);
  assertBoundReviewRawBinding(record, candidateBody);
  return { record, bytes };
  } catch (error) {
    throw asChapterArtifactEvidenceError(`Commit V2 ${reviewer.reviewerRole} terminal review evidence failed`, error);
  }
}

/** Admit the exact current candidate's parsed terminal reviews before either truth model can run. */
export async function assertCanonicalTruthTerminalReviewAuthority(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly candidateSha256: string;
}): Promise<void> {
  try {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const candidateBodies = new Set<string>();
  const candidateRoot = join(transaction.root, "staging", "evidence", "candidates");
  for (const name of await readdir(candidateRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ChapterArtifactEvidenceError("ARTIFACT_EVIDENCE_DEFECT: terminal candidate evidence I/O failure", error);
  })) {
    try {
      const candidateBody = await readFile(join(candidateRoot, name, "body.md"), "utf8");
      if (sha256(candidateBody) === input.candidateSha256) candidateBodies.add(candidateBody);
    } catch (error) {
      throw new ChapterArtifactEvidenceError("ARTIFACT_EVIDENCE_DEFECT: terminal candidate evidence read failure", error);
    }
  }
  if (candidateBodies.size !== 1) throw new Error("Canonical truth terminal candidate body authority is missing or ambiguous");
  const candidateBody = [...candidateBodies][0]!;
  for (const reviewerRole of ["logic-canon-auditor", "commercial-reader"] as const) {
    const directory = join(
      transaction.root,
      "staging", "evidence", "reviews", input.candidateSha256, reviewerRole,
    );
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
      else throw new ChapterArtifactEvidenceError(`Canonical truth terminal ${reviewerRole} review evidence I/O failure`, error);
    }
    names = names.filter((name) => name.endsWith(".json")).sort();
    const approvals: BoundReviewEvidenceRecord[] = [];
    for (const name of names) {
      let bytes: Buffer;
      try { bytes = await readFile(join(directory, name)); }
      catch (error) { throw new ChapterArtifactEvidenceError(`Canonical truth terminal ${reviewerRole} review evidence I/O failure`, error); }
      let record: BoundReviewEvidenceRecord;
      try { record = JSON.parse(bytes.toString("utf8")) as BoundReviewEvidenceRecord; }
      catch (error) { throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Canonical truth terminal ${reviewerRole} review is malformed`, error); }
      const expectedStage = reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
      if (record.schemaVersion !== 3 || record.transactionId !== transaction.record.transactionId
        || record.chapterNumber !== transaction.record.chapterNumber || record.candidateSha256 !== input.candidateSha256
        || record.reviewerRole !== reviewerRole || record.evidence.reviewedCandidateSha !== input.candidateSha256
        || record.providerEvidence.role !== reviewerRole || record.providerEvidence.stage !== expectedStage) {
        throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Canonical truth terminal ${reviewerRole} review authority identity mismatch`, record);
      }
      const rawResponse = await verifyProviderReference(input.bookDir, transaction.record, record.providerEvidence);
      if (rawResponse !== record.rawResponse) throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Canonical truth terminal ${reviewerRole} Provider response mismatch`, record);
      assertBoundReviewRawBinding(record, candidateBody);
      if (["APPROVED", "APPROVED_WITH_NOTES"].includes(record.evidence.decision)) approvals.push(record);
    }
    if (approvals.length !== 1) throw new Error(`Canonical truth terminal ${reviewerRole} valid approval authority is missing or ambiguous`);
    const approval = approvals[0]!;
    const providerRequest = approval.providerRequest;
    if (!providerRequest?.reviewLanguage) {
      throw new ChapterArtifactEvidenceError(
        `ARTIFACT_EVIDENCE_DEFECT: Canonical truth terminal ${reviewerRole} exact request language is missing`,
        approval,
      );
    }
    const { inputFingerprint: _inputFingerprint, reviewLanguage, ...request } = providerRequest;
    await loadExactBoundProviderRequest({
      bookDir: input.bookDir,
      transaction,
      candidateBody,
      role: reviewerRole,
      stage: reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW",
      reference: approval.providerEvidence,
      request,
      reviewLanguage,
    });
  }
  } catch (error) {
    throw asChapterArtifactEvidenceError("canonical truth terminal review authority failed", error);
  }
}

/** Fail-closed gate used by the canonical truth path before reading or writing attempt evidence. */
export async function assertCurrentChapterTransactionAttempt(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly chapterNumber: number;
  readonly predecessorCommitSha256: string;
}): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const canonicalTransaction = await loadActiveCanonicalTruthTransaction(input.bookDir);
  if (canonicalTransaction?.transactionId !== input.transactionId) throw new Error("CANONICAL_TRUTH_TRANSACTION_MODE_REQUIRED");
  const authority = await inspectChapterAuthority({ bookDir: input.bookDir });
  if (transaction.record.transactionId !== input.transactionId
    || transaction.record.chapterNumber !== input.chapterNumber
    || transaction.attemptNumber !== input.attemptNumber
    || input.attemptId !== `attempt-${transaction.attemptNumber}`
    || transaction.record.previousAuthoritySha256 !== input.predecessorCommitSha256
    || authority.activeTransactionId !== input.transactionId
    || authority.nextChapter !== input.chapterNumber
    || authority.latestAuthoritySha256 !== input.predecessorCommitSha256) {
    throw new Error("CANONICAL_TRUTH_CURRENT_ATTEMPT_AUTHORITY_MISMATCH");
  }
}

export async function stageChapterCommitCandidate(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly title: string;
  readonly language?: "zh" | "en";
  readonly body: string;
  readonly lengthSpec: LengthSpec;
  readonly review: ChapterCommitReviewAuthority;
  readonly stateFiles: Readonly<Record<string, string | Uint8Array>>;
  readonly snapshotFiles: Readonly<Record<string, string | Uint8Array>>;
  readonly usage: unknown;
  readonly stateValidation: ChapterStateValidationAuthority;
  readonly providerReferences: ReadonlyArray<ChapterProviderReference>;
  readonly completedAt: string;
}): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")) {
    throw new Error("V1 after V2 is forbidden");
  }
  const bodySha = sha256(input.body);
  const finalLengthCount = countChapterLength(input.body, input.lengthSpec.countingMode);
  if (!input.title.trim()) throw new Error("Chapter commit title is empty");
  if (!input.body.trim()) throw new Error("Chapter commit body is empty");
  if (isOutsideHardRange(finalLengthCount, input.lengthSpec)) throw new Error("Chapter commit candidate is outside hard range");
  validateReviewAuthority(input.review, bodySha);
  validateStateValidationAuthority(input.stateValidation, transaction.record.chapterNumber, bodySha, transaction.record.previousAuthoritySha256);
  const stateManifest = input.stateFiles["manifest.json"];
  const snapshotManifest = input.snapshotFiles["state/manifest.json"];
  if (typeof stateManifest !== "string" || typeof snapshotManifest !== "string") throw new Error("State and snapshot manifests are required");
  parseStateManifest(stateManifest, transaction.record.chapterNumber, bodySha, transaction.record.previousAuthoritySha256, "State");
  parseStateManifest(snapshotManifest, transaction.record.chapterNumber, bodySha, transaction.record.previousAuthoritySha256, "Snapshot");
  if (input.providerReferences.length === 0) throw new Error("Chapter commit requires Provider operation authority");
  for (const reference of input.providerReferences) await verifyProviderReference(input.bookDir, transaction.record, reference);
  for (const reviewer of input.review.reviewerEvidence) {
    const acceptedRoles = reviewer.reviewerRole === "logic-canon-auditor" ? ["logic-canon-auditor", "auditor"] : ["commercial-reader"];
    const expectedStage = reviewer.reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
    if (!input.providerReferences.some((reference) => acceptedRoles.includes(reference.role)
      && reference.stage === expectedStage
      && reference.provider === reviewer.provider && reference.requestedModel === reviewer.model)) {
      throw new Error(`Chapter commit ${reviewer.reviewerRole} Provider authority is missing`);
    }
  }

  const root = join(transaction.root, "staging", "bundle");
  const reviewText = `${JSON.stringify(input.review, null, 2)}\n`;
  const usageText = `${JSON.stringify(input.usage, null, 2)}\n`;
  const stateValidationText = `${JSON.stringify(input.stateValidation, null, 2)}\n`;
  const providerText = `${JSON.stringify(input.providerReferences, null, 2)}\n`;
  const inMemoryEntries = (files: Readonly<Record<string, string | Uint8Array>>) => Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
      return { relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
    });
  const expectedStateFiles = inMemoryEntries(input.stateFiles);
  const expectedSnapshotFiles = inMemoryEntries(input.snapshotFiles);
  if (await exists(root)) {
    let existing: LegacyChapterCommitV1 | null = null;
    try {
      const verified = await verifyBundle(root, transaction.record.chapterNumber, input.bookDir);
      if (verified.kind !== "CHAPTER_COMMIT") throw new Error("Immutable staged chapter commit version conflict");
      existing = verified;
    }
    catch (error) {
      let marker: unknown;
      try { marker = await readJson(join(root, "commit.json")); } catch { marker = null; }
      if (marker && typeof marker === "object" && (marker as { kind?: unknown }).kind === "CHAPTER_COMMIT") throw error;
      await publishOpenChapterTransaction(input, () => rm(root, { recursive: true, force: true }));
    }
    if (existing) {
    if (existing.transactionId === transaction.record.transactionId
      && existing.chapterTitle === input.title
      && existing.language === (input.language ?? "en")
      && existing.finalBodySha256 === bodySha
      && existing.finalLengthCount === finalLengthCount
      && canonical(existing.lengthSpec) === canonical(input.lengthSpec)
      && existing.boundedReviewStatus === input.review.status
      && existing.revisionCount === input.review.revisionCount
      && existing.reviewEvidenceSha256 === sha256(reviewText)
      && existing.stateTreeSha256 === treeSha(expectedStateFiles)
      && existing.snapshotTreeSha256 === treeSha(expectedSnapshotFiles)
      && existing.usageSha256 === sha256(usageText)
      && existing.stateValidationSha256 === sha256(stateValidationText)
      && existing.providerReferencesSha256 === sha256(providerText)) return;
    throw new Error("Immutable staged chapter commit conflict");
    }
  }
  await mkdir(dirname(root), { recursive: true });
  await publishOpenChapterTransaction(input, () => cleanupSiblingTemps(root));
  const tempRoot = `${root}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(tempRoot, { recursive: false });
  await writeFile(join(tempRoot, "chapter.md"), input.body, "utf-8");
  await Promise.all([
    writeFile(join(tempRoot, "review.json"), reviewText, "utf-8"),
    writeFile(join(tempRoot, "usage.json"), usageText, "utf-8"),
    writeFile(join(tempRoot, "state-validation.json"), stateValidationText, "utf-8"),
    writeFile(join(tempRoot, "provider-refs.json"), providerText, "utf-8"),
  ]);
  const stateFiles = await writeTree(join(tempRoot, "state"), input.stateFiles);
  const snapshotFiles = await writeTree(join(tempRoot, "snapshot"), input.snapshotFiles);
  const unsigned = {
    schemaVersion: 1 as const, kind: "CHAPTER_COMMIT" as const, bookId: transaction.record.bookId,
    chapterNumber: transaction.record.chapterNumber, chapterTitle: input.title, language: input.language ?? "en", transactionId: transaction.record.transactionId,
    productionAuthority: transaction.record.productionAuthority,
    previousAuthoritySha256: transaction.record.previousAuthoritySha256, finalBodySha256: bodySha, finalLengthCount,
    lengthSpec: input.lengthSpec, boundedReviewStatus: input.review.status, revisionCount: input.review.revisionCount,
    reviewEvidenceSha256: sha256(reviewText), finalCandidateSha256: bodySha,
    stateManifestSha256: sha256(stateManifest), snapshotManifestSha256: sha256(snapshotManifest), stateValidationSha256: sha256(stateValidationText),
    stateTreeSha256: treeSha(stateFiles), snapshotTreeSha256: treeSha(snapshotFiles), stateFiles, snapshotFiles,
    usageSha256: sha256(usageText), providerReferencesSha256: sha256(providerText), providerReferenceCount: input.providerReferences.length,
    createdAt: transaction.record.createdAt, completedAt: input.completedAt,
  };
  const commit: ChapterCommit = { ...unsigned, commitSha256: sha256(canonical(unsigned)) };
  await writeFile(join(tempRoot, "commit.json"), `${JSON.stringify(commit, null, 2)}\n`, "utf-8");
  try {
    await verifyBundle(tempRoot, transaction.record.chapterNumber, input.bookDir);
    await publishOpenChapterTransaction(input, () => rename(tempRoot, root));
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function canonicalTextV2(value: unknown): string {
  return `${canonicalJsonV2(value)}\n`;
}

function parseCanonicalRepairArtifact<T>(bytes: Buffer, label: string): T {
  let value: T;
  try { value = JSON.parse(bytes.toString("utf8")) as T; }
  catch (error) { throw new Error(`${label} is invalid JSON`, { cause: error }); }
  if (canonicalTextV2(value) !== bytes.toString("utf8")) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function assertCopiedProviderArtifact(reference: ChapterProviderReference, bytes: Buffer, label: string): string {
  if (sha256(bytes) !== reference.artifactSha256) throw new Error(`${label} Provider artifact hash mismatch`);
  let artifact: {
    readonly schema_version?: unknown;
    readonly transaction_id?: unknown;
    readonly logical_step_id?: unknown;
    readonly usage_identity?: unknown;
    readonly chapter_number?: unknown;
    readonly role?: unknown;
    readonly stage?: unknown;
    readonly provider?: unknown;
    readonly requested_model?: unknown;
    readonly input_fingerprint?: unknown;
    readonly response_artifact_status?: unknown;
    readonly content_sha256?: unknown;
    readonly response?: { readonly content?: unknown };
  };
  try { artifact = JSON.parse(bytes.toString("utf8")) as typeof artifact; }
  catch (error) { throw new Error(`${label} Provider artifact is invalid JSON`, { cause: error }); }
  if (artifact.schema_version !== "1.0" || artifact.transaction_id !== reference.transactionId
    || artifact.logical_step_id !== reference.logicalOperationId || artifact.usage_identity !== reference.logicalOperationId
    || artifact.chapter_number !== reference.chapterNumber || artifact.role !== reference.role || artifact.stage !== reference.stage
    || artifact.provider !== reference.provider || artifact.requested_model !== reference.requestedModel
    || artifact.input_fingerprint !== reference.inputFingerprint || artifact.response_artifact_status !== "COMPLETE"
    || artifact.content_sha256 !== reference.responseContentSha256 || typeof artifact.response?.content !== "string"
    || sha256(artifact.response.content) !== reference.responseContentSha256) {
    throw new Error(`${label} Provider artifact identity mismatch`);
  }
  return artifact.response.content;
}

function assertInitialRepairContext(
  current: CanonicalTruthExtractionContextRecord,
  initial: CanonicalTruthExtractionContextRecord,
): void {
  const { repairAuthorization: _authorization, repairDiagnostics: _diagnostics, ...requestBase } = current.request;
  const expectedInitialRequest = { ...requestBase, extractionKind: "INITIAL" as const, repairOrdinal: 0 as const };
  const { contextSha256, ...unsignedInitial } = initial;
  const expectedMessages = buildTruthExtractorMessages(expectedInitialRequest);
  const expectedFingerprint = sha256(JSON.stringify({
    provider: initial.execution.provider,
    model: initial.execution.model,
    messages: expectedMessages,
    temperature: initial.execution.temperature,
    maxTokens: initial.execution.maxTokens,
    stream: initial.execution.stream,
  }));
  if (current.extractionKind !== "REPAIR" || current.repairOrdinal !== 1
    || current.stage !== "TRUTH_EXTRACTION_REPAIR"
    || initial.schemaVersion !== "1.0" || initial.kind !== "CANONICAL_TRUTH_MODEL_CONTEXT"
    || initial.baseContextSha256 !== current.baseContextSha256 || initial.role !== "truth-extractor"
    || initial.stage !== "TRUTH_EXTRACTION" || initial.extractionKind !== "INITIAL" || initial.repairOrdinal !== 0
    || canonicalJsonV2(initial.request) !== canonicalJsonV2(expectedInitialRequest)
    || initial.requestSha256 !== canonicalSha256(expectedInitialRequest)
    || contextSha256 !== canonicalSha256(unsignedInitial)
    || canonicalJsonV2(initial.execution.messages) !== canonicalJsonV2(expectedMessages)
    || initial.execution.inputFingerprint !== expectedFingerprint) {
    throw new Error("Commit V2 INITIAL repair context authority mismatch");
  }
}

function assertRepairAuthorityGraph(input: {
  readonly truthContext: Record<string, unknown>;
  readonly currentContext: CanonicalTruthExtractionContextRecord;
  readonly authorization: TruthRepairAuthorizationV1;
  readonly initialContext: CanonicalTruthExtractionContextRecord;
  readonly initialExtraction: CanonicalTruthExtractionArtifact;
  readonly defectArtifact: unknown;
  readonly defectProviderReference: ChapterProviderReference;
  readonly defectProviderArtifactBytes: Buffer;
  readonly initialExtractorReference: ChapterProviderReference;
  readonly initialExtractorArtifactBytes: Buffer;
  readonly initialValidationContext?: CanonicalTruthValidationContextRecord;
  readonly initialValidation?: CanonicalTruthValidationArtifact;
  readonly initialDeltaAdmission?: ChapterDeltaAdmissionResultV1;
  readonly initialApplicationReceipt?: TruthApplicationReceiptV1;
  readonly initialResultingTruth?: StructuredTruthV1;
  readonly initialProjectionManifest?: ProjectionManifestV1;
}): void {
  assertInitialRepairContext(input.currentContext, input.initialContext);
  if (input.initialExtraction.contextSha256 !== input.initialContext.contextSha256
    || input.initialExtraction.logicalOperationId !== input.initialExtractorReference.logicalOperationId
    || input.initialExtraction.inputFingerprint !== input.initialExtractorReference.inputFingerprint
    || input.initialExtraction.providerArtifactSha256 !== input.initialExtractorReference.artifactSha256
    || input.initialExtraction.responseContentSha256 !== input.initialExtractorReference.responseContentSha256) {
    throw new Error("Commit V2 INITIAL Extractor evidence authority mismatch");
  }
  const extractorRaw = assertCopiedProviderArtifact(
    input.initialExtractorReference,
    input.initialExtractorArtifactBytes,
    "Commit V2 INITIAL Extractor",
  );
  if (input.initialExtraction.rawProposal !== extractorRaw
    || sha256(input.initialExtraction.rawProposal) !== input.initialExtraction.responseContentSha256) {
    throw new Error("Commit V2 INITIAL Extractor raw response mismatch");
  }
  const defectRaw = assertCopiedProviderArtifact(
    input.defectProviderReference,
    input.defectProviderArtifactBytes,
    "Commit V2 INITIAL defect",
  );
  let diagnostics: readonly string[];
  let expectedAuthorization: TruthRepairAuthorizationV1;
  if (input.authorization.source === "DELTA_ADMISSION") {
    const defect = input.defectArtifact as { readonly status?: unknown; readonly diagnostics?: unknown };
    if (canonicalJsonV2(defect) !== canonicalJsonV2({ status: "DELTA_EXTRACTION_DEFECT", diagnostics: defect.diagnostics })
      || defect.status !== "DELTA_EXTRACTION_DEFECT" || !Array.isArray(defect.diagnostics)
      || input.defectProviderReference.logicalOperationId !== input.initialExtraction.logicalOperationId
      || defectRaw !== input.initialExtraction.rawProposal) {
      throw new Error("Commit V2 INITIAL delta-admission defect authority mismatch");
    }
    diagnostics = defect.diagnostics as readonly string[];
    expectedAuthorization = {
      schemaVersion: "1.0", kind: "CANONICAL_TRUTH_REPAIR_AUTHORIZATION", source: "DELTA_ADMISSION",
      initialExtractionContextSha256: input.initialContext.contextSha256,
      initialExtractionArtifactSha256: canonicalSha256(input.initialExtraction),
      initialProviderResponseSha256: input.initialExtraction.responseContentSha256,
      initialDefectArtifactSha256: canonicalSha256(defect), diagnostics,
    };
  } else if (input.authorization.source === "SEMANTIC_VALIDATION") {
    const validationContext = input.initialValidationContext;
    const validation = input.initialValidation;
    const admission = input.initialDeltaAdmission;
    const application = input.initialApplicationReceipt;
    const resultingTruth = input.initialResultingTruth;
    const projectionManifest = input.initialProjectionManifest;
    if (!validationContext || !validation || validation.verdict !== "DELTA_EXTRACTION_DEFECT"
      || validation.contextSha256 !== validationContext.contextSha256
      || validation.logicalOperationId !== input.defectProviderReference.logicalOperationId
      || validation.inputFingerprint !== input.defectProviderReference.inputFingerprint
      || validation.providerArtifactSha256 !== input.defectProviderReference.artifactSha256
      || validation.responseContentSha256 !== input.defectProviderReference.responseContentSha256
      || validation.rawResponse !== defectRaw
      || canonicalJsonV2(parseTruthValidatorResponse(defectRaw))
        !== canonicalJsonV2({ verdict: validation.verdict, diagnostics: validation.diagnostics })) {
      throw new Error("Commit V2 INITIAL semantic-validation defect authority mismatch");
    }
    if (!admission || admission.status !== "ACCEPTED" || !application || !resultingTruth || !projectionManifest) {
      throw new Error("Commit V2 INITIAL semantic-validation complete authority graph is missing");
    }
    const predecessor = validateStructuredTruthV1(JSON.parse(input.initialContext.request.predecessorTruthJson));
    const acceptedDelta = validateAcceptedChapterDeltaV1(admission.acceptedDelta, predecessor);
    const readmitted = admitChapterDeltaV1({
      rawProposal: input.initialExtraction.rawProposal,
      candidate: input.initialContext.request.candidate,
      predecessor,
      host: {
        transactionId: input.initialContext.request.transactionId,
        attemptId: input.initialContext.request.attemptId,
        bookId: predecessor.bookId,
        chapterNumber: input.initialContext.request.chapterNumber,
        candidateSha256: input.initialContext.request.candidateSha256,
        predecessorCommitSha256: input.initialContext.request.predecessorCommitSha256,
        predecessorTruthSha256: input.initialContext.request.predecessorTruthSha256,
        predecessorVocabularyCatalogSha256: input.initialContext.request.vocabularyCatalogSha256,
        extractorLogicalOperationId: input.initialExtraction.logicalOperationId,
        extractorInputFingerprint: input.initialExtraction.inputFingerprint,
        providerArtifactSha256: input.initialExtraction.providerArtifactSha256,
        responseContentSha256: input.initialExtraction.responseContentSha256,
      },
    });
    const expectedTruth = reduceStructuredTruthV1({ predecessor, acceptedDelta });
    const expectedProjectionManifest = buildProjectionManifestV1({
      truthSha256: canonicalSha256(expectedTruth),
      projections: renderStructuredTruthProjectionsV1(expectedTruth),
    });
    const attemptNumber = input.truthContext.attemptNumber;
    if (!Number.isSafeInteger(attemptNumber) || (attemptNumber as number) < 1
      || canonicalJsonV2(resultingTruth) !== canonicalJsonV2(expectedTruth)
      || canonicalJsonV2(readmitted) !== canonicalJsonV2(admission)
      || canonicalJsonV2(projectionManifest) !== canonicalJsonV2(expectedProjectionManifest)
      || application.transactionId !== input.initialContext.request.transactionId
      || application.attemptId !== input.initialContext.request.attemptId
      || application.candidateSha256 !== input.initialContext.request.candidateSha256
      || application.predecessorCommitSha256 !== input.initialContext.request.predecessorCommitSha256
      || application.predecessorTruthSha256 !== canonicalSha256(predecessor)
      || application.acceptedDeltaSha256 !== canonicalSha256(acceptedDelta)
      || application.deltaId !== acceptedDelta.deltaId
      || application.admissionSha256 !== canonicalSha256(admission)
      || application.resultingTruthSha256 !== canonicalSha256(resultingTruth)
      || application.reducerId !== "inkos.structured-truth.reducer.v1"
      || application.reducerVersion !== "1.0"
      || canonicalJsonV2(application.operationOutcomes) !== canonicalJsonV2(
        acceptedDelta.delta.operations.map((operation) => ({ operationId: operation.operationId, status: "APPLIED" })),
      )) {
      throw new Error("Commit V2 INITIAL semantic-validation accepted-cycle graph mismatch");
    }
    assertCanonicalTruthContextSemantics({
      label: "Commit V2 INITIAL semantic repair",
      truthContext: input.truthContext,
      extractionContext: input.initialContext,
      validationContext,
      transactionId: input.initialContext.request.transactionId,
      attemptId: input.initialContext.request.attemptId,
      attemptNumber: attemptNumber as number,
      chapterNumber: input.initialContext.request.chapterNumber,
      candidateSha256: input.initialContext.request.candidateSha256,
      predecessorCommitSha256: input.initialContext.request.predecessorCommitSha256,
      predecessor,
      acceptedDelta,
      resultingTruth,
      applicationReceipt: application,
      projectionManifest,
    });
    const { contextSha256, ...unsignedValidationContext } = validationContext;
    if (validationContext.schemaVersion !== "1.0" || validationContext.kind !== "CANONICAL_TRUTH_MODEL_CONTEXT"
      || validationContext.baseContextSha256 !== input.currentContext.baseContextSha256
      || validationContext.role !== "truth-validator" || validationContext.stage !== "TRUTH_VALIDATION"
      || validationContext.extractionKind !== "INITIAL" || validationContext.repairOrdinal !== 0
      || validationContext.requestSha256 !== canonicalSha256(validationContext.request)
      || contextSha256 !== canonicalSha256(unsignedValidationContext)) {
      throw new Error("Commit V2 INITIAL Validator context authority mismatch");
    }
    diagnostics = validation.diagnostics;
    expectedAuthorization = {
      schemaVersion: "1.0", kind: "CANONICAL_TRUTH_REPAIR_AUTHORIZATION", source: "SEMANTIC_VALIDATION",
      initialExtractionContextSha256: input.initialContext.contextSha256,
      initialExtractionArtifactSha256: canonicalSha256(input.initialExtraction),
      initialProviderResponseSha256: validation.responseContentSha256,
      initialDefectArtifactSha256: canonicalSha256(validation),
      initialValidationContextSha256: validationContext.contextSha256,
      initialValidationArtifactSha256: canonicalSha256(validation), diagnostics,
    };
  } else {
    throw new Error("Commit V2 repair authorization source is invalid");
  }
  if (canonicalJsonV2(input.authorization) !== canonicalJsonV2(expectedAuthorization)
    || canonicalJsonV2(input.currentContext.request.repairAuthorization) !== canonicalJsonV2(input.authorization)
    || canonicalJsonV2(input.currentContext.request.repairDiagnostics) !== canonicalJsonV2(diagnostics)) {
    throw new Error("Commit V2 REPAIR request is not bound to the exact INITIAL defect authority");
  }
}

async function buildRepairAuthorityBundle(input: {
  readonly bookDir: string;
  readonly transaction: LocatedChapterTransaction;
  readonly candidateSha256: string;
  readonly currentContext: CanonicalTruthExtractionContextRecord;
  readonly truthContext: Record<string, unknown>;
  readonly providerReferences: ReadonlyArray<ChapterProviderReference>;
}): Promise<RepairAuthorityBundle | null> {
  if (input.currentContext.extractionKind === "INITIAL") return null;
  const evidenceRoot = join(input.transaction.root, "staging", "evidence", "truth", input.candidateSha256);
  const initialRoot = join(evidenceRoot, "initial");
  const authorizationBytes = await readFile(join(evidenceRoot, "repair-authorization.json"));
  const initialContextBytes = await readFile(join(initialRoot, "extraction-context.json"));
  const initialExtractionBytes = await readFile(join(initialRoot, "extraction.json"));
  const authorization = parseCanonicalRepairArtifact<TruthRepairAuthorizationV1>(authorizationBytes, "Commit V2 repair authorization");
  const initialContext = parseCanonicalRepairArtifact<CanonicalTruthExtractionContextRecord>(initialContextBytes, "Commit V2 INITIAL extraction context");
  const initialExtraction = parseCanonicalRepairArtifact<CanonicalTruthExtractionArtifact>(initialExtractionBytes, "Commit V2 INITIAL extraction");
  const extractorReference = input.providerReferences.find((reference) => reference.role === "truth-extractor"
    && reference.stage === "TRUTH_EXTRACTION" && reference.logicalOperationId === initialExtraction.logicalOperationId);
  if (!extractorReference) throw new Error("Commit V2 INITIAL Extractor Provider reference is missing");
  await verifyProviderReference(input.bookDir, input.transaction.record, extractorReference);
  const extractorArtifactBytes = await readFile(join(input.bookDir, extractorReference.artifactRelativePath));
  let defectPath: string;
  let defectProviderReference = extractorReference;
  let defectProviderArtifactBytes = extractorArtifactBytes;
  let initialValidationContext: CanonicalTruthValidationContextRecord | undefined;
  let initialValidation: CanonicalTruthValidationArtifact | undefined;
  let initialDeltaAdmission: ChapterDeltaAdmissionResultV1 | undefined;
  let initialApplicationReceipt: TruthApplicationReceiptV1 | undefined;
  let initialResultingTruth: StructuredTruthV1 | undefined;
  let initialProjectionManifest: ProjectionManifestV1 | undefined;
  const files: Array<{ relativePath: string; content: Buffer }> = [
    { relativePath: "repair-authorization.json", content: authorizationBytes },
    { relativePath: "initial/extraction-context.json", content: initialContextBytes },
    { relativePath: "initial/extraction.json", content: initialExtractionBytes },
  ];
  if (authorization.source === "DELTA_ADMISSION") {
    defectPath = "delta-admission-defect.json";
  } else {
    defectPath = "semantic-validation.json";
    const validationContextBytes = await readFile(join(initialRoot, "validation-context.json"));
    const validationBytes = await readFile(join(initialRoot, defectPath));
    initialValidationContext = parseCanonicalRepairArtifact<CanonicalTruthValidationContextRecord>(validationContextBytes, "Commit V2 INITIAL validation context");
    initialValidation = parseCanonicalRepairArtifact<CanonicalTruthValidationArtifact>(validationBytes, "Commit V2 INITIAL semantic validation");
    const [admissionBytes, applicationBytes, resultingTruthBytes, projectionManifestBytes] = await Promise.all([
      readFile(join(initialRoot, "delta-admission.json")),
      readFile(join(initialRoot, "truth-application.json")),
      readFile(join(initialRoot, "resulting-truth.json")),
      readFile(join(initialRoot, "projection-manifest.json")),
    ]);
    initialDeltaAdmission = parseCanonicalRepairArtifact<ChapterDeltaAdmissionResultV1>(admissionBytes, "Commit V2 INITIAL delta admission");
    initialApplicationReceipt = parseCanonicalRepairArtifact<TruthApplicationReceiptV1>(applicationBytes, "Commit V2 INITIAL truth application");
    initialResultingTruth = validateStructuredTruthV1(parseCanonicalRepairArtifact<unknown>(resultingTruthBytes, "Commit V2 INITIAL resulting truth"));
    initialProjectionManifest = parseCanonicalRepairArtifact<ProjectionManifestV1>(projectionManifestBytes, "Commit V2 INITIAL projection manifest");
    const validatorReference = input.providerReferences.find((reference) => reference.role === "truth-validator"
      && reference.stage === "TRUTH_VALIDATION" && reference.logicalOperationId === initialValidation!.logicalOperationId);
    if (!validatorReference) throw new Error("Commit V2 INITIAL Validator Provider reference is missing");
    await verifyProviderReference(input.bookDir, input.transaction.record, validatorReference);
    defectProviderReference = validatorReference;
    defectProviderArtifactBytes = await readFile(join(input.bookDir, validatorReference.artifactRelativePath));
    files.push(
      { relativePath: "initial/validation-context.json", content: validationContextBytes },
      { relativePath: "initial/extractor-provider-reference.json", content: Buffer.from(canonicalTextV2(extractorReference), "utf8") },
      { relativePath: "initial/extractor-provider-response.json", content: extractorArtifactBytes },
      { relativePath: "initial/delta-admission.json", content: admissionBytes },
      { relativePath: "initial/truth-application.json", content: applicationBytes },
      { relativePath: "initial/resulting-truth.json", content: resultingTruthBytes },
      { relativePath: "initial/projection-manifest.json", content: projectionManifestBytes },
    );
  }
  const defectBytes = await readFile(join(initialRoot, defectPath));
  const defectArtifact = parseCanonicalRepairArtifact<unknown>(defectBytes, "Commit V2 INITIAL defect artifact");
  files.push(
    { relativePath: `initial/${defectPath}`, content: defectBytes },
    { relativePath: "initial/provider-reference.json", content: Buffer.from(canonicalTextV2(defectProviderReference), "utf8") },
    { relativePath: "initial/provider-response.json", content: defectProviderArtifactBytes },
  );
  assertRepairAuthorityGraph({
    truthContext: input.truthContext, currentContext: input.currentContext, authorization, initialContext, initialExtraction, defectArtifact,
    defectProviderReference, defectProviderArtifactBytes, initialExtractorReference: extractorReference,
    initialExtractorArtifactBytes: extractorArtifactBytes, initialValidationContext, initialValidation,
    initialDeltaAdmission, initialApplicationReceipt, initialResultingTruth, initialProjectionManifest,
  });
  const sortedFiles = files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest: RepairAuthorityManifestV1 = {
    schemaVersion: "1.0", kind: "CANONICAL_TRUTH_REPAIR_AUTHORITY_MANIFEST", source: authorization.source,
    files: entriesFor(sortedFiles),
  };
  return { manifest, manifestBytes: Buffer.from(canonicalTextV2(manifest), "utf8"), files: sortedFiles };
}

async function verifyCommittedRepairAuthority(input: {
  readonly root: string;
  readonly commit: TruthChapterCommitV2;
  readonly currentContext: CanonicalTruthExtractionContextRecord;
  readonly truthContext: Record<string, unknown>;
}): Promise<void> {
  const repairRoot = join(input.root, "repair-authority");
  if (input.currentContext.extractionKind === "INITIAL") {
    if (input.commit.repairAuthorityManifestSha256 !== undefined || await exists(repairRoot)) {
      throw new Error("Commit V2 INITIAL extraction has unexpected repair authority");
    }
    return;
  }
  if (!input.commit.repairAuthorityManifestSha256) throw new Error("Commit V2 REPAIR authority manifest is missing");
  const manifestBytes = await readFile(join(repairRoot, "manifest.json"));
  if (sha256(manifestBytes) !== input.commit.repairAuthorityManifestSha256) throw new Error("Commit V2 REPAIR authority manifest hash mismatch");
  const manifest = parseCanonicalRepairArtifact<RepairAuthorityManifestV1>(manifestBytes, "Commit V2 REPAIR authority manifest");
  if (manifest.schemaVersion !== "1.0" || manifest.kind !== "CANONICAL_TRUTH_REPAIR_AUTHORITY_MANIFEST") {
    throw new Error("Commit V2 REPAIR authority manifest identity mismatch");
  }
  await verifySelectedFiles(input.root, manifest.files, "Commit V2 REPAIR authority");
  const actualFiles = (await listFiles(input.root)).filter((file) => file.relativePath === "repair-authorization.json" || file.relativePath.startsWith("initial/"));
  if (canonicalJsonV2(entriesFor(actualFiles)) !== canonicalJsonV2(manifest.files)) throw new Error("Commit V2 REPAIR authority tree mismatch");
  const read = (path: string) => readFile(join(input.root, path));
  const [authorizationBytes, initialContextBytes, initialExtractionBytes, defectReferenceBytes, defectProviderArtifactBytes] = await Promise.all([
    read("repair-authorization.json"), read("initial/extraction-context.json"), read("initial/extraction.json"),
    read("initial/provider-reference.json"), read("initial/provider-response.json"),
  ]);
  const authorization = parseCanonicalRepairArtifact<TruthRepairAuthorizationV1>(authorizationBytes, "Commit V2 committed repair authorization");
  if (authorization.source !== manifest.source) throw new Error("Commit V2 committed repair authorization source mismatch");
  const initialContext = parseCanonicalRepairArtifact<CanonicalTruthExtractionContextRecord>(initialContextBytes, "Commit V2 committed INITIAL extraction context");
  const initialExtraction = parseCanonicalRepairArtifact<CanonicalTruthExtractionArtifact>(initialExtractionBytes, "Commit V2 committed INITIAL extraction");
  const defectProviderReference = parseCanonicalRepairArtifact<ChapterProviderReference>(defectReferenceBytes, "Commit V2 committed INITIAL Provider reference");
  let initialExtractorReference = defectProviderReference;
  let initialExtractorArtifactBytes = defectProviderArtifactBytes;
  let initialValidationContext: CanonicalTruthValidationContextRecord | undefined;
  let initialValidation: CanonicalTruthValidationArtifact | undefined;
  let initialDeltaAdmission: ChapterDeltaAdmissionResultV1 | undefined;
  let initialApplicationReceipt: TruthApplicationReceiptV1 | undefined;
  let initialResultingTruth: StructuredTruthV1 | undefined;
  let initialProjectionManifest: ProjectionManifestV1 | undefined;
  let defectArtifact: unknown;
  if (authorization.source === "DELTA_ADMISSION") {
    defectArtifact = parseCanonicalRepairArtifact<unknown>(await read("initial/delta-admission-defect.json"), "Commit V2 committed INITIAL delta defect");
  } else {
    const [validationContextBytes, validationBytes, extractorReferenceBytes, extractorArtifactBytes,
      admissionBytes, applicationBytes, resultingTruthBytes, projectionManifestBytes] = await Promise.all([
      read("initial/validation-context.json"), read("initial/semantic-validation.json"),
      read("initial/extractor-provider-reference.json"), read("initial/extractor-provider-response.json"),
      read("initial/delta-admission.json"), read("initial/truth-application.json"),
      read("initial/resulting-truth.json"), read("initial/projection-manifest.json"),
    ]);
    initialValidationContext = parseCanonicalRepairArtifact<CanonicalTruthValidationContextRecord>(validationContextBytes, "Commit V2 committed INITIAL validation context");
    initialValidation = parseCanonicalRepairArtifact<CanonicalTruthValidationArtifact>(validationBytes, "Commit V2 committed INITIAL semantic validation");
    defectArtifact = initialValidation;
    initialExtractorReference = parseCanonicalRepairArtifact<ChapterProviderReference>(extractorReferenceBytes, "Commit V2 committed INITIAL Extractor reference");
    initialExtractorArtifactBytes = extractorArtifactBytes;
    initialDeltaAdmission = parseCanonicalRepairArtifact<ChapterDeltaAdmissionResultV1>(admissionBytes, "Commit V2 committed INITIAL delta admission");
    initialApplicationReceipt = parseCanonicalRepairArtifact<TruthApplicationReceiptV1>(applicationBytes, "Commit V2 committed INITIAL truth application");
    initialResultingTruth = validateStructuredTruthV1(parseCanonicalRepairArtifact<unknown>(resultingTruthBytes, "Commit V2 committed INITIAL resulting truth"));
    initialProjectionManifest = parseCanonicalRepairArtifact<ProjectionManifestV1>(projectionManifestBytes, "Commit V2 committed INITIAL projection manifest");
  }
  assertRepairAuthorityGraph({
    truthContext: input.truthContext, currentContext: input.currentContext, authorization, initialContext, initialExtraction, defectArtifact,
    defectProviderReference, defectProviderArtifactBytes, initialExtractorReference, initialExtractorArtifactBytes,
    initialValidationContext, initialValidation, initialDeltaAdmission, initialApplicationReceipt,
    initialResultingTruth, initialProjectionManifest,
  });
}

function commitProjectionPath(path: string): string {
  return path.startsWith("state/") ? path.slice("state/".length) : path;
}

function assertCanonicalTruthProviderEvidence(
  references: ReadonlyArray<ChapterProviderReference>,
  role: "truth-extractor" | "truth-validator",
  expected: TruthChapterCommitArtifactsV2["extractorEvidence"],
  extractorStage?: "TRUTH_EXTRACTION" | "TRUTH_EXTRACTION_REPAIR",
): ChapterProviderReference {
  const stage = role === "truth-extractor" ? extractorStage ?? "TRUTH_EXTRACTION" : "TRUTH_VALIDATION";
  const reference = references.find((candidate) => candidate.role === role && candidate.stage === stage
    && candidate.logicalOperationId === expected.logicalOperationId);
  if (!reference || reference.inputFingerprint !== expected.inputFingerprint
    || reference.artifactSha256 !== expected.providerArtifactSha256
    || reference.responseContentSha256 !== expected.responseContentSha256) {
    throw new Error(`Commit V2 ${role} Provider authority is missing or mismatched`);
  }
  return reference;
}

function assertCanonicalTruthContextSemantics(input: {
  readonly label: string;
  readonly truthContext: Record<string, unknown>;
  readonly extractionContext: CanonicalTruthExtractionContextRecord;
  readonly validationContext: CanonicalTruthValidationContextRecord;
  readonly transactionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly chapterNumber: number;
  readonly candidateSha256: string;
  readonly predecessorCommitSha256: string;
  readonly predecessor: StructuredTruthV1;
  readonly acceptedDelta: AcceptedChapterDeltaV1;
  readonly resultingTruth: StructuredTruthV1;
  readonly applicationReceipt: TruthApplicationReceiptV1;
  readonly projectionManifest: ProjectionManifestV1;
}): void {
  const { truthContext, extractionContext, validationContext } = input;
  const extractionRequest = extractionContext.request;
  const validationRequest = validationContext.request;
  const { contextSha256: truthContextSha256, ...unsignedTruthContext } = truthContext;
  const { contextSha256: extractionContextSha256, ...unsignedExtractionContext } = extractionContext;
  const { contextSha256: validationContextSha256, ...unsignedValidationContext } = validationContext;
  const expectedExtractionStage = extractionContext.extractionKind === "INITIAL"
    ? "TRUTH_EXTRACTION"
    : "TRUTH_EXTRACTION_REPAIR";
  const expectedRepairOrdinal = extractionContext.extractionKind === "INITIAL" ? 0 : 1;
  const assertExecution = (
    execution: CanonicalTruthExtractionContextRecord["execution"],
    expectedMessages: ReturnType<typeof buildTruthExtractorMessages>,
    expectedRole: string,
  ): boolean => {
    if (!execution || !isValidProviderIdentity(execution.provider) || !isValidProviderIdentity(execution.model)
      || typeof execution.temperature !== "number" || !Number.isFinite(execution.temperature)
      || typeof execution.maxTokens !== "number" || !Number.isSafeInteger(execution.maxTokens) || execution.maxTokens <= 0
      || typeof execution.stream !== "boolean"
      || typeof execution.webSearch !== "boolean"
      || !execution.extra || typeof execution.extra !== "object" || Array.isArray(execution.extra)
      || canonicalJsonV2(execution.messages) !== canonicalJsonV2(expectedMessages)) return false;
    try { canonicalJsonV2(execution.extra); }
    catch { return false; }
    const fingerprint = sha256(JSON.stringify({
      provider: execution.provider,
      model: execution.model,
      messages: expectedMessages,
      temperature: execution.temperature,
      maxTokens: execution.maxTokens,
      stream: execution.stream,
    }));
    const fullRequestSha256 = canonicalSha256({
      provider: execution.provider,
      model: execution.model,
      messages: expectedMessages,
      temperature: execution.temperature,
      maxTokens: execution.maxTokens,
      stream: execution.stream,
      webSearch: execution.webSearch,
      extra: execution.extra,
    });
    return execution.inputFingerprint === fingerprint
      && execution.fullRequestSha256 === fullRequestSha256
      && expectedRole.length > 0;
  };
  if (!assertExecution(extractionContext.execution, buildTruthExtractorMessages(extractionRequest), "truth-extractor")) {
    throw new Error(`${input.label} truth-extractor execution messages or fingerprint mismatch`);
  }
  if (!assertExecution(validationContext.execution, buildTruthValidatorMessages(validationRequest), "truth-validator")) {
    throw new Error(`${input.label} truth-validator execution messages or fingerprint mismatch`);
  }
  if (truthContext.schemaVersion !== "1.0" || truthContext.kind !== "CANONICAL_TRUTH_CONTEXT"
    || truthContextSha256 !== canonicalSha256(unsignedTruthContext)
    || truthContext.transactionId !== input.transactionId || truthContext.attemptId !== input.attemptId
    || truthContext.attemptNumber !== input.attemptNumber || truthContext.chapterNumber !== input.chapterNumber
    || truthContext.candidateSha256 !== input.candidateSha256
    || truthContext.predecessorCommitSha256 !== input.predecessorCommitSha256
    || truthContext.predecessorTruthSha256 !== canonicalSha256(input.predecessor)
    || truthContext.predecessorVocabularyCatalogSha256 !== canonicalSha256(input.predecessor.vocabulary)
    || truthContext.committedAuthoritySha256 !== sha256(extractionRequest.committedAuthority)
    || truthContext.chapterMemoSha256 !== sha256(extractionRequest.chapterMemo ?? "")
    || truthContext.extractorPromptVersion !== "inkos.truth-extractor.prompt.v1"
    || truthContext.extractorSchemaVersion !== "ChapterDeltaProposalV1/1.0"
    || truthContext.validatorPromptVersion !== "inkos.truth-validator.prompt.v1"
    || truthContext.validatorSchemaVersion !== "TruthValidationResult/1.0"
    || extractionContext.schemaVersion !== "1.0" || validationContext.schemaVersion !== "1.0"
    || extractionContext.kind !== "CANONICAL_TRUTH_MODEL_CONTEXT" || validationContext.kind !== "CANONICAL_TRUTH_MODEL_CONTEXT"
    || extractionContextSha256 !== canonicalSha256(unsignedExtractionContext)
    || validationContextSha256 !== canonicalSha256(unsignedValidationContext)
    || extractionContext.baseContextSha256 !== truthContextSha256 || validationContext.baseContextSha256 !== truthContextSha256
    || extractionContext.role !== "truth-extractor" || validationContext.role !== "truth-validator"
    || extractionContext.stage !== expectedExtractionStage || validationContext.stage !== "TRUTH_VALIDATION"
    || extractionContext.repairOrdinal !== expectedRepairOrdinal
    || validationContext.extractionKind !== extractionContext.extractionKind
    || validationContext.repairOrdinal !== expectedRepairOrdinal
    || extractionContext.requestSha256 !== canonicalSha256(extractionRequest)
    || validationContext.requestSha256 !== canonicalSha256(validationRequest)
    || extractionRequest.transactionId !== input.transactionId || extractionRequest.attemptId !== input.attemptId
    || extractionRequest.chapterNumber !== input.chapterNumber
    || extractionRequest.candidateSha256 !== input.candidateSha256 || sha256(extractionRequest.candidate) !== input.candidateSha256
    || extractionRequest.predecessorCommitSha256 !== input.predecessorCommitSha256
    || extractionRequest.predecessorTruthSha256 !== canonicalSha256(input.predecessor)
    || extractionRequest.predecessorTruthJson !== canonicalJsonV2(input.predecessor)
    || extractionRequest.vocabularyCatalogSha256 !== canonicalSha256(input.predecessor.vocabulary)
    || extractionRequest.vocabularyCatalogJson !== canonicalJsonV2(input.predecessor.vocabulary)
    || extractionRequest.extractionKind !== extractionContext.extractionKind
    || extractionRequest.repairOrdinal !== expectedRepairOrdinal
    || (expectedRepairOrdinal === 0 && extractionRequest.repairDiagnostics !== undefined)
    || (expectedRepairOrdinal === 1 && !Array.isArray(extractionRequest.repairDiagnostics))
    || validationRequest.candidateSha256 !== input.candidateSha256 || sha256(validationRequest.candidate) !== input.candidateSha256
    || validationRequest.predecessorTruthSha256 !== canonicalSha256(input.predecessor)
    || validationRequest.predecessorTruthJson !== canonicalJsonV2(input.predecessor)
    || validationRequest.acceptedDeltaSha256 !== canonicalSha256(input.acceptedDelta)
    || validationRequest.acceptedDeltaJson !== canonicalJsonV2(input.acceptedDelta)
    || validationRequest.resultingTruthSha256 !== canonicalSha256(input.resultingTruth)
    || validationRequest.resultingTruthJson !== canonicalJsonV2(input.resultingTruth)
    || validationRequest.committedAuthority !== extractionRequest.committedAuthority
    || validationRequest.applicationReceiptSha256 !== canonicalSha256(input.applicationReceipt)
    || validationRequest.projectionManifestSha256 !== canonicalSha256(input.projectionManifest)) {
    throw new Error(`${input.label} complete canonical truth context semantic mismatch`);
  }
}

async function assertCanonicalTruthModelContextEvidence(
  transaction: LocatedChapterTransaction,
  candidateSha256: string,
  truth: TruthChapterCommitArtifactsV2,
  truthContext: Record<string, unknown>,
): Promise<{
  readonly extractionContextBytes: Buffer;
  readonly validationContextBytes: Buffer;
  readonly extraction: CanonicalTruthExtractionArtifact;
  readonly validation: CanonicalTruthValidationArtifact;
}> {
  const root = join(transaction.root, "staging", "evidence", "truth", candidateSha256);
  const cycle = truth.extractionContext.extractionKind.toLowerCase();
  const extractionContextPath = join(root, cycle, "extraction-context.json");
  const validationContextPath = join(root, cycle, "validation-context.json");
  const [extractionContextBytes, validationContextBytes, extraction, validation] = await Promise.all([
    readFile(extractionContextPath), readFile(validationContextPath),
    readJson<CanonicalTruthExtractionArtifact>(join(root, cycle, "extraction.json")),
    readJson<CanonicalTruthValidationArtifact>(join(root, cycle, "semantic-validation.json")),
  ]).catch((error) => { throw new Error("Commit V2 canonical truth model context evidence is missing", { cause: error }); });
  const extractionContext = JSON.parse(extractionContextBytes.toString("utf8")) as CanonicalTruthExtractionContextRecord;
  const validationContext = JSON.parse(validationContextBytes.toString("utf8")) as CanonicalTruthValidationContextRecord;
  const { contextSha256: extractionContextSha, ...unsignedExtractionContext } = extractionContext;
  const { contextSha256: validationContextSha, ...unsignedValidationContext } = validationContext;
  const extractionRequest = extractionContext.request;
  const validationRequest = validationContext.request;
  assertCanonicalTruthContextSemantics({
    label: "Commit V2 staged",
    truthContext,
    extractionContext,
    validationContext,
    transactionId: transaction.record.transactionId,
    attemptId: `attempt-${transaction.attemptNumber}`,
    attemptNumber: transaction.attemptNumber,
    chapterNumber: transaction.record.chapterNumber,
    candidateSha256,
    predecessorCommitSha256: transaction.record.previousAuthoritySha256,
    predecessor: truth.predecessor,
    acceptedDelta: truth.acceptedDelta,
    resultingTruth: truth.resultingTruth,
    applicationReceipt: truth.applicationReceipt,
    projectionManifest: truth.projectionManifest,
  });
  if (canonicalJsonV2(extractionContext) !== canonicalJsonV2(truth.extractionContext)
    || canonicalJsonV2(validationContext) !== canonicalJsonV2(truth.validationContext)
    || extractionContextSha !== canonicalSha256(unsignedExtractionContext)
    || validationContextSha !== canonicalSha256(unsignedValidationContext)
    || extractionContext.requestSha256 !== canonicalSha256(extractionRequest)
    || validationContext.requestSha256 !== canonicalSha256(validationRequest)
    || extractionContext.baseContextSha256 !== truth.contextSha256 || validationContext.baseContextSha256 !== truth.contextSha256
    || extractionContext.role !== "truth-extractor" || validationContext.role !== "truth-validator"
    || validationContext.stage !== "TRUTH_VALIDATION"
    || extractionContext.extractionKind !== validationContext.extractionKind
    || extractionContext.repairOrdinal !== validationContext.repairOrdinal
    || extractionContext.stage !== (extractionContext.extractionKind === "INITIAL" ? "TRUTH_EXTRACTION" : "TRUTH_EXTRACTION_REPAIR")
    || extractionRequest.transactionId !== transaction.record.transactionId
    || extractionRequest.attemptId !== `attempt-${transaction.attemptNumber}`
    || extractionRequest.chapterNumber !== transaction.record.chapterNumber
    || extractionRequest.candidateSha256 !== candidateSha256
    || sha256(extractionRequest.candidate) !== candidateSha256
    || extractionRequest.predecessorCommitSha256 !== transaction.record.previousAuthoritySha256
    || extractionRequest.predecessorTruthSha256 !== canonicalSha256(truth.predecessor)
    || extractionRequest.predecessorTruthJson !== canonicalJsonV2(truth.predecessor)
    || extractionRequest.vocabularyCatalogSha256 !== canonicalSha256(truth.predecessor.vocabulary)
    || extractionRequest.vocabularyCatalogJson !== canonicalJsonV2(truth.predecessor.vocabulary)
    || extractionRequest.extractionKind !== extractionContext.extractionKind
    || extractionRequest.repairOrdinal !== extractionContext.repairOrdinal
    || validationRequest.candidateSha256 !== candidateSha256
    || sha256(validationRequest.candidate) !== candidateSha256
    || validationRequest.predecessorTruthSha256 !== canonicalSha256(truth.predecessor)
    || validationRequest.predecessorTruthJson !== canonicalJsonV2(truth.predecessor)
    || validationRequest.acceptedDeltaSha256 !== canonicalSha256(truth.acceptedDelta)
    || validationRequest.acceptedDeltaJson !== canonicalJsonV2(truth.acceptedDelta)
    || validationRequest.resultingTruthSha256 !== canonicalSha256(truth.resultingTruth)
    || validationRequest.resultingTruthJson !== canonicalJsonV2(truth.resultingTruth)
    || validationRequest.applicationReceiptSha256 !== canonicalSha256(truth.applicationReceipt)
    || validationRequest.projectionManifestSha256 !== canonicalSha256(truth.projectionManifest)
    || extraction.logicalOperationId !== truth.extractorEvidence.logicalOperationId
    || extraction.inputFingerprint !== truth.extractorEvidence.inputFingerprint
    || extraction.providerArtifactSha256 !== truth.extractorEvidence.providerArtifactSha256
    || extraction.responseContentSha256 !== truth.extractorEvidence.responseContentSha256
    || extraction.contextSha256 !== extractionContextSha
    || extraction.inputFingerprint !== extractionContext.execution.inputFingerprint
    || validation.logicalOperationId !== truth.validatorEvidence.logicalOperationId
    || validation.inputFingerprint !== truth.validatorEvidence.inputFingerprint
    || validation.providerArtifactSha256 !== truth.validatorEvidence.providerArtifactSha256
    || validation.responseContentSha256 !== truth.validatorEvidence.responseContentSha256
    || validation.contextSha256 !== validationContextSha
    || validation.inputFingerprint !== validationContext.execution.inputFingerprint) {
    throw new Error("Commit V2 canonical truth model context evidence is missing or ambiguous");
  }
  return { extractionContextBytes, validationContextBytes, extraction, validation };
}

export async function stageTruthChapterCommitV2(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly title: string;
  readonly language?: "zh" | "en";
  readonly body: string;
  readonly lengthSpec: LengthSpec;
  readonly review: ChapterCommitReviewAuthority;
  readonly usage: unknown;
  readonly providerReferences: ReadonlyArray<ChapterProviderReference>;
  readonly completedAt: string;
  readonly firstV2Baseline?: FirstV2BaselineContext;
  readonly truth: TruthChapterCommitArtifactsV2;
}): Promise<void> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  if ((await loadActiveCanonicalTruthTransaction(input.bookDir))?.transactionId !== input.transactionId) {
    throw new Error("CANONICAL_TRUTH_TRANSACTION_MODE_REQUIRED");
  }
  const attemptId = `attempt-${transaction.attemptNumber}`;
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.latestChapter + 1 !== transaction.record.chapterNumber
    || chain.latestAuthoritySha256 !== transaction.record.previousAuthoritySha256) {
    throw new Error("Commit V2 predecessor authority does not match the current chain");
  }
  const chainPredecessor = chain.commits.at(-1);
  let firstV2BaselineBytes: Buffer | undefined;
  if (chainPredecessor?.kind === "TRUTH_CHAPTER_COMMIT") {
    const committedTruth = validateStructuredTruthV1(JSON.parse(await readFile(
      join(commitRoot(input.bookDir, chainPredecessor.chapterNumber), "state", "truth.json"),
      "utf8",
    )));
    if (canonicalJsonV2(committedTruth) !== canonicalJsonV2(input.truth.predecessor)
      || canonicalSha256(committedTruth) !== chainPredecessor.truthSha256) {
      throw new Error("Commit V2 predecessor truth does not equal the previous committed V2 truth");
    }
  } else {
    if (input.firstV2Baseline && canonicalSha256(input.firstV2Baseline) !== transaction.record.firstV2BaselineSha256) {
      throw new Error("FIRST_V2_BASELINE_TRANSACTION_BINDING_MISMATCH");
    }
    const authority = await loadCommittedV2PredecessorAuthorityFromVerifiedChain({
      bookDir: input.bookDir, chapterNumber: transaction.record.chapterNumber, firstV2Baseline: input.firstV2Baseline,
    }, chain);
    if (canonicalJsonV2(authority.truth) !== canonicalJsonV2(input.truth.predecessor)) {
      throw new Error("Commit V2 requires the exact verified first-V2 baseline predecessor authority");
    }
    firstV2BaselineBytes = await readFile(join(transaction.root, "first-v2-baseline.json"));
    if (canonicalSha256(JSON.parse(firstV2BaselineBytes.toString("utf8"))) !== transaction.record.firstV2BaselineSha256) {
      throw new Error("FIRST_V2_BASELINE_TRANSACTION_BINDING_MISMATCH");
    }
  }
  const bodySha = sha256(input.body);
  const finalLengthCount = countChapterLength(input.body, input.lengthSpec.countingMode);
  if (!input.title.trim() || !input.body.trim()) throw new Error("Commit V2 chapter title/body is empty");
  if (isOutsideHardRange(finalLengthCount, input.lengthSpec)) throw new Error("Commit V2 candidate is outside hard range");
  try {
    validateReviewAuthority(input.review, bodySha);
    if (input.review.finalCandidateSha256 !== bodySha) throw new Error("Commit V2 final review candidate mismatch");
  } catch (error) {
    throw asChapterArtifactEvidenceError("Commit V2 terminal stable-review validation failed", error);
  }
  assertUniqueProviderReferences(input.providerReferences);
  assertTerminalProviderReferencePrechecks(input.review, input.providerReferences);
  if (input.truth.acceptedDelta.delta.transactionId !== transaction.record.transactionId
    || input.truth.acceptedDelta.delta.attemptId !== attemptId) {
    throw new Error("Commit V2 accepted delta transaction attempt identity mismatch");
  }

  const predecessor = validateStructuredTruthV1(structuredClone(input.truth.predecessor));
  const truthContextBytes = await readFile(join(
    transaction.root, "staging", "evidence", "truth", bodySha, "context.json",
  )).catch((error) => { throw new Error("Commit V2 durable truth context is missing", { cause: error }); });
  let truthContext: Record<string, unknown>;
  try { truthContext = JSON.parse(truthContextBytes.toString("utf8")) as Record<string, unknown>; }
  catch (error) { throw new Error("Commit V2 durable truth context is invalid JSON", { cause: error }); }
  const { contextSha256: persistedContextSha256, ...unsignedTruthContext } = truthContext;
  if (persistedContextSha256 !== input.truth.contextSha256
    || canonicalSha256(unsignedTruthContext) !== input.truth.contextSha256
    || truthContext.transactionId !== transaction.record.transactionId || truthContext.attemptId !== attemptId
    || truthContext.attemptNumber !== transaction.attemptNumber || truthContext.chapterNumber !== transaction.record.chapterNumber
    || truthContext.candidateSha256 !== bodySha || truthContext.predecessorCommitSha256 !== transaction.record.previousAuthoritySha256) {
    throw new Error("Commit V2 durable truth context identity mismatch");
  }
  if (predecessor.bookId !== transaction.record.bookId || predecessor.throughChapter + 1 !== transaction.record.chapterNumber
    || input.truth.acceptedDelta.delta.transactionId !== transaction.record.transactionId
    || input.truth.acceptedDelta.delta.attemptId !== attemptId
    || transaction.record.previousAuthoritySha256 !== input.truth.acceptedDelta.delta.predecessorCommitSha256
    || canonicalSha256(predecessor) !== input.truth.acceptedDelta.delta.predecessorTruthSha256
    || canonicalSha256(predecessor.vocabulary) !== input.truth.acceptedDelta.delta.predecessorVocabularyCatalogSha256
    || bodySha !== input.truth.acceptedDelta.delta.candidateSha256) {
    throw new Error("Commit V2 predecessor or candidate authority mismatch");
  }
  const acceptedDelta = validateAcceptedChapterDeltaV1(structuredClone(input.truth.acceptedDelta), predecessor);
  const { extractionContextBytes, validationContextBytes, extraction } = await assertCanonicalTruthModelContextEvidence(
    transaction,
    bodySha,
    input.truth,
    truthContext,
  );
  if (acceptedDelta.delta.extractorLogicalOperationId !== input.truth.extractorEvidence.logicalOperationId
    || acceptedDelta.delta.extractorInputFingerprint !== input.truth.extractorEvidence.inputFingerprint
    || acceptedDelta.delta.providerArtifactSha256 !== input.truth.extractorEvidence.providerArtifactSha256
    || acceptedDelta.delta.responseContentSha256 !== input.truth.extractorEvidence.responseContentSha256) {
    throw new Error("Commit V2 accepted delta extractor evidence mismatch");
  }
  for (const reference of input.providerReferences) await verifyProviderReference(input.bookDir, transaction.record, reference);
  let providerUsageByRole: Map<string, ProviderUsageAuthority>;
  try {
    providerUsageByRole = await assertProviderUsageAuthority(
      input.bookDir,
      transaction.record,
      input.providerReferences,
      input.usage,
    );
  } catch (error) {
    if (await exists(join(transaction.root, "staging", "bundle"))) {
      throw new Error("Immutable staged Commit V2 conflict", { cause: error });
    }
    throw error;
  }
  if (canonicalJsonV2(providerUsageByRole.get("truth-extractor")) !== canonicalJsonV2(input.truth.usageByRole["truth-extractor"])) {
    throw new Error("Commit V2 truth-extractor Provider response usage binding mismatch");
  }
  const extractorReference = assertCanonicalTruthProviderEvidence(
    input.providerReferences,
    "truth-extractor",
    input.truth.extractorEvidence,
    input.truth.extractionContext.stage,
  );
  if (canonicalJsonV2(await providerUsageForReference(input.bookDir, transaction.record, extractorReference))
    !== canonicalJsonV2(extraction.usage)) {
    throw new Error("Commit V2 accepted truth-extractor Provider response usage binding mismatch");
  }
  const exactExtractorRawResponse = await verifyProviderReference(input.bookDir, transaction.record, extractorReference);
  if (extraction.rawProposal !== exactExtractorRawResponse
    || sha256(extraction.rawProposal) !== extractorReference.responseContentSha256
    || extraction.responseContentSha256 !== extractorReference.responseContentSha256) {
    throw new Error("Commit V2 Extractor raw proposal does not equal the exact Provider response");
  }
  const readmitted = admitChapterDeltaV1({
    rawProposal: exactExtractorRawResponse,
    candidate: input.body,
    predecessor,
    host: {
      transactionId: transaction.record.transactionId,
      attemptId,
      bookId: transaction.record.bookId,
      chapterNumber: transaction.record.chapterNumber,
      candidateSha256: bodySha,
      predecessorCommitSha256: transaction.record.previousAuthoritySha256,
      predecessorTruthSha256: canonicalSha256(predecessor),
      predecessorVocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
      extractorLogicalOperationId: extractorReference.logicalOperationId,
      extractorInputFingerprint: extractorReference.inputFingerprint,
      providerArtifactSha256: extractorReference.artifactSha256,
      responseContentSha256: extractorReference.responseContentSha256,
    },
  });
  if (canonicalJsonV2(readmitted) !== canonicalJsonV2(input.truth.deltaAdmission)) {
    throw new Error("Commit V2 exact Extractor Provider response admission mismatch");
  }
  if (input.truth.deltaAdmission.status !== "ACCEPTED"
    || canonicalJsonV2(input.truth.deltaAdmission.acceptedDelta) !== canonicalJsonV2(acceptedDelta)) {
    throw new Error("Commit V2 requires READY accepted delta and host admission PASS");
  }
  const resultingTruth = reduceStructuredTruthV1({ predecessor, acceptedDelta });
  if (canonicalJsonV2(resultingTruth) !== canonicalJsonV2(input.truth.resultingTruth)) {
    throw new Error("Commit V2 deterministic application mismatch");
  }
  const truthSha256 = canonicalSha256(resultingTruth);
  if (input.truth.applicationReceipt.transactionId !== transaction.record.transactionId
    || input.truth.applicationReceipt.attemptId !== attemptId) {
    throw new Error("Commit V2 transaction attempt identity mismatch");
  }
  if (input.truth.applicationReceipt.transactionId !== transaction.record.transactionId
    || input.truth.applicationReceipt.attemptId !== attemptId
    || input.truth.applicationReceipt.candidateSha256 !== bodySha
    || input.truth.applicationReceipt.predecessorCommitSha256 !== transaction.record.previousAuthoritySha256
    || input.truth.applicationReceipt.predecessorTruthSha256 !== canonicalSha256(predecessor)
    || input.truth.applicationReceipt.acceptedDeltaSha256 !== canonicalSha256(acceptedDelta)
    || input.truth.applicationReceipt.deltaId !== acceptedDelta.deltaId
    || input.truth.applicationReceipt.admissionSha256 !== canonicalSha256(input.truth.deltaAdmission)
    || input.truth.applicationReceipt.resultingTruthSha256 !== truthSha256
    || input.truth.applicationReceipt.reducerId !== "inkos.structured-truth.reducer.v1"
    || input.truth.applicationReceipt.reducerVersion !== "1.0"
    || canonicalJsonV2(input.truth.applicationReceipt.operationOutcomes) !== canonicalJsonV2(
      acceptedDelta.delta.operations.map((operation) => ({ operationId: operation.operationId, status: "APPLIED" })),
    )) {
    throw new Error("Commit V2 deterministic application receipt mismatch");
  }
  if (input.truth.semanticValidation.verdict !== "PASS" || input.truth.semanticValidation.diagnostics.length !== 0) {
    throw new Error("Commit V2 requires semantic validation PASS");
  }
  if (sha256(input.truth.semanticValidation.rawResponse) !== input.truth.semanticValidation.responseContentSha256
    || canonicalJsonV2(parseTruthValidatorResponse(input.truth.semanticValidation.rawResponse))
      !== canonicalJsonV2({ verdict: input.truth.semanticValidation.verdict, diagnostics: input.truth.semanticValidation.diagnostics })) {
    throw new Error("Commit V2 semantic Validator raw response PASS binding mismatch");
  }
  if (input.truth.semanticValidation.logicalOperationId !== input.truth.validatorEvidence.logicalOperationId
    || input.truth.semanticValidation.inputFingerprint !== input.truth.validatorEvidence.inputFingerprint
    || input.truth.semanticValidation.providerArtifactSha256 !== input.truth.validatorEvidence.providerArtifactSha256
    || input.truth.semanticValidation.responseContentSha256 !== input.truth.validatorEvidence.responseContentSha256) {
    throw new Error("Commit V2 semantic Validator evidence binding mismatch");
  }
  const projections = renderStructuredTruthProjectionsV1(resultingTruth);
  const projectionManifest = buildProjectionManifestV1({ truthSha256, projections });
  if (canonicalJsonV2(projectionManifest) !== canonicalJsonV2(input.truth.projectionManifest)
    || projections.length !== input.truth.projections.length
    || projections.some((projection, index) => projection.path !== input.truth.projections[index]?.path
      || projection.rendererId !== input.truth.projections[index]?.rendererId
      || !Buffer.from(projection.bytes).equals(Buffer.from(input.truth.projections[index]!.bytes)))) {
    throw new Error("Commit V2 deterministic projection verification mismatch");
  }
  assertCanonicalTruthProviderEvidence(
    input.providerReferences,
    "truth-extractor",
    input.truth.extractorEvidence,
    input.truth.extractionContext.stage,
  );
  assertCanonicalTruthProviderEvidence(input.providerReferences, "truth-validator", input.truth.validatorEvidence);
  const validatorReference = input.providerReferences.find((reference) => reference.role === "truth-validator"
    && reference.stage === "TRUTH_VALIDATION"
    && reference.logicalOperationId === input.truth.semanticValidation.logicalOperationId);
  if (!validatorReference || await verifyProviderReference(input.bookDir, transaction.record, validatorReference) !== input.truth.semanticValidation.rawResponse) {
    throw new Error("Commit V2 Validator provider response does not match semantic PASS artifact");
  }
  if (canonicalJsonV2(providerUsageByRole.get("truth-validator")) !== canonicalJsonV2(input.truth.usageByRole["truth-validator"])
    || canonicalJsonV2(await providerUsageForReference(input.bookDir, transaction.record, validatorReference))
      !== canonicalJsonV2(input.truth.semanticValidation.usage)) {
    throw new Error("Commit V2 truth-validator Provider response usage binding mismatch");
  }
  const logicReviewer = input.review.reviewerEvidence.find((reviewer) => reviewer.reviewerRole === "logic-canon-auditor");
  const commercialReviewer = input.review.reviewerEvidence.find((reviewer) => reviewer.reviewerRole === "commercial-reader");
  if (!logicReviewer || !commercialReviewer) throw new Error("Commit V2 requires both terminal reviewer authorities");
  const [logicReviewRecord, commercialReviewRecord] = await Promise.all([
    loadBoundReviewEvidenceRecord(input.bookDir, transaction, logicReviewer, input.body),
    loadBoundReviewEvidenceRecord(input.bookDir, transaction, commercialReviewer, input.body),
  ]);
  const requestFromReviewRecord = (record: BoundReviewEvidenceRecord): ChapterProviderRequestAuthority["request"] => {
    if (!record.providerRequest) throw new ChapterArtifactEvidenceError(
      "ARTIFACT_EVIDENCE_DEFECT: terminal review frozen Provider request is missing",
      record,
    );
    const { inputFingerprint: _inputFingerprint, reviewLanguage: _reviewLanguage, ...request } = record.providerRequest;
    return normalizedProviderRequest(request);
  };
  const [logicReviewRequest, commercialReviewRequest] = await Promise.all([
    loadExactBoundProviderRequest({
      bookDir: input.bookDir, transaction, candidateBody: input.body,
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
      reference: logicReviewRecord.record.providerEvidence,
      request: requestFromReviewRecord(logicReviewRecord.record),
      reviewLanguage: logicReviewRecord.record.providerRequest?.reviewLanguage,
    }),
    loadExactBoundProviderRequest({
      bookDir: input.bookDir, transaction, candidateBody: input.body,
      role: "commercial-reader", stage: "READER_REVIEW",
      reference: commercialReviewRecord.record.providerEvidence,
      request: requestFromReviewRecord(commercialReviewRecord.record),
      reviewLanguage: commercialReviewRecord.record.providerRequest?.reviewLanguage,
    }),
  ]);
  const [truthExtractorRequest, truthValidatorRequest] = await Promise.all([
    loadExactBoundProviderRequest({
      bookDir: input.bookDir, transaction, candidateBody: input.body,
      role: "truth-extractor", stage: input.truth.extractionContext.stage,
      reference: extractorReference,
      request: providerRequestFromTruthExecution(input.truth.extractionContext.execution),
      requestOrdinal: input.truth.extractionContext.repairOrdinal,
    }),
    loadExactBoundProviderRequest({
      bookDir: input.bookDir, transaction, candidateBody: input.body,
      role: "truth-validator", stage: "TRUTH_VALIDATION",
      reference: validatorReference,
      request: providerRequestFromTruthExecution(input.truth.validationContext.execution),
      requestOrdinal: input.truth.validationContext.repairOrdinal,
    }),
  ]);
  const repairAuthority = await buildRepairAuthorityBundle({
    bookDir: input.bookDir,
    transaction,
    candidateSha256: bodySha,
    currentContext: input.truth.extractionContext,
    truthContext,
    providerReferences: input.providerReferences,
  });

  const root = join(transaction.root, "staging", "bundle");
  const retainedCommit = await exists(root) ? await verifyBundle(root, transaction.record.chapterNumber, input.bookDir) : undefined;
  const reviewText = `${JSON.stringify(input.review, null, 2)}\n`;
  const usageText = `${JSON.stringify(input.usage, null, 2)}\n`;
  const providerText = `${JSON.stringify(input.providerReferences, null, 2)}\n`;
  const acceptedDeltaText = canonicalTextV2(acceptedDelta);
  const admissionText = canonicalTextV2(input.truth.deltaAdmission);
  const applicationText = canonicalTextV2(input.truth.applicationReceipt);
  const semanticValidationText = canonicalTextV2(input.truth.semanticValidation);
  const extractorEvidenceText = canonicalTextV2(input.truth.extractorEvidence);
  const validatorEvidenceText = canonicalTextV2(input.truth.validatorEvidence);
  const truthUsageText = canonicalTextV2(input.truth.usageByRole);
  const manifestText = canonicalTextV2(projectionManifest);
  const stateFilesInput: Record<string, string | Uint8Array> = {
    "truth.json": canonicalTextV2(resultingTruth),
    "projection-manifest.json": manifestText,
  };
  for (const projection of projections) stateFilesInput[commitProjectionPath(projection.path)] = projection.bytes;
  const expectedStateFiles = entriesFor(Object.entries(stateFilesInput)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({
    relativePath, content: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    })));
  const payload: Record<string, string | Uint8Array> = {
    "chapter.md": input.body, "review.json": reviewText,
    "logic-review-evidence.json": logicReviewRecord.bytes, "commercial-review-evidence.json": commercialReviewRecord.bytes,
    "logic-review-request-reservation.json": logicReviewRequest.reservationBytes, "logic-review-request-binding.json": logicReviewRequest.bindingBytes,
    "commercial-review-request-reservation.json": commercialReviewRequest.reservationBytes, "commercial-review-request-binding.json": commercialReviewRequest.bindingBytes,
    "truth-extractor-request-reservation.json": truthExtractorRequest.reservationBytes, "truth-extractor-request-binding.json": truthExtractorRequest.bindingBytes,
    "truth-validator-request-reservation.json": truthValidatorRequest.reservationBytes, "truth-validator-request-binding.json": truthValidatorRequest.bindingBytes,
    "usage.json": usageText, "provider-refs.json": providerText,
    "accepted-delta.json": acceptedDeltaText, "delta-admission.json": admissionText,
    "truth-application.json": applicationText, "semantic-validation.json": semanticValidationText,
    "extractor-evidence.json": extractorEvidenceText, "validator-evidence.json": validatorEvidenceText,
    "truth-usage.json": truthUsageText, "truth-context.json": truthContextBytes,
    "extraction-context.json": extractionContextBytes, "validation-context.json": validationContextBytes,
    "projection-manifest.json": manifestText,
  };
  if (firstV2BaselineBytes) payload["first-v2-baseline.json"] = firstV2BaselineBytes;
  for (const [path, content] of Object.entries(stateFilesInput)) {
    payload[`state/${path}`] = content;
    payload[`snapshot/${path}`] = content;
  }
  if (repairAuthority) {
    for (const file of repairAuthority.files) payload[file.relativePath] = file.content;
    payload["repair-authority/manifest.json"] = repairAuthority.manifestBytes;
  }
  const bundlePayloadFiles = entriesFor(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({ relativePath, content: typeof content === "string" ? Buffer.from(content, "utf8") : content })));
  const expectedUnsigned = {
    bundlePayloadFiles, bundlePayloadTreeSha256: treeSha(bundlePayloadFiles),
    schemaVersion: 2 as const, kind: "TRUTH_CHAPTER_COMMIT" as const, bookId: transaction.record.bookId,
    chapterNumber: transaction.record.chapterNumber, chapterTitle: input.title, language: input.language ?? "en",
    transactionId: transaction.record.transactionId, attemptId, attemptNumber: transaction.attemptNumber,
    productionAuthority: transaction.record.productionAuthority,
    previousAuthoritySha256: transaction.record.previousAuthoritySha256,
    predecessorCommitSha256: transaction.record.previousAuthoritySha256,
    predecessorTruthSha256: canonicalSha256(predecessor), predecessorVocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
    finalBodySha256: bodySha, finalLengthCount, lengthSpec: input.lengthSpec,
    boundedReviewStatus: input.review.status, revisionCount: input.review.revisionCount,
    reviewEvidenceSha256: sha256(reviewText),
    logicReviewRecordSha256: sha256(logicReviewRecord.bytes),
    commercialReviewRecordSha256: sha256(commercialReviewRecord.bytes),
    logicReviewRequestReservationSha256: sha256(logicReviewRequest.reservationBytes),
    logicReviewRequestBindingSha256: sha256(logicReviewRequest.bindingBytes),
    commercialReviewRequestReservationSha256: sha256(commercialReviewRequest.reservationBytes),
    commercialReviewRequestBindingSha256: sha256(commercialReviewRequest.bindingBytes),
    truthExtractorRequestReservationSha256: sha256(truthExtractorRequest.reservationBytes),
    truthExtractorRequestBindingSha256: sha256(truthExtractorRequest.bindingBytes),
    truthValidatorRequestReservationSha256: sha256(truthValidatorRequest.reservationBytes),
    truthValidatorRequestBindingSha256: sha256(truthValidatorRequest.bindingBytes),
    finalCandidateSha256: bodySha,
    deltaId: acceptedDelta.deltaId, acceptedDeltaArtifactSha256: sha256(acceptedDeltaText),
    deltaAdmissionSha256: sha256(admissionText), truthApplicationSha256: sha256(applicationText),
    semanticValidationSha256: sha256(semanticValidationText), stateValidationSha256: sha256(semanticValidationText), truthSha256,
    projectionManifestSha256: sha256(manifestText), projectionTreeSha256: projectionManifest.treeSha256,
    extractorEvidenceSha256: sha256(extractorEvidenceText), validatorEvidenceSha256: sha256(validatorEvidenceText),
    truthUsageSha256: sha256(truthUsageText), truthContextSha256: sha256(truthContextBytes),
    truthContextIdentitySha256: input.truth.contextSha256,
    extractionContextSha256: sha256(extractionContextBytes), validationContextSha256: sha256(validationContextBytes),
    ...(repairAuthority ? { repairAuthorityManifestSha256: sha256(repairAuthority.manifestBytes) } : {}),
    stateTreeSha256: treeSha(expectedStateFiles), stateFiles: expectedStateFiles,
    snapshotTreeSha256: treeSha(expectedStateFiles), snapshotFiles: expectedStateFiles,
    usageSha256: sha256(usageText), providerReferencesSha256: sha256(providerText), providerReferenceCount: input.providerReferences.length,
    createdAt: transaction.record.createdAt, completedAt: retainedCommit?.completedAt ?? input.completedAt,
  };
  const expectedCommit: TruthChapterCommitV2 = { ...expectedUnsigned, commitSha256: canonicalSha256(expectedUnsigned) };
  if (await exists(root)) {
    const existing = await verifyBundle(root, transaction.record.chapterNumber, input.bookDir).catch((error) => {
      throw new Error("Immutable staged Commit V2 is invalid", { cause: error });
    });
    if (existing?.kind === "TRUTH_CHAPTER_COMMIT"
      && canonicalJsonV2(existing) === canonicalJsonV2(expectedCommit)) return;
    throw new Error("Immutable staged Commit V2 conflict");
  }
  const usage = input.usage as {
    readonly totalUsage?: { readonly promptTokens?: unknown; readonly completionTokens?: unknown; readonly totalTokens?: unknown };
    readonly roleUsage?: Readonly<Record<string, { readonly promptTokens?: unknown; readonly completionTokens?: unknown; readonly totalTokens?: unknown }>>;
  };
  if (!usage || typeof usage !== "object" || !usage.roleUsage || !usage.totalUsage) {
    throw new Error("Commit V2 usage authority is missing final role totals");
  }
  for (const [role, expected] of Object.entries(input.truth.usageByRole)) {
    const actual = usage.roleUsage[role];
    if (!actual || ![actual.promptTokens, actual.completionTokens, actual.totalTokens].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || actual.promptTokens !== expected.promptTokens
      || actual.completionTokens !== expected.completionTokens || actual.totalTokens !== expected.totalTokens) {
      throw new Error(`Commit V2 ${role} usage authority mismatch`);
    }
  }
  const summed = Object.values(usage.roleUsage).reduce<{ promptTokens: number; completionTokens: number; totalTokens: number }>((total, role) => ({
    promptTokens: total.promptTokens + Number(role.promptTokens),
    completionTokens: total.completionTokens + Number(role.completionTokens),
    totalTokens: total.totalTokens + Number(role.totalTokens),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  if (usage.totalUsage.promptTokens !== summed.promptTokens || usage.totalUsage.completionTokens !== summed.completionTokens
    || usage.totalUsage.totalTokens !== summed.totalTokens) {
    throw new Error("Commit V2 total usage authority does not equal final role totals");
  }
  await safeMutationPath(dirname(root), basename(root));
  await mkdir(dirname(root), { recursive: true });
  const tempRoot = `${root}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(tempRoot, { recursive: false });
  await Promise.all([
    writeFile(join(tempRoot, "chapter.md"), input.body, "utf8"),
    writeFile(join(tempRoot, "review.json"), reviewText, "utf8"),
    writeFile(join(tempRoot, "logic-review-evidence.json"), logicReviewRecord.bytes),
    writeFile(join(tempRoot, "commercial-review-evidence.json"), commercialReviewRecord.bytes),
    writeFile(join(tempRoot, "logic-review-request-reservation.json"), logicReviewRequest.reservationBytes),
    writeFile(join(tempRoot, "logic-review-request-binding.json"), logicReviewRequest.bindingBytes),
    writeFile(join(tempRoot, "commercial-review-request-reservation.json"), commercialReviewRequest.reservationBytes),
    writeFile(join(tempRoot, "commercial-review-request-binding.json"), commercialReviewRequest.bindingBytes),
    writeFile(join(tempRoot, "truth-extractor-request-reservation.json"), truthExtractorRequest.reservationBytes),
    writeFile(join(tempRoot, "truth-extractor-request-binding.json"), truthExtractorRequest.bindingBytes),
    writeFile(join(tempRoot, "truth-validator-request-reservation.json"), truthValidatorRequest.reservationBytes),
    writeFile(join(tempRoot, "truth-validator-request-binding.json"), truthValidatorRequest.bindingBytes),
    writeFile(join(tempRoot, "usage.json"), usageText, "utf8"),
    writeFile(join(tempRoot, "provider-refs.json"), providerText, "utf8"),
    writeFile(join(tempRoot, "accepted-delta.json"), acceptedDeltaText, "utf8"),
    writeFile(join(tempRoot, "delta-admission.json"), admissionText, "utf8"),
    writeFile(join(tempRoot, "truth-application.json"), applicationText, "utf8"),
    writeFile(join(tempRoot, "semantic-validation.json"), semanticValidationText, "utf8"),
    writeFile(join(tempRoot, "extractor-evidence.json"), extractorEvidenceText, "utf8"),
    writeFile(join(tempRoot, "validator-evidence.json"), validatorEvidenceText, "utf8"),
    writeFile(join(tempRoot, "truth-usage.json"), truthUsageText, "utf8"),
    writeFile(join(tempRoot, "truth-context.json"), truthContextBytes),
    writeFile(join(tempRoot, "extraction-context.json"), extractionContextBytes),
    writeFile(join(tempRoot, "validation-context.json"), validationContextBytes),
    writeFile(join(tempRoot, "projection-manifest.json"), manifestText, "utf8"),
    ...(firstV2BaselineBytes ? [writeFile(join(tempRoot, "first-v2-baseline.json"), firstV2BaselineBytes)] : []),
  ]);
  if (repairAuthority) {
    await Promise.all(repairAuthority.files.map(async (file) => {
      const destination = join(tempRoot, file.relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }));
    await mkdir(join(tempRoot, "repair-authority"), { recursive: true });
    await writeFile(join(tempRoot, "repair-authority", "manifest.json"), repairAuthority.manifestBytes);
  }
  const stateFiles = await writeTree(join(tempRoot, "state"), stateFilesInput);
  const snapshotFiles = await writeTree(join(tempRoot, "snapshot"), stateFilesInput);
  if (canonicalJsonV2(stateFiles) !== canonicalJsonV2(expectedStateFiles)
    || canonicalJsonV2(snapshotFiles) !== canonicalJsonV2(expectedStateFiles)) {
    throw new Error("Commit V2 deterministic tree construction mismatch");
  }
  await publishImmutableFile(join(tempRoot, "commit.json"), `${JSON.stringify(expectedCommit, null, 2)}\n`);
  try { await verifyBundle(tempRoot, transaction.record.chapterNumber, input.bookDir); await publishOpenChapterTransaction(input, () => rename(tempRoot, root)); }
  catch (error) { await rm(tempRoot, { recursive: true, force: true }); throw error; }
}

/** Read-only recovery observation; never authorizes ordinary work on a selected attempt. */
export async function loadRecoverableTruthChapterCommit(input: { readonly bookDir: string; readonly pendingChapterNumber?: number }): Promise<{
  readonly root: string;
  readonly commit: TruthChapterCommitV2;
  readonly extractionContext: CanonicalTruthExtractionContextRecord;
  readonly validationContext: CanonicalTruthValidationContextRecord;
  readonly firstV2Baseline?: FirstV2BaselineContext;
} | null> {
  const chain = await verifyChapterCommitChain(input);
  const latest = chain.commits.at(-1);
  // The runtime chapter is a routing hint only. A promoted target is recoverable
  // solely through its verified Commit and matching retained terminal claim.
  const promoted = input.pendingChapterNumber === chain.latestChapter && latest?.kind === "TRUTH_CHAPTER_COMMIT" ? latest : undefined;
  const predecessorChain = promoted ? { ...chain, commits: chain.commits.slice(0, -1), latestChapter: promoted.chapterNumber - 1,
    latestAuthoritySha256: promoted.previousAuthoritySha256 } : chain;
  const attempts = (await listChapterTransactions(input.bookDir, predecessorChain.latestChapter + 1)).filter((attempt) => !attempt.abandoned);
  if (attempts.length > 1) throw new Error("MULTIPLE_ACTIVE_CHAPTER_ATTEMPTS");
  const transaction = attempts[0];
  if (!transaction || transaction.record.truthMode !== "CANONICAL_V2") return null;
  await loadActiveCanonicalTruthTransactionFromVerifiedChain(input.bookDir, predecessorChain);
  if (promoted && (transaction.terminal?.outcome !== "COMMIT_SELECTED"
    || transaction.record.transactionId !== promoted.transactionId || transaction.terminal.commitSha256 !== promoted.commitSha256
    || transaction.terminal.commitKind !== promoted.kind)) throw new Error("SELECTED_COMMIT_RECOVERY_IDENTITY_MISMATCH");
  const source = join(transaction.root, "staging", "bundle");
  const root = promoted && !(await exists(source)) ? commitRoot(input.bookDir, promoted.chapterNumber) : source;
  if (!(await exists(root))) {
    if (transaction.terminal?.outcome === "COMMIT_SELECTED") throw new Error("SELECTED_COMMIT_RECOVERY_SOURCE_MISSING");
    return null;
  }
  const commit = await verifyBundle(root, transaction.record.chapterNumber, input.bookDir);
  if (commit.kind !== "TRUTH_CHAPTER_COMMIT" || commit.transactionId !== transaction.record.transactionId
    || commit.bookId !== chain.bookId || commit.previousAuthoritySha256 !== predecessorChain.latestAuthoritySha256
    || promoted && commit.commitSha256 !== promoted.commitSha256
    || transaction.terminal?.outcome === "COMMIT_SELECTED" &&
      (transaction.terminal.commitSha256 !== commit.commitSha256 || transaction.terminal.commitKind !== commit.kind)) {
    throw new Error("SELECTED_COMMIT_RECOVERY_IDENTITY_MISMATCH");
  }
  return { root, commit,
    ...(commit.bundlePayloadFiles.some((entry) => entry.relativePath === "first-v2-baseline.json")
      ? { firstV2Baseline: await readJson<FirstV2BaselineContext>(join(root, "first-v2-baseline.json")) } : {}),
    extractionContext: await readJson<CanonicalTruthExtractionContextRecord>(join(root, "extraction-context.json")),
    validationContext: await readJson<CanonicalTruthValidationContextRecord>(join(root, "validation-context.json")),
  };
}

export async function finalizeChapterTransaction(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  /** Test-only crash boundary after target-first source presence is observed. */
  readonly afterTargetSourceExists?: () => Promise<void> | void;
  /** Runs after retaining the immutable source commit identity and before full source verification. */
  readonly afterRetainSourceIdentity?: () => Promise<void> | void;
  /** Runs after source verification and immediately before atomic promotion. */
  readonly beforePromote?: () => Promise<void> | void;
}): Promise<ChapterCommit> {
  const transaction = await findTransaction(input.bookDir, input.transactionId, { allowCommitSelected: true });
  const source = join(transaction.root, "staging", "bundle");
  const target = commitRoot(input.bookDir, transaction.record.chapterNumber);
  if (await exists(target)) {
    const existing = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.record.chapterNumber });
    if (existing.transactionId !== transaction.record.transactionId) throw new Error("Immutable chapter commit transaction identity mismatch");
    if (await exists(source)) {
      await input.afterTargetSourceExists?.();
      let staged: ChapterCommit;
      try { staged = await verifyBundle(source, transaction.record.chapterNumber, input.bookDir); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
          ?? ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code);
        if (code !== "ENOENT") throw error;
        const reverified = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.record.chapterNumber });
        if (reverified.transactionId !== transaction.record.transactionId
          || reverified.commitSha256 !== existing.commitSha256) {
          throw new Error("Immutable chapter commit target-first source verification race conflict", { cause: error });
        }
        await selectAttemptTerminal(input.bookDir, transaction, { outcome: "COMMIT_SELECTED", commitKind: existing.kind, commitSha256: existing.commitSha256 });
        return verifyFinalChapterCommitIdentity({
          bookDir: input.bookDir,
          chapterNumber: transaction.record.chapterNumber,
          expected: existing,
        });
      }
      if (existing.transactionId !== transaction.record.transactionId || existing.commitSha256 !== staged.commitSha256) {
        throw new Error("Immutable chapter commit conflict");
      }
    } else if (existing.transactionId !== transaction.record.transactionId) {
      throw new Error("Immutable chapter commit transaction identity mismatch");
    }
    await selectAttemptTerminal(input.bookDir, transaction, { outcome: "COMMIT_SELECTED", commitKind: existing.kind, commitSha256: existing.commitSha256 });
    return verifyFinalChapterCommitIdentity({
      bookDir: input.bookDir,
      chapterNumber: transaction.record.chapterNumber,
      expected: existing,
    });
  }
  const retained = await readJson<ChapterCommit>(join(source, "commit.json"));
  const { commitSha256: retainedSha256, ...retainedUnsigned } = retained;
  if (retained.transactionId !== transaction.record.transactionId
    || retained.chapterNumber !== transaction.record.chapterNumber
    || retainedSha256 !== canonicalSha256(retainedUnsigned)) {
    throw new Error("Immutable staged source identity mismatch");
  }
  await input.afterRetainSourceIdentity?.();
  let staged: ChapterCommit;
  try { staged = await verifyBundle(source, transaction.record.chapterNumber, input.bookDir); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
      ?? ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code);
    if (code !== "ENOENT" || !(await exists(target))) throw error;
    const promoted = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.record.chapterNumber });
    if (promoted.transactionId !== retained.transactionId || promoted.commitSha256 !== retained.commitSha256) {
      throw new Error("Immutable chapter commit source verification race conflict", { cause: error });
    }
    return verifyFinalChapterCommitIdentity({
      bookDir: input.bookDir,
      chapterNumber: transaction.record.chapterNumber,
      expected: retained,
    });
  }
  if (staged.transactionId !== retained.transactionId || staged.commitSha256 !== retained.commitSha256) {
    throw new Error("Immutable staged source identity conflict");
  }
  await selectAttemptTerminal(input.bookDir, transaction, { outcome: "COMMIT_SELECTED", commitKind: staged.kind, commitSha256: staged.commitSha256 });
  await mkdir(dirname(target), { recursive: true });
  await input.beforePromote?.();
  try { await rename(source, target); }
  catch (error) {
    if (!(await exists(target))) throw error;
    const raced = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.record.chapterNumber });
    if (raced.transactionId !== transaction.record.transactionId || raced.commitSha256 !== staged.commitSha256) {
      throw new Error("Immutable chapter commit rename race conflict", { cause: error });
    }
    return verifyFinalChapterCommitIdentity({
      bookDir: input.bookDir,
      chapterNumber: transaction.record.chapterNumber,
      expected: staged,
    });
  }
  return verifyFinalChapterCommitIdentity({
    bookDir: input.bookDir,
    chapterNumber: transaction.record.chapterNumber,
    expected: staged,
  });
}

async function verifyFinalChapterCommitIdentity(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly expected: Pick<ChapterCommit, "transactionId" | "commitSha256">;
}): Promise<ChapterCommit> {
  const committed = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: input.chapterNumber });
  if (committed.transactionId !== input.expected.transactionId || committed.commitSha256 !== input.expected.commitSha256) {
    throw new Error("Immutable chapter commit final target identity conflict");
  }
  return committed;
}

async function verifyBundle(root: string, chapterNumber: number, bookDir: string, commitArtifactBytes?: Buffer): Promise<ChapterCommit> {
  const rawCommit = commitArtifactBytes
    ? JSON.parse(commitArtifactBytes.toString("utf8")) as ChapterCommit
    : await readJson<ChapterCommit>(join(root, "commit.json"));
  if (rawCommit.kind === "TRUTH_CHAPTER_COMMIT") return verifyTruthBundleV2(root, chapterNumber, rawCommit, bookDir);
  const commit = rawCommit as LegacyChapterCommitV1;
  const { commitSha256, ...unsigned } = commit;
  if (commit.kind !== "CHAPTER_COMMIT" || commit.schemaVersion !== 1 || commit.chapterNumber !== chapterNumber || sha256(canonical(unsigned)) !== commitSha256) {
    throw new Error(`Chapter ${chapterNumber} commit manifest integrity mismatch`);
  }
  const body = await readFile(join(root, "chapter.md"), "utf-8");
  if (sha256(body) !== commit.finalBodySha256 || commit.finalCandidateSha256 !== commit.finalBodySha256) throw new Error(`Chapter ${chapterNumber} body hash mismatch`);
  if (countChapterLength(body, commit.lengthSpec.countingMode) !== commit.finalLengthCount || isOutsideHardRange(commit.finalLengthCount, commit.lengthSpec)) throw new Error(`Chapter ${chapterNumber} length authority mismatch`);
  const review = await readFile(join(root, "review.json"));
  const usage = await readFile(join(root, "usage.json"));
  const stateValidation = await readFile(join(root, "state-validation.json"));
  const providers = await readFile(join(root, "provider-refs.json"));
  if (sha256(review) !== commit.reviewEvidenceSha256 || sha256(usage) !== commit.usageSha256
    || sha256(stateValidation) !== commit.stateValidationSha256 || sha256(providers) !== commit.providerReferencesSha256) throw new Error(`Chapter ${chapterNumber} evidence hash mismatch`);
  const reviewEvidence = JSON.parse(review.toString("utf-8")) as ChapterCommitReviewAuthority;
  if (reviewEvidence.status !== commit.boundedReviewStatus || reviewEvidence.revisionCount !== commit.revisionCount) {
    throw new Error(`Chapter ${chapterNumber} review authority mismatch`);
  }
  validateReviewAuthority(reviewEvidence, commit.finalBodySha256);
  const validationEvidence = JSON.parse(stateValidation.toString("utf-8")) as ChapterStateValidationAuthority;
  validateStateValidationAuthority(validationEvidence, chapterNumber, commit.finalBodySha256, commit.previousAuthoritySha256);
  const references = JSON.parse(providers.toString("utf-8")) as ReadonlyArray<ChapterProviderReference>;
  if (!Array.isArray(references) || references.length === 0 || references.length !== commit.providerReferenceCount) {
    throw new Error(`Chapter ${chapterNumber} Provider operation authority is missing`);
  }
  for (const reviewer of reviewEvidence.reviewerEvidence) {
    const acceptedRoles = reviewer.reviewerRole === "logic-canon-auditor" ? ["logic-canon-auditor", "auditor"] : ["commercial-reader"];
    const expectedStage = reviewer.reviewerRole === "logic-canon-auditor" ? "LOGIC_REVIEW" : "READER_REVIEW";
    if (!references.some((reference) => acceptedRoles.includes(reference.role)
      && reference.stage === expectedStage
      && reference.provider === reviewer.provider && reference.requestedModel === reviewer.model)) {
      throw new Error(`Chapter ${chapterNumber} reviewer Provider authority mismatch`);
    }
  }
  await verifyTree(join(root, "state"), commit.stateFiles, "State");
  await verifyTree(join(root, "snapshot"), commit.snapshotFiles, "Snapshot");
  if (treeSha(commit.stateFiles) !== commit.stateTreeSha256 || treeSha(commit.snapshotFiles) !== commit.snapshotTreeSha256) throw new Error(`Chapter ${chapterNumber} tree hash mismatch`);
  parseStateManifest(await readFile(join(root, "state", "manifest.json"), "utf-8"), chapterNumber, commit.finalBodySha256, commit.previousAuthoritySha256, "State");
  parseStateManifest(await readFile(join(root, "snapshot", "state", "manifest.json"), "utf-8"), chapterNumber, commit.finalBodySha256, commit.previousAuthoritySha256, "Snapshot");
  return commit;
}

const V2_ROOT_PAYLOAD = [
  "accepted-delta.json", "chapter.md", "commercial-review-evidence.json", "commercial-review-request-binding.json",
  "commercial-review-request-reservation.json", "delta-admission.json", "extraction-context.json", "extractor-evidence.json",
  "logic-review-evidence.json", "logic-review-request-binding.json", "logic-review-request-reservation.json", "projection-manifest.json",
  "provider-refs.json", "review.json", "semantic-validation.json", "truth-application.json", "truth-context.json",
  "truth-extractor-request-binding.json", "truth-extractor-request-reservation.json", "truth-usage.json",
  "truth-validator-request-binding.json", "truth-validator-request-reservation.json", "usage.json", "validation-context.json", "validator-evidence.json",
] as const;
const V2_STATE_PAYLOAD = ["truth.json", "projection-manifest.json", "current_state.md", "current_state.json", "pending_hooks.md", "hooks.json",
  "particle_ledger.md", "chapter_summaries.md", "chapter_summaries.json", "subplot_board.md", "emotional_arcs.md", "character_matrix.md"] as const;

async function verifyCompleteV2Payload(root: string, commit: TruthChapterCommitV2, firstV2: boolean): Promise<void> {
  await safeMutationPath(root, "commit.json");
  const expected: string[] = [...V2_ROOT_PAYLOAD, ...V2_STATE_PAYLOAD.flatMap((path) => [`state/${path}`, `snapshot/${path}`])];
  if (firstV2) expected.push("first-v2-baseline.json");
  if (commit.repairAuthorityManifestSha256 !== undefined) {
    const repair = await readJson<RepairAuthorityManifestV1>(join(root, "repair-authority", "manifest.json"));
    expected.push("repair-authority/manifest.json", "repair-authorization.json", "initial/extraction-context.json", "initial/extraction.json",
      "initial/provider-reference.json", "initial/provider-response.json");
    if (repair.source === "DELTA_ADMISSION") expected.push("initial/delta-admission-defect.json");
    else if (repair.source === "SEMANTIC_VALIDATION") expected.push("initial/validation-context.json", "initial/extractor-provider-reference.json",
      "initial/extractor-provider-response.json", "initial/delta-admission.json", "initial/truth-application.json", "initial/resulting-truth.json",
      "initial/projection-manifest.json", "initial/semantic-validation.json");
    else throw new Error("Commit V2 bundle repair variant invalid");
  }
  expected.sort((left, right) => left.localeCompare(right));
  if (!Array.isArray(commit.bundlePayloadFiles)
    || canonicalJsonV2(commit.bundlePayloadFiles.map((entry) => entry.relativePath)) !== canonicalJsonV2(expected)
    || treeSha(commit.bundlePayloadFiles) !== commit.bundlePayloadTreeSha256) throw new Error("Commit V2 bundle inventory mismatch");
  const actual: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(directory);
    if (!names.length) throw new Error("Commit V2 bundle unexpected empty directory");
    for (const name of names) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Commit V2 bundle unsafe file type");
      if (info.isDirectory()) await visit(path);
      else actual.push(relative(root, path).split(sep).join("/"));
    }
  };
  await visit(root);
  const actualPayload = actual.filter((path) => path !== "commit.json").sort((left, right) => left.localeCompare(right));
  if (!actual.includes("commit.json") || canonicalJsonV2(actualPayload) !== canonicalJsonV2(expected)) throw new Error("Commit V2 bundle file inventory mismatch");
  for (const entry of commit.bundlePayloadFiles) {
    const bytes = await readFile(join(root, entry.relativePath));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new ChapterArtifactEvidenceError(
      `ARTIFACT_EVIDENCE_DEFECT: Commit V2 bundle ${entry.relativePath} integrity mismatch`, entry,
    );
  }
  if (canonicalJsonV2(commit.stateFiles) !== canonicalJsonV2(commit.snapshotFiles)) throw new Error("Commit V2 state/snapshot manifest mismatch");
  for (const path of V2_STATE_PAYLOAD) {
    const state = await readFile(join(root, "state", path));
    if (!state.equals(await readFile(join(root, "snapshot", path)))) throw new Error(`Commit V2 state/snapshot ${path} mismatch`);
  }
  const manifest = await readFile(join(root, "projection-manifest.json"));
  if (!manifest.equals(await readFile(join(root, "state", "projection-manifest.json")))) throw new Error("Commit V2 root/state/snapshot projection manifest mismatch");
}

async function verifyTruthBundleV2(root: string, chapterNumber: number, commit: TruthChapterCommitV2, bookDir: string): Promise<TruthChapterCommitV2> {
  const { commitSha256, ...unsigned } = commit;
  if (commit.schemaVersion !== 2 || commit.kind !== "TRUTH_CHAPTER_COMMIT" || commit.chapterNumber !== chapterNumber
    || canonicalSha256(unsigned) !== commitSha256 || commit.previousAuthoritySha256 !== commit.predecessorCommitSha256
    || !Number.isSafeInteger(commit.attemptNumber) || commit.attemptNumber < 1
    || commit.attemptId !== `attempt-${commit.attemptNumber}`) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 manifest integrity mismatch`);
  }
  const predecessorCommit = await readJson<ChapterCommit>(join(commitRoot(bookDir, chapterNumber - 1), "commit.json"));
  if (predecessorCommit.commitSha256 !== commit.predecessorCommitSha256
    || predecessorCommit.bookId !== commit.bookId || predecessorCommit.chapterNumber !== chapterNumber - 1
    || !["CHAPTER_COMMIT", "TRUTH_CHAPTER_COMMIT"].includes(predecessorCommit.kind)) {
    throw new Error("Commit V2 predecessor Commit identity mismatch");
  }
  const firstV2 = predecessorCommit.kind === "CHAPTER_COMMIT";
  try { await verifyCompleteV2Payload(root, commit, firstV2); }
  catch (error) { throw asChapterArtifactEvidenceError("Commit V2 complete bundle verification failed", error); }
  const body = await readFile(join(root, "chapter.md"), "utf8");
  if (sha256(body) !== commit.finalBodySha256 || commit.finalCandidateSha256 !== commit.finalBodySha256
    || countChapterLength(body, commit.lengthSpec.countingMode) !== commit.finalLengthCount
    || isOutsideHardRange(commit.finalLengthCount, commit.lengthSpec)) throw new Error(`Chapter ${chapterNumber} Commit V2 body authority mismatch`);
  const [review, logicReviewRecordBytes, commercialReviewRecordBytes,
    logicRequestReservationBytes, logicRequestBindingBytes,
    commercialRequestReservationBytes, commercialRequestBindingBytes,
    truthExtractorRequestReservationBytes, truthExtractorRequestBindingBytes,
    truthValidatorRequestReservationBytes, truthValidatorRequestBindingBytes,
    usage, providers, acceptedBytes, admissionBytes, applicationBytes, validationBytes, extractorBytes, validatorBytes, truthUsageBytes, truthContextBytes, extractionContextBytes, validationContextBytes, manifestBytes, truthBytes] = await Promise.all([
    readFile(join(root, "review.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} terminal review aggregate read failed`, error); }),
    readFile(join(root, "logic-review-evidence.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Logic review record read failed`, error); }),
    readFile(join(root, "commercial-review-evidence.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commercial Reader review record read failed`, error); }),
    readFile(join(root, "logic-review-request-reservation.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Logic request reservation read failed`, error); }),
    readFile(join(root, "logic-review-request-binding.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Logic request binding read failed`, error); }),
    readFile(join(root, "commercial-review-request-reservation.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commercial request reservation read failed`, error); }),
    readFile(join(root, "commercial-review-request-binding.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commercial request binding read failed`, error); }),
    readFile(join(root, "truth-extractor-request-reservation.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Truth Extractor request reservation read failed`, error); }),
    readFile(join(root, "truth-extractor-request-binding.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Truth Extractor request binding read failed`, error); }),
    readFile(join(root, "truth-validator-request-reservation.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Truth Validator request reservation read failed`, error); }),
    readFile(join(root, "truth-validator-request-binding.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Truth Validator request binding read failed`, error); }),
    readFile(join(root, "usage.json")),
    readFile(join(root, "provider-refs.json")).catch((error) => { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Provider reference record read failed`, error); }),
    readFile(join(root, "accepted-delta.json")), readFile(join(root, "delta-admission.json")), readFile(join(root, "truth-application.json")),
    readFile(join(root, "semantic-validation.json")), readFile(join(root, "extractor-evidence.json")), readFile(join(root, "validator-evidence.json")), readFile(join(root, "truth-usage.json")), readFile(join(root, "truth-context.json")), readFile(join(root, "extraction-context.json")), readFile(join(root, "validation-context.json")),
    readFile(join(root, "projection-manifest.json")), readFile(join(root, "state", "truth.json")),
  ]);
  if (sha256(logicReviewRecordBytes) !== commit.logicReviewRecordSha256
    || sha256(commercialReviewRecordBytes) !== commit.commercialReviewRecordSha256
    || sha256(logicRequestReservationBytes) !== commit.logicReviewRequestReservationSha256
    || sha256(logicRequestBindingBytes) !== commit.logicReviewRequestBindingSha256
    || sha256(commercialRequestReservationBytes) !== commit.commercialReviewRequestReservationSha256
    || sha256(commercialRequestBindingBytes) !== commit.commercialReviewRequestBindingSha256
    || sha256(truthExtractorRequestReservationBytes) !== commit.truthExtractorRequestReservationSha256
    || sha256(truthExtractorRequestBindingBytes) !== commit.truthExtractorRequestBindingSha256
    || sha256(truthValidatorRequestReservationBytes) !== commit.truthValidatorRequestReservationSha256
    || sha256(truthValidatorRequestBindingBytes) !== commit.truthValidatorRequestBindingSha256) {
    throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Chapter ${chapterNumber} Provider request authority hash mismatch`, commit);
  }
  if (sha256(review) !== commit.reviewEvidenceSha256 || sha256(providers) !== commit.providerReferencesSha256) {
    throw new ChapterArtifactEvidenceError(`ARTIFACT_EVIDENCE_DEFECT: Chapter ${chapterNumber} terminal review/Provider record hash mismatch`, commit);
  }
  if (sha256(usage) !== commit.usageSha256 || sha256(acceptedBytes) !== commit.acceptedDeltaArtifactSha256
    || sha256(admissionBytes) !== commit.deltaAdmissionSha256 || sha256(applicationBytes) !== commit.truthApplicationSha256
    || sha256(validationBytes) !== commit.semanticValidationSha256 || commit.stateValidationSha256 !== commit.semanticValidationSha256
    || sha256(extractorBytes) !== commit.extractorEvidenceSha256
    || sha256(validatorBytes) !== commit.validatorEvidenceSha256 || sha256(truthUsageBytes) !== commit.truthUsageSha256
    || sha256(truthContextBytes) !== commit.truthContextSha256
    || sha256(extractionContextBytes) !== commit.extractionContextSha256
    || sha256(validationContextBytes) !== commit.validationContextSha256
    || sha256(manifestBytes) !== commit.projectionManifestSha256) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 evidence hash mismatch`);
  }
  let reviewEvidence: ChapterCommitReviewAuthority;
  try {
    reviewEvidence = JSON.parse(review.toString("utf8")) as ChapterCommitReviewAuthority;
    validateReviewAuthority(reviewEvidence, commit.finalBodySha256);
    if (reviewEvidence.status !== commit.boundedReviewStatus || reviewEvidence.revisionCount !== commit.revisionCount) {
      throw new Error(`Chapter ${chapterNumber} Commit V2 review authority mismatch`);
    }
  } catch (error) {
    throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commit V2 terminal stable-review authority failed`, error);
  }
  for (const [reviewerRole, bytes] of [
    ["logic-canon-auditor", logicReviewRecordBytes],
    ["commercial-reader", commercialReviewRecordBytes],
  ] as const) {
    try {
    const reviewer = reviewEvidence.reviewerEvidence.find((candidate) => candidate.reviewerRole === reviewerRole);
    let record: BoundReviewEvidenceRecord;
    try { record = JSON.parse(bytes.toString("utf8")) as BoundReviewEvidenceRecord; }
    catch (error) { throw new Error(`Chapter ${chapterNumber} Commit V2 ${reviewerRole} review record invalid JSON`, { cause: error }); }
    if (!reviewer || record.schemaVersion !== 3 || record.transactionId !== commit.transactionId
      || record.chapterNumber !== chapterNumber || record.candidateSha256 !== commit.finalCandidateSha256
      || record.reviewerRole !== reviewerRole || canonical(record.evidence) !== canonical(reviewer)
      || record.evidenceSha256 !== sha256(canonical(reviewer))) {
      throw new Error(`Chapter ${chapterNumber} Commit V2 ${reviewerRole} candidate-bound review authority mismatch`);
    }
    assertBoundReviewRawBinding(record, body);
    } catch (error) {
      throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commit V2 ${reviewerRole} terminal review evidence failed`, error);
    }
  }
  const acceptedDelta = JSON.parse(acceptedBytes.toString("utf8")) as AcceptedChapterDeltaV1;
  const admission = JSON.parse(admissionBytes.toString("utf8")) as ChapterDeltaAdmissionResultV1;
  const application = JSON.parse(applicationBytes.toString("utf8")) as TruthApplicationReceiptV1;
  const validation = JSON.parse(validationBytes.toString("utf8")) as CanonicalTruthValidationArtifact;
  const extractorEvidence = JSON.parse(extractorBytes.toString("utf8")) as TruthChapterCommitArtifactsV2["extractorEvidence"];
  const validatorEvidence = JSON.parse(validatorBytes.toString("utf8")) as TruthChapterCommitArtifactsV2["validatorEvidence"];
  const truthUsage = JSON.parse(truthUsageBytes.toString("utf8")) as TruthChapterCommitArtifactsV2["usageByRole"];
  const truthContext = JSON.parse(truthContextBytes.toString("utf8")) as Record<string, unknown>;
  const extractionContext = JSON.parse(extractionContextBytes.toString("utf8")) as CanonicalTruthExtractionContextRecord;
  const validationContext = JSON.parse(validationContextBytes.toString("utf8")) as CanonicalTruthValidationContextRecord;
  const committedUsage = JSON.parse(usage.toString("utf8")) as {
    readonly totalUsage?: ProviderUsageAuthority;
    readonly roleUsage?: Readonly<Record<string, ProviderUsageAuthority>>;
  };
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ProjectionManifestV1;
  const truth = validateStructuredTruthV1(JSON.parse(truthBytes.toString("utf8")));
  const contextPredecessor = validateStructuredTruthV1(JSON.parse(extractionContext.request.predecessorTruthJson));
  if (firstV2) {
    const verifiedLegacy = await verifyChapterCommit({ bookDir, chapterNumber: chapterNumber - 1 });
    if (verifiedLegacy.kind !== "CHAPTER_COMMIT" || verifiedLegacy.commitSha256 !== commit.predecessorCommitSha256) {
      throw new Error("FIRST_V2_BASELINE_PREDECESSOR_COMMIT_MISMATCH");
    }
    const baseline = await readJson<FirstV2BaselineContext>(join(root, "first-v2-baseline.json"));
    const sourceRoot = join(commitRoot(bookDir, chapterNumber - 1), "state");
    const sourceFiles = Object.fromEntries(await Promise.all(verifiedLegacy.stateFiles.map(async (entry) => [
      entry.relativePath, await readFile(join(sourceRoot, entry.relativePath)),
    ] as const)));
    const baselineTruth = validateBaselineAuthorityV1({ truth: baseline.truth, sourceManifest: baseline.sourceManifest,
      receipt: baseline.receipt, sourceFiles, chapterCommit: verifiedLegacy });
    const predecessorBody = await readFile(join(commitRoot(bookDir, chapterNumber - 1), "chapter.md"), "utf8");
    if (baseline.previousAuthoritySha256 !== verifiedLegacy.commitSha256
      || baseline.predecessorChapterBody !== predecessorBody
      || baseline.predecessorChapterBodySha256 !== sha256(predecessorBody)
      || sha256(predecessorBody) !== verifiedLegacy.finalBodySha256
      || baseline.truthSha256 !== canonicalSha256(baselineTruth)
      || baseline.vocabularyCatalogSha256 !== canonicalSha256(baselineTruth.vocabulary)
      || baseline.truthSha256 !== commit.predecessorTruthSha256
      || baseline.vocabularyCatalogSha256 !== commit.predecessorVocabularyCatalogSha256
      || canonicalJsonV2(baselineTruth) !== canonicalJsonV2(contextPredecessor)) {
      throw new Error("FIRST_V2_BASELINE_COMMITTED_AUTHORITY_MISMATCH");
    }
  }
  assertCanonicalTruthContextSemantics({
    label: `Chapter ${chapterNumber} committed`,
    truthContext,
    extractionContext,
    validationContext,
    transactionId: commit.transactionId,
    attemptId: commit.attemptId,
    attemptNumber: commit.attemptNumber,
    chapterNumber,
    candidateSha256: commit.finalCandidateSha256,
    predecessorCommitSha256: commit.predecessorCommitSha256,
    predecessor: contextPredecessor,
    acceptedDelta,
    resultingTruth: truth,
    applicationReceipt: application,
    projectionManifest: manifest,
  });
  await verifyCommittedRepairAuthority({ root, commit, currentContext: extractionContext, truthContext });
  const { contextSha256: persistedContextSha256, ...unsignedTruthContext } = truthContext;
  if (persistedContextSha256 !== commit.truthContextIdentitySha256
    || canonicalSha256(unsignedTruthContext) !== commit.truthContextIdentitySha256
    || truthContext.transactionId !== commit.transactionId || truthContext.attemptId !== commit.attemptId
    || truthContext.attemptNumber !== commit.attemptNumber || truthContext.chapterNumber !== chapterNumber
    || truthContext.candidateSha256 !== commit.finalCandidateSha256
    || truthContext.predecessorCommitSha256 !== commit.predecessorCommitSha256) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 durable truth context mismatch`);
  }
  const { contextSha256: extractionContextSha, ...unsignedExtractionContext } = extractionContext;
  const { contextSha256: validationContextSha, ...unsignedValidationContext } = validationContext;
  if (extractionContextSha !== extractorEvidence.contextSha256
    || validationContextSha !== validatorEvidence.contextSha256
    || extractionContextSha !== canonicalSha256(unsignedExtractionContext)
    || validationContextSha !== canonicalSha256(unsignedValidationContext)
    || extractionContext.requestSha256 !== canonicalSha256(extractionContext.request)
    || validationContext.requestSha256 !== canonicalSha256(validationContext.request)
    || extractionContext.baseContextSha256 !== commit.truthContextIdentitySha256
    || validationContext.baseContextSha256 !== commit.truthContextIdentitySha256
    || extractionContext.role !== "truth-extractor" || validationContext.role !== "truth-validator"
    || validationContext.stage !== "TRUTH_VALIDATION"
    || extractionContext.extractionKind !== validationContext.extractionKind
    || extractionContext.repairOrdinal !== validationContext.repairOrdinal) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 model context authority mismatch`);
  }
  if (canonicalSha256(truth) !== commit.truthSha256 || truth.lineage.kind !== "CHAPTER_DELTA"
    || truth.lineage.predecessorCommitSha256 !== commit.predecessorCommitSha256
    || truth.lineage.predecessorTruthSha256 !== commit.predecessorTruthSha256
    || truth.lineage.predecessorVocabularyCatalogSha256 !== commit.predecessorVocabularyCatalogSha256
    || truth.lineage.candidateSha256 !== commit.finalCandidateSha256 || truth.lineage.deltaId !== commit.deltaId
    || canonicalSha256(acceptedDelta) !== truth.lineage.acceptedDeltaArtifactSha256
    || admission.status !== "ACCEPTED" || canonicalJsonV2(admission.acceptedDelta) !== canonicalJsonV2(acceptedDelta)
    || acceptedDelta.delta.transactionId !== commit.transactionId || acceptedDelta.delta.attemptId !== commit.attemptId
    || application.transactionId !== commit.transactionId || application.attemptId !== commit.attemptId
    || application.resultingTruthSha256 !== commit.truthSha256 || application.deltaId !== commit.deltaId
    || validation.verdict !== "PASS" || validation.diagnostics.length !== 0
    || manifest.truthSha256 !== commit.truthSha256 || manifest.treeSha256 !== commit.projectionTreeSha256
    || canonicalJsonV2(manifest) + "\n" !== manifestBytes.toString("utf8")) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 canonical truth authority mismatch`);
  }
  if (sha256(validation.rawResponse) !== validation.responseContentSha256
    || canonicalJsonV2(parseTruthValidatorResponse(validation.rawResponse))
      !== canonicalJsonV2({ verdict: validation.verdict, diagnostics: validation.diagnostics })
    || validation.logicalOperationId !== validatorEvidence.logicalOperationId
    || validation.inputFingerprint !== validatorEvidence.inputFingerprint
    || validation.providerArtifactSha256 !== validatorEvidence.providerArtifactSha256
    || validation.responseContentSha256 !== validatorEvidence.responseContentSha256) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 Validator raw response PASS binding mismatch`);
  }
  if (!committedUsage.roleUsage || Object.entries(truthUsage).some(([role, roleUsage]) =>
    canonicalJsonV2(committedUsage.roleUsage?.[role]) !== canonicalJsonV2(roleUsage))) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 truth usage authority mismatch`);
  }
  await verifyTree(join(root, "state"), commit.stateFiles, "Commit V2 state");
  await verifyTree(join(root, "snapshot"), commit.snapshotFiles, "Commit V2 snapshot");
  if (treeSha(commit.stateFiles) !== commit.stateTreeSha256 || treeSha(commit.snapshotFiles) !== commit.snapshotTreeSha256) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 state tree mismatch`);
  }
  const projections = renderStructuredTruthProjectionsV1(truth);
  const expectedManifest = buildProjectionManifestV1({ truthSha256: commit.truthSha256, projections });
  if (canonicalJsonV2(expectedManifest) !== canonicalJsonV2(manifest)) throw new Error(`Chapter ${chapterNumber} Commit V2 projection manifest mismatch`);
  for (const projection of projections) {
    const bytes = await readFile(join(root, "state", commitProjectionPath(projection.path)));
    if (!Buffer.from(projection.bytes).equals(bytes)) throw new Error(`Chapter ${chapterNumber} Commit V2 projection mismatch`);
  }
  let references: ReadonlyArray<ChapterProviderReference>;
  try {
    references = JSON.parse(providers.toString("utf8")) as ReadonlyArray<ChapterProviderReference>;
    if (!Array.isArray(references) || references.length !== commit.providerReferenceCount) throw new Error(`Chapter ${chapterNumber} Commit V2 Provider authority is missing`);
  } catch (error) {
    throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commit V2 Provider authority record failed`, error);
  }
  for (const bytes of [logicReviewRecordBytes, commercialReviewRecordBytes]) {
    try {
      const record = JSON.parse(bytes.toString("utf8")) as BoundReviewEvidenceRecord;
      const reference = references.find((candidate) => candidate.logicalOperationId === record.providerEvidence.logicalOperationId);
      if (!reference || canonical(reference) !== canonical(record.providerEvidence)) {
        throw new Error(`Chapter ${chapterNumber} Commit V2 terminal review Provider binding mismatch`);
      }
    } catch (error) {
      throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} Commit V2 terminal review Provider binding failed`, error);
    }
  }
  const extractorReference = assertCanonicalTruthProviderEvidence(
    references,
    "truth-extractor",
    extractorEvidence,
    extractionContext.stage,
  );
  const validatorReference = assertCanonicalTruthProviderEvidence(references, "truth-validator", validatorEvidence);
  const transactionRecord: ChapterTransactionRecord = {
    schemaVersion: 1,
    kind: "CHAPTER_TRANSACTION",
    transactionId: commit.transactionId,
    bookId: commit.bookId,
    chapterNumber: commit.chapterNumber,
    previousAuthoritySha256: commit.previousAuthoritySha256,
    productionAuthority: commit.productionAuthority,
    state: "STAGING",
    createdAt: commit.createdAt,
  };
  const committedTransaction: LocatedChapterTransaction = {
    record: transactionRecord,
    root,
    attemptNumber: commit.attemptNumber,
    abandoned: false,
  };
  for (const [role, stage, reviewBytes, reservationBytes, bindingBytes] of [
    ["logic-canon-auditor", "LOGIC_REVIEW", logicReviewRecordBytes, logicRequestReservationBytes, logicRequestBindingBytes],
    ["commercial-reader", "READER_REVIEW", commercialReviewRecordBytes, commercialRequestReservationBytes, commercialRequestBindingBytes],
  ] as const) {
    let reviewRecord: BoundReviewEvidenceRecord;
    try { reviewRecord = JSON.parse(reviewBytes.toString("utf8")) as BoundReviewEvidenceRecord; }
    catch (error) { throw asChapterArtifactEvidenceError(`Chapter ${chapterNumber} committed terminal request review parse failed`, error); }
    if (!reviewRecord.providerRequest?.reviewLanguage) {
      throw new ChapterArtifactEvidenceError(
        `ARTIFACT_EVIDENCE_DEFECT: Chapter ${chapterNumber} committed terminal request language is missing`,
        reviewRecord,
      );
    }
    const {
      inputFingerprint: _inputFingerprint,
      reviewLanguage,
      ...reviewRequest
    } = reviewRecord.providerRequest;
    await validateCommittedProviderRequestAuthority({
      bookDir,
      transaction: committedTransaction,
      candidateBody: body,
      reservationBytes,
      bindingBytes,
      role,
      stage,
      reference: reviewRecord.providerEvidence,
      reviewLanguage,
      request: reviewRequest,
    });
  }
  await Promise.all([
    validateCommittedProviderRequestAuthority({
      bookDir,
      transaction: committedTransaction,
      candidateBody: body,
      reservationBytes: truthExtractorRequestReservationBytes,
      bindingBytes: truthExtractorRequestBindingBytes,
      role: "truth-extractor",
      stage: extractionContext.stage,
      reference: extractorReference,
      requestOrdinal: extractionContext.repairOrdinal,
      request: providerRequestFromTruthExecution(extractionContext.execution),
    }),
    validateCommittedProviderRequestAuthority({
      bookDir,
      transaction: committedTransaction,
      candidateBody: body,
      reservationBytes: truthValidatorRequestReservationBytes,
      bindingBytes: truthValidatorRequestBindingBytes,
      role: "truth-validator",
      stage: "TRUTH_VALIDATION",
      reference: validatorReference,
      requestOrdinal: validationContext.repairOrdinal,
      request: providerRequestFromTruthExecution(validationContext.execution),
    }),
  ]);
  const providerUsageByRole = await assertProviderUsageAuthority(bookDir, transactionRecord, references, committedUsage);
  if (canonicalJsonV2(providerUsageByRole.get("truth-extractor")) !== canonicalJsonV2(truthUsage["truth-extractor"])
    || canonicalJsonV2(providerUsageByRole.get("truth-validator")) !== canonicalJsonV2(truthUsage["truth-validator"])) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 Provider truth usage binding mismatch`);
  }
  const exactExtractorRawResponse = await verifyProviderReference(bookDir, transactionRecord, extractorReference);
  if (sha256(exactExtractorRawResponse) !== extractorEvidence.responseContentSha256) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 Extractor raw Provider response mismatch`);
  }
  const readmitted = admitChapterDeltaV1({
    rawProposal: exactExtractorRawResponse,
    candidate: body,
    predecessor: contextPredecessor,
    host: {
      transactionId: commit.transactionId,
      attemptId: commit.attemptId,
      bookId: commit.bookId,
      chapterNumber,
      candidateSha256: commit.finalCandidateSha256,
      predecessorCommitSha256: commit.predecessorCommitSha256,
      predecessorTruthSha256: commit.predecessorTruthSha256,
      predecessorVocabularyCatalogSha256: commit.predecessorVocabularyCatalogSha256,
      extractorLogicalOperationId: extractorReference.logicalOperationId,
      extractorInputFingerprint: extractorReference.inputFingerprint,
      providerArtifactSha256: extractorReference.artifactSha256,
      responseContentSha256: extractorReference.responseContentSha256,
    },
  });
  if (canonicalJsonV2(readmitted) !== canonicalJsonV2(admission)) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 exact Extractor Provider response admission mismatch`);
  }
  if (canonicalJsonV2(await providerUsageForReference(bookDir, transactionRecord, validatorReference))
    !== canonicalJsonV2(validation.usage)) {
    throw new Error(`Chapter ${chapterNumber} Commit V2 Validator Provider response usage mismatch`);
  }
  return commit;
}

export async function verifyChapterCommit(input: { readonly bookDir: string; readonly chapterNumber: number }): Promise<ChapterCommit> {
  const root = commitRoot(input.bookDir, input.chapterNumber);
  const commitPath = join(root, "commit.json");
  const initialCommitArtifactBytes = await readFile(commitPath);
  const commit = await verifyBundle(root, input.chapterNumber, input.bookDir, initialCommitArtifactBytes);
  const references = await readJson<ReadonlyArray<ChapterProviderReference>>(join(root, "provider-refs.json"));
  const transaction: ChapterTransactionRecord = {
    schemaVersion: 1, kind: "CHAPTER_TRANSACTION", transactionId: commit.transactionId, bookId: commit.bookId,
    chapterNumber: commit.chapterNumber, previousAuthoritySha256: commit.previousAuthoritySha256,
    productionAuthority: commit.productionAuthority, state: "STAGING", createdAt: commit.createdAt,
  };
  for (const reference of references) {
    await verifyProviderReference(input.bookDir, transaction, reference);
  }
  const finalCommitArtifactBytes = await readFile(commitPath);
  if (!finalCommitArtifactBytes.equals(initialCommitArtifactBytes)) {
    throw new Error(`Chapter ${input.chapterNumber} Commit artifact changed during verification`);
  }
  const finalCommit = JSON.parse(finalCommitArtifactBytes.toString("utf8")) as ChapterCommit;
  if (finalCommit.transactionId !== commit.transactionId || finalCommit.commitSha256 !== commit.commitSha256) {
    throw new Error(`Chapter ${input.chapterNumber} Commit verification snapshot conflict`);
  }
  return commit;
}

export async function verifyChapterCommitChain(input: { readonly bookDir: string }): Promise<{ readonly bookId: string; readonly latestChapter: number; readonly latestAuthoritySha256: string; readonly commits: ReadonlyArray<ChapterCommit>; readonly genesis: ChapterGenesis }> {
  const genesis = await loadChapterGenesis(input.bookDir);
  if (!genesis) throw new Error("Chapter transaction genesis is missing");
  const trustedSnapshotDir = join(input.bookDir, "story", "snapshots", String(genesis.lastTrustedChapter));
  await verifyTree(trustedSnapshotDir, genesis.trustedSnapshotFiles, "Genesis trusted snapshot");
  if (treeSha(genesis.trustedSnapshotFiles) !== genesis.trustedSnapshotSha256) throw new Error("Genesis trusted snapshot hash mismatch");
  await verifySelectedFiles(join(input.bookDir, "chapters"), genesis.legacyChapterFiles, "Genesis legacy chapter");
  if (treeSha(genesis.legacyChapterFiles) !== genesis.legacyChapterTreeSha256) throw new Error("Genesis legacy chapter hash mismatch");
  const dirs = (await readdir(authorityRoot(input.bookDir), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^chapter-\d{4,}$/u.test(entry.name))
    .map((entry) => Number(entry.name.slice("chapter-".length)))
    .sort((left, right) => left - right);
  const commits: ChapterCommit[] = [];
  let expected = genesis.lastTrustedChapter + 1;
  let previous = genesis.genesisSha256;
  let sawV2 = false;
  for (const chapter of dirs) {
    if (chapter !== expected) throw new Error(`Chapter commit chain is not contiguous: missing chapter ${expected}`);
    const commit = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: chapter });
    if (commit.bookId !== genesis.bookId || commit.previousAuthoritySha256 !== previous) throw new Error(`Chapter ${chapter} previous commit chain mismatch`);
    const previousCommit = commits.at(-1);
    if (commit.kind === "TRUTH_CHAPTER_COMMIT" && previousCommit?.kind === "TRUTH_CHAPTER_COMMIT"
      && commit.predecessorTruthSha256 !== previousCommit.truthSha256) {
      throw new Error(`Chapter ${chapter} predecessor truth chain mismatch`);
    }
    if (sawV2 && commit.kind === "CHAPTER_COMMIT") throw new Error(`Chapter ${chapter} V1 after V2 is forbidden`);
    sawV2 ||= commit.kind === "TRUTH_CHAPTER_COMMIT";
    commits.push(commit);
    previous = commit.commitSha256;
    expected += 1;
  }
  return { bookId: genesis.bookId, latestChapter: expected - 1, latestAuthoritySha256: previous, commits, genesis };
}

export async function inspectChapterAuthority(input: { readonly bookDir: string; readonly allowRecoverableFirstV2Baseline?: boolean }): Promise<{ readonly bookId: string; readonly state: ChapterAuthorityState; readonly latestChapter: number; readonly nextChapter: number; readonly latestAuthoritySha256: string; readonly activeTransactionId?: string }> {
  const chain = await verifyChapterCommitChain(input);
  return inspectChapterAuthorityFromVerifiedChain(input, chain).catch(async (error: unknown) => {
    // Read-only Studio admission may recognize only the exact existing Package B
    // publication gap. Actual publication remains behind the book/job lock.
    if (!input.allowRecoverableFirstV2Baseline || !(error instanceof Error) || error.message !== "FIRST_V2_BASELINE_TRANSACTION_MISSING") throw error;
    const firstV2Baseline = await buildCommittedLegacyBaseline(input.bookDir, chain);
    await verifyRecoverableBaselineOrphan({ bookDir: input.bookDir, bookId: chain.bookId, chapterNumber: chain.latestChapter + 1,
      productionAuthority: "read-only-orphan-verification", truthMode: "CANONICAL_V2", firstV2Baseline });
    return { bookId: chain.bookId, state: "COMMITTED" as const, latestChapter: chain.latestChapter,
      nextChapter: chain.latestChapter + 1, latestAuthoritySha256: chain.latestAuthoritySha256 };
  });
}

// Private observations live only in their calling read-only phase. Public
// operations always obtain their own complete verification, never a token.
async function inspectChapterAuthorityFromVerifiedChain(
  input: { readonly bookDir: string },
  chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>,
): ReturnType<typeof inspectChapterAuthority> {
  const transactions = await listChapterTransactions(input.bookDir, chain.latestChapter + 1);
  const active = transactions.filter((transaction) => !transaction.abandoned);
  if (active.length > 1) throw new Error("MULTIPLE_ACTIVE_CHAPTER_ATTEMPTS");
  const transaction = active[0]?.record;
  return {
    bookId: chain.bookId, state: transaction ? "STAGING" : chain.commits.length > 0 ? "COMMITTED" : "NOT_STARTED",
    latestChapter: chain.latestChapter, nextChapter: chain.latestChapter + 1, latestAuthoritySha256: chain.latestAuthoritySha256,
    ...(transaction ? { activeTransactionId: transaction.transactionId } : {}),
  };
}

function safeTitle(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1f]/gu, "_").trim();
  return cleaned || "Untitled";
}

export async function reconcileChapterProjections(input: { readonly bookDir: string }): Promise<void> {
  const chain = await verifyChapterCommitChain(input);
  const writes: AtomicFileWrite[] = [];
  const deletes: string[] = [];
  const index: Array<Record<string, unknown>> = [...chain.genesis.legacyIndex];
  const canonicalChapterFiles = new Set<string>();
  for (const commit of chain.commits) {
    const root = commitRoot(input.bookDir, commit.chapterNumber);
    const filename = `${String(commit.chapterNumber).padStart(4, "0")}_${safeTitle(commit.chapterTitle)}.md`;
    canonicalChapterFiles.add(filename);
    const prose = await readFile(join(root, "chapter.md"), "utf-8");
    const heading = commit.language === "zh" ? `# 第${commit.chapterNumber}章 ${commit.chapterTitle}` : `# Chapter ${commit.chapterNumber}: ${commit.chapterTitle}`;
    writes.push({ relativePath: join("chapters", filename), content: `${heading}\n\n${prose}` });
    index.push({
      number: commit.chapterNumber, title: commit.chapterTitle, status: commit.boundedReviewStatus === "APPROVED" ? "approved" : "accepted-with-findings",
      wordCount: commit.finalLengthCount, createdAt: commit.completedAt, updatedAt: commit.completedAt, auditIssues: [], lengthWarnings: [],
      autonomousReview: { status: commit.boundedReviewStatus, revisionCount: commit.revisionCount }, chapterCommitSha256: commit.commitSha256,
    });
    const canonicalSnapshotFiles = new Set(commit.snapshotFiles.map((file) => file.relativePath));
    for (const file of await listFiles(join(root, "snapshot"))) {
      writes.push({ relativePath: join("story", "snapshots", String(commit.chapterNumber), file.relativePath), content: file.content });
    }
    const publicSnapshotRoot = join(input.bookDir, "story", "snapshots", String(commit.chapterNumber));
    for (const file of await listFiles(publicSnapshotRoot).catch(() => [])) {
      if (!canonicalSnapshotFiles.has(file.relativePath)) deletes.push(join("story", "snapshots", String(commit.chapterNumber), file.relativePath));
    }
  }
  const latest = chain.commits.at(-1);
  if (latest) {
    const root = commitRoot(input.bookDir, latest.chapterNumber);
    const canonicalStructuredStateFiles = new Set<string>();
    const canonicalTopLevelTruthFiles = new Set<string>();
    for (const file of await listFiles(join(root, "state"))) {
      const target = file.relativePath.endsWith(".md") && !file.relativePath.includes("/")
        ? join("story", file.relativePath)
        : join("story", "state", file.relativePath);
      if (file.relativePath.endsWith(".md") && !file.relativePath.includes("/")) canonicalTopLevelTruthFiles.add(file.relativePath);
      else canonicalStructuredStateFiles.add(file.relativePath);
      writes.push({ relativePath: target, content: file.content });
    }
    for (const file of await listFiles(join(input.bookDir, "story", "state")).catch(() => [])) {
      if (!canonicalStructuredStateFiles.has(file.relativePath)) deletes.push(join("story", "state", file.relativePath));
    }
    for (const name of ["current_state.md", "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md"]) {
      if (!canonicalTopLevelTruthFiles.has(name) && await exists(join(input.bookDir, "story", name))) deletes.push(join("story", name));
    }
  } else {
    const root = join(input.bookDir, "story", "snapshots", String(chain.genesis.lastTrustedChapter));
    for (const file of await listFiles(root)) {
      const target = file.relativePath.endsWith(".md") && !file.relativePath.includes("/")
        ? join("story", file.relativePath)
        : file.relativePath.startsWith("state/")
          ? join("story", file.relativePath)
          : null;
      if (target) writes.push({ relativePath: target, content: file.content });
    }
  }
  for (const name of await readdir(join(input.bookDir, "chapters")).catch(() => [])) {
    const match = name.match(/^(\d+)[_-].*\.md$/u);
    if (match && Number(match[1]) > chain.genesis.lastTrustedChapter && !canonicalChapterFiles.has(name)) deletes.push(join("chapters", name));
  }
  const committedChapters = new Set(chain.commits.map((commit) => commit.chapterNumber));
  for (const name of await readdir(join(input.bookDir, "story", "snapshots")).catch(() => [])) {
    const chapter = Number(name);
    if (Number.isInteger(chapter) && chapter > chain.genesis.lastTrustedChapter && !committedChapters.has(chapter)) deletes.push(join("story", "snapshots", name));
  }
  writes.push({ relativePath: join("chapters", "index.json"), content: `${JSON.stringify(index, null, 2)}\n` });
  writes.push({ relativePath: join("story", "runtime", "chapter-transactions", "authority-projection.json"), content: `${JSON.stringify({ schemaVersion: 1, bookId: chain.bookId, latestChapter: chain.latestChapter, nextChapter: chain.latestChapter + 1, latestAuthoritySha256: chain.latestAuthoritySha256 }, null, 2)}\n` });
  const runtimeRelativePath = join("story", "runtime", "bounded-autonomous", "production-state.json");
  const runtime = await readJson<Record<string, unknown>>(join(input.bookDir, runtimeRelativePath)).catch(() => null);
  if (runtime) {
    writes.push({
      relativePath: runtimeRelativePath,
      content: `${JSON.stringify({ ...runtime, nextChapter: chain.latestChapter + 1 }, null, 2)}\n`,
    });
  }
  // These public files are derived projections, never authority. Verify their
  // paths and current bytes on every call, but avoid republishing identical
  // history. Missing/different files still use the unchanged atomic writer.
  const changedWrites: AtomicFileWrite[] = [];
  for (const entry of writes) {
    const target = await safeMutationPath(input.bookDir, entry.relativePath);
    const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
    if (!current || !current.equals(Buffer.from(entry.content))) changedWrites.push(entry);
  }
  if (changedWrites.length || deletes.length) {
    await commitAtomicFileSet({ rootDir: input.bookDir, writes: changedWrites, deletes });
  }
}

export async function isChapterTransactionEnabled(bookDir: string): Promise<boolean> {
  return exists(join(authorityRoot(bookDir), "genesis.json"));
}

/** Blocks generic mutation paths from rewriting immutable transaction authority. */
export async function assertChapterAuthorityMutationAllowed(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
}): Promise<void> {
  const genesis = await loadChapterGenesis(input.bookDir);
  const committed = genesis && await exists(join(commitRoot(input.bookDir, input.chapterNumber), "commit.json"));
  if (genesis && (input.chapterNumber <= genesis.lastTrustedChapter || committed)) {
    throw new Error("TRANSACTION_AUTHORITY_MUTATION_FORBIDDEN");
  }
  const { assertLegacyTruthMutationAllowed } = await import("../interaction/truth-authority.js");
  await assertLegacyTruthMutationAllowed(input.bookDir);
}

export async function assertChapterWriterStartAllowed(input: { readonly bookDir: string; readonly chapterNumber: number }): Promise<void> {
  if (!(await isChapterTransactionEnabled(input.bookDir))) return;
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.latestChapter + 1 !== input.chapterNumber) throw new Error("CHAPTER_TRANSACTION_WRITER_START_AUTHORITY_MISMATCH");
}

export async function loadCommittedTruthForWriter(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly firstV2Baseline?: FirstV2BaselineContext;
}): Promise<StructuredTruthV1> {
  return (await loadCommittedV2PredecessorAuthority(input)).truth;
}

export async function loadCommittedV2PredecessorAuthority(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly firstV2Baseline?: FirstV2BaselineContext;
}): Promise<{
  readonly truth: StructuredTruthV1;
  readonly predecessorChapterBody: string;
  readonly recentChapterBodies: ReadonlyArray<string>;
}> {
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  const active = await loadActiveCanonicalTruthTransactionFromVerifiedChain(input.bookDir, chain);
  if (chain.commits.at(-1)?.kind !== "TRUTH_CHAPTER_COMMIT"
    && input.firstV2Baseline && active && canonicalSha256(input.firstV2Baseline) !== active.firstV2BaselineSha256) {
    throw new Error("FIRST_V2_BASELINE_TRANSACTION_BINDING_MISMATCH");
  }
  return loadCommittedV2PredecessorAuthorityFromVerifiedChain(input, chain);
}

async function loadCommittedV2PredecessorAuthorityFromVerifiedChain(
  input: Parameters<typeof loadCommittedV2PredecessorAuthority>[0],
  chain: Awaited<ReturnType<typeof verifyChapterCommitChain>>,
): ReturnType<typeof loadCommittedV2PredecessorAuthority> {
  if (chain.latestChapter + 1 !== input.chapterNumber) throw new Error("Writer chapter predecessor gate failed");
  const latest = chain.commits.at(-1);
  if (latest?.kind === "TRUTH_CHAPTER_COMMIT") {
    const path = join(commitRoot(input.bookDir, latest.chapterNumber), "state", "truth.json");
    const truth = validateStructuredTruthV1(JSON.parse(await readFile(path, "utf8")));
    if (canonicalSha256(truth) !== latest.truthSha256 || truth.throughChapter !== latest.chapterNumber
      || truth.bookId !== latest.bookId) throw new Error("Writer committed V2 truth predecessor gate failed");
    const predecessorChapterBody = await readFile(join(commitRoot(input.bookDir, latest.chapterNumber), "chapter.md"), "utf8");
    if (sha256(predecessorChapterBody) !== latest.finalBodySha256) throw new Error("Writer committed V2 prose predecessor gate failed");
    const recentChapterBodies: string[] = [];
    for (const commit of chain.commits
      .filter((entry): entry is TruthChapterCommitV2 => entry.kind === "TRUTH_CHAPTER_COMMIT")
      .slice(-24)) {
      const body = await readFile(join(commitRoot(input.bookDir, commit.chapterNumber), "chapter.md"), "utf8");
      if (sha256(body) !== commit.finalBodySha256) throw new Error("Writer committed V2 prose history gate failed");
      recentChapterBodies.push(body);
    }
    return { truth, predecessorChapterBody, recentChapterBodies };
  }
  const baseline = input.firstV2Baseline ?? await loadDurableFirstV2BaselineFromVerifiedChain(input.bookDir, input.chapterNumber, chain);
  if (!baseline || latest?.kind !== "CHAPTER_COMMIT" || latest.commitSha256 !== chain.latestAuthoritySha256
    || latest.bookId !== chain.bookId || latest.chapterNumber !== chain.latestChapter
    || baseline.previousAuthoritySha256 !== latest.commitSha256
    || baseline.truthSha256 !== canonicalSha256(baseline.truth)
    || baseline.vocabularyCatalogSha256 !== canonicalSha256(baseline.truth.vocabulary)
    || baseline.predecessorChapterBodySha256 !== sha256(baseline.predecessorChapterBody)
    || baseline.truth.bookId !== chain.bookId || baseline.truth.throughChapter !== chain.latestChapter) {
    throw new Error("Writer requires committed V2 truth predecessor or a host-verified first-V2 baseline");
  }
  const sourceRoot = join(commitRoot(input.bookDir, latest.chapterNumber), "state");
  const sourceFiles = Object.fromEntries((await listFiles(sourceRoot)).map((file) => [file.relativePath, file.content]));
  const truth = validateBaselineAuthorityV1({
    truth: baseline.truth, sourceManifest: baseline.sourceManifest, receipt: baseline.receipt,
    sourceFiles, chapterCommit: latest,
  });
  const predecessorChapterBody = await readFile(join(commitRoot(input.bookDir, latest.chapterNumber), "chapter.md"), "utf8");
  if (sha256(predecessorChapterBody) !== latest.finalBodySha256 || predecessorChapterBody !== baseline.predecessorChapterBody) {
    throw new Error("FIRST_V2_BASELINE_PREDECESSOR_PROSE_MISMATCH");
  }
  return {
    truth,
    predecessorChapterBody,
    recentChapterBodies: [predecessorChapterBody],
  };
}

export function chapterTransactionStagingBookDir(bookDir: string, chapterNumber: number, attemptNumber = 1): string {
  return join(transactionAttemptRoot(bookDir, chapterNumber, attemptNumber), "staging", "book");
}

async function projectionStateFiles(stagingBookDir: string): Promise<Record<string, string | Uint8Array>> {
  const output: Record<string, string | Uint8Array> = {};
  const storyDir = join(stagingBookDir, "story");
  for (const name of ["current_state.md", "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md"]) {
    const content = await readFile(join(storyDir, name)).catch(() => null);
    if (content) output[name] = content;
  }
  for (const file of await listFiles(join(storyDir, "state")).catch(() => [])) output[file.relativePath] = file.content;
  return output;
}

async function collectProviderReferences(bookDir: string, chapterNumber: number, transactionId: string): Promise<ReadonlyArray<ChapterProviderReference>> {
  try {
  const dir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
  const references: ChapterProviderReference[] = [];
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".binding.json")) continue;
    const bytes = await readFile(join(dir, name));
    const artifact = JSON.parse(bytes.toString("utf-8")) as {
      readonly logical_step_id?: unknown; readonly usage_identity?: unknown; readonly chapter_number?: unknown; readonly response_artifact_status?: unknown;
      readonly content_sha256?: unknown; readonly response?: { readonly content?: unknown }; readonly role?: unknown; readonly stage?: unknown;
      readonly provider?: unknown; readonly requested_model?: unknown; readonly input_fingerprint?: unknown;
      readonly transaction_id?: unknown;
    };
    if (artifact.chapter_number !== chapterNumber || artifact.transaction_id !== transactionId) continue;
    if (typeof artifact.logical_step_id !== "string" || artifact.usage_identity !== artifact.logical_step_id || artifact.response_artifact_status !== "COMPLETE"
      || typeof artifact.content_sha256 !== "string" || typeof artifact.response?.content !== "string"
      || typeof artifact.role !== "string" || typeof artifact.stage !== "string" || typeof artifact.provider !== "string"
      || typeof artifact.requested_model !== "string" || typeof artifact.input_fingerprint !== "string"
      || sha256(artifact.response.content) !== artifact.content_sha256) {
      throw new Error("Chapter transaction Provider artifact identity mismatch");
    }
    references.push({
      transactionId, logicalOperationId: artifact.logical_step_id, chapterNumber, role: artifact.role, stage: artifact.stage,
      provider: artifact.provider, requestedModel: artifact.requested_model, inputFingerprint: artifact.input_fingerprint,
      artifactRelativePath: relative(bookDir, join(dir, name)).split(sep).join("/"), artifactSha256: sha256(bytes),
      responseContentSha256: artifact.content_sha256, responseArtifactStatus: "COMPLETE",
    });
  }
  return references.sort((left, right) => left.logicalOperationId.localeCompare(right.logicalOperationId));
  } catch (error) {
    throw asChapterArtifactEvidenceError("Chapter transaction Provider reference collection failed", error);
  }
}

/** Read and verify the existing durable provider artifacts for a V2 commit. */
export async function collectChapterProviderReferences(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly transactionId: string;
}): Promise<ReadonlyArray<ChapterProviderReference>> {
  return collectProviderReferences(input.bookDir, input.chapterNumber, input.transactionId);
}

export async function stageChapterCommitFromProjection(input: {
  readonly bookDir: string;
  readonly stagingBookDir: string;
  readonly transactionId: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly language?: "zh" | "en";
  readonly body: string;
  readonly lengthSpec: LengthSpec;
  readonly review: ChapterCommitReviewAuthority;
  readonly stateValidation: Omit<ChapterStateValidationAuthority, "chapterNumber" | "finalCandidateSha256" | "previousAuthoritySha256">;
  readonly usage: unknown;
  readonly completedAt?: string;
}): Promise<void> {
  const candidateSha = sha256(input.body);
  const stateFiles = await projectionStateFiles(input.stagingBookDir);
  const snapshotRoot = join(input.stagingBookDir, "story", "snapshots", String(input.chapterNumber));
  const snapshotFiles = Object.fromEntries((await listFiles(snapshotRoot)).map((file) => [file.relativePath, file.content]));
  const bindManifest = (files: Record<string, string | Uint8Array>, path: string, label: string) => {
    const raw = files[path];
    if (!raw) throw new Error(`${label} manifest is missing from staging`);
    const manifest = JSON.parse(Buffer.from(raw).toString("utf-8")) as Record<string, unknown>;
    files[path] = JSON.stringify({ ...manifest, candidateSha256: candidateSha, previousAuthoritySha256: transaction.record.previousAuthoritySha256 }, null, 2);
  };
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  bindManifest(stateFiles, "manifest.json", "State");
  bindManifest(snapshotFiles, "state/manifest.json", "Snapshot");
  const providerReferences = await collectProviderReferences(input.bookDir, input.chapterNumber, input.transactionId);
  const stateValidation: ChapterStateValidationAuthority = {
    ...input.stateValidation,
    chapterNumber: input.chapterNumber,
    finalCandidateSha256: candidateSha,
    previousAuthoritySha256: transaction.record.previousAuthoritySha256,
  };
  await stageChapterCommitCandidate({
    bookDir: input.bookDir, transactionId: input.transactionId, title: input.title, language: input.language, body: input.body,
    lengthSpec: input.lengthSpec, review: input.review, stateFiles, snapshotFiles, usage: input.usage, stateValidation,
    providerReferences, completedAt: input.completedAt ?? new Date().toISOString(),
  });
}
