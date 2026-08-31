import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { parseBookProductionMap, resolveProductionScope, type BookProductionMap, type ProductionMode } from "./book-production-map.js";
import type { ChapterMeta } from "../models/chapter.js";
import {
  classifyLLMCallFailure,
  LLMCallExecutionError,
  runWithLLMCallExecutionPolicy,
  type LLMCallFailureMetadata,
  type LLMCallExecutionIdentity,
  type LLMCallExecutionPolicy,
  type LLMResponse,
} from "../llm/provider.js";
import { classifyFinalAuditDecision, type ReviewerRole, type ScoredReview } from "../pipeline/bounded-review.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { countChapterLength, resolveLengthCountingMode } from "../utils/length-metrics.js";

export type AutonomousRunStatus =
  | "RUNNING"
  | "VOLUME_COMPLETE"
  | "BOOK_COMPLETE"
  | "PAUSED_BY_USER"
  | "WAITING_PROVIDER_RETRY"
  | "PAUSED_PROVIDER_UNAVAILABLE"
  | "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME"
  | "PAUSED_DETERMINISTIC_PROVIDER_ERROR"
  | "PAUSED_PIPELINE_ERROR"
  | "BLOCKED_CRITICAL_FINDINGS"
  | "REVIEW_DECISION_CONTRADICTORY"
  | "REVIEW_EXHAUSTED"
  | "HELD_AFTER_TWO_REVISIONS"
  | "REVIEW_OUTPUT_INVALID";

interface AutonomousRecoveryOwnershipIdentity {
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}

export type AutonomousRecoveryOwnership = AutonomousRecoveryOwnershipIdentity & ({
  readonly kind: "FORMAL_OFFLINE_FINALIZATION" | "FORMAL_BOUNDED_STATE_REBASELINE";
  readonly recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED" | "FAILED_REENTRY";
} | {
  readonly kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME";
  readonly recoveryClass: "PRESERVED_BOUNDED_REVIEW";
});

export interface AutonomousRunProgress {
  readonly jobId: string;
  readonly status: AutonomousRunStatus;
  readonly mode: ProductionMode;
  readonly volumeId: string;
  readonly startChapter: number;
  readonly targetChapter: number;
  readonly nextChapter: number;
  readonly completedThisRun: number;
  readonly reason?: string;
  readonly logicalStepId?: string;
  readonly chapterNumber?: number;
  readonly role?: string;
  readonly stage?: string;
  readonly provider?: string;
  readonly requestedModel?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly transportRetryCount?: number;
  readonly transportAttemptId?: string;
  readonly providerAttemptHistory?: ReadonlyArray<{
    readonly transportAttemptId: string;
    readonly logicalStepId: string;
    readonly chapterNumber: number;
    readonly role: string;
    readonly provider: string;
    readonly requestedModel: string;
    readonly transactionId?: string;
    readonly attempt: number;
    readonly classification: string;
    readonly transportStarted: boolean;
    readonly transportReturned: boolean;
    readonly httpStatus?: number;
    readonly recordedAt: string;
  }>;
  readonly nextRetryAt?: string;
  readonly retryAfterMs?: number;
  readonly lastRetryableClassification?: string;
  readonly lastErrorClassification?: string;
  readonly lastHttpStatus?: number;
  readonly checkpoint?: string;
  readonly responseArtifactStatus?: "NONE" | "COMPLETE";
  readonly revisionRound?: number;
  readonly reviewRound?: number;
  readonly revisionCount?: number;
  readonly invalidReviewerRole?: string;
  readonly recoveryOwnership?: AutonomousRecoveryOwnership | null;
}

export interface AutonomousStageMetadata {
  readonly stage: string;
  readonly role: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly revisionRound?: number;
  readonly reviewRound?: number;
  readonly transactionId?: string;
}

export interface AutonomousProviderRecovery {
  readonly execute: <T>(chapterNumber: number, task: () => Promise<T>) => Promise<T>;
  readonly loadPersistedProgress: () => Promise<AutonomousRunProgress | null>;
  readonly now: () => number;
  readonly sleep: (delayMs: number) => Promise<void>;
}

export function autonomousProductionStatePath(projectRoot: string, bookId: string): string {
  return join(projectRoot, "books", bookId, "story", "runtime", "bounded-autonomous", "production-state.json");
}

export interface AutonomousJobClaim {
  readonly jobId: string;
  readonly claimId: string;
  readonly ownerPid: number;
}

function autonomousProductionLeasePath(projectRoot: string, bookId: string): string {
  return join(projectRoot, "books", bookId, "story", "runtime", "bounded-autonomous", "active-job.json");
}

const AUTONOMOUS_HEARTBEAT_STALE_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
let currentProcessIdentity: Promise<string | null> | undefined;

