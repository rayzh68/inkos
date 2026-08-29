import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { LengthSpec } from "../models/length-governance.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";

export type ChapterAuthorityState = "NOT_STARTED" | "STAGING" | "COMMITTED";
export type ChapterCommitReviewStatus = "APPROVED" | "ACCEPTED_WITH_FINDINGS";

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

interface TreeEntry {
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
}

export interface ChapterCommit {
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

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
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
}): Promise<ChapterTransactionHandle> {
  const authority = await inspectChapterAuthority({ bookDir: input.bookDir });
  if (authority.bookId !== input.bookId || authority.nextChapter !== input.chapterNumber) throw new Error("Chapter transaction does not match authoritative next chapter");
  const transactionId = `chapter-txn-${sha256(canonical({ bookId: input.bookId, chapterNumber: input.chapterNumber, previousAuthoritySha256: authority.latestAuthoritySha256, productionAuthority: input.productionAuthority })).slice(0, 40)}`;
  const root = transactionRoot(input.bookDir, input.chapterNumber);
  const path = join(root, "transaction.json");
  const expected: ChapterTransactionRecord = {
    schemaVersion: 1, kind: "CHAPTER_TRANSACTION", transactionId, bookId: input.bookId,
    chapterNumber: input.chapterNumber, previousAuthoritySha256: authority.latestAuthoritySha256,
    productionAuthority: input.productionAuthority, state: "STAGING", createdAt: input.createdAt ?? new Date().toISOString(),
  };
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
  return { ...transaction, completedOperations: await completedOperations(root), hash: sha256 };
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
    chapterNumber: transaction.chapterNumber,
    stage: input.stage,
    inputFingerprint: input.inputFingerprint,
    responseArtifactStatus: input.responseArtifactStatus,
    responseSha256: input.responseSha256,
  };
  const path = join(transactionRoot(input.bookDir, transaction.chapterNumber), "operations", `${sha256(input.logicalOperationId)}.json`);
  try {
    await writeJsonExclusive(path, record);
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
  const root = join(transactionRoot(input.bookDir, transaction.chapterNumber), "staging", "evidence", "candidates");
  const target = join(root, input.label);
  const bodyPath = join(target, "body.md");
  const metadataPath = join(target, "metadata.json");
  const metadata = { schemaVersion: 1, label: input.label, sha256: input.sha256 };
  await mkdir(root, { recursive: true });
  await cleanupSiblingTemps(target);
  if (await exists(target)) {
    try {
      const [body, persisted] = await Promise.all([readFile(bodyPath, "utf-8"), readJson(metadataPath)]);
      if (body === input.content && canonical(persisted) === canonical(metadata)) return;
      throw new Error(`Staged candidate ${input.label} is immutable`);
    } catch (error) {
      const incomplete = (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError;
      if (!incomplete) throw error;
      await rm(target, { recursive: true, force: true });
    }
  }
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temp, { recursive: false });
  try {
    await writeFile(join(temp, "body.md"), input.content, { encoding: "utf-8", flag: "wx" });
    await writeFile(join(temp, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
    await rename(temp, target);
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
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(input.candidateSha256)) throw new Error("Review candidate SHA is invalid");
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const reviewer = input.reviewerRole.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
  const evidenceSha256 = sha256(canonical(input.evidence));
  const path = join(
    transactionRoot(input.bookDir, transaction.chapterNumber),
    "staging", "evidence", "reviews", input.candidateSha256, reviewer, `${evidenceSha256}.json`,
  );
  const record = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    chapterNumber: transaction.chapterNumber,
    candidateSha256: input.candidateSha256,
    reviewerRole: input.reviewerRole,
    evidenceSha256,
    evidence: input.evidence,
  };
  try { await writeJsonExclusive(path, record); }
  catch (error) { throw new Error("Staged reviewer evidence is immutable", { cause: error }); }
  return path;
}

export async function recordChapterTransactionReviewResult(input: {
  readonly bookDir: string;
  readonly transactionId: string;
  readonly result: unknown;
}): Promise<string> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const path = join(transactionRoot(input.bookDir, transaction.chapterNumber), "staging", "evidence", "review-result.json");
  const record = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    chapterNumber: transaction.chapterNumber,
    result: input.result,
  };
  try { await writeJsonExclusive(path, record); }
  catch (error) { throw new Error("Staged bounded-review result is immutable", { cause: error }); }
  return path;
}

