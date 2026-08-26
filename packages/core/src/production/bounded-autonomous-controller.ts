import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { parseBookProductionMap, resolveProductionScope, type BookProductionMap, type ProductionMode } from "./book-production-map.js";
import type { ChapterMeta } from "../models/chapter.js";
import {
  LLMCallExecutionError,
  runWithLLMCallExecutionPolicy,
  type LLMCallExecutionIdentity,
  type LLMCallExecutionPolicy,
  type LLMResponse,
} from "../llm/provider.js";
import { classifyFinalAuditDecision } from "../pipeline/bounded-review.js";
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
  | "BLOCKED_CRITICAL_FINDINGS"
  | "REVIEW_DECISION_CONTRADICTORY"
  | "REVIEW_EXHAUSTED"
  | "HELD_AFTER_TWO_REVISIONS";

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
}

export interface AutonomousStageMetadata {
  readonly stage: string;
  readonly role: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly revisionRound?: number;
  readonly reviewRound?: number;
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
  if (runtime?.jobId !== params.jobId || runtime.status !== "REVIEW_EXHAUSTED"
    || runtime.nextChapter !== sourceChapter || runtime.chapterNumber !== sourceChapter
    || runtime.responseArtifactStatus !== "COMPLETE") return null;
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

export interface FormalPendingChapterRecoveryPlan {
  readonly kind: "FORMAL_OFFLINE_FINALIZATION";
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

async function resolveFormalPendingChapterRecoveryPlanUnsafe(params: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly jobId: string;
  readonly pendingChapterNumber: number;
}): Promise<FormalPendingChapterRecoveryPlan | null> {
  const runtime = await loadAutonomousProductionState<AutonomousRunProgress>(params.projectRoot, params.bookId);
  const recoveryClass = runtime?.status === "REVIEW_EXHAUSTED"
    ? "ORIGINAL_REVIEW_EXHAUSTED" as const
    : runtime?.status === "BLOCKED_CRITICAL_FINDINGS" ? "FAILED_REENTRY" as const : null;
  if (!runtime || !recoveryClass) return null;
  const sourceChapterNumber = params.pendingChapterNumber + 1;
  const expectedRuntimeChapter = recoveryClass === "FAILED_REENTRY" ? params.pendingChapterNumber : sourceChapterNumber;
  if (runtime.jobId !== params.jobId || runtime.nextChapter !== sourceChapterNumber
    || runtime.chapterNumber !== expectedRuntimeChapter || runtime.responseArtifactStatus !== "COMPLETE") {
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
  const evidenceBytes = await readFile(join(bookDir, "story", "runtime", "bounded-autonomous", `chapter-${chapter}`, "resume-review.json"));
  const evidence = JSON.parse(evidenceBytes.toString("utf-8")) as {
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

  return {
    kind: "FORMAL_OFFLINE_FINALIZATION",
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
      candidateBodySha256: sha256(candidateBody),
    },
    finalReview: {
      sourceLogicalStepId: finalSource.artifact.logical_step_id,
      sourceArtifactSha256: sha256(finalSource.bytes),
      sourceContentSha256: finalSource.artifact.content_sha256,
      decision: accepted.decision,
      overallScore: accepted.overallScore,
      issues: accepted.issues,
    },
    bindings,
    failedReentryArtifacts,
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
    throw new Error("OFFLINE_FINALIZATION_EVIDENCE_NOT_PROVABLE", { cause: error });
  }
}

export async function finalizePendingChapterOfflinePlan(params: {
  readonly projectRoot: string;
  readonly plan: FormalPendingChapterRecoveryPlan;
}): Promise<{
  readonly chapterNumber: number;
  readonly status: "approved" | "accepted-with-findings";
  readonly revisionCount: 2;
  readonly logicReviewCount: 2;
  readonly commercialReviewCount: 0;
  readonly roleUsage: Readonly<Record<string, never>>;
}> {
  const plan = params.plan;
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
  const updatedIndex = index.map((entry) => entry.number === plan.pendingChapterNumber ? {
    ...entry,
    status,
    wordCount: countChapterLength(plan.rescue.candidateBody, resolveLengthCountingMode(bookLanguage)),
    updatedAt,
    auditIssues: plan.finalReview.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    autonomousReview: {
      status: plan.finalReview.decision,
      grade: plan.finalReview.overallScore >= 90 ? "A" as const : plan.finalReview.overallScore >= 80 ? "B" as const : "C" as const,
      revisionCount: 2,
    },
  } : entry);
  const runtimePath = join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf-8")) as Record<string, unknown>;
  const writes: Array<{ readonly relativePath: string; readonly content: string }> = [
    { relativePath: join("chapters", plan.chapterFile), content: finalBody },
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
  return { chapterNumber: plan.pendingChapterNumber, status, revisionCount: 2, logicReviewCount: 2, commercialReviewCount: 0, roleUsage: {} };
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
    "inkos-autonomous-provider-step-v1",
    params.jobId,
    params.chapterNumber,
    params.stage.stage,
    params.stage.role,
    params.provider,
    params.model,
    params.inputFingerprint,
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
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}): AutonomousProviderRecovery & {
  readonly responseArtifactPath: (inputFingerprint: string, provider: string, model: string, chapterNumber: number) => string;
  readonly responseArtifactBindingPath: (inputFingerprint: string, provider: string, model: string, chapterNumber: number) => string;
  readonly runProviderCall: (chapterNumber: number, transport: () => Promise<LLMResponse>, request: { readonly provider: string; readonly model: string; readonly inputFingerprint: string }) => Promise<LLMResponse>;
} {
  let activeChapter = 0;
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
    const attempt = existingSuccess?.attempt ?? Math.max(0, ...history
      .filter((entry) => entry.logicalStepId === identity.logicalStepId)
      .map((entry) => entry.attempt)) + 1;
    const transportAttemptId = existingSuccess?.transportAttemptId ?? `${identity.logicalStepId}:transport-attempt:${attempt}`;
    if (!existingSuccess) {
      history.push({
        transportAttemptId,
        logicalStepId: identity.logicalStepId,
        chapterNumber: activeChapter,
        role: identity.role,
        provider: identity.provider,
        requestedModel: identity.model,
        attempt,
        classification: "SUCCESS",
        transportStarted: true,
        transportReturned: true,
        recordedAt: new Date(params.now?.() ?? Date.now()).toISOString(),
      });
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
    await markResponseArtifactComplete(identity);
  };
  const policy: LLMCallExecutionPolicy = {
    prepare: async (request) => {
      const identity = identify(request);
      const cachedResponse = await readArtifact(identity);
      return { identity, ...(cachedResponse ? { cachedResponse } : {}) };
    },
    persistSuccess: persistArtifact,
  };
  const runProviderCall = async (chapterNumber: number, transport: () => Promise<LLMResponse>, request: { readonly provider: string; readonly model: string; readonly inputFingerprint: string }) => {
    activeChapter = chapterNumber;
    const prepared = await policy.prepare(request);
    if (prepared.cachedResponse) return prepared.cachedResponse;
    const response = await transport();
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
  const approve = async (chapterNumber: number) => {
    const latest = await params.state.loadChapterIndex(params.bookId);
    const now = new Date().toISOString();
    await params.state.saveChapterIndex(params.bookId, latest.map((chapter) => chapter.number === chapterNumber
      ? { ...chapter, status: "approved" as const, updatedAt: now }
      : chapter));
  };
  return {
    ...(pending ? { pendingChapterNumber: pending.number } : {}),
    ...(pending ? {
      resumePendingChapter: async (options?: { readonly safeReplayStage?: string }) => {
        const result = await params.pipeline.resumeAuditFailedChapterBounded(params.bookId, pending.number, options);
        if (result.status === "approved") await approve(pending.number);
        return result;
      },
    } : {}),
    runChapter: async (wordCount?: number) => {
      const result = await params.pipeline.writeNextChapter(params.bookId, wordCount);
      if (result.status === "ready-for-review") await approve(result.chapterNumber);
      return result;
    },
  };
}

export async function runBoundedAutonomousScope(params: {
  readonly map: BookProductionMap;
  readonly mode: ProductionMode;
  readonly getNextChapter: () => Promise<number>;
  readonly pendingChapterNumber?: number;
  readonly resumePendingChapter?: (options?: { readonly safeReplayStage?: string }) => Promise<{ readonly status: string; readonly chapterNumber: number }>;
  readonly runChapter: () => Promise<{ readonly status: string }>;
  readonly shouldStop: () => boolean;
  readonly persistProgress: (progress: AutonomousRunProgress) => Promise<void>;
  readonly providerRecovery?: AutonomousProviderRecovery;
}): Promise<AutonomousRunProgress> {
  const initialNext = await params.getNextChapter();
  const scope = resolveProductionScope(params.map, initialNext, params.mode);
  const jobId = deriveAutonomousJobIdentity({ map: params.map, mode: params.mode, nextChapter: initialNext });
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
    let previous = retryState;
    if (previous?.nextRetryAt && params.providerRecovery) {
      const remaining = Math.max(0, Date.parse(previous.nextRetryAt) - params.providerRecovery.now());
      if (remaining > 0) await params.providerRecovery.sleep(remaining);
    }
    while (true) {
      try {
        const result = params.providerRecovery
          ? await params.providerRecovery.execute(chapterNumber, () => action(previous?.stage))
          : await action();
        retryState = null;
        return result;
      } catch (error) {
        if (!params.providerRecovery) throw error;
        if (!(error instanceof LLMCallExecutionError)) {
          const paused = project(
            "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
            chapterNumber,
            error instanceof Error ? error.message : String(error),
            {
              chapterNumber,
              checkpoint: "DETERMINISTIC_PIPELINE_ERROR",
              lastErrorClassification: "DETERMINISTIC_PIPELINE_ERROR",
            },
          );
          await params.persistProgress(paused);
          return paused;
        }
        const priorAttempt = previous?.logicalStepId === error.metadata.logicalStepId ? previous.attempt ?? 0 : 0;
        const attempt = priorAttempt + 1;
        const base = await retryDetails(error, attempt, { chapterNumber });
        if (error.metadata.classification === "RETRYABLE_PROVIDER_HTTP" || error.metadata.classification === "RETRYABLE_PRE_TRANSPORT") {
          if (attempt >= 3) {
            const paused = project("PAUSED_PROVIDER_UNAVAILABLE", chapterNumber, "PROVIDER_RETRY_EXHAUSTED", {
              ...base,
              checkpoint: "PROVIDER_RETRY_EXHAUSTED",
            });
            await params.persistProgress(paused);
            return paused;
          }
          const minimum = attempt === 1 ? 300_000 : 900_000;
          const delayMs = Math.max(minimum, error.metadata.retryAfterMs ?? 0);
          const waiting = project("WAITING_PROVIDER_RETRY", chapterNumber, "PROVIDER_TEMPORARY_INTERRUPTION", {
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
          const paused = project("PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", chapterNumber, "PROVIDER_OUTCOME_MAY_HAVE_EXECUTED", {
            ...base,
            checkpoint: "AMBIGUOUS_PROVIDER_OUTCOME",
          });
          await params.persistProgress(paused);
          return paused;
        }
        const paused = project("PAUSED_DETERMINISTIC_PROVIDER_ERROR", chapterNumber, error.message, {
          ...base,
          checkpoint: "DETERMINISTIC_PROVIDER_ERROR",
        });
        await params.persistProgress(paused);
        return paused;
      }
    }
  };

  if (scope.complete) {
    const complete = project("BOOK_COMPLETE", initialNext);
    await params.persistProgress(complete);
    return complete;
  }

  if (!retryState) await params.persistProgress(project("RUNNING", initialNext));
  if (params.resumePendingChapter) {
    const resumed = await executeRecoverably(params.pendingChapterNumber ?? initialNext, (safeReplayStage) => params.resumePendingChapter!({ ...(safeReplayStage ? { safeReplayStage } : {}) }));
    if ("mode" in resumed) return resumed;
    if (resumed.status === "held-after-two-revisions" || resumed.status === "review-exhausted") {
      const held = project("REVIEW_EXHAUSTED", initialNext, "REVISION_LIMIT_REACHED");
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
    const result = await executeRecoverably(nextChapter, () => params.runChapter());
    if ("mode" in result) return result;
    if (result.status === "state-degraded") {
      throw new Error("STATE_SETTLEMENT_FAILED");
    }
    if (result.status === "audit-failed") {
      throw new Error("AUTONOMOUS_REVIEW_DID_NOT_SETTLE");
    }
    if (result.status === "held-after-two-revisions") {
      const heldNext = await params.getNextChapter();
      const held = project("HELD_AFTER_TWO_REVISIONS", heldNext, "REVISION_LIMIT_REACHED");
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