async function queryProcessIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`,
      ], { windowsHide: true });
      return `win32:${pid}:${stdout.trim()}`;
    }
    if (process.platform === "linux") {
      const raw = await readFile(`/proc/${pid}/stat`, "utf-8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      return `linux:${pid}:${fields[19] ?? ""}`;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    return `${process.platform}:${pid}:${stdout.trim()}`;
  } catch {
    return null;
  }
}

function defaultProcessIdentity(pid: number): Promise<string | null> {
  if (pid !== process.pid) return queryProcessIdentity(pid);
  currentProcessIdentity ??= queryProcessIdentity(pid);
  return currentProcessIdentity;
}

function autonomousHeartbeatPath(leasePath: string, claimId: string): string {
  return `${leasePath}.heartbeat.${claimId}`;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function claimIsActive(
  leasePath: string,
  claim: AutonomousJobClaim,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (!isProcessAlive(claim.ownerPid)) return false;
  try {
    const heartbeat = JSON.parse(await readFile(autonomousHeartbeatPath(leasePath, claim.claimId), "utf-8")) as { updatedAt?: string };
    const updatedAt = Date.parse(heartbeat.updatedAt ?? "");
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= AUTONOMOUS_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

const localLeaseGuardQueues = new Map<string, Promise<void>>();

async function withAutonomousLeaseGuardUnqueued<T>(
  leasePath: string,
  task: () => Promise<T>,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
  getProcessIdentity: (pid: number) => Promise<string | null> = defaultProcessIdentity,
): Promise<T> {
  interface GuardParticipant {
    readonly token: string;
    readonly ownerPid: number;
    readonly ownerIdentity: string;
    readonly ticket: number | null;
    readonly choosing: boolean;
    readonly updatedAt: string;
  }
  const guardDir = `${leasePath}.reclaim-contenders`;
  const token = randomUUID();
  const participantPath = join(guardDir, `${token}.json`);
  await mkdir(guardDir, { recursive: true });
  const ownerIdentity = await getProcessIdentity(process.pid);
  if (!ownerIdentity) throw new Error("AUTONOMOUS_JOB_PROCESS_IDENTITY_UNAVAILABLE");

  const writeParticipant = async (participant: GuardParticipant): Promise<void> => {
    const temp = `${participantPath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(participant)}\n`, "utf-8");
    await rename(temp, participantPath);
  };
  const readParticipants = async (): Promise<Array<{ path: string; participant: GuardParticipant | null; active: boolean }>> => {
    const entries = await readdir(guardDir);
    return Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
      const path = join(guardDir, entry);
      try {
        const [raw, metadata] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
        try {
          const participant = JSON.parse(raw) as GuardParticipant;
          const updatedAt = Date.parse(participant.updatedAt);
          const valid = typeof participant.token === "string"
            && Number.isInteger(participant.ownerPid)
            && typeof participant.ownerIdentity === "string"
            && participant.ownerIdentity.length > 0
            && (participant.ticket === null || Number.isInteger(participant.ticket))
            && typeof participant.choosing === "boolean"
            && Number.isFinite(updatedAt);
          const ownerIsAlive = valid && isProcessAlive(participant.ownerPid);
          const liveIdentity = ownerIsAlive
            ? await getProcessIdentity(participant.ownerPid)
            : null;
          return {
            path,
            participant: valid ? participant : null,
            active: valid
              ? ownerIsAlive && (liveIdentity === null || liveIdentity === participant.ownerIdentity)
              : Date.now() - metadata.mtimeMs <= AUTONOMOUS_HEARTBEAT_STALE_MS,
          };
        } catch {
          return { path, participant: null, active: Date.now() - metadata.mtimeMs <= AUTONOMOUS_HEARTBEAT_STALE_MS };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, participant: null, active: false };
        throw error;
      }
    }));
  };

  const initialHandle = await open(participantPath, "wx");
  await initialHandle.writeFile(`${JSON.stringify({ token, ownerPid: process.pid, ownerIdentity, ticket: null, choosing: true, updatedAt: new Date().toISOString() })}\n`, "utf-8");
  await initialHandle.close();
  try {
    const observed = await readParticipants();
    if (observed.some((contender) => contender.active && !contender.participant)) {
      throw new Error("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
    }
    const ticket = 1 + observed.reduce((maximum, contender) => {
      const value = contender.active ? contender.participant?.ticket : null;
      return typeof value === "number" ? Math.max(maximum, value) : maximum;
    }, 0);
    await writeParticipant({ token, ownerPid: process.pid, ownerIdentity, ticket, choosing: false, updatedAt: new Date().toISOString() });

    let acquired = false;
    for (let attempt = 0; attempt < 3_000 && !acquired; attempt += 1) {
      const contenders = await readParticipants();
      if (contenders.some((contender) => contender.active && !contender.participant)) {
        throw new Error("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
      }
      const choosing = contenders.some((contender) => {
        if (!contender.active || contender.participant?.token === token) return false;
        if (!contender.participant || contender.participant.choosing || contender.participant.ticket === null) return true;
        return false;
      });
      if (choosing) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const blocked = contenders.some((contender) => {
        if (!contender.active || contender.participant?.token === token || !contender.participant || contender.participant.ticket === null) return false;
        return contender.participant.ticket < ticket
          || (contender.participant.ticket === ticket && contender.participant.token < token);
      });
      if (blocked) throw new Error("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
      acquired = true;
    }
    if (!acquired) throw new Error("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
    await writeParticipant({ token, ownerPid: process.pid, ownerIdentity, ticket, choosing: false, updatedAt: new Date().toISOString() });
    return await task();
  } finally {
    await unlink(participantPath).catch(() => undefined);
  }
}

async function withAutonomousLeaseGuard<T>(
  leasePath: string,
  task: () => Promise<T>,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
  getProcessIdentity: (pid: number) => Promise<string | null> = defaultProcessIdentity,
): Promise<T> {
  const previous = localLeaseGuardQueues.get(leasePath) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.catch(() => undefined).then(() => held);
  localLeaseGuardQueues.set(leasePath, tail);
  await previous.catch(() => undefined);
  try {
    return await withAutonomousLeaseGuardUnqueued(leasePath, task, isProcessAlive, getProcessIdentity);
  } finally {
    unlock();
    if (localLeaseGuardQueues.get(leasePath) === tail) localLeaseGuardQueues.delete(leasePath);
  }
}

async function writeAutonomousHeartbeat(leasePath: string, claim: AutonomousJobClaim): Promise<void> {
  const path = autonomousHeartbeatPath(leasePath, claim.claimId);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...claim, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  await rename(temp, path);
}

/** Atomically grants the single cross-process right to run one book job. */
export async function claimAutonomousJob(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly ownerPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly getProcessIdentity?: (pid: number) => Promise<string | null>;
}): Promise<AutonomousJobClaim> {
  const path = autonomousProductionLeasePath(params.projectRoot, params.bookId);
  const ownerPid = params.ownerPid ?? process.pid;
  const isProcessAlive = params.isProcessAlive ?? defaultProcessAlive;
  const getProcessIdentity = params.getProcessIdentity ?? defaultProcessIdentity;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim: AutonomousJobClaim = { jobId: params.jobId, claimId: randomUUID(), ownerPid };
    await writeAutonomousHeartbeat(path, claim);
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ ...claim, acquiredAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
      } finally {
        await handle.close();
      }
      return claim;
    } catch (error) {
      await unlink(autonomousHeartbeatPath(path, claim.claimId)).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let existing: AutonomousJobClaim;
    try {
      existing = JSON.parse(await readFile(path, "utf-8")) as AutonomousJobClaim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("AUTONOMOUS_JOB_LEASE_INVALID", { cause: error });
    }
    if (await claimIsActive(path, existing, isProcessAlive)) {
      throw new Error("AUTONOMOUS_JOB_ALREADY_RUNNING");
    }
    await withAutonomousLeaseGuard(path, async () => {
      let current: AutonomousJobClaim;
      try {
        current = JSON.parse(await readFile(path, "utf-8")) as AutonomousJobClaim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (current.claimId !== existing.claimId || current.jobId !== existing.jobId || current.ownerPid !== existing.ownerPid) {
        throw new Error("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
      }
      if (await claimIsActive(path, current, isProcessAlive)) throw new Error("AUTONOMOUS_JOB_ALREADY_RUNNING");
      await rename(path, `${path}.stale.${current.claimId}.${randomUUID()}`);
    }, isProcessAlive, getProcessIdentity);
  }
  throw new Error("AUTONOMOUS_JOB_CLAIM_CONFLICT");
}

export async function refreshAutonomousJobClaim(
  projectRoot: string,
  bookId: string,
  claim: AutonomousJobClaim,
): Promise<void> {
  const path = autonomousProductionLeasePath(projectRoot, bookId);
  await withAutonomousLeaseGuard(path, async () => {
    const current = JSON.parse(await readFile(path, "utf-8")) as AutonomousJobClaim;
    if (current.claimId !== claim.claimId || current.jobId !== claim.jobId || current.ownerPid !== claim.ownerPid) {
      throw new Error("AUTONOMOUS_JOB_CLAIM_LOST");
    }
    await writeAutonomousHeartbeat(path, claim);
  });
}

export function startAutonomousJobHeartbeat(
  projectRoot: string,
  bookId: string,
  claim: AutonomousJobClaim,
  onFailure?: (error: unknown) => void,
): () => void {
  const timer = setInterval(() => {
    void refreshAutonomousJobClaim(projectRoot, bookId, claim).catch((error) => onFailure?.(error));
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function releaseAutonomousJob(
  projectRoot: string,
  bookId: string,
  claim: AutonomousJobClaim,
): Promise<void> {
  const path = autonomousProductionLeasePath(projectRoot, bookId);
  await withAutonomousLeaseGuard(path, async () => {
    let existing: AutonomousJobClaim;
    try {
      existing = JSON.parse(await readFile(path, "utf-8")) as AutonomousJobClaim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (existing.claimId !== claim.claimId || existing.jobId !== claim.jobId || existing.ownerPid !== claim.ownerPid) return;
    const released = `${path}.released.${claim.claimId}.${randomUUID()}`;
    await rename(path, released);
    await unlink(released);
  });
  await unlink(autonomousHeartbeatPath(path, claim.claimId)).catch(() => undefined);
}

export async function loadAutonomousProductionState<T>(projectRoot: string, bookId: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(autonomousProductionStatePath(projectRoot, bookId), "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveAutonomousProductionState(
  projectRoot: string,
  bookId: string,
  state: object,
): Promise<void> {
  const path = autonomousProductionStatePath(projectRoot, bookId);
  const temp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  await rename(temp, path);
}

interface PersistedProviderResponseArtifact {
  readonly schema_version: "1.0";
  readonly job_id: string;
  readonly logical_step_id: string;
  readonly usage_identity: string;
  readonly chapter_number: number;
  readonly role: string;
  readonly stage: string;
  readonly provider: string;
  readonly requested_model: string;
  readonly input_fingerprint: string;
  readonly response_artifact_status: "COMPLETE";
  readonly content_sha256: string;
  readonly response: LLMResponse;
  readonly completed_at: string;
  readonly transaction_id?: string;
}

const MAX_CHAPTER_TRANSACTION_LOGICAL_CALLS = 18;
const MAX_CHAPTER_TRANSACTION_PROVIDER_TRANSPORTS = 24;
const RETURNED_TRANSPORT_CHECKPOINT_FAILURE = "AUTONOMOUS_RETURNED_TRANSPORT_CHECKPOINT_FAILURE";

interface ReturnedTransportCheckpointFailureEnvelope {
  readonly code: typeof RETURNED_TRANSPORT_CHECKPOINT_FAILURE;
  readonly checkpoint: {
    readonly jobId: string;
    readonly chapterNumber: number;
    readonly logicalStepId: string;
    readonly providerAttemptHistory: AutonomousRunProgress["providerAttemptHistory"];
  };
}

async function loadTransactionCompleteLogicalStepIds(
  projectRoot: string,
  bookId: string,
  transactionId: string,
): Promise<ReadonlySet<string>> {
  const dir = providerResponseArtifactDir(projectRoot, bookId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const ids = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".binding.json"))) {
    try {
      const artifact = JSON.parse(await readFile(join(dir, name), "utf-8")) as PersistedProviderResponseArtifact;
      if (artifact.response_artifact_status === "COMPLETE"
        && artifact.transaction_id === transactionId
        && artifact.logical_step_id === name.slice(0, -5)) {
        ids.add(artifact.logical_step_id);
      }
    } catch {
      // Invalid artifacts are handled fail-closed by the normal replay path. They
      // cannot contribute trusted budget authority here.
    }
  }
  return ids;
}

interface CorrectedProviderArtifactBinding {
  readonly schema_version: "1.0";
  readonly binding_type: "CORRECTED_PENDING_CHAPTER_REFERENCE";
  readonly job_id: string;
  readonly logical_step_id: string;
  readonly chapter_number: number;
  readonly source_chapter_number: number;
  readonly source_logical_step_id: string;
  readonly source_artifact_sha256: string;
  readonly source_content_sha256: string;
  readonly resume_evidence_sha256: string;
  readonly created_at: string;
}

const FINAL_REVIEW_DIMENSIONS = [
  "blueprint_transition",
  "causal_logic",
  "canon_continuity",
  "character_motivation",
  "state_inheritance",
  "hooks_disclosure",
  "narrative_clarity",
] as const;

interface AcceptedFinalReview {
  readonly decision: "APPROVED" | "ACCEPTED_WITH_FINDINGS";
  readonly overallScore: number;
  readonly issues: ReadonlyArray<{
    readonly severity: "critical" | "warning" | "info";
    readonly explicitSeverity?: "MAJOR";
    readonly category: string;
    readonly description: string;
    readonly suggestion: string;
    readonly repairScope?: "local" | "structural" | "unknown";
    readonly blocking?: boolean;
  }>;
}

function parseAcceptedFinalReview(content: string): AcceptedFinalReview | null {
  try {
    const parsed = JSON.parse(content) as {
      readonly passed?: unknown;
      readonly overall_score?: unknown;
      readonly dimension_scores?: Readonly<Record<string, unknown>>;
      readonly issues?: unknown;
      readonly summary?: unknown;
    };
    if (!(typeof parsed.passed === "boolean"
      && typeof parsed.overall_score === "number" && Number.isFinite(parsed.overall_score)
      && parsed.dimension_scores !== undefined
      && FINAL_REVIEW_DIMENSIONS.every((dimension) => typeof parsed.dimension_scores?.[dimension] === "number"
        && Number.isFinite(parsed.dimension_scores[dimension]))
      && Array.isArray(parsed.issues)
      && typeof parsed.summary === "string")) return null;
    const issues = parsed.issues as ReadonlyArray<{
      readonly severity?: unknown; readonly category?: unknown; readonly description?: unknown;
      readonly suggestion?: unknown; readonly repair_scope?: unknown; readonly blocking?: unknown;
    }>;
    if (!issues.every((issue) => typeof issue.category === "string" && typeof issue.description === "string"
      && typeof issue.suggestion === "string" && ["critical", "major", "warning", "info"].includes(String(issue.severity)))) return null;
    const normalizedIssues = issues.map((issue) => ({
      severity: issue.severity === "major" ? "warning" as const : issue.severity as "critical" | "warning" | "info",
      ...(issue.severity === "major" ? { explicitSeverity: "MAJOR" as const } : {}),
      category: issue.category as string,
      description: issue.description as string,
      suggestion: issue.suggestion as string,
      repairScope: issue.repair_scope as "local" | "structural" | "unknown" | undefined,
      blocking: issue.blocking as boolean | undefined,
    }));
    const decision = classifyFinalAuditDecision({
      passed: parsed.passed,
      overallScore: parsed.overall_score,
      dimensionScores: parsed.dimension_scores as Readonly<Record<string, number>>,
      issues: normalizedIssues,
      summary: parsed.summary,
    });
    return decision === "APPROVED" || decision === "ACCEPTED_WITH_FINDINGS"
      ? { decision, overallScore: parsed.overall_score, issues: normalizedIssues }
      : null;
  } catch {
    return null;
  }
}

function isRescueCandidateResponse(artifact: PersistedProviderResponseArtifact): boolean {
  const content = artifact.response?.content;
  return typeof content === "string" && artifact.role === "reviser" && artifact.stage === "RESCUE_REVISING_2"
    && /=== REVISED_CONTENT ===\s*[\s\S]+/u.test(content);
}

function isFinalReviewArtifact(artifact: PersistedProviderResponseArtifact): boolean {
  const legacyIdentity = artifact.role === "reviser" && artifact.stage === "RESCUE_REVISING_2";
  const normalizedIdentity = artifact.role === "logicAuditor" && artifact.stage === "LOGIC_REVIEW";
  return (legacyIdentity || normalizedIdentity) && parseAcceptedFinalReview(artifact.response?.content ?? "") !== null;
}

function providerResponseArtifactDir(projectRoot: string, bookId: string): string {
  return join(projectRoot, "books", bookId, "story", "runtime", "bounded-autonomous", "provider-responses");
}

interface FormalRecoveryArtifact {
  readonly artifact: PersistedProviderResponseArtifact;
  readonly bytes: Buffer;
  readonly targetRole: "reviser" | "logicAuditor";
  readonly targetStage: "RESCUE_REVISING_2" | "LOGIC_REVIEW";
}

interface FormalPendingChapterRecoveryEvidence {
  readonly evidenceSha256: string;
  readonly artifacts: readonly [FormalRecoveryArtifact, FormalRecoveryArtifact];
}

async function resolveFormalPendingChapterRecoveryEvidence(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<FormalPendingChapterRecoveryEvidence | null> {
  const runtime = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
  const sourceChapter = params.pendingChapterNumber + 1;
  const ownership = runtime?.recoveryOwnership;
  const ownedOriginalRecovery = ownership?.bookId === params.bookId
    && ownership.jobId === params.jobId
    && ownership.pendingChapterNumber === params.pendingChapterNumber
    && ownership.recoveryClass === "ORIGINAL_REVIEW_EXHAUSTED"
    && ["RUNNING", "WAITING_PROVIDER_RETRY", "PAUSED_PROVIDER_UNAVAILABLE", "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "PAUSED_DETERMINISTIC_PROVIDER_ERROR", "PAUSED_PIPELINE_ERROR"].includes(runtime?.status ?? "");
  const originalRuntime = runtime?.status === "REVIEW_EXHAUSTED"
    && runtime.chapterNumber === sourceChapter
    && runtime.responseArtifactStatus === "COMPLETE";
  if (runtime?.jobId !== params.jobId || runtime.nextChapter !== sourceChapter || (!originalRuntime && !ownedOriginalRecovery)) return null;
  const dir = providerResponseArtifactDir(params.projectRoot, params.bookId);
  const chapter = String(params.pendingChapterNumber).padStart(4, "0");
  let evidenceBytes: Buffer;
  let evidence: {
    readonly chapter_number?: number;
    readonly status?: string;
    readonly modelOutcomes?: ReadonlyArray<{
      readonly modelCallId?: string; readonly provider?: string; readonly model?: string; readonly returnedAt?: string;
    }>;
  };
  try {
    evidenceBytes = await readFile(join(dirname(dir), `chapter-${chapter}`, "resume-review.json"));
    evidence = JSON.parse(evidenceBytes.toString("utf-8")) as typeof evidence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("AUTONOMOUS_RESUME_REVIEW_EVIDENCE_INVALID", { cause: error });
  }
  if (evidence.chapter_number !== params.pendingChapterNumber || evidence.status !== "REVIEW_EXHAUSTED") return null;
  const outcomes = evidence.modelOutcomes ?? [];
  const ids = outcomes.map((outcome) => outcome.modelCallId);
  if (ids.some((id) => !/^provider-step-[a-f0-9]{64}$/u.test(id ?? "")) || new Set(ids).size !== ids.length) {
    throw new Error("AUTONOMOUS_RESUME_REVIEW_EVIDENCE_INVALID");
  }
  const ordered: Array<{ readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer }> = [];
  for (const outcome of outcomes) {
    const id = outcome.modelCallId!;
    let bytes: Buffer;
    let artifact: PersistedProviderResponseArtifact;
    try {
      bytes = await readFile(join(dir, `${id}.json`));
      artifact = JSON.parse(bytes.toString("utf-8")) as PersistedProviderResponseArtifact;
    } catch (error) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_INVALID", { cause: error });
    }
    const contentSha = createHash("sha256").update(artifact.response?.content ?? "", "utf-8").digest("hex");
    if (artifact.schema_version !== "1.0" || artifact.job_id !== params.jobId
      || artifact.chapter_number !== sourceChapter || artifact.response_artifact_status !== "COMPLETE"
      || artifact.logical_step_id !== id || artifact.usage_identity !== id || artifact.content_sha256 !== contentSha
      || (outcome.provider !== undefined && outcome.provider !== artifact.provider)
      || (outcome.model !== undefined && outcome.model !== artifact.requested_model)) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_IDENTITY_MISMATCH");
    }
    ordered.push({ artifact, bytes });
  }
  const rescueIndexes = ordered.flatMap((entry, index) => isRescueCandidateResponse(entry.artifact) ? [index] : []);
  const finalIndexes = ordered.flatMap((entry, index) => isFinalReviewArtifact(entry.artifact) ? [index] : []);
  if (rescueIndexes.length !== 1 || finalIndexes.length !== 1 || finalIndexes[0]! <= rescueIndexes[0]!) {
    throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_SEMANTIC_MISMATCH");
  }
  for (const index of [rescueIndexes[0]!, finalIndexes[0]!]) {
    const artifact = ordered[index]!.artifact;
    const derivedSourceIdentity = logicalProviderStepId({
      jobId: artifact.job_id,
      chapterNumber: artifact.chapter_number,
      stage: { stage: artifact.stage, role: artifact.role, provider: artifact.provider, model: artifact.requested_model },
      provider: artifact.provider,
      model: artifact.requested_model,
      inputFingerprint: artifact.input_fingerprint,
    });
    if (artifact.logical_step_id !== derivedSourceIdentity) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_IDENTITY_MISMATCH");
    }
  }
  return {
    evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    artifacts: [
      { ...ordered[rescueIndexes[0]!]!, targetRole: "reviser", targetStage: "RESCUE_REVISING_2" },
      { ...ordered[finalIndexes[0]!]!, targetRole: "logicAuditor", targetStage: "LOGIC_REVIEW" },
    ],
  };
}

export async function verifyFormalPendingChapterRecoveryEvidence(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<boolean> {
  try {
    return await resolveFormalPendingChapterRecoveryEvidence(params) !== null;
  } catch {
    return false;
  }
}

export async function correctLegacyPendingChapterArtifactBindings(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<ReadonlyArray<CorrectedProviderArtifactBinding>> {
  const resolved = await resolveFormalPendingChapterRecoveryEvidence(params);
  if (!resolved) return [];
  const sourceChapter = params.pendingChapterNumber + 1;
  const dir = providerResponseArtifactDir(params.projectRoot, params.bookId);
  const bindings: CorrectedProviderArtifactBinding[] = [];
  for (const { artifact, bytes, targetRole, targetStage } of resolved.artifacts) {
    const correctedLogicalStepId = logicalProviderStepId({
      jobId: params.jobId,
      chapterNumber: params.pendingChapterNumber,
      stage: { stage: targetStage, role: targetRole, provider: artifact.provider, model: artifact.requested_model },
      provider: artifact.provider,
      model: artifact.requested_model,
      inputFingerprint: artifact.input_fingerprint,
    });
    const binding: CorrectedProviderArtifactBinding = {
      schema_version: "1.0",
      binding_type: "CORRECTED_PENDING_CHAPTER_REFERENCE",
      job_id: params.jobId,
      logical_step_id: correctedLogicalStepId,
      chapter_number: params.pendingChapterNumber,
      source_chapter_number: sourceChapter,
      source_logical_step_id: artifact.logical_step_id,
      source_artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
      source_content_sha256: artifact.content_sha256,
      resume_evidence_sha256: resolved.evidenceSha256,
      created_at: new Date().toISOString(),
    };
    const path = join(dir, `${correctedLogicalStepId}.binding.json`);
    try {
      const existing = JSON.parse(await readFile(path, "utf-8")) as CorrectedProviderArtifactBinding;
      if (JSON.stringify({ ...existing, created_at: binding.created_at }) !== JSON.stringify(binding)) {
        throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_CONFLICT");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(binding, null, 2)}\n`, "utf-8");
      try { await rename(temp, path); } catch (renameError) { await unlink(temp).catch(() => undefined); throw renameError; }
    }
    bindings.push(binding);
  }
  return bindings;
}

interface FormalPendingChapterRecoveryAuthority {
  readonly recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED" | "FAILED_REENTRY";
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
  readonly expectedLogicalChapter: number;
  readonly sourceChapterNumber: number;
  readonly productionMapSha256: string;
  readonly chapterFile: string;
  readonly currentChapterSha256: string;
  readonly evidence: {
    readonly historicalSha256: string;
    readonly currentSha256: string;
  };
  readonly rescue: {
    readonly sourceLogicalStepId: string;
    readonly sourceArtifactSha256: string;
    readonly sourceContentSha256: string;
    readonly candidateBody: string;
    readonly candidateBodySha256: string;
  };
  readonly finalReview: {
    readonly sourceLogicalStepId: string;
    readonly sourceArtifactSha256: string;
    readonly sourceContentSha256: string;
    readonly decision: "APPROVED" | "ACCEPTED_WITH_FINDINGS";
    readonly overallScore: number;
    readonly issues: AcceptedFinalReview["issues"];
  };
  readonly provenance: {
    readonly revisionCount: number;
    readonly logicReviewCount: number;
    readonly commercialReviewCount: number;
    readonly roleUsage: Readonly<Record<string, {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly actualCostUsd?: number;
    }>>;
  };
  readonly bindings: ReadonlyArray<{
    readonly logicalStepId: string;
    readonly sourceLogicalStepId: string;
    readonly sourceArtifactSha256: string;
    readonly sourceContentSha256: string;
    readonly resumeEvidenceSha256: string;
    readonly authoritySha256: string;
    readonly fileSha256?: string;
  }>;
  readonly failedReentryArtifacts: ReadonlyArray<{
    readonly logicalStepId: string;
    readonly artifactSha256: string;
    readonly contentSha256: string;
  }>;
}

export interface FormalOfflineFinalizationPlan extends FormalPendingChapterRecoveryAuthority {
  readonly kind: "FORMAL_OFFLINE_FINALIZATION";
  readonly stateSettlement: {
    readonly proofRelativePath: "state-settlement-proof.json";
    readonly proofSha256: string;
    readonly snapshotId: string;
    readonly candidateBodySha256: string;
    readonly artifacts: ReadonlyArray<{
      readonly sourceRelativePath: string;
      readonly targetRelativePath: string;
      readonly sha256: string;
      readonly content: string;
    }>;
  };
}

export interface FormalBoundedStateRebaselinePlan extends FormalPendingChapterRecoveryAuthority {
  readonly kind: "FORMAL_BOUNDED_STATE_REBASELINE";
  readonly baselineChapterNumber: number;
}

export interface FormalPreservedBoundedReviewResumePlan {
  readonly kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME";
  readonly recoveryClass: "PRESERVED_BOUNDED_REVIEW";
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
  readonly baselineChapterNumber: number;
  readonly productionMapSha256: string;
  readonly candidate: {
    readonly content: string;
    readonly sha256: string;
    readonly title: string;
    readonly titleAuthorityLogicalStepId: string;
    readonly titleAuthorityArtifactSha256: string;
  };
  readonly reviewEvidence: {
    readonly relativePath: string;
    readonly sha256: string;
    readonly runRelativePath: string;
    readonly runSha256: string;
  };
  readonly initialReviews: Partial<Readonly<Record<ReviewerRole, ScoredReview>>>;
  readonly invalidReviewerRoles: ReadonlyArray<ReviewerRole>;
  readonly historicalRoleUsage: Readonly<Record<string, RecoveryUsage>>;
  readonly terminalReconciliation?: {
    readonly status: "approved" | "accepted-with-findings";
    readonly chapterFile: string;
    readonly candidateSha256: string;
    readonly receiptRelativePath: string;
    readonly receiptSha256: string;
    readonly snapshotManifestSha256: string;
    readonly stateManifestSha256: string;
  };
}