async function findTransaction(bookDir: string, transactionId: string): Promise<ChapterTransactionRecord> {
  const base = join(bookDir, "story", "runtime", "chapter-transactions");
  for (const entry of await readdir(base).catch(() => [])) {
    const path = join(base, entry, "transaction.json");
    const transaction = await readJson<ChapterTransactionRecord>(path).catch(() => null);
    if (transaction?.transactionId === transactionId) return transaction;
  }
  throw new Error(`Unknown chapter transaction: ${transactionId}`);
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

async function verifyProviderReference(bookDir: string, transaction: ChapterTransactionRecord, reference: ChapterProviderReference): Promise<void> {
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
    readonly response_artifact_status?: unknown; readonly content_sha256?: unknown; readonly response?: { readonly content?: unknown };
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
  const bodySha = sha256(input.body);
  const finalLengthCount = countChapterLength(input.body, input.lengthSpec.countingMode);
  if (!input.title.trim()) throw new Error("Chapter commit title is empty");
  if (!input.body.trim()) throw new Error("Chapter commit body is empty");
  if (isOutsideHardRange(finalLengthCount, input.lengthSpec)) throw new Error("Chapter commit candidate is outside hard range");
  validateReviewAuthority(input.review, bodySha);
  validateStateValidationAuthority(input.stateValidation, transaction.chapterNumber, bodySha, transaction.previousAuthoritySha256);
  const stateManifest = input.stateFiles["manifest.json"];
  const snapshotManifest = input.snapshotFiles["state/manifest.json"];
  if (typeof stateManifest !== "string" || typeof snapshotManifest !== "string") throw new Error("State and snapshot manifests are required");
  parseStateManifest(stateManifest, transaction.chapterNumber, bodySha, transaction.previousAuthoritySha256, "State");
  parseStateManifest(snapshotManifest, transaction.chapterNumber, bodySha, transaction.previousAuthoritySha256, "Snapshot");
  if (input.providerReferences.length === 0) throw new Error("Chapter commit requires Provider operation authority");
  for (const reference of input.providerReferences) await verifyProviderReference(input.bookDir, transaction, reference);
  for (const reviewer of input.review.reviewerEvidence) {
    const acceptedRoles = reviewer.reviewerRole === "logic-canon-auditor" ? ["logic-canon-auditor", "auditor"] : ["commercial-reader"];
    if (!input.providerReferences.some((reference) => acceptedRoles.includes(reference.role)
      && reference.provider === reviewer.provider && reference.requestedModel === reviewer.model)) {
      throw new Error(`Chapter commit ${reviewer.reviewerRole} Provider authority is missing`);
    }
  }

  const root = join(transactionRoot(input.bookDir, transaction.chapterNumber), "staging", "bundle");
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
    let existing: ChapterCommit | null = null;
    try { existing = await verifyBundle(root, transaction.chapterNumber); }
    catch (error) {
      let marker: unknown;
      try { marker = await readJson(join(root, "commit.json")); } catch { marker = null; }
      if (marker && typeof marker === "object" && (marker as { kind?: unknown }).kind === "CHAPTER_COMMIT") throw error;
      await rm(root, { recursive: true, force: true });
    }
    if (existing) {
    if (existing.transactionId === transaction.transactionId
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
  await cleanupSiblingTemps(root);
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
    schemaVersion: 1 as const, kind: "CHAPTER_COMMIT" as const, bookId: transaction.bookId,
    chapterNumber: transaction.chapterNumber, chapterTitle: input.title, language: input.language ?? "en", transactionId: transaction.transactionId,
    productionAuthority: transaction.productionAuthority,
    previousAuthoritySha256: transaction.previousAuthoritySha256, finalBodySha256: bodySha, finalLengthCount,
    lengthSpec: input.lengthSpec, boundedReviewStatus: input.review.status, revisionCount: input.review.revisionCount,
    reviewEvidenceSha256: sha256(reviewText), finalCandidateSha256: bodySha,
    stateManifestSha256: sha256(stateManifest), snapshotManifestSha256: sha256(snapshotManifest), stateValidationSha256: sha256(stateValidationText),
    stateTreeSha256: treeSha(stateFiles), snapshotTreeSha256: treeSha(snapshotFiles), stateFiles, snapshotFiles,
    usageSha256: sha256(usageText), providerReferencesSha256: sha256(providerText), providerReferenceCount: input.providerReferences.length,
    createdAt: transaction.createdAt, completedAt: input.completedAt,
  };
  const commit: ChapterCommit = { ...unsigned, commitSha256: sha256(canonical(unsigned)) };
  await writeFile(join(tempRoot, "commit.json"), `${JSON.stringify(commit, null, 2)}\n`, "utf-8");
  try {
    await verifyBundle(tempRoot, transaction.chapterNumber);
    await rename(tempRoot, root);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeChapterTransaction(input: { readonly bookDir: string; readonly transactionId: string }): Promise<ChapterCommit> {
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  const source = join(transactionRoot(input.bookDir, transaction.chapterNumber), "staging", "bundle");
  const target = commitRoot(input.bookDir, transaction.chapterNumber);
  await verifyBundle(source, transaction.chapterNumber);
  if (await exists(target)) {
    const existing = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.chapterNumber });
    const staged = await readJson<ChapterCommit>(join(source, "commit.json"));
    if (existing.commitSha256 !== staged.commitSha256) throw new Error("Immutable chapter commit conflict");
    return existing;
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  return verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: transaction.chapterNumber });
}

async function verifyBundle(root: string, chapterNumber: number): Promise<ChapterCommit> {
  const commit = await readJson<ChapterCommit>(join(root, "commit.json"));
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
    if (!references.some((reference) => acceptedRoles.includes(reference.role)
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

export async function verifyChapterCommit(input: { readonly bookDir: string; readonly chapterNumber: number }): Promise<ChapterCommit> {
  const commit = await verifyBundle(commitRoot(input.bookDir, input.chapterNumber), input.chapterNumber);
  const references = await readJson<ReadonlyArray<ChapterProviderReference>>(join(commitRoot(input.bookDir, input.chapterNumber), "provider-refs.json"));
  const transaction: ChapterTransactionRecord = {
    schemaVersion: 1, kind: "CHAPTER_TRANSACTION", transactionId: commit.transactionId, bookId: commit.bookId,
    chapterNumber: commit.chapterNumber, previousAuthoritySha256: commit.previousAuthoritySha256,
    productionAuthority: commit.productionAuthority, state: "STAGING", createdAt: commit.createdAt,
  };
  for (const reference of references) {
    await verifyProviderReference(input.bookDir, transaction, reference);
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
  for (const chapter of dirs) {
    if (chapter !== expected) throw new Error(`Chapter commit chain is not contiguous: missing chapter ${expected}`);
    const commit = await verifyChapterCommit({ bookDir: input.bookDir, chapterNumber: chapter });
    if (commit.bookId !== genesis.bookId || commit.previousAuthoritySha256 !== previous) throw new Error(`Chapter ${chapter} previous commit chain mismatch`);
    commits.push(commit);
    previous = commit.commitSha256;
    expected += 1;
  }
  return { bookId: genesis.bookId, latestChapter: expected - 1, latestAuthoritySha256: previous, commits, genesis };
}

export async function inspectChapterAuthority(input: { readonly bookDir: string }): Promise<{ readonly bookId: string; readonly state: ChapterAuthorityState; readonly latestChapter: number; readonly nextChapter: number; readonly latestAuthoritySha256: string; readonly activeTransactionId?: string }> {
  const chain = await verifyChapterCommitChain(input);
  const root = transactionRoot(input.bookDir, chain.latestChapter + 1);
  const transaction = await readJson<ChapterTransactionRecord>(join(root, "transaction.json")).catch(() => null);
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
  await commitAtomicFileSet({ rootDir: input.bookDir, writes, deletes });
}

export async function isChapterTransactionEnabled(bookDir: string): Promise<boolean> {
  return exists(join(authorityRoot(bookDir), "genesis.json"));
}

export async function assertChapterWriterStartAllowed(input: { readonly bookDir: string; readonly chapterNumber: number }): Promise<void> {
  if (!(await isChapterTransactionEnabled(input.bookDir))) return;
  const chain = await verifyChapterCommitChain({ bookDir: input.bookDir });
  if (chain.latestChapter + 1 !== input.chapterNumber) throw new Error("CHAPTER_TRANSACTION_WRITER_START_AUTHORITY_MISMATCH");
}

export function chapterTransactionStagingBookDir(bookDir: string, chapterNumber: number): string {
  return join(transactionRoot(bookDir, chapterNumber), "staging", "book");
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
  const dir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
  const references: ChapterProviderReference[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
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
    files[path] = JSON.stringify({ ...manifest, candidateSha256: candidateSha, previousAuthoritySha256: transaction.previousAuthoritySha256 }, null, 2);
  };
  const transaction = await findTransaction(input.bookDir, input.transactionId);
  bindManifest(stateFiles, "manifest.json", "State");
  bindManifest(snapshotFiles, "state/manifest.json", "Snapshot");
  const providerReferences = await collectProviderReferences(input.bookDir, input.chapterNumber, input.transactionId);
  const stateValidation: ChapterStateValidationAuthority = {
    ...input.stateValidation,
    chapterNumber: input.chapterNumber,
    finalCandidateSha256: candidateSha,
    previousAuthoritySha256: transaction.previousAuthoritySha256,
  };
  await stageChapterCommitCandidate({
    bookDir: input.bookDir, transactionId: input.transactionId, title: input.title, language: input.language, body: input.body,
    lengthSpec: input.lengthSpec, review: input.review, stateFiles, snapshotFiles, usage: input.usage, stateValidation,
    providerReferences, completedAt: input.completedAt ?? new Date().toISOString(),
  });
}