export type FormalPendingChapterRecoveryPlan = FormalOfflineFinalizationPlan | FormalBoundedStateRebaselinePlan | FormalPreservedBoundedReviewResumePlan;

interface RecoveryBindingAuthority {
  readonly schema_version: "1.0";
  readonly binding_type: "CORRECTED_PENDING_CHAPTER_REFERENCE";
  readonly job_id: string;
  readonly logical_step_id: string;
  readonly chapter_number: number;
  readonly source_chapter_number: number;
  readonly source_logical_step_id: string;
  readonly source_artifact_sha256: string;
  readonly source_content_sha256: string;
  readonly resume_evidence_sha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function recoveryBindingAuthority(binding: CorrectedProviderArtifactBinding | RecoveryBindingAuthority): RecoveryBindingAuthority {
  return {
    schema_version: binding.schema_version,
    binding_type: binding.binding_type,
    job_id: binding.job_id,
    logical_step_id: binding.logical_step_id,
    chapter_number: binding.chapter_number,
    source_chapter_number: binding.source_chapter_number,
    source_logical_step_id: binding.source_logical_step_id,
    source_artifact_sha256: binding.source_artifact_sha256,
    source_content_sha256: binding.source_content_sha256,
    resume_evidence_sha256: binding.resume_evidence_sha256,
  };
}

function bindingAuthoritySha256(binding: CorrectedProviderArtifactBinding | RecoveryBindingAuthority): string {
  return sha256(JSON.stringify(recoveryBindingAuthority(binding)));
}

async function readRecoveryArtifact(
  dir: string,
  logicalStepId: string,
  params: { readonly jobId: string; readonly chapterNumber: number },
): Promise<{ readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer }> {
  const bytes = await readFile(join(dir, `${logicalStepId}.json`));
  const artifact = JSON.parse(bytes.toString("utf-8")) as PersistedProviderResponseArtifact;
  const contentSha = sha256(artifact.response?.content ?? "");
  const derived = logicalProviderStepId({
    jobId: artifact.job_id,
    chapterNumber: artifact.chapter_number,
    stage: { stage: artifact.stage, role: artifact.role, provider: artifact.provider, model: artifact.requested_model },
    provider: artifact.provider,
    model: artifact.requested_model,
    inputFingerprint: artifact.input_fingerprint,
  });
  if (artifact.schema_version !== "1.0" || artifact.job_id !== params.jobId
    || artifact.chapter_number !== params.chapterNumber || artifact.response_artifact_status !== "COMPLETE"
    || artifact.logical_step_id !== logicalStepId || artifact.usage_identity !== logicalStepId
    || artifact.content_sha256 !== contentSha || derived !== logicalStepId) {
    throw new Error("OFFLINE_FINALIZATION_ARTIFACT_IDENTITY_MISMATCH");
  }
  return { artifact, bytes };
}

async function readRelevantRecoveryBindings(params: {
  readonly dir: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
  readonly sourceChapterNumber: number;
}): Promise<ReadonlyArray<{ readonly binding: CorrectedProviderArtifactBinding; readonly bytes: Buffer }>> {
  const names = await readdir(params.dir);
  const found: Array<{ readonly binding: CorrectedProviderArtifactBinding; readonly bytes: Buffer }> = [];
  for (const name of names.filter((entry) => entry.endsWith(".binding.json"))) {
    const bytes = await readFile(join(params.dir, name));
    const binding = JSON.parse(bytes.toString("utf-8")) as CorrectedProviderArtifactBinding;
    if (binding.job_id !== params.jobId || binding.chapter_number !== params.pendingChapterNumber) continue;
    if (binding.schema_version !== "1.0" || binding.binding_type !== "CORRECTED_PENDING_CHAPTER_REFERENCE"
      || binding.source_chapter_number !== params.sourceChapterNumber || `${binding.logical_step_id}.binding.json` !== name) {
      throw new Error("OFFLINE_FINALIZATION_BINDING_IDENTITY_MISMATCH");
    }
    found.push({ binding, bytes });
  }
  return found;
}

function extractRescueCandidate(content: string): string {
  const match = content.match(/=== REVISED_CONTENT ===\s*([\s\S]+)$/u);
  if (!match?.[1]?.trim()) throw new Error("OFFLINE_FINALIZATION_RESCUE_CONTENT_INVALID");
  return match[1].trim();
}

const SETTLEMENT_MARKDOWN_FILES = [
  "current_state.md",
  "pending_hooks.md",
  "chapter_summaries.md",
  "particle_ledger.md",
  "subplot_board.md",
  "emotional_arcs.md",
  "character_matrix.md",
] as const;

const SETTLEMENT_STRUCTURED_FILES = [
  "manifest.json",
  "current_state.json",
  "hooks.json",
  "chapter_summaries.json",
] as const;

interface RecoveryUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly actualCostUsd?: number;
}

function parseRecoveryUsage(value: unknown, label: string): Record<string, RecoveryUsage> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OFFLINE_FINALIZATION_PROVENANCE_INVALID:${label}`);
  }
  const result: Record<string, RecoveryUsage> = {};
  for (const [role, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`OFFLINE_FINALIZATION_PROVENANCE_INVALID:${label}:${role}`);
    }
    const usage = raw as Partial<RecoveryUsage>;
    if (![usage.promptTokens, usage.completionTokens, usage.totalTokens].every((token) => Number.isInteger(token) && token! >= 0)
      || usage.totalTokens !== usage.promptTokens! + usage.completionTokens!
      || (usage.actualCostUsd !== undefined && (!Number.isFinite(usage.actualCostUsd) || usage.actualCostUsd < 0))) {
      throw new Error(`OFFLINE_FINALIZATION_PROVENANCE_INVALID:${label}:${role}`);
    }
    result[role] = {
      promptTokens: usage.promptTokens!,
      completionTokens: usage.completionTokens!,
      totalTokens: usage.totalTokens!,
      ...(usage.actualCostUsd !== undefined ? { actualCostUsd: usage.actualCostUsd } : {}),
    };
  }
  return result;
}

function resolveRecoveryProvenance(evidence: Record<string, unknown>): FormalPendingChapterRecoveryAuthority["provenance"] {
  const revisionCount = evidence.revisionCount;
  const logicReviewCount = evidence.logicReviewCount;
  const commercialReviewCount = evidence.commercialReviewCount;
  if (!Number.isInteger(revisionCount) || (revisionCount as number) < 0 || (revisionCount as number) > 2
    || !Number.isInteger(logicReviewCount) || (logicReviewCount as number) < 0
    || !Number.isInteger(commercialReviewCount) || (commercialReviewCount as number) < 0) {
    throw new Error("OFFLINE_FINALIZATION_PROVENANCE_INVALID");
  }
  const baseline = parseRecoveryUsage(evidence.baselineRoleUsage ?? {}, "baselineRoleUsage");
  const current = parseRecoveryUsage(evidence.roleUsage ?? {}, "roleUsage");
  const roleUsage: Record<string, RecoveryUsage> = { ...baseline };
  for (const [role, usage] of Object.entries(current)) {
    const prior = roleUsage[role];
    roleUsage[role] = prior ? {
      promptTokens: prior.promptTokens + usage.promptTokens,
      completionTokens: prior.completionTokens + usage.completionTokens,
      totalTokens: prior.totalTokens + usage.totalTokens,
      ...(prior.actualCostUsd !== undefined || usage.actualCostUsd !== undefined
        ? { actualCostUsd: (prior.actualCostUsd ?? 0) + (usage.actualCostUsd ?? 0) }
        : {}),
    } : usage;
  }
  return {
    revisionCount: revisionCount as number,
    logicReviewCount: logicReviewCount as number,
    commercialReviewCount: commercialReviewCount as number,
    roleUsage,
  };
}

const PERSISTED_REVIEW_DIMENSIONS: Readonly<Record<ReviewerRole, ReadonlyArray<string>>> = {
  "logic-canon-auditor": [
    "blueprint_transition", "causal_logic", "canon_continuity", "character_motivation",
    "state_inheritance", "hooks_disclosure", "narrative_clarity",
  ],
  "commercial-reader": [
    "opening_hook", "pacing_tension", "emotional_investment", "plot_clarity",
    "dialogue_appeal", "western_cultural_naturalness", "commercial_appeal", "ending_hook",
  ],
};

function parsePersistedInitialReview(raw: unknown, candidateSha: string): ScoredReview {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
  const review = raw as Partial<ScoredReview>;
  const roles: readonly ReviewerRole[] = ["logic-canon-auditor", "commercial-reader"];
  const decisions: readonly ScoredReview["decision"][] = ["APPROVED", "APPROVED_WITH_NOTES", "REVISION_REQUIRED", "HELD", "INVALID_OUTPUT"];
  if (!roles.includes(review.reviewerRole as ReviewerRole) || !decisions.includes(review.decision as ScoredReview["decision"])
    || review.reviewedCandidateSha !== candidateSha || typeof review.reviewedAt !== "string"
    || (review.provider !== null && typeof review.provider !== "string")
    || (review.model !== null && typeof review.model !== "string")
    || typeof review.totalScore !== "number" || review.totalScore < 0 || review.totalScore > 100
    || !review.dimensionScores || typeof review.dimensionScores !== "object" || Array.isArray(review.dimensionScores)
    || !Array.isArray(review.findings)) {
    throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
  }
  if (review.decision !== "INVALID_OUTPUT" && PERSISTED_REVIEW_DIMENSIONS[review.reviewerRole!].some((dimension) => {
    const value = review.dimensionScores?.[dimension];
    return typeof value !== "number" || value < 0 || value > 100;
  })) {
    throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
  }
  for (const finding of review.findings) {
    if (!finding || typeof finding !== "object"
      || !["CRITICAL", "MAJOR", "MINOR", "NOTE"].includes(String((finding as { severity?: unknown }).severity ?? ""))
      || ["findingId", "evidence", "impact", "requiredOutcome"].some((key) => typeof (finding as Record<string, unknown>)[key] !== "string")) {
      throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
    }
  }
  if (review.tokenUsage) parseRecoveryUsage({ [review.reviewerRole!]: review.tokenUsage }, "persistedReviewUsage");
  return review as ScoredReview;
}

function parseChapterTitleAuthority(content: string, candidate: string): { readonly title: string; readonly body: string } | null {
  const titleMatch = content.match(/=== CHAPTER_TITLE ===\s*\r?\n([^\r\n]+)\s*[\r\n]+=== CHAPTER_CONTENT ===\s*\r?\n([\s\S]*?)(?=\r?\n=== [A-Z_ ]+ ===|$)/u);
  if (!titleMatch) return null;
  const body = titleMatch[2]!.trim();
  return body === candidate.trim() ? { title: titleMatch[1]!.trim(), body } : null;
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function attachPreservedTerminalReconciliation(params: {
  readonly bookDir: string;
  readonly evidenceDir: string;
  readonly chapterFile: string;
  readonly indexEntry: ChapterMeta;
  readonly plan: FormalPreservedBoundedReviewResumePlan;
}): Promise<FormalPreservedBoundedReviewResumePlan> {
  try {
    const receiptNames = (await readdir(params.evidenceDir))
      .filter((name) => /^preserved-review-resume-\d{3}\.json$/u.test(name))
      .sort();
    const receipts = await Promise.all(receiptNames.map(async (name) => {
      const bytes = await readFile(join(params.evidenceDir, name));
      return { name, bytes, value: JSON.parse(bytes.toString("utf-8")) as {
        readonly schema_version?: unknown;
        readonly chapter_number?: unknown;
        readonly status?: unknown;
        readonly best_candidate?: { readonly label?: unknown; readonly sha256?: unknown };
        readonly candidates?: ReadonlyArray<{ readonly label?: unknown; readonly sha256?: unknown }>;
      } };
    }));
    const terminalReceipts = receipts.filter(({ value }) => value.status === "APPROVED" || value.status === "ACCEPTED_WITH_FINDINGS");
    if (terminalReceipts.length !== 1 || terminalReceipts[0]!.name !== receiptNames.at(-1)) throw new Error("terminal receipt mismatch");
    const receipt = terminalReceipts[0]!;
    const expectedStatus = receipt.value.status === "APPROVED" ? "approved" as const : "accepted-with-findings" as const;
    if (receipt.value.schema_version !== "1.0" || receipt.value.chapter_number !== params.plan.pendingChapterNumber
      || params.indexEntry.status !== expectedStatus || typeof params.indexEntry.title !== "string" || !params.indexEntry.title.trim()
      || !Array.isArray(receipt.value.candidates)) {
      throw new Error("terminal identity mismatch");
    }
    const initialAuthorities = receipt.value.candidates.filter((candidate) => candidate.label === "INITIAL" && candidate.sha256 === params.plan.candidate.sha256);
    const finalAuthorities = receipt.value.candidates.filter((candidate) => candidate.label === receipt.value.best_candidate?.label
      && candidate.sha256 === receipt.value.best_candidate?.sha256);
    if (initialAuthorities.length !== 1 || finalAuthorities.length !== 1 || typeof receipt.value.best_candidate?.label !== "string"
      || !["INITIAL", "REVISION_1", "REVISION_2"].includes(receipt.value.best_candidate.label)
      || !/^[a-f0-9]{64}$/u.test(String(receipt.value.best_candidate.sha256 ?? ""))) {
      throw new Error("terminal candidate authority mismatch");
    }
    const candidateName = `preserved-review-resume-${receipt.name.match(/(\d{3})/u)![1]}-${receipt.value.best_candidate.label.toLowerCase()}.md`;
    const finalCandidateBytes = await readFile(join(params.evidenceDir, candidateName));
    if (sha256(finalCandidateBytes) !== receipt.value.best_candidate.sha256) throw new Error("terminal candidate hash mismatch");
    const finalCandidate = finalCandidateBytes.toString("utf-8");
    if (!Buffer.from(finalCandidate, "utf-8").equals(finalCandidateBytes)) throw new Error("terminal candidate encoding mismatch");

    const book = JSON.parse(await readFile(join(params.bookDir, "book.json"), "utf-8")) as { readonly language?: unknown };
    const heading = book.language === "en"
      ? `# Chapter ${params.plan.pendingChapterNumber}: ${params.indexEntry.title}`
      : `# 第${params.plan.pendingChapterNumber}章 ${params.indexEntry.title}`;
    const formalChapterBytes = await readFile(join(params.bookDir, "chapters", params.chapterFile));
    if (formalChapterBytes.toString("utf-8") !== `${heading}\n\n${finalCandidate}`) throw new Error("formal chapter mismatch");

    const stateManifestBytes = await readFile(join(params.bookDir, "story", "state", "manifest.json"));
    const snapshotManifestBytes = await readFile(join(params.bookDir, "story", "snapshots", String(params.plan.pendingChapterNumber), "state", "manifest.json"));
    for (const bytes of [stateManifestBytes, snapshotManifestBytes]) {
      const manifest = JSON.parse(bytes.toString("utf-8")) as { readonly schemaVersion?: unknown; readonly lastAppliedChapter?: unknown };
      if (manifest.schemaVersion !== 2 || manifest.lastAppliedChapter !== params.plan.pendingChapterNumber) throw new Error("terminal state mismatch");
    }
    return {
      ...params.plan,
      terminalReconciliation: {
        status: expectedStatus,
        chapterFile: params.chapterFile,
        candidateSha256: receipt.value.best_candidate.sha256 as string,
        receiptRelativePath: join("story", "runtime", "bounded-autonomous", `chapter-${String(params.plan.pendingChapterNumber).padStart(4, "0")}`, receipt.name).replace(/\\/gu, "/"),
        receiptSha256: sha256(receipt.bytes),
        snapshotManifestSha256: sha256(snapshotManifestBytes),
        stateManifestSha256: sha256(stateManifestBytes),
      },
    };
  } catch (error) {
    throw new Error("PRESERVED_CANDIDATE_TERMINAL_RECONCILIATION_CONFLICT", { cause: error });
  }
}

async function resolvePreservedBoundedReviewResumePlan(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
  readonly runtime: AutonomousRunProgress | null;
}): Promise<FormalPreservedBoundedReviewResumePlan | null> {
  const runtime = params.runtime;
  if (!runtime) return null;
  const ownership = runtime.recoveryOwnership;
  const ownedReentry = ownership?.kind === "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME"
    && ownership.bookId === params.bookId && ownership.jobId === params.jobId
    && ownership.pendingChapterNumber === params.pendingChapterNumber
    && ["RUNNING", "WAITING_PROVIDER_RETRY", "PAUSED_PROVIDER_UNAVAILABLE", "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "PAUSED_DETERMINISTIC_PROVIDER_ERROR", "PAUSED_PIPELINE_ERROR"].includes(runtime.status);
  if (!ownedReentry && runtime.status !== "REVIEW_OUTPUT_INVALID" && runtime.status !== "HELD_AFTER_TWO_REVISIONS") return null;
  if (runtime.jobId !== params.jobId) {
    throw new Error("PRESERVED_CANDIDATE_RUNTIME_IDENTITY_MISMATCH");
  }
  if ((runtime.providerAttemptHistory ?? []).some((attempt) => attempt.chapterNumber === params.pendingChapterNumber
    && attempt.transportStarted && !attempt.transportReturned)) {
    throw new Error("PRESERVED_CANDIDATE_AMBIGUOUS_PROVIDER_OUTCOME");
  }

  const bookDir = join(params.projectRoot, "books", params.bookId);
  const mapBytes = await readFile(join(bookDir, "story", "outline", "book-production-map.json"));
  const productionMap = parseBookProductionMap(JSON.parse(mapBytes.toString("utf-8")), params.bookId);
  if (params.pendingChapterNumber > productionMap.totalChapters
    || (runtime.mode !== "current-volume" && runtime.mode !== "full-book")
    || deriveAutonomousJobIdentity({ map: productionMap, mode: runtime.mode, nextChapter: params.pendingChapterNumber }) !== params.jobId) {
    throw new Error("PRESERVED_CANDIDATE_PRODUCTION_JOB_IDENTITY_MISMATCH");
  }
  const chapterPrefix = new RegExp(`^${String(params.pendingChapterNumber).padStart(4, "0")}[_-].*\\.md$`, "u");
  const formalChapterFiles = (await readdir(join(bookDir, "chapters"))).filter((name) => chapterPrefix.test(name));
  const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
  const terminalIndexEntries = index.filter((entry) => entry.number === params.pendingChapterNumber);
  const terminalSnapshotExists = await pathExists(join(bookDir, "story", "snapshots", String(params.pendingChapterNumber)));
  const hasTerminalArtifacts = formalChapterFiles.length > 0 || terminalIndexEntries.length > 0 || terminalSnapshotExists;
  if (runtime.nextChapter !== params.pendingChapterNumber
    && !(ownedReentry && hasTerminalArtifacts && runtime.nextChapter === params.pendingChapterNumber + 1)) {
    throw new Error("PRESERVED_CANDIDATE_RUNTIME_IDENTITY_MISMATCH");
  }
  if (hasTerminalArtifacts && !ownedReentry) {
    if (formalChapterFiles.length > 0) throw new Error("PRESERVED_CANDIDATE_FORMAL_CHAPTER_ALREADY_EXISTS");
    if (terminalIndexEntries.length > 0) throw new Error("PRESERVED_CANDIDATE_INDEX_ALREADY_EXISTS");
    throw new Error("PRESERVED_CANDIDATE_TERMINAL_SNAPSHOT_CONFLICT");
  }
  if (hasTerminalArtifacts && (formalChapterFiles.length !== 1 || terminalIndexEntries.length !== 1 || !terminalSnapshotExists)) {
    throw new Error("PRESERVED_CANDIDATE_TERMINAL_RECONCILIATION_CONFLICT");
  }
  const baselineChapterNumber = params.pendingChapterNumber - 1;
  const terminalBaselineStatuses = new Set<ChapterMeta["status"]>(["approved", "accepted-with-findings", "published", "imported"]);
  const orderedIndex = index.filter((entry) => entry.number !== params.pendingChapterNumber).sort((left, right) => left.number - right.number);
  if (baselineChapterNumber < 0 || orderedIndex.length !== baselineChapterNumber
    || orderedIndex.some((entry, offset) => entry.number !== offset + 1 || !terminalBaselineStatuses.has(entry.status))) {
    throw new Error("PRESERVED_CANDIDATE_BASELINE_NOT_PROVABLE");
  }
  const [baselineManifest, currentManifest] = await Promise.all([
    readFile(join(bookDir, "story", "snapshots", String(baselineChapterNumber), "state", "manifest.json"), "utf-8"),
    readFile(join(bookDir, "story", "state", "manifest.json"), "utf-8"),
  ]).then((values) => values.map((value) => JSON.parse(value) as { readonly lastAppliedChapter?: unknown }));
  if (baselineManifest.lastAppliedChapter !== baselineChapterNumber
    || currentManifest.lastAppliedChapter !== (hasTerminalArtifacts ? params.pendingChapterNumber : baselineChapterNumber)) {
    throw new Error("PRESERVED_CANDIDATE_BASELINE_NOT_PROVABLE");
  }

  const padded = String(params.pendingChapterNumber).padStart(4, "0");
  const evidenceDir = join(bookDir, "story", "runtime", "bounded-autonomous", `chapter-${padded}`);
  if (!hasTerminalArtifacts && (await readdir(evidenceDir)).some((name) => /^preserved-review-resume-\d{3}\.json$/u.test(name))) {
    throw new Error("PRESERVED_CANDIDATE_RECOVERY_ALREADY_ATTEMPTED");
  }
  const initialBytes = await readFile(join(evidenceDir, "initial.md"));
  const candidateSha = sha256(initialBytes);
  const reviewBytes = await readFile(join(evidenceDir, "review.json"));
  const evidence = JSON.parse(reviewBytes.toString("utf-8")) as {
    readonly schema_version?: unknown; readonly chapter_number?: unknown; readonly status?: unknown;
    readonly revision_count?: unknown; readonly hold_reason?: unknown;
    readonly best_candidate?: { readonly label?: unknown; readonly sha256?: unknown };
    readonly candidates?: ReadonlyArray<{ readonly label?: unknown; readonly sha256?: unknown; readonly reviews?: ReadonlyArray<unknown> }>;
    readonly usage_by_role?: unknown;
  };
  const supported = evidence.status === "REVIEW_OUTPUT_INVALID" && evidence.revision_count === 0 && evidence.hold_reason === "INVALID_OUTPUT"
    || evidence.status === "HELD_AFTER_TWO_REVISIONS" && evidence.revision_count === 0 && evidence.hold_reason === "INVALID_OUTPUT";
  if (evidence.schema_version !== "1.0" || evidence.chapter_number !== params.pendingChapterNumber || !supported) {
    if (evidence.status === "HELD_AFTER_TWO_REVISIONS" && evidence.revision_count === 2 && evidence.hold_reason === "REVISION_LIMIT_REACHED") {
      if (ownedReentry) throw new Error("PRESERVED_CANDIDATE_RECOVERY_AUTHORITY_CHANGED");
      return null;
    }
    throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
  }
  const initialCandidates = (evidence.candidates ?? []).filter((candidate) => candidate.label === "INITIAL");
  if (evidence.candidates?.length !== 1 || initialCandidates.length !== 1 || initialCandidates[0]!.sha256 !== candidateSha
    || evidence.best_candidate?.label !== "INITIAL" || evidence.best_candidate.sha256 !== candidateSha
    || !Array.isArray(initialCandidates[0]!.reviews)) {
    throw new Error("PRESERVED_CANDIDATE_SHA_AUTHORITY_MISMATCH");
  }
  const reviews = initialCandidates[0]!.reviews!.map((review) => parsePersistedInitialReview(review, candidateSha));
  if (reviews.length !== 2 || new Set(reviews.map((review) => review.reviewerRole)).size !== 2) {
    throw new Error("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
  }
  const initialReviews: Partial<Record<ReviewerRole, ScoredReview>> = {};
  const invalidReviewerRoles: ReviewerRole[] = [];
  for (const review of reviews) {
    if (review.decision === "INVALID_OUTPUT") invalidReviewerRoles.push(review.reviewerRole);
    else initialReviews[review.reviewerRole] = review;
  }
  if (invalidReviewerRoles.length === 0) throw new Error("PRESERVED_CANDIDATE_INVALID_REVIEWER_MISSING");

  const runRelativePath = join("story", "runtime", `chapter-${padded}.run.json`);
  const runBytes = await readFile(join(bookDir, runRelativePath));
  const run = JSON.parse(runBytes.toString("utf-8")) as { readonly id?: unknown; readonly stage?: unknown; readonly resumeCursor?: unknown; readonly status?: unknown; readonly artifacts?: ReadonlyArray<unknown> };
  const reviewRelativePath = join("story", "runtime", "bounded-autonomous", `chapter-${padded}`, "review.json").replace(/\\/gu, "/");
  if (run.id !== `${params.bookId}:chapter-${padded}` || run.stage !== `chapter-${params.pendingChapterNumber}`
    || run.resumeCursor !== String(params.pendingChapterNumber) || run.status !== "needs-review"
    || !run.artifacts?.includes(reviewRelativePath)) {
    throw new Error("PRESERVED_CANDIDATE_RUN_EVIDENCE_INVALID");
  }

  const candidate = initialBytes.toString("utf-8");
  const responseDir = providerResponseArtifactDir(params.projectRoot, params.bookId);
  const titleAuthorities: Array<{ readonly title: string; readonly logicalStepId: string; readonly artifactSha256: string; readonly usage?: RecoveryUsage }> = [];
  for (const name of (await readdir(responseDir)).filter((entry) => /^provider-step-[a-f0-9]{64}\.json$/u.test(entry))) {
    const logicalStepId = name.replace(/\.json$/u, "");
    let source: { readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer };
    try { source = await readRecoveryArtifact(responseDir, logicalStepId, { jobId: params.jobId, chapterNumber: params.pendingChapterNumber }); }
    catch { continue; }
    if (source.artifact.role !== "writer" || source.artifact.stage !== "WRITING") continue;
    const parsed = parseChapterTitleAuthority(source.artifact.response.content, candidate);
    if (parsed) titleAuthorities.push({
      title: parsed.title, logicalStepId, artifactSha256: sha256(source.bytes),
      ...(source.artifact.response.usage ? { usage: source.artifact.response.usage } : {}),
    });
  }
  const uniqueTitles = new Set(titleAuthorities.map((authority) => authority.title));
  if (titleAuthorities.length === 0 || uniqueTitles.size !== 1) throw new Error("PRESERVED_CANDIDATE_TITLE_AUTHORITY_NOT_PROVABLE");
  const titleAuthority = titleAuthorities[0]!;
  const historicalRoleUsage = parseRecoveryUsage(evidence.usage_by_role ?? {}, "usage_by_role");
  if (titleAuthority.usage) historicalRoleUsage.writer = parseRecoveryUsage({ writer: titleAuthority.usage }, "titleAuthorityUsage").writer!;
  const plan: FormalPreservedBoundedReviewResumePlan = {
    kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", recoveryClass: "PRESERVED_BOUNDED_REVIEW",
    bookId: params.bookId, jobId: params.jobId, pendingChapterNumber: params.pendingChapterNumber,
    baselineChapterNumber, productionMapSha256: sha256(mapBytes),
    candidate: { content: candidate, sha256: candidateSha, title: titleAuthority.title, titleAuthorityLogicalStepId: titleAuthority.logicalStepId, titleAuthorityArtifactSha256: titleAuthority.artifactSha256 },
    reviewEvidence: { relativePath: reviewRelativePath, sha256: sha256(reviewBytes), runRelativePath: runRelativePath.replace(/\\/gu, "/"), runSha256: sha256(runBytes) },
    initialReviews, invalidReviewerRoles,
    historicalRoleUsage,
  };
  return hasTerminalArtifacts
    ? attachPreservedTerminalReconciliation({
        bookDir,
        evidenceDir,
        chapterFile: formalChapterFiles[0]!,
        indexEntry: terminalIndexEntries[0]!,
        plan,
      })
    : plan;
}

async function resolveStateSettlementProof(params: {
  readonly bookDir: string;
  readonly evidenceDir: string;
  readonly evidence: Record<string, unknown>;
  readonly bookId: string;
  readonly jobId: string;
  readonly chapterNumber: number;
  readonly candidateBodySha256: string;
}): Promise<FormalOfflineFinalizationPlan["stateSettlement"]> {
  const reference = params.evidence.stateSettlementProof as { readonly relativePath?: unknown; readonly sha256?: unknown } | undefined;
  if (reference?.relativePath !== "state-settlement-proof.json" || !/^[a-f0-9]{64}$/u.test(String(reference.sha256 ?? ""))) {
    throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
  }
  const proofBytes = await readFile(join(params.evidenceDir, reference.relativePath));
  if (sha256(proofBytes) !== reference.sha256) throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
  const proof = JSON.parse(proofBytes.toString("utf-8")) as {
    readonly schema_version?: unknown;
    readonly evidence_type?: unknown;
    readonly book_id?: unknown;
    readonly job_id?: unknown;
    readonly chapter_number?: unknown;
    readonly snapshot_id?: unknown;
    readonly rescue_candidate_body_sha256?: unknown;
    readonly artifacts?: ReadonlyArray<{
      readonly source_relative_path?: unknown;
      readonly target_relative_path?: unknown;
      readonly sha256?: unknown;
    }>;
  };
  if (proof.schema_version !== "1.0" || proof.evidence_type !== "OFFLINE_FINALIZATION_STATE_SETTLEMENT_PROOF"
    || proof.book_id !== params.bookId || proof.job_id !== params.jobId || proof.chapter_number !== params.chapterNumber
    || typeof proof.snapshot_id !== "string" || !proof.snapshot_id.trim()
    || proof.rescue_candidate_body_sha256 !== params.candidateBodySha256 || !Array.isArray(proof.artifacts)) {
    throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
  }
  const expected = [
    ...SETTLEMENT_MARKDOWN_FILES.map((name) => ({
      sourceRelativePath: `story/snapshots/${params.chapterNumber}/${name}`,
      targetRelativePath: `story/${name}`,
    })),
    ...SETTLEMENT_STRUCTURED_FILES.map((name) => ({
      sourceRelativePath: `story/snapshots/${params.chapterNumber}/state/${name}`,
      targetRelativePath: `story/state/${name}`,
    })),
  ];
  if (proof.artifacts.length !== expected.length) throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
  const artifacts = await Promise.all(expected.map(async (required) => {
    const matches = proof.artifacts!.filter((artifact) => artifact.source_relative_path === required.sourceRelativePath
      && artifact.target_relative_path === required.targetRelativePath);
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/u.test(String(matches[0]!.sha256 ?? ""))) {
      throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
    }
    const bytes = await readFile(join(params.bookDir, required.sourceRelativePath));
    if (sha256(bytes) !== matches[0]!.sha256) throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
    const content = bytes.toString("utf-8");
    if (!Buffer.from(content, "utf-8").equals(bytes)) throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
    return { ...required, sha256: matches[0]!.sha256 as string, content };
  }));
  const manifest = JSON.parse(artifacts.find((artifact) => artifact.sourceRelativePath.endsWith("/state/manifest.json"))!.content) as { readonly schemaVersion?: unknown; readonly lastAppliedChapter?: unknown };
  const currentState = JSON.parse(artifacts.find((artifact) => artifact.sourceRelativePath.endsWith("/state/current_state.json"))!.content) as { readonly chapter?: unknown };
  const summaries = JSON.parse(artifacts.find((artifact) => artifact.sourceRelativePath.endsWith("/state/chapter_summaries.json"))!.content) as { readonly rows?: ReadonlyArray<{ readonly chapter?: unknown }> };
  if (manifest.schemaVersion !== 2 || manifest.lastAppliedChapter !== params.chapterNumber
    || currentState.chapter !== params.chapterNumber
    || !Array.isArray(summaries.rows) || !summaries.rows.some((row) => row.chapter === params.chapterNumber)) {
    throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE");
  }
  return {
    proofRelativePath: "state-settlement-proof.json",
    proofSha256: reference.sha256 as string,
    snapshotId: proof.snapshot_id,
    candidateBodySha256: params.candidateBodySha256,
    artifacts,
  };
}

async function resolveFormalPendingChapterRecoveryPlanUnsafe(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<FormalPendingChapterRecoveryPlan | null> {
  const runtime = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
  const preserved = await resolvePreservedBoundedReviewResumePlan({ ...params, runtime });
  if (preserved) return preserved;
  const ownership = runtime?.recoveryOwnership;
  const ownedReentry = ownership?.kind !== "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME"
    && ownership?.bookId === params.bookId
    && ownership.jobId === params.jobId
    && ownership.pendingChapterNumber === params.pendingChapterNumber
    && [
      "RUNNING",
      "WAITING_PROVIDER_RETRY",
      "PAUSED_PROVIDER_UNAVAILABLE",
      "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME",
      "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
      "PAUSED_PIPELINE_ERROR",
    ].includes(runtime?.status ?? "");
  const recoveryClass = runtime?.status === "REVIEW_EXHAUSTED"
    ? "ORIGINAL_REVIEW_EXHAUSTED" as const
    : runtime?.status === "BLOCKED_CRITICAL_FINDINGS"
      ? "FAILED_REENTRY" as const
      : ownedReentry ? ownership.recoveryClass : null;
  if (!runtime || !recoveryClass) return null;
  const sourceChapterNumber = params.pendingChapterNumber + 1;
  const expectedRuntimeChapter = recoveryClass === "FAILED_REENTRY" ? params.pendingChapterNumber : sourceChapterNumber;
  if (runtime.jobId !== params.jobId || runtime.nextChapter !== sourceChapterNumber
    || (!ownedReentry && (runtime.chapterNumber !== expectedRuntimeChapter || runtime.responseArtifactStatus !== "COMPLETE"))) {
    throw new Error("OFFLINE_FINALIZATION_RUNTIME_IDENTITY_MISMATCH");
  }

  const bookDir = join(params.projectRoot, "books", params.bookId);
  const mapBytes = await readFile(join(bookDir, "story", "outline", "book-production-map.json"));
  const productionMap = parseBookProductionMap(JSON.parse(mapBytes.toString("utf-8")), params.bookId);
  if (sourceChapterNumber > productionMap.totalChapters) throw new Error("OFFLINE_FINALIZATION_PRODUCTION_MAP_MISMATCH");
  if ((runtime.mode !== "current-volume" && runtime.mode !== "full-book")
    || deriveAutonomousJobIdentity({ map: productionMap, mode: runtime.mode, nextChapter: sourceChapterNumber }) !== params.jobId) {
    throw new Error("OFFLINE_FINALIZATION_PRODUCTION_JOB_IDENTITY_MISMATCH");
  }
  const chapterNames = (await readdir(join(bookDir, "chapters"))).filter((name) =>
    new RegExp(`^${String(params.pendingChapterNumber).padStart(4, "0")}[_-].*\\.md$`, "u").test(name));
  if (chapterNames.length !== 1) throw new Error("OFFLINE_FINALIZATION_CHAPTER_SOURCE_INVALID");
  const chapterFile = chapterNames[0]!;
  const currentChapterBytes = await readFile(join(bookDir, "chapters", chapterFile));
  const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
  const pending = index.filter((entry) => entry.number === params.pendingChapterNumber);
  if (pending.length !== 1 || pending[0]!.status !== "audit-failed") throw new Error("OFFLINE_FINALIZATION_CHAPTER_STATE_INVALID");

  const chapter = String(params.pendingChapterNumber).padStart(4, "0");
  const evidenceDir = join(bookDir, "story", "runtime", "bounded-autonomous", `chapter-${chapter}`);
  const evidenceBytes = await readFile(join(evidenceDir, "resume-review.json"));
  const evidence = JSON.parse(evidenceBytes.toString("utf-8")) as Record<string, unknown> & {
    readonly chapter_number?: number;
    readonly status?: string;
    readonly modelOutcomes?: ReadonlyArray<{ readonly modelCallId?: string }>;
  };
  if (evidence.chapter_number !== params.pendingChapterNumber) throw new Error("OFFLINE_FINALIZATION_EVIDENCE_CHAPTER_MISMATCH");
  const currentEvidenceSha256 = sha256(evidenceBytes);
  const responseDir = providerResponseArtifactDir(params.projectRoot, params.bookId);
  const existingBindings = await readRelevantRecoveryBindings({
    dir: responseDir,
    jobId: params.jobId,
    pendingChapterNumber: params.pendingChapterNumber,
    sourceChapterNumber,
  });

  let historicalEvidenceSha256: string;
  let failedEvidenceSuffixIds: readonly string[] = [];
  let sourceArtifacts: readonly [
    { readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer },
    { readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer },
  ];
  if (recoveryClass === "ORIGINAL_REVIEW_EXHAUSTED") {
    if (evidence.status !== "REVIEW_EXHAUSTED") throw new Error("OFFLINE_FINALIZATION_EVIDENCE_STATUS_MISMATCH");
    const original = await resolveFormalPendingChapterRecoveryEvidence(params);
    if (!original) throw new Error("OFFLINE_FINALIZATION_ORIGINAL_EVIDENCE_MISSING");
    historicalEvidenceSha256 = original.evidenceSha256;
    sourceArtifacts = [original.artifacts[0], original.artifacts[1]];
    if (existingBindings.length !== 0 && existingBindings.length !== 2) {
      throw new Error("OFFLINE_FINALIZATION_BINDING_SET_INCOMPLETE");
    }
  } else {
    if (evidence.status !== "BLOCKED_CRITICAL_FINDINGS" || existingBindings.length !== 2) {
      throw new Error("OFFLINE_FINALIZATION_FAILED_REENTRY_AUTHORITY_MISSING");
    }
    const evidenceAnchors = new Set(existingBindings.map(({ binding }) => binding.resume_evidence_sha256));
    if (evidenceAnchors.size !== 1) throw new Error("OFFLINE_FINALIZATION_EVIDENCE_ANCHOR_MISMATCH");
    historicalEvidenceSha256 = existingBindings[0]!.binding.resume_evidence_sha256;
    if (historicalEvidenceSha256 === currentEvidenceSha256) throw new Error("OFFLINE_FINALIZATION_FAILED_REENTRY_NOT_SUPERSEDED");
    const ordered = await Promise.all(existingBindings.map(({ binding }) => readRecoveryArtifact(responseDir, binding.source_logical_step_id, {
      jobId: params.jobId, chapterNumber: sourceChapterNumber,
    })));
    const rescue = ordered.filter(({ artifact }) => isRescueCandidateResponse(artifact));
    const final = ordered.filter(({ artifact }) => isFinalReviewArtifact(artifact));
    if (rescue.length !== 1 || final.length !== 1) throw new Error("OFFLINE_FINALIZATION_SOURCE_SEMANTICS_INVALID");
    sourceArtifacts = [rescue[0]!, final[0]!];
    const outcomeIds = (evidence.modelOutcomes ?? []).map((outcome) => outcome.modelCallId ?? "");
    if (outcomeIds.some((id) => !/^provider-step-[a-f0-9]{64}$/u.test(id)) || new Set(outcomeIds).size !== outcomeIds.length) {
      throw new Error("OFFLINE_FINALIZATION_HISTORICAL_PREFIX_INVALID");
    }
    const rescueIndex = outcomeIds.indexOf(rescue[0]!.artifact.logical_step_id);
    const finalIndex = outcomeIds.indexOf(final[0]!.artifact.logical_step_id);
    if (rescueIndex < 0 || finalIndex <= rescueIndex || finalIndex >= outcomeIds.length - 1) {
      throw new Error("OFFLINE_FINALIZATION_HISTORICAL_PREFIX_MISMATCH");
    }
    await Promise.all(outcomeIds.map((logicalStepId, index) => readRecoveryArtifact(responseDir, logicalStepId, {
      jobId: params.jobId,
      chapterNumber: index <= finalIndex ? sourceChapterNumber : params.pendingChapterNumber,
    })));
    failedEvidenceSuffixIds = outcomeIds.slice(finalIndex + 1);
  }

  const [rescueSource, finalSource] = sourceArtifacts;
  const accepted = parseAcceptedFinalReview(finalSource.artifact.response.content);
  if (!accepted) throw new Error("OFFLINE_FINALIZATION_FINAL_REVIEW_NOT_ACCEPTED");
  const candidateBody = extractRescueCandidate(rescueSource.artifact.response.content);
  const candidateBodySha256 = sha256(candidateBody);
  let stateSettlement: FormalOfflineFinalizationPlan["stateSettlement"] | undefined;
  if (Object.prototype.hasOwnProperty.call(evidence, "stateSettlementProof")) {
    try {
      stateSettlement = await resolveStateSettlementProof({
        bookDir,
        evidenceDir,
        evidence,
        bookId: params.bookId,
        jobId: params.jobId,
        chapterNumber: params.pendingChapterNumber,
        candidateBodySha256,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE") throw error;
      throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE", { cause: error });
    }
  }
  const provenance = resolveRecoveryProvenance(evidence);
  const expectedBindings = [
    { source: rescueSource, targetRole: "reviser", targetStage: "RESCUE_REVISING_2" },
    { source: finalSource, targetRole: "logicAuditor", targetStage: "LOGIC_REVIEW" },
  ] as const;
  const bindings = expectedBindings.map(({ source, targetRole, targetStage }) => {
    const logicalStepId = logicalProviderStepId({
      jobId: params.jobId,
      chapterNumber: params.pendingChapterNumber,
      stage: { stage: targetStage, role: targetRole, provider: source.artifact.provider, model: source.artifact.requested_model },
      provider: source.artifact.provider,
      model: source.artifact.requested_model,
      inputFingerprint: source.artifact.input_fingerprint,
    });
    const authority: RecoveryBindingAuthority = {
      schema_version: "1.0",
      binding_type: "CORRECTED_PENDING_CHAPTER_REFERENCE",
      job_id: params.jobId,
      logical_step_id: logicalStepId,
      chapter_number: params.pendingChapterNumber,
      source_chapter_number: sourceChapterNumber,
      source_logical_step_id: source.artifact.logical_step_id,
      source_artifact_sha256: sha256(source.bytes),
      source_content_sha256: source.artifact.content_sha256,
      resume_evidence_sha256: historicalEvidenceSha256,
    };
    const existing = existingBindings.find(({ binding }) => binding.logical_step_id === logicalStepId);
    if (existing && bindingAuthoritySha256(existing.binding) !== bindingAuthoritySha256(authority)) {
      throw new Error("OFFLINE_FINALIZATION_BINDING_AUTHORITY_MISMATCH");
    }
    return {
      logicalStepId,
      sourceLogicalStepId: authority.source_logical_step_id,
      sourceArtifactSha256: authority.source_artifact_sha256,
      sourceContentSha256: authority.source_content_sha256,
      resumeEvidenceSha256: authority.resume_evidence_sha256,
      authoritySha256: bindingAuthoritySha256(authority),
      ...(existing ? { fileSha256: sha256(existing.bytes) } : {}),
    };
  });
  if (existingBindings.some(({ binding }) => !bindings.some((expected) => expected.logicalStepId === binding.logical_step_id))) {
    throw new Error("OFFLINE_FINALIZATION_BINDING_SET_MISMATCH");
  }

  const failedReentryArtifacts = recoveryClass === "FAILED_REENTRY"
    ? await Promise.all([...new Set((runtime.providerAttemptHistory ?? [])
      .filter((attempt) => attempt.chapterNumber === params.pendingChapterNumber && attempt.transportStarted)
      .map((attempt) => attempt.logicalStepId))].map(async (logicalStepId) => {
        const source = await readRecoveryArtifact(responseDir, logicalStepId, {
          jobId: params.jobId, chapterNumber: params.pendingChapterNumber,
        });
        return { logicalStepId, artifactSha256: sha256(source.bytes), contentSha256: source.artifact.content_sha256 };
      }))
    : [];
  if (recoveryClass === "FAILED_REENTRY" && failedReentryArtifacts.length === 0) {
    throw new Error("OFFLINE_FINALIZATION_FAILED_REENTRY_ARTIFACTS_MISSING");
  }
  if (recoveryClass === "FAILED_REENTRY") {
    const failedArtifactIds = new Set(failedReentryArtifacts.map((artifact) => artifact.logicalStepId));
    if (failedEvidenceSuffixIds.length === 0 || failedEvidenceSuffixIds.some((id) => !failedArtifactIds.has(id))) {
      throw new Error("OFFLINE_FINALIZATION_FAILED_REENTRY_HISTORY_MISMATCH");
    }
  }

  const authority = {
    recoveryClass,
    bookId: params.bookId,
    jobId: params.jobId,
    pendingChapterNumber: params.pendingChapterNumber,
    expectedLogicalChapter: params.pendingChapterNumber,
    sourceChapterNumber,
    productionMapSha256: sha256(mapBytes),
    chapterFile,
    currentChapterSha256: sha256(currentChapterBytes),
    evidence: { historicalSha256: historicalEvidenceSha256, currentSha256: currentEvidenceSha256 },
    rescue: {
      sourceLogicalStepId: rescueSource.artifact.logical_step_id,
      sourceArtifactSha256: sha256(rescueSource.bytes),
      sourceContentSha256: rescueSource.artifact.content_sha256,
      candidateBody,
      candidateBodySha256,
    },
    finalReview: {
      sourceLogicalStepId: finalSource.artifact.logical_step_id,
      sourceArtifactSha256: sha256(finalSource.bytes),
      sourceContentSha256: finalSource.artifact.content_sha256,
      decision: accepted.decision,
      overallScore: accepted.overallScore,
      issues: accepted.issues,
    },
    provenance,
    bindings,
    failedReentryArtifacts,
  };
  return stateSettlement
    ? { ...authority, kind: "FORMAL_OFFLINE_FINALIZATION", stateSettlement }
    : {
        ...authority,
        kind: "FORMAL_BOUNDED_STATE_REBASELINE",
        baselineChapterNumber: params.pendingChapterNumber - 1,
      };
}

export async function resolveFormalPendingChapterRecoveryPlan(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<FormalPendingChapterRecoveryPlan | null> {
  try {
    return await resolveFormalPendingChapterRecoveryPlanUnsafe(params);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PRESERVED_CANDIDATE_")) throw error;
    if (error instanceof Error && error.message === "OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE") {
      throw new Error("OFFLINE_FINALIZATION_STATE_EVIDENCE_NOT_PROVABLE", { cause: error });
    }
    throw new Error("OFFLINE_FINALIZATION_EVIDENCE_NOT_PROVABLE", { cause: error });
  }
}

export async function finalizePendingChapterOfflinePlan(params: {
  readonly projectRoot: string;
  readonly plan: FormalPendingChapterRecoveryPlan;
}): Promise<{
  readonly chapterNumber: number;
  readonly status: "approved" | "accepted-with-findings";
  readonly revisionCount: number;
  readonly logicReviewCount: number;
  readonly commercialReviewCount: number;
  readonly roleUsage: FormalPendingChapterRecoveryAuthority["provenance"]["roleUsage"];
}> {
  const plan = params.plan;
  if (plan.kind !== "FORMAL_OFFLINE_FINALIZATION") throw new Error("OFFLINE_FINALIZATION_MODE_MISMATCH");
  const verified = await resolveFormalPendingChapterRecoveryPlan({
    projectRoot: params.projectRoot,
    bookId: plan.bookId,
    jobId: plan.jobId,
    pendingChapterNumber: plan.pendingChapterNumber,
  });
  if (!verified || JSON.stringify(verified) !== JSON.stringify(plan)) {
    throw new Error("OFFLINE_FINALIZATION_PLAN_CHANGED");
  }
  const bookDir = join(params.projectRoot, "books", plan.bookId);
  const responseDirRelative = join("story", "runtime", "bounded-autonomous", "provider-responses");
  const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
  const chapter = index.find((entry) => entry.number === plan.pendingChapterNumber)!;
  const currentBody = await readFile(join(bookDir, "chapters", plan.chapterFile), "utf-8");
  const bookLanguage = await readFile(join(bookDir, "book.json"), "utf-8")
    .then((bytes) => (JSON.parse(bytes) as { readonly language?: unknown }).language === "en" ? "en" as const : "zh" as const)
    .catch(() => "zh" as const);
  const heading = currentBody.match(/^# .+$/mu)?.[0] ?? `# ${chapter.title}`;
  const finalBody = `${heading}\n\n${plan.rescue.candidateBody}`;
  const status = plan.finalReview.decision === "APPROVED" ? "approved" as const : "accepted-with-findings" as const;
  const updatedAt = new Date().toISOString();
  const tokenUsage = Object.values(plan.provenance.roleUsage).reduce((total, usage) => ({
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
    ...(total.actualCostUsd !== undefined || usage.actualCostUsd !== undefined
      ? { actualCostUsd: (total.actualCostUsd ?? 0) + (usage.actualCostUsd ?? 0) }
      : {}),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as RecoveryUsage);
  const updatedIndex = index.map((entry) => entry.number === plan.pendingChapterNumber ? {
    ...entry,
    status,
    wordCount: countChapterLength(plan.rescue.candidateBody, resolveLengthCountingMode(bookLanguage)),
    updatedAt,
    auditIssues: plan.finalReview.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    tokenUsage,
    roleUsage: plan.provenance.roleUsage,
    autonomousReview: {
      status: plan.finalReview.decision,
      grade: plan.finalReview.overallScore >= 90 ? "A" as const : plan.finalReview.overallScore >= 80 ? "B" as const : "C" as const,
      revisionCount: plan.provenance.revisionCount,
    },
  } : entry);
  const runtimePath = join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf-8")) as Record<string, unknown>;
  const writes: Array<{ readonly relativePath: string; readonly content: string }> = [
    { relativePath: join("chapters", plan.chapterFile), content: finalBody },
    ...plan.stateSettlement.artifacts.map((artifact) => ({
      relativePath: artifact.targetRelativePath,
      content: artifact.content,
    })),
    { relativePath: join("chapters", "index.json"), content: `${JSON.stringify(updatedIndex, null, 2)}\n` },
    { relativePath: join("story", "runtime", "bounded-autonomous", "production-state.json"), content: `${JSON.stringify({
      ...runtime,
      status: "RUNNING",
      nextChapter: plan.sourceChapterNumber,
      chapterNumber: plan.sourceChapterNumber,
      checkpoint: "OFFLINE_FINALIZATION_COMPLETE",
      responseArtifactStatus: "COMPLETE",
      updatedAt,
    }, null, 2)}\n` },
  ];
  for (const binding of plan.bindings.filter((entry) => entry.fileSha256 === undefined)) {
    const authority: RecoveryBindingAuthority = {
      schema_version: "1.0",
      binding_type: "CORRECTED_PENDING_CHAPTER_REFERENCE",
      job_id: plan.jobId,
      logical_step_id: binding.logicalStepId,
      chapter_number: plan.pendingChapterNumber,
      source_chapter_number: plan.sourceChapterNumber,
      source_logical_step_id: binding.sourceLogicalStepId,
      source_artifact_sha256: binding.sourceArtifactSha256,
      source_content_sha256: binding.sourceContentSha256,
      resume_evidence_sha256: binding.resumeEvidenceSha256,
    };
    writes.push({
      relativePath: join(responseDirRelative, `${binding.logicalStepId}.binding.json`),
      content: `${JSON.stringify({ ...authority, created_at: updatedAt }, null, 2)}\n`,
    });
  }
  if (plan.recoveryClass === "FAILED_REENTRY") {
    const supersessionRelativePath = join("story", "runtime", "bounded-autonomous", `chapter-${String(plan.pendingChapterNumber).padStart(4, "0")}`, "offline-finalization-supersession.json");
    const authority = {
      schema_version: "1.0",
      evidence_type: "OFFLINE_FINALIZATION_SUPERSESSION",
      reason_code: "OFFLINE_RECOVERY_REENTRY_SUPERSEDED",
      book_id: plan.bookId,
      job_id: plan.jobId,
      pending_chapter_number: plan.pendingChapterNumber,
      historical_resume_evidence_sha256: plan.evidence.historicalSha256,
      current_resume_evidence_sha256: plan.evidence.currentSha256,
      corrected_bindings: plan.bindings.map((binding) => ({ logical_step_id: binding.logicalStepId, authority_sha256: binding.authoritySha256, file_sha256: binding.fileSha256 })),
      rescue_artifact: { logical_step_id: plan.rescue.sourceLogicalStepId, artifact_sha256: plan.rescue.sourceArtifactSha256, content_sha256: plan.rescue.sourceContentSha256 },
      final_review_artifact: { logical_step_id: plan.finalReview.sourceLogicalStepId, artifact_sha256: plan.finalReview.sourceArtifactSha256, content_sha256: plan.finalReview.sourceContentSha256 },
      state_settlement_proof: {
        relative_path: plan.stateSettlement.proofRelativePath,
        sha256: plan.stateSettlement.proofSha256,
        snapshot_id: plan.stateSettlement.snapshotId,
        rescue_candidate_body_sha256: plan.stateSettlement.candidateBodySha256,
      },
      failed_reentry_artifacts: plan.failedReentryArtifacts.map((artifact) => ({ logical_step_id: artifact.logicalStepId, artifact_sha256: artifact.artifactSha256, content_sha256: artifact.contentSha256 })),
    };
    try {
      const existing = JSON.parse(await readFile(join(bookDir, supersessionRelativePath), "utf-8")) as Record<string, unknown>;
      const { created_at: _createdAt, ...existingAuthority } = existing;
      if (JSON.stringify(existingAuthority) !== JSON.stringify(authority)) throw new Error("OFFLINE_FINALIZATION_SUPERSESSION_CONFLICT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      writes.push({ relativePath: supersessionRelativePath, content: `${JSON.stringify({ ...authority, created_at: updatedAt }, null, 2)}\n` });
    }
  }
  await commitAtomicFileSet({ rootDir: bookDir, writes });
  return {
    chapterNumber: plan.pendingChapterNumber,
    status,
    revisionCount: plan.provenance.revisionCount,
    logicReviewCount: plan.provenance.logicReviewCount,
    commercialReviewCount: plan.provenance.commercialReviewCount,
    roleUsage: plan.provenance.roleUsage,
  };
}

function logicalProviderStepId(params: {
  readonly jobId: string;
  readonly chapterNumber: number;
  readonly stage: AutonomousStageMetadata;
  readonly provider: string;
  readonly model: string;
  readonly inputFingerprint: string;
}): string {
  const raw = [
    params.stage.transactionId ? "inkos-autonomous-provider-step-v2" : "inkos-autonomous-provider-step-v1",
    params.stage.transactionId ?? params.jobId,
    params.chapterNumber,
    params.stage.stage,
    params.stage.role,
    params.provider,
    params.model,
    params.inputFingerprint,
    ...(params.stage.transactionId && params.stage.revisionRound !== undefined ? [`revision-round:${params.stage.revisionRound}`] : []),
    ...(params.stage.transactionId && params.stage.reviewRound !== undefined ? [`review-round:${params.stage.reviewRound}`] : []),
    ...(!params.stage.transactionId && params.stage.reviewRound === 0 ? ["semantic-review-retry:1"] : []),
  ].join("\n");
  return `provider-step-${createHash("sha256").update(raw, "utf-8").digest("hex")}`;
}

/**
 * Binds Provider calls to the existing durable autonomous job. Successful
 * responses are saved before agent parsing and replayed by identity after a
 * process restart; ordinary non-autonomous calls never enter this context.
 */
export function createAutonomousProviderExecution(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly getActiveStage: () => AutonomousStageMetadata;
  readonly assertModelCallAdmission?: () => void;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}): AutonomousProviderRecovery & {
  readonly responseArtifactPath: (inputFingerprint: string, provider: string, model: string, chapterNumber: number) => string;
  readonly responseArtifactBindingPath: (inputFingerprint: string, provider: string, model: string, chapterNumber: number) => string;
  readonly runProviderCall: (chapterNumber: number, transport: () => Promise<LLMResponse>, request: { readonly provider: string; readonly model: string; readonly inputFingerprint: string }) => Promise<LLMResponse>;
} {
  let activeChapter = 0;
  const completeAdmissionBootstraps = new Map<string, Promise<Set<string>>>();
  const getCompleteAdmissionLogicalStepIds = (transactionId: string): Promise<Set<string>> => {
    const existing = completeAdmissionBootstraps.get(transactionId);
    if (existing) return existing;
    const logicalStepIds = loadTransactionCompleteLogicalStepIds(
      params.projectRoot,
      params.bookId,
      transactionId,
    ).then((ids) => new Set(ids));
    completeAdmissionBootstraps.set(transactionId, logicalStepIds);
    return logicalStepIds;
  };
  const identify = (request: { readonly provider: string; readonly model: string; readonly inputFingerprint: string }): LLMCallExecutionIdentity => {
    const stage = params.getActiveStage();
    const logicalStepId = logicalProviderStepId({
      jobId: params.jobId,
      chapterNumber: activeChapter,
      stage,
      provider: request.provider,
      model: request.model,
      inputFingerprint: request.inputFingerprint,
    });
    return {
      logicalStepId,
      inputFingerprint: request.inputFingerprint,
      provider: request.provider,
      model: request.model,
      role: stage.role,
      stage: stage.stage,
      ...(stage.transactionId !== undefined ? { transactionId: stage.transactionId } : {}),
      ...(stage.revisionRound !== undefined ? { revisionRound: stage.revisionRound } : {}),
      ...(stage.reviewRound !== undefined ? { reviewRound: stage.reviewRound } : {}),
    };
  };
  const artifactPathForIdentity = (identity: LLMCallExecutionIdentity) => join(providerResponseArtifactDir(params.projectRoot, params.bookId), `${identity.logicalStepId}.json`);
  const bindingPathForIdentity = (identity: LLMCallExecutionIdentity) => join(providerResponseArtifactDir(params.projectRoot, params.bookId), `${identity.logicalStepId}.binding.json`);
  const markResponseArtifactComplete = async (identity: LLMCallExecutionIdentity): Promise<void> => {
    const progress = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
    if (progress?.jobId !== params.jobId) return;
    const history = [...(progress.providerAttemptHistory ?? [])];
    const existingSuccess = history.find((entry) => entry.logicalStepId === identity.logicalStepId && entry.classification === "SUCCESS");
    let startedIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]!;
      if (entry.logicalStepId === identity.logicalStepId && entry.transportStarted
        && (!entry.transportReturned || entry.classification === "TRANSPORT_STARTED")) {
        startedIndex = index;
        break;
      }
    }
    const started = startedIndex >= 0 ? history[startedIndex] : undefined;
    const attempt = existingSuccess?.attempt ?? started?.attempt ?? Math.max(0, ...history
      .filter((entry) => entry.logicalStepId === identity.logicalStepId)
      .map((entry) => entry.attempt)) + 1;
    const transportAttemptId = existingSuccess?.transportAttemptId ?? started?.transportAttemptId ?? `${identity.logicalStepId}:transport-attempt:${attempt}`;
    if (!existingSuccess) {
      const success: (typeof history)[number] = {
        transportAttemptId,
        logicalStepId: identity.logicalStepId,
        chapterNumber: activeChapter,
        role: identity.role,
        provider: identity.provider,
        requestedModel: identity.model,
        ...(identity.transactionId ? { transactionId: identity.transactionId } : {}),
        attempt,
        classification: "SUCCESS",
        transportStarted: true,
        transportReturned: true,
        recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
      };
      if (startedIndex >= 0) history[startedIndex] = success;
      else history.push(success);
    }
    await saveAutonomousProductionState(params.projectRoot, params.bookId, {
      ...progress,
      logicalStepId: identity.logicalStepId,
      chapterNumber: activeChapter,
      role: identity.role,
      stage: identity.stage,
      provider: identity.provider,
      requestedModel: identity.model,
      attempt,
      maxAttempts: 3,
      transportRetryCount: Math.max(0, attempt - 1),
      transportAttemptId,
      providerAttemptHistory: history,
      checkpoint: "RESPONSE_ARTIFACT_PERSISTED",
      responseArtifactStatus: "COMPLETE",
    });
  };
  const readArtifactFile = async (
    path: string,
    identity: LLMCallExecutionIdentity,
    expectedChapter: number,
    expectedLogicalStepId: string,
    enforceTargetSemantics = true,
  ): Promise<{ readonly artifact: PersistedProviderResponseArtifact; readonly bytes: Buffer } | undefined> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_INVALID", { cause: error });
    }
    let artifact: PersistedProviderResponseArtifact;
    try {
      artifact = JSON.parse(bytes.toString("utf-8")) as PersistedProviderResponseArtifact;
    } catch (error) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_INVALID", { cause: error });
    }
    const contentSha = createHash("sha256").update(artifact.response.content, "utf-8").digest("hex");
    if (
      artifact.schema_version !== "1.0"
      || artifact.job_id !== params.jobId
      || artifact.logical_step_id !== expectedLogicalStepId
      || artifact.usage_identity !== expectedLogicalStepId
      || artifact.chapter_number !== expectedChapter
      || (enforceTargetSemantics && artifact.role !== identity.role)
      || (enforceTargetSemantics && artifact.stage !== identity.stage)
      || artifact.provider !== identity.provider
      || artifact.requested_model !== identity.model
      || artifact.input_fingerprint !== identity.inputFingerprint
      || artifact.response_artifact_status !== "COMPLETE"
      || (identity.transactionId !== undefined && artifact.transaction_id !== identity.transactionId)
      || artifact.content_sha256 !== contentSha
    ) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_IDENTITY_MISMATCH");
    }
    return { artifact, bytes };
  };
  const readArtifact = async (identity: LLMCallExecutionIdentity): Promise<LLMResponse | undefined> => {
    const direct = await readArtifactFile(artifactPathForIdentity(identity), identity, activeChapter, identity.logicalStepId);
    if (direct) {
      return direct.artifact.response;
    }
    const bindingPath = bindingPathForIdentity(identity);
    let binding: CorrectedProviderArtifactBinding | undefined;
    try {
      binding = JSON.parse(await readFile(bindingPath, "utf-8")) as CorrectedProviderArtifactBinding;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_INVALID", { cause: error });
    }
    if (!binding) return undefined;
    const sourceChapter = activeChapter + 1;
    if (binding.schema_version !== "1.0" || binding.binding_type !== "CORRECTED_PENDING_CHAPTER_REFERENCE"
      || binding.job_id !== params.jobId || binding.logical_step_id !== identity.logicalStepId
      || binding.chapter_number !== activeChapter || binding.source_chapter_number !== sourceChapter
      || !/^provider-step-[a-f0-9]{64}$/u.test(binding.source_logical_step_id)
      || !/^[a-f0-9]{64}$/u.test(binding.resume_evidence_sha256)) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_IDENTITY_MISMATCH");
    }
    const evidencePath = join(dirname(providerResponseArtifactDir(params.projectRoot, params.bookId)), `chapter-${String(activeChapter).padStart(4, "0")}`, "resume-review.json");
    let evidenceBytes: Buffer;
    let evidence: {
      readonly schema_version?: string;
      readonly chapter_number?: number;
      readonly status?: string;
      readonly modelOutcomes?: ReadonlyArray<{ readonly modelCallId?: string }>;
    };
    try {
      evidenceBytes = await readFile(evidencePath);
      evidence = JSON.parse(evidenceBytes.toString("utf-8")) as typeof evidence;
    } catch (error) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_AUTHORITY_MISMATCH", { cause: error });
    }
    const evidenceSha = createHash("sha256").update(evidenceBytes).digest("hex");
    const evidenceTransitionValid = evidence.status === "REVIEW_EXHAUSTED"
      ? evidenceSha === binding.resume_evidence_sha256
      : evidence.status === "RUNNING";
    if (evidence.schema_version !== "1.0" || evidence.chapter_number !== activeChapter || !evidenceTransitionValid
      || !(evidence.modelOutcomes ?? []).some((outcome) => outcome.modelCallId === binding.source_logical_step_id)) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_AUTHORITY_MISMATCH");
    }
    const source = await readArtifactFile(
      join(providerResponseArtifactDir(params.projectRoot, params.bookId), `${binding.source_logical_step_id}.json`),
      identity,
      binding.source_chapter_number,
      binding.source_logical_step_id,
      false,
    );
    if (!source || createHash("sha256").update(source.bytes).digest("hex") !== binding.source_artifact_sha256
      || source.artifact.content_sha256 !== binding.source_content_sha256) {
      throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_SOURCE_MISMATCH");
    }
    return source.artifact.response;
  };
  const persistArtifact = async (identity: LLMCallExecutionIdentity, response: LLMResponse): Promise<void> => {
    const path = artifactPathForIdentity(identity);
    const existing = await readArtifact(identity);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(response)) throw new Error("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_CONFLICT");
      return;
    }
    const artifact: PersistedProviderResponseArtifact = {
      schema_version: "1.0",
      job_id: params.jobId,
      logical_step_id: identity.logicalStepId,
      usage_identity: identity.logicalStepId,
      chapter_number: activeChapter,
      role: identity.role,
      stage: identity.stage,
      provider: identity.provider,
      requested_model: identity.model,
      input_fingerprint: identity.inputFingerprint,
      response_artifact_status: "COMPLETE",
      content_sha256: createHash("sha256").update(response.content, "utf-8").digest("hex"),
      response,
      completed_at: new Date(params.now?.() ?? Date.now()).toISOString(),
      ...(identity.transactionId ? { transaction_id: identity.transactionId } : {}),
    };
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
    try {
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    const admissionBootstrap = identity.transactionId
      ? completeAdmissionBootstraps.get(identity.transactionId)
      : undefined;
    if (admissionBootstrap) {
      (await admissionBootstrap).add(identity.logicalStepId);
    }
    await markResponseArtifactComplete(identity);
  };
  const markTransportStarted = async (identity: LLMCallExecutionIdentity): Promise<void> => {
    params.assertModelCallAdmission?.();
    const progress = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
    if (progress?.jobId !== params.jobId) return;
    const history = [...(progress.providerAttemptHistory ?? [])];
    const ambiguous = history.find((entry) => entry.logicalStepId === identity.logicalStepId && entry.transportStarted && !entry.transportReturned);
    if (ambiguous) {
      throw new LLMCallExecutionError("AUTONOMOUS_PROVIDER_OUTCOME_AMBIGUOUS", {
        ...identity, classification: "AMBIGUOUS_PROVIDER_OUTCOME",
        transportStarted: true, transportReturned: false,
      });
    }
    if (identity.transactionId) {
      const completeLogicalStepIds = await getCompleteAdmissionLogicalStepIds(identity.transactionId);
      const transactionHistory = history.filter((entry) => entry.transactionId === identity.transactionId
        || completeLogicalStepIds.has(entry.logicalStepId)
        // Pre-ceiling runtime rows have no transactionId. The active runtime is
        // chapter-scoped, so conservatively charge unbound rows for this chapter
        // rather than allowing already-spent transports to disappear on upgrade.
        || (entry.transactionId === undefined && entry.chapterNumber === activeChapter));
      const admittedLogicalCalls = new Set([
        ...completeLogicalStepIds,
        ...transactionHistory.map((entry) => entry.logicalStepId),
      ]);
      if (!admittedLogicalCalls.has(identity.logicalStepId)
        && admittedLogicalCalls.size >= MAX_CHAPTER_TRANSACTION_LOGICAL_CALLS) {
        throw new Error("CHAPTER_LOGICAL_MODEL_CALL_LIMIT_REACHED");
      }
      if (transactionHistory.filter((entry) => entry.transportStarted).length
        >= MAX_CHAPTER_TRANSACTION_PROVIDER_TRANSPORTS) {
        throw new Error("CHAPTER_PROVIDER_TRANSPORT_LIMIT_REACHED");
      }
    }
    const attempt = Math.max(0, ...history.filter((entry) => entry.logicalStepId === identity.logicalStepId).map((entry) => entry.attempt)) + 1;
    if (attempt > 3) throw new Error("PROVIDER_RETRY_EXHAUSTED");
    const transportAttemptId = `${identity.logicalStepId}:transport-attempt:${attempt}`;
    history.push({
      transportAttemptId, logicalStepId: identity.logicalStepId, chapterNumber: activeChapter, role: identity.role,
      provider: identity.provider, requestedModel: identity.model, attempt, classification: "TRANSPORT_STARTED",
      ...(identity.transactionId ? { transactionId: identity.transactionId } : {}),
      transportStarted: true, transportReturned: false, recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
    });
    await saveAutonomousProductionState(params.projectRoot, params.bookId, {
      ...progress, logicalStepId: identity.logicalStepId, chapterNumber: activeChapter, role: identity.role,
      stage: identity.stage, provider: identity.provider, requestedModel: identity.model, attempt, maxAttempts: 3,
      transportRetryCount: Math.max(0, attempt - 1), transportAttemptId, providerAttemptHistory: history,
      checkpoint: "TRANSPORT_STARTED", responseArtifactStatus: "NONE",
    });
  };
  const persistFailure = async (identity: LLMCallExecutionIdentity, failure: LLMCallFailureMetadata): Promise<void> => {
    const progress = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
    if (progress?.jobId !== params.jobId) return;
    const history = [...(progress.providerAttemptHistory ?? [])];
    let startedIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]!;
      if (entry.logicalStepId === identity.logicalStepId && entry.transportStarted && !entry.transportReturned) {
        startedIndex = index;
        break;
      }
    }
    if (startedIndex < 0) throw new Error("AUTONOMOUS_PROVIDER_ATTEMPT_START_NOT_DURABLE");
    const started = history[startedIndex]!;
    history[startedIndex] = {
      ...started,
      classification: failure.classification,
      transportStarted: failure.transportStarted,
      transportReturned: failure.transportReturned,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
    };
    await saveAutonomousProductionState(params.projectRoot, params.bookId, {
      ...progress,
      logicalStepId: identity.logicalStepId,
      chapterNumber: activeChapter,
      role: identity.role,
      stage: identity.stage,
      provider: identity.provider,
      requestedModel: identity.model,
      attempt: started.attempt,
      maxAttempts: 3,
      transportRetryCount: Math.max(0, started.attempt - 1),
      transportAttemptId: started.transportAttemptId,
      providerAttemptHistory: history,
      checkpoint: failure.transportReturned ? "TRANSPORT_RETURNED_FAILURE" : "TRANSPORT_OUTCOME_AMBIGUOUS",
      responseArtifactStatus: "NONE",
      lastErrorClassification: failure.classification,
      lastRetryableClassification: failure.classification,
      ...(failure.httpStatus !== undefined ? { lastHttpStatus: failure.httpStatus } : {}),
    });
  };
  const markTransportReturned = async (identity: LLMCallExecutionIdentity): Promise<void> => {
    const progress = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
    if (progress?.jobId !== params.jobId) return;
    const history = [...(progress.providerAttemptHistory ?? [])];
    let startedIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]!;
      if (entry.logicalStepId === identity.logicalStepId && entry.transportStarted && !entry.transportReturned) {
        startedIndex = index;
        break;
      }
    }
    if (startedIndex < 0) throw new Error("AUTONOMOUS_PROVIDER_ATTEMPT_START_NOT_DURABLE");
    const started = history[startedIndex]!;
    history[startedIndex] = {
      ...started,
      transportReturned: true,
      recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
    };
    try {
      await saveAutonomousProductionState(params.projectRoot, params.bookId, {
        ...progress,
        logicalStepId: identity.logicalStepId,
        chapterNumber: activeChapter,
        role: identity.role,
        stage: identity.stage,
        provider: identity.provider,
        requestedModel: identity.model,
        attempt: started.attempt,
        maxAttempts: 3,
        transportRetryCount: Math.max(0, started.attempt - 1),
        transportAttemptId: started.transportAttemptId,
        providerAttemptHistory: history,
        checkpoint: "TRANSPORT_RETURNED",
        responseArtifactStatus: "NONE",
      });
    } catch (error) {
      const checkpointError = error instanceof Error ? error : new Error(String(error), { cause: error });
      Object.assign(checkpointError, {
        code: RETURNED_TRANSPORT_CHECKPOINT_FAILURE,
        checkpoint: {
          jobId: params.jobId,
          chapterNumber: activeChapter,
          logicalStepId: identity.logicalStepId,
          providerAttemptHistory: history,
        },
      } satisfies ReturnedTransportCheckpointFailureEnvelope);
      throw checkpointError;
    }
  };
  const normalizeLegacyEmptyResponseAttempt = async (
    identity: LLMCallExecutionIdentity,
    progress: AutonomousRunProgress,
  ): Promise<AutonomousRunProgress> => {
    const history = [...(progress.providerAttemptHistory ?? [])];
    const ambiguousIndexes = history
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.logicalStepId === identity.logicalStepId && entry.transportStarted && !entry.transportReturned);
    const errorText = String(progress.reason ?? "").toLowerCase();
    const knownEmptyResponse = errorText.includes("llm returned empty response")
      || errorText.includes("llm returned reasoning without a final answer");
    const provableLegacyShape = progress.responseArtifactStatus !== "COMPLETE"
      && progress.status === "PAUSED_DETERMINISTIC_PROVIDER_ERROR"
      && progress.checkpoint === "DETERMINISTIC_PROVIDER_ERROR"
      && progress.lastErrorClassification === "DETERMINISTIC_PROVIDER_ERROR"
      && knownEmptyResponse
      && ambiguousIndexes.length === 1;
    if (!provableLegacyShape) return progress;
    const { entry, index } = ambiguousIndexes[0]!;
    history[index] = {
      ...entry,
      classification: "RETRYABLE_PROVIDER_RESPONSE",
      transportStarted: true,
      transportReturned: true,
      recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
    };
    const normalized = {
      ...progress,
      providerAttemptHistory: history,
      lastErrorClassification: "RETRYABLE_PROVIDER_RESPONSE",
      lastRetryableClassification: "RETRYABLE_PROVIDER_RESPONSE",
      checkpoint: "LEGACY_RETURNED_RESPONSE_NORMALIZED",
    };
    await saveAutonomousProductionState(params.projectRoot, params.bookId, normalized);
    return normalized;
  };
  const policy: LLMCallExecutionPolicy = {
    prepare: async (request) => {
      const identity = identify(request);
      const cachedResponse = await readArtifact(identity);
      if (!cachedResponse) {
        let progress = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
        if (progress?.jobId === params.jobId) progress = await normalizeLegacyEmptyResponseAttempt(identity, progress);
        if (progress?.jobId === params.jobId && (progress.providerAttemptHistory ?? []).some((entry) => entry.logicalStepId === identity.logicalStepId
          && entry.transportStarted && !entry.transportReturned)) {
          throw new LLMCallExecutionError("AUTONOMOUS_PROVIDER_OUTCOME_AMBIGUOUS", {
            ...identity, classification: "AMBIGUOUS_PROVIDER_OUTCOME",
            transportStarted: true, transportReturned: false,
          });
        }
        const returned = progress?.jobId === params.jobId
          ? [...(progress.providerAttemptHistory ?? [])].reverse().find((entry) => entry.logicalStepId === identity.logicalStepId && entry.transportReturned)
          : undefined;
        if (returned && !["RETRYABLE_PROVIDER_HTTP", "RETRYABLE_PROVIDER_RESPONSE"].includes(returned.classification)) {
          throw new Error("OPERATOR_DECISION_REQUIRED");
        }
      }
      return { identity, ...(cachedResponse ? { cachedResponse } : {}) };
    },
    persistSuccess: persistArtifact,
    markTransportStarted,
    markTransportReturned,
    persistFailure,
  };
  const runProviderCall = async (chapterNumber: number, transport: () => Promise<LLMResponse>, request: { readonly provider: string; readonly model: string; readonly inputFingerprint: string }) => {
    activeChapter = chapterNumber;
    const prepared = await policy.prepare(request);
    if (prepared.cachedResponse) return prepared.cachedResponse;
    await policy.markTransportStarted?.(prepared.identity);
    let response: LLMResponse;
    try {
      response = await transport();
    } catch (error) {
      if (error instanceof LLMCallExecutionError) throw error;
      const classified = classifyLLMCallFailure(error);
      const executionError = new LLMCallExecutionError(error instanceof Error ? error.message : String(error), {
        ...prepared.identity,
        ...classified,
      }, { cause: error });
      await policy.persistFailure?.(prepared.identity, executionError.metadata);
      throw executionError;
    }
    await policy.markTransportReturned?.(prepared.identity);
    await policy.persistSuccess(prepared.identity, response);
    return response;
  };
  return {
    execute: async (chapterNumber, task) => {
      activeChapter = chapterNumber;
      return runWithLLMCallExecutionPolicy(policy, task);
    },
    loadPersistedProgress: () => loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId),
    now: params.now ?? Date.now,
    sleep: params.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    responseArtifactPath: (inputFingerprint, provider, model, chapterNumber) => {
      activeChapter = chapterNumber;
      return artifactPathForIdentity(identify({ inputFingerprint, provider, model }));
    },
    responseArtifactBindingPath: (inputFingerprint, provider, model, chapterNumber) => {
      activeChapter = chapterNumber;
      return bindingPathForIdentity(identify({ inputFingerprint, provider, model }));
    },
    runProviderCall,
  };
}

export function deriveAutonomousJobIdentity(params: {
  readonly map: BookProductionMap;
  readonly mode: ProductionMode;
  readonly nextChapter: number;
}): string {
  const scope = resolveProductionScope(params.map, params.nextChapter, params.mode);
const identity = [
    "inkos-autonomous-production-v1",
    params.map.bookId,
    params.mode,
    params.mode === "current-volume" ? scope.currentVolume.volumeId : "full-book",
    scope.targetChapter,
  ].join("\n");
  return `autonomous-${createHash("sha256").update(identity, "utf-8").digest("hex").slice(0, 32)}`;
}

export async function createAutonomousPipelineActions<
  ChapterResult extends { readonly chapterNumber: number; readonly status: string },
  ResumeResult extends { readonly chapterNumber: number; readonly status: string },
>(params: {
  readonly bookId: string;
  readonly state: {
    loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>>;
    saveChapterIndex(bookId: string, chapters: ReadonlyArray<ChapterMeta>): Promise<void>;
  };
  readonly pipeline: {
    writeNextChapter(bookId: string, wordCount?: number): Promise<ChapterResult>;
    resumeAuditFailedChapterBounded(bookId: string, chapterNumber: number, options?: { readonly safeReplayStage?: string }): Promise<ResumeResult>;
  };
}) {
  const index = await params.state.loadChapterIndex(params.bookId);
  const pendingChapters = index.filter((chapter) => chapter.status === "audit-failed");
  if (pendingChapters.length > 1) {
    throw new Error("AUTONOMOUS_MULTIPLE_AUDIT_FAILED_CHAPTERS");
  }
  const pending = pendingChapters[0];
  const latest = index.reduce((maximum, chapter) => Math.max(maximum, chapter.number), 0);
  if (pending && pending.number !== latest) {
    throw new Error("AUTONOMOUS_AUDIT_FAILED_CHAPTER_NOT_LATEST");
  }
  const verifyChapterTerminal = async (chapterNumber: number, status: "approved" | "accepted-with-findings") => {
    const latest = await params.state.loadChapterIndex(params.bookId);
    const matches = latest.filter((chapter) => chapter.number === chapterNumber);
    if (matches.length !== 1 || matches[0]!.status !== status) {
      throw new Error("AUTONOMOUS_CHAPTER_TERMINAL_PROMOTION_FAILED");
    }
    return { chapterNumber, status } as const;
  };
  const promoteChapterTerminal = async (chapterNumber: number, status: "approved" | "accepted-with-findings") => {
    const latest = await params.state.loadChapterIndex(params.bookId);
    const matches = latest.filter((chapter) => chapter.number === chapterNumber);
    if (matches.length !== 1) throw new Error("AUTONOMOUS_CHAPTER_TERMINAL_PROMOTION_FAILED");
    const current = matches[0]!;
    const promotable = status === "approved"
      ? current.status === "ready-for-review" || current.status === "audit-failed" || current.status === "approved"
      : current.status === "ready-for-review" || current.status === "audit-failed" || current.status === "accepted-with-findings";
    if (!promotable) throw new Error("AUTONOMOUS_CHAPTER_TERMINAL_PROMOTION_CONFLICT");
    if (current.status === status) return verifyChapterTerminal(chapterNumber, status);
    const now = new Date().toISOString();
    await params.state.saveChapterIndex(params.bookId, latest.map((chapter) => chapter.number === chapterNumber
      ? { ...chapter, status, updatedAt: now }
      : chapter));
    return verifyChapterTerminal(chapterNumber, status);
  };
  return {
    ...(pending ? { pendingChapterNumber: pending.number } : {}),
    ...(pending ? {
      resumePendingChapter: async (options?: { readonly safeReplayStage?: string }) => {
        const result = await params.pipeline.resumeAuditFailedChapterBounded(params.bookId, pending.number, options);
        if (result.status === "approved" || result.status === "accepted-with-findings") {
          await promoteChapterTerminal(pending.number, result.status);
        }
        return result;
      },
    } : {}),
    runChapter: async (wordCount?: number) => {
      const result = await params.pipeline.writeNextChapter(params.bookId, wordCount);
      if (result.status === "ready-for-review") await promoteChapterTerminal(result.chapterNumber, "approved");
      if (result.status === "accepted-with-findings") await promoteChapterTerminal(result.chapterNumber, "accepted-with-findings");
      return result;
    },
    promoteChapterTerminal,
    verifyChapterTerminal,
  };
}

export async function runBoundedAutonomousScope(params: {
  readonly map: BookProductionMap;
  readonly mode: ProductionMode;
  readonly getNextChapter: () => Promise<number>;
  readonly pendingChapterNumber?: number;
  readonly recoveryScopeChapterNumber?: number;
  readonly resumePendingChapter?: (options?: { readonly safeReplayStage?: string }) => Promise<{
    readonly status: string;
    readonly chapterNumber: number;
    readonly revisionCount?: number;
    readonly invalidReviewerRole?: string;
  }>;
  readonly runChapter: () => Promise<{
    readonly status: string;
    readonly autonomousReview?: {
      readonly revisionCount: number;
      readonly holdReason?: string;
      readonly invalidReviewerRole?: string;
    };
  }>;
  readonly shouldStop: () => boolean;
  readonly persistProgress: (progress: AutonomousRunProgress) => Promise<void>;
  readonly providerRecovery?: AutonomousProviderRecovery;
  readonly verifyChapterStartAuthority?: (chapterNumber: number) => Promise<void>;
}): Promise<AutonomousRunProgress> {
  const initialNext = await params.getNextChapter();
  const scopeChapterNumber = params.recoveryScopeChapterNumber ?? initialNext;
  const scope = resolveProductionScope(params.map, scopeChapterNumber, params.mode);
  const jobId = deriveAutonomousJobIdentity({ map: params.map, mode: params.mode, nextChapter: scopeChapterNumber });
  let completedThisRun = 0;

  const project = (
    status: AutonomousRunStatus,
    nextChapter: number,
    reason?: string,
    details: Partial<AutonomousRunProgress> = {},
  ): AutonomousRunProgress => ({
    jobId,
    status,
    mode: params.mode,
    volumeId: (status === "VOLUME_COMPLETE"
      ? scope.currentVolume
      : params.map.volumes.find((volume) => nextChapter >= volume.startChapter && nextChapter <= volume.endChapter)
        ?? params.map.volumes.at(-1)!).volumeId,
    startChapter: scope.startChapter,
    targetChapter: scope.targetChapter,
    nextChapter,
    completedThisRun,
    ...(reason ? { reason } : {}),
    ...details,
  });

  const persistedProgress = params.providerRecovery
    ? await params.providerRecovery.loadPersistedProgress()
    : null;
  let retryState = persistedProgress;
  if (retryState?.jobId !== jobId || retryState.status !== "WAITING_PROVIDER_RETRY") retryState = null;
  let providerAttemptHistory = persistedProgress?.jobId === jobId
    ? [...(persistedProgress.providerAttemptHistory ?? [])]
    : [];

  const retryDetails = async (error: LLMCallExecutionError, attempt: number, details: Partial<AutonomousRunProgress> = {}): Promise<Partial<AutonomousRunProgress>> => {
    const latest = params.providerRecovery ? await params.providerRecovery.loadPersistedProgress() : null;
    if (latest?.jobId === jobId) providerAttemptHistory = [...(latest.providerAttemptHistory ?? providerAttemptHistory)];
    const transportAttemptId = `${error.metadata.logicalStepId}:transport-attempt:${attempt}`;
    if (!providerAttemptHistory.some((entry) => entry.transportAttemptId === transportAttemptId)) {
      providerAttemptHistory = [...providerAttemptHistory, {
        transportAttemptId,
        logicalStepId: error.metadata.logicalStepId,
        chapterNumber: details.chapterNumber ?? 0,
        role: error.metadata.role,
        provider: error.metadata.provider,
        requestedModel: error.metadata.model,
        attempt,
        classification: error.metadata.classification,
        transportStarted: error.metadata.transportStarted,
        transportReturned: error.metadata.transportReturned,
        ...(error.metadata.httpStatus !== undefined ? { httpStatus: error.metadata.httpStatus } : {}),
        recordedAt: new Date(params.providerRecovery?.now() ?? Date.now()).toISOString(),
      }];
    }
    return {
      logicalStepId: error.metadata.logicalStepId,
      chapterNumber: details.chapterNumber,
      role: error.metadata.role,
      stage: error.metadata.stage,
      provider: error.metadata.provider,
      requestedModel: error.metadata.model,
      attempt,
      maxAttempts: 3,
      transportRetryCount: Math.max(0, attempt - 1),
      transportAttemptId,
      providerAttemptHistory,
      lastRetryableClassification: error.metadata.classification,
      lastErrorClassification: error.metadata.classification,
      ...(error.metadata.httpStatus !== undefined ? { lastHttpStatus: error.metadata.httpStatus } : {}),
      ...(error.metadata.retryAfterMs !== undefined ? { retryAfterMs: error.metadata.retryAfterMs } : {}),
      responseArtifactStatus: "NONE",
      ...(error.metadata.revisionRound !== undefined ? { revisionRound: error.metadata.revisionRound } : {}),
      ...(error.metadata.reviewRound !== undefined ? { reviewRound: error.metadata.reviewRound } : {}),
      ...details,
    };
  };

  const executeRecoverably = async <T>(chapterNumber: number, action: (safeReplayStage?: string) => Promise<T>): Promise<T | AutonomousRunProgress> => {
    const durableNextChapter = params.pendingChapterNumber === chapterNumber ? initialNext : chapterNumber;
    const pauseForStop = async (): Promise<AutonomousRunProgress> => {
      const paused = project("PAUSED_BY_USER", durableNextChapter, undefined, { chapterNumber });
      await params.persistProgress(paused);
      return paused;
    };
    let previous = retryState;
    if (previous?.nextRetryAt && params.providerRecovery) {
      const remaining = Math.max(0, Date.parse(previous.nextRetryAt) - params.providerRecovery.now());
      if (remaining > 0) await params.providerRecovery.sleep(remaining);
    }
    while (true) {
      if (params.shouldStop()) return pauseForStop();
      try {
        const result = params.providerRecovery
          ? await params.providerRecovery.execute(chapterNumber, () => action(previous?.stage))
          : await action();
        retryState = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "AUTONOMOUS_STAGE_ADMISSION_STOPPED") {
          return pauseForStop();
        }
        if (!params.providerRecovery) throw error;
        if (!(error instanceof LLMCallExecutionError)) {
          const latest = await params.providerRecovery.loadPersistedProgress();
          const checkpoint = error && typeof error === "object"
            && (error as { readonly code?: unknown }).code === RETURNED_TRANSPORT_CHECKPOINT_FAILURE
            ? (error as Partial<ReturnedTransportCheckpointFailureEnvelope>).checkpoint
            : undefined;
          const intendedHistory = checkpoint?.jobId === jobId
            && checkpoint.chapterNumber === chapterNumber
            && checkpoint.logicalStepId
            && checkpoint.providerAttemptHistory?.some((entry) => entry.logicalStepId === checkpoint.logicalStepId
              && entry.transportStarted && entry.transportReturned)
            ? checkpoint.providerAttemptHistory
            : undefined;
          const durableHistory = intendedHistory ?? (latest?.jobId === jobId ? latest.providerAttemptHistory : undefined);
          const paused = project(
            "PAUSED_PIPELINE_ERROR",
            durableNextChapter,
            error instanceof Error ? error.message : String(error),
            {
              chapterNumber,
              checkpoint: "DETERMINISTIC_PIPELINE_ERROR",
              lastErrorClassification: "DETERMINISTIC_PIPELINE_ERROR",
              ...(durableHistory ? { providerAttemptHistory: durableHistory } : {}),
            },
          );
          await params.persistProgress(paused);
          return paused;
        }
        const priorAttempt = previous?.logicalStepId === error.metadata.logicalStepId ? previous.attempt ?? 0 : 0;
        const latestFailureState = await params.providerRecovery.loadPersistedProgress();
        const matchingHistory = latestFailureState?.jobId === jobId
          ? (latestFailureState.providerAttemptHistory ?? []).filter((entry) => entry.logicalStepId === error.metadata.logicalStepId)
          : [];
        const unfinishedAttempt = [...matchingHistory].reverse()
          .find((entry) => entry.transportStarted && !entry.transportReturned)?.attempt;
        const latestDurableAttempt = Math.max(0, ...matchingHistory.map((entry) => entry.attempt));
        const attempt = error.metadata.classification === "AMBIGUOUS_PROVIDER_OUTCOME" && unfinishedAttempt !== undefined
          ? unfinishedAttempt
          : Math.max(priorAttempt + 1, latestDurableAttempt);
        const base = await retryDetails(error, attempt, { chapterNumber });
        if (error.metadata.classification === "RETRYABLE_PROVIDER_HTTP"
          || error.metadata.classification === "RETRYABLE_PROVIDER_RESPONSE"
          || error.metadata.classification === "RETRYABLE_PRE_TRANSPORT") {
          if (attempt >= 3) {
            const paused = project("PAUSED_PROVIDER_UNAVAILABLE", durableNextChapter, "PROVIDER_RETRY_EXHAUSTED", {
              ...base,
              checkpoint: "PROVIDER_RETRY_EXHAUSTED",
            });
            await params.persistProgress(paused);
            return paused;
          }
          const minimum = attempt === 1 ? 300_000 : 900_000;
          const delayMs = Math.max(minimum, error.metadata.retryAfterMs ?? 0);
          const waiting = project("WAITING_PROVIDER_RETRY", durableNextChapter, "PROVIDER_TEMPORARY_INTERRUPTION", {
            ...base,
            nextRetryAt: new Date(params.providerRecovery.now() + delayMs).toISOString(),
            checkpoint: "RETRY_SCHEDULED",
          });
          await params.persistProgress(waiting);
          previous = waiting;
          retryState = waiting;
          await params.providerRecovery.sleep(delayMs);
          continue;
        }
        if (error.metadata.classification === "AMBIGUOUS_PROVIDER_OUTCOME") {
          const paused = project("PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", durableNextChapter, "PROVIDER_OUTCOME_MAY_HAVE_EXECUTED", {
            ...base,
            checkpoint: "AMBIGUOUS_PROVIDER_OUTCOME",
          });
          await params.persistProgress(paused);
          return paused;
        }
        const paused = project("PAUSED_DETERMINISTIC_PROVIDER_ERROR", durableNextChapter, error.message, {
          ...base,
          checkpoint: "DETERMINISTIC_PROVIDER_ERROR",
        });
        await params.persistProgress(paused);
        return paused;
      }
    }
  };

  if (scope.complete && !params.resumePendingChapter) {
    const complete = project("BOOK_COMPLETE", initialNext);
    await params.persistProgress(complete);
    return complete;
  }

  if (!retryState) await params.persistProgress(project("RUNNING", initialNext));
  if (params.resumePendingChapter) {
    const resumed = await executeRecoverably(params.pendingChapterNumber ?? initialNext, (safeReplayStage) => params.resumePendingChapter!({ ...(safeReplayStage ? { safeReplayStage } : {}) }));
    if ("mode" in resumed) return resumed;
    if (resumed.status === "review-output-invalid") {
      const invalid = project("REVIEW_OUTPUT_INVALID", initialNext, "INVALID_OUTPUT", {
        chapterNumber: params.pendingChapterNumber ?? initialNext,
        revisionCount: resumed.revisionCount ?? 0,
        ...(resumed.invalidReviewerRole ? { invalidReviewerRole: resumed.invalidReviewerRole } : {}),
      });
      await params.persistProgress(invalid);
      return invalid;
    }
    if (resumed.status === "held-after-two-revisions" || resumed.status === "review-exhausted") {
      if (resumed.revisionCount !== 2) throw new Error("AUTONOMOUS_REVISION_LIMIT_INVARIANT_VIOLATION");
      const held = project("REVIEW_EXHAUSTED", initialNext, "REVISION_LIMIT_REACHED", { revisionCount: 2 });
      await params.persistProgress(held);
      return held;
    }
    if (resumed.status === "blocked-critical-findings") {
      const blocked = project("BLOCKED_CRITICAL_FINDINGS", initialNext, "FINAL_REVIEW_CRITICAL_FINDINGS");
      await params.persistProgress(blocked);
      return blocked;
    }
    if (resumed.status === "review-decision-contradictory") {
      const blocked = project("REVIEW_DECISION_CONTRADICTORY", initialNext, "FINAL_REVIEW_DECISION_CONTRADICTORY", { chapterNumber: params.pendingChapterNumber ?? initialNext });
      await params.persistProgress(blocked);
      return blocked;
    }
    if (resumed.status !== "approved" && resumed.status !== "accepted-with-findings") {
      throw new Error("AUTONOMOUS_RECOVERED_CHAPTER_NOT_TERMINAL");
    }
    await params.persistProgress(project("RUNNING", initialNext));
  }
  while (true) {
    const nextChapter = await params.getNextChapter();
    if (nextChapter > scope.targetChapter) {
      const status = nextChapter > params.map.totalChapters ? "BOOK_COMPLETE" : "VOLUME_COMPLETE";
      const complete = project(status, nextChapter);
      await params.persistProgress(complete);
      return complete;
    }
    if (params.shouldStop()) {
      const paused = project("PAUSED_BY_USER", nextChapter);
      await params.persistProgress(paused);
      return paused;
    }
    await params.verifyChapterStartAuthority?.(nextChapter);
    const result = await executeRecoverably(nextChapter, () => params.runChapter());
    if ("mode" in result) return result;
    if (result.status === "state-degraded") {
      throw new Error("STATE_SETTLEMENT_FAILED");
    }
    if (result.status === "audit-failed") {
      throw new Error("AUTONOMOUS_REVIEW_DID_NOT_SETTLE");
    }
    if (result.status === "review-output-invalid") {
      const invalidNext = await params.getNextChapter();
      const invalid = project("REVIEW_OUTPUT_INVALID", invalidNext, "INVALID_OUTPUT", {
        chapterNumber: invalidNext,
        revisionCount: result.autonomousReview?.revisionCount ?? 0,
        ...(result.autonomousReview?.invalidReviewerRole
          ? { invalidReviewerRole: result.autonomousReview.invalidReviewerRole }
          : {}),
      });
      await params.persistProgress(invalid);
      return invalid;
    }
    if (result.status === "held-after-two-revisions") {
      if (result.autonomousReview?.revisionCount !== 2) throw new Error("AUTONOMOUS_REVISION_LIMIT_INVARIANT_VIOLATION");
      const heldNext = await params.getNextChapter();
      const held = project("HELD_AFTER_TWO_REVISIONS", heldNext, "REVISION_LIMIT_REACHED", { revisionCount: 2 });
      await params.persistProgress(held);
      return held;
    }
    if (result.status === "blocked-critical-findings") {
      const blockedNext = await params.getNextChapter();
      const blocked = project("BLOCKED_CRITICAL_FINDINGS", blockedNext, "FINAL_REVIEW_CRITICAL_FINDINGS");
      await params.persistProgress(blocked);
      return blocked;
    }
    completedThisRun += 1;
    const committedNext = await params.getNextChapter();
    await params.persistProgress(project("RUNNING", committedNext));
  }
}
