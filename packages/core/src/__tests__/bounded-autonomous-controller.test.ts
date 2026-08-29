import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimAutonomousJob, correctLegacyPendingChapterArtifactBindings, createAutonomousPipelineActions, createAutonomousProviderExecution, deriveAutonomousJobIdentity, finalizePendingChapterOfflinePlan, refreshAutonomousJobClaim, releaseAutonomousJob, resolveFormalPendingChapterRecoveryPlan, runBoundedAutonomousScope, saveAutonomousProductionState, verifyFormalPendingChapterRecoveryEvidence } from "../production/bounded-autonomous-controller.js";
import type { AutonomousRunProgress } from "../production/bounded-autonomous-controller.js";
import { LLMCallExecutionError } from "../llm/provider.js";
import type { BookProductionMap } from "../production/book-production-map.js";
import type { ChapterMeta } from "../models/chapter.js";
import { abandonChapterTransactionAttempt, beginChapterTransaction, createChapterGenesis } from "../production/chapter-transaction.js";

const providerResponseFsReads = vi.hoisted(() => ({ directoryScans: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]).replace(/\\/gu, "/").endsWith("/provider-responses")) {
        providerResponseFsReads.directoryScans += 1;
      }
      return Reflect.apply(actual.readdir, actual, args);
    },
  };
});

const map: BookProductionMap = {
  schemaVersion: "1.0",
  bookId: "book",
  authorityBookId: "authority",
  title: "Book",
  totalChapters: 6,
  volumes: [
    { volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 3, chapterCount: 3 },
    { volumeId: "volume-002", volumeNumber: 2, title: "Two", startChapter: 4, endChapter: 6, chapterCount: 3 },
  ],
};

function providerFailure(params: {
  readonly classification: "RETRYABLE_PROVIDER_HTTP" | "RETRYABLE_PROVIDER_RESPONSE" | "RETRYABLE_PRE_TRANSPORT" | "AMBIGUOUS_PROVIDER_OUTCOME" | "DETERMINISTIC_PROVIDER_ERROR";
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly logicalStepId?: string;
  readonly revisionRound?: number;
}) {
  return new LLMCallExecutionError("safe synthetic provider failure", {
    logicalStepId: params.logicalStepId ?? "step-1",
    inputFingerprint: "a".repeat(64),
    provider: "openrouter",
    model: "provider/model",
    role: "auditor",
    stage: "LOGIC_REVIEW",
    ...(params.revisionRound !== undefined ? { revisionRound: params.revisionRound } : {}),
    classification: params.classification,
    transportStarted: params.classification !== "RETRYABLE_PRE_TRANSPORT",
    transportReturned: params.classification === "RETRYABLE_PROVIDER_HTTP" || params.classification === "RETRYABLE_PROVIDER_RESPONSE" || params.classification === "DETERMINISTIC_PROVIDER_ERROR",
    ...(params.status ? { httpStatus: params.status } : {}),
    ...(params.retryAfterMs ? { retryAfterMs: params.retryAfterMs } : {}),
  });
}

describe("bounded autonomous production controller", () => {
  it("proves a generic unindexed Chapter 6 preserved-review recovery and excludes true exhaustion", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-preserved-review-"));
    const { createHash } = await import("node:crypto");
    try {
      const bookDir = join(root, "books", "book");
      const evidenceDir = join(bookDir, "story", "runtime", "bounded-autonomous", "chapter-0006");
      const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
      await Promise.all([
        mkdir(join(bookDir, "chapters"), { recursive: true }),
        mkdir(join(bookDir, "story", "outline"), { recursive: true }),
        mkdir(join(bookDir, "story", "state"), { recursive: true }),
        mkdir(join(bookDir, "story", "snapshots", "5", "state"), { recursive: true }),
        mkdir(evidenceDir, { recursive: true }),
        mkdir(responseDir, { recursive: true }),
      ]);
      const recoveryMap: BookProductionMap = {
        schemaVersion: "1.0", bookId: "book", authorityBookId: "authority", title: "Book", totalChapters: 8,
        volumes: [{ volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 8, chapterCount: 8 }],
      };
      const persistedMap = {
        schema_version: recoveryMap.schemaVersion, book_id: recoveryMap.bookId, authority_book_id: recoveryMap.authorityBookId,
        title: recoveryMap.title, total_chapters: recoveryMap.totalChapters,
        volumes: recoveryMap.volumes.map((volume) => ({ volume_id: volume.volumeId, volume_number: volume.volumeNumber, title: volume.title, start_chapter: volume.startChapter, end_chapter: volume.endChapter, chapter_count: volume.chapterCount })),
      };
      await writeFile(join(bookDir, "story", "outline", "book-production-map.json"), JSON.stringify(persistedMap));
      const index = Array.from({ length: 5 }, (_, offset) => ({
        number: offset + 1, title: `Chapter ${offset + 1}`, status: "approved", wordCount: 10,
        createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", auditIssues: [], lengthWarnings: [],
      }));
      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(index));
      const manifest = JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 5 });
      await writeFile(join(bookDir, "story", "state", "manifest.json"), manifest);
      await writeFile(join(bookDir, "story", "snapshots", "5", "state", "manifest.json"), manifest);
      const candidate = "CANDIDATE_A";
      const candidateSha = createHash("sha256").update(candidate).digest("hex");
      await writeFile(join(evidenceDir, "initial.md"), candidate);
      const logicDimensions = {
        blueprint_transition: 80, causal_logic: 70, canon_continuity: 90, character_motivation: 90,
        state_inheritance: 90, hooks_disclosure: 90, narrative_clarity: 90,
      };
      const logic = {
        reviewerRole: "logic-canon-auditor", provider: "openrouter", model: "logic", totalScore: 81,
        dimensionScores: logicDimensions, decision: "REVISION_REQUIRED",
        findings: [{ findingId: "logic-1", severity: "MAJOR", evidence: "fix", impact: "causal_logic", requiredOutcome: "repair" }],
        reviewedCandidateSha: candidateSha, reviewedAt: "2026-08-27T00:00:00.000Z",
      };
      const invalidCommercial = {
        reviewerRole: "commercial-reader", provider: "openrouter", model: "reader", totalScore: 0,
        dimensionScores: {}, decision: "INVALID_OUTPUT",
        findings: [{ findingId: "commercial-1", severity: "CRITICAL", evidence: "invalid", impact: "contract", requiredOutcome: "retry" }],
        reviewedCandidateSha: candidateSha, reviewedAt: "2026-08-27T00:00:01.000Z",
      };
      const reviewPath = join(evidenceDir, "review.json");
      const reviewEvidence = {
        schema_version: "1.0", chapter_number: 6, status: "HELD_AFTER_TWO_REVISIONS", grade: "E",
        revision_count: 0, hold_reason: "INVALID_OUTPUT",
        best_candidate: { label: "INITIAL", sha256: candidateSha, combined_score: 81 },
        candidates: [{ label: "INITIAL", sha256: candidateSha, combined_score: 81, reviews: [logic, invalidCommercial] }],
        usage_by_role: {},
      };
      const originalReview = `${JSON.stringify(reviewEvidence, null, 2)}\n`;
      await writeFile(reviewPath, originalReview);
      await writeFile(join(bookDir, "story", "runtime", "chapter-0006.run.json"), JSON.stringify({
        version: 1, kind: "long-fiction", id: "book:chapter-0006", stage: "chapter-6", model: "model", skillIds: ["inkos-long-writing"],
        resumeCursor: "6", status: "needs-review", artifacts: ["story/runtime/bounded-autonomous/chapter-0006/review.json"], observations: [], updatedAt: "2026-08-27T00:00:02.000Z",
      }));
      const jobId = deriveAutonomousJobIdentity({ map: recoveryMap, mode: "current-volume", nextChapter: 6 });
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId,
        getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "openrouter", model: "writer" }),
      });
      const fingerprint = "a".repeat(64);
      const artifactPath = execution.responseArtifactPath(fingerprint, "openrouter", "writer", 6);
      const logicalStepId = artifactPath.split(/[\\/]/u).at(-1)!.replace(/\.json$/u, "");
      const content = `=== CHAPTER_TITLE ===\nGeneric Six\n=== CHAPTER_CONTENT ===\n${candidate}`;
      await writeFile(artifactPath, JSON.stringify({
        schema_version: "1.0", job_id: jobId, logical_step_id: logicalStepId, usage_identity: logicalStepId,
        chapter_number: 6, role: "writer", stage: "WRITING", provider: "openrouter", requested_model: "writer",
        input_fingerprint: fingerprint, response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(content).digest("hex"),
        response: { content }, completed_at: "2026-08-27T00:00:00.000Z",
      }));
      await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({
        jobId, status: "HELD_AFTER_TWO_REVISIONS", mode: "current-volume", volumeId: "volume-001", startChapter: 6,
        targetChapter: 8, nextChapter: 6, chapterNumber: 6, completedThisRun: 0, responseArtifactStatus: "COMPLETE",
      }));

      const plan = await resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 });
      expect(plan).toMatchObject({
        kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", pendingChapterNumber: 6,
        candidate: { content: candidate, sha256: candidateSha, title: "Generic Six" },
        invalidReviewerRoles: ["commercial-reader"],
        initialReviews: { "logic-canon-auditor": { decision: "REVISION_REQUIRED" } },
      });
      expect(await readFile(reviewPath, "utf-8")).toBe(originalReview);

      const runtimePath = join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json");
      const originalRuntime = JSON.parse(await readFile(runtimePath, "utf-8"));
      for (const status of ["RUNNING", "WAITING_PROVIDER_RETRY", "PAUSED_PROVIDER_UNAVAILABLE", "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "PAUSED_DETERMINISTIC_PROVIDER_ERROR"] as const) {
        await writeFile(runtimePath, JSON.stringify({
          ...originalRuntime, status,
          recoveryOwnership: {
            kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", recoveryClass: "PRESERVED_BOUNDED_REVIEW",
            bookId: "book", jobId, pendingChapterNumber: 6,
          },
        }));
        await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
          .resolves.toMatchObject({ kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", candidate: { sha256: candidateSha } });
      }
      await writeFile(runtimePath, JSON.stringify(originalRuntime));

      const completedAttemptPath = join(evidenceDir, "preserved-review-resume-001.json");
      await writeFile(completedAttemptPath, JSON.stringify({ status: "REVIEW_OUTPUT_INVALID" }));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_RECOVERY_ALREADY_ATTEMPTED");
      await rm(completedAttemptPath);

      await writeFile(reviewPath, JSON.stringify({ ...reviewEvidence, revision_count: 2, hold_reason: "REVISION_LIMIT_REACHED" }));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 })).resolves.toBeNull();
      await writeFile(reviewPath, originalReview);
      await writeFile(join(evidenceDir, "initial.md"), "MISMATCH");
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_SHA_AUTHORITY_MISMATCH");
      await writeFile(join(evidenceDir, "initial.md"), candidate);

      const formalChapterPath = join(bookDir, "chapters", "0006_Unexpected.md");
      await writeFile(formalChapterPath, "unexpected");
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_FORMAL_CHAPTER_ALREADY_EXISTS");
      await rm(formalChapterPath);

      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([...index, { ...index[0], number: 6 }]));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_INDEX_ALREADY_EXISTS");
      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(index));

      const snapshotSix = join(bookDir, "story", "snapshots", "6");
      await mkdir(snapshotSix, { recursive: true });
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_TERMINAL_SNAPSHOT_CONFLICT");
      await rm(snapshotSix, { recursive: true });

      await writeFile(join(bookDir, "story", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 4 }));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_BASELINE_NOT_PROVABLE");
      await writeFile(join(bookDir, "story", "state", "manifest.json"), manifest);

      await writeFile(reviewPath, JSON.stringify({ ...reviewEvidence, chapter_number: 7 }));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_REVIEW_EVIDENCE_INVALID");
      await writeFile(reviewPath, originalReview);

      const titleArtifact = await readFile(artifactPath);
      await rm(artifactPath);
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_TITLE_AUTHORITY_NOT_PROVABLE");
      await writeFile(artifactPath, titleArtifact);

      const finalCandidate = "CANDIDATE_A after bounded review.";
      const finalCandidateSha = createHash("sha256").update(finalCandidate).digest("hex");
      const terminalReceiptPath = join(evidenceDir, "preserved-review-resume-001.json");
      const terminalCandidatePath = join(evidenceDir, "preserved-review-resume-001-revision_1.md");
      const terminalChapterPath = join(bookDir, "chapters", "0006_Generic_Six.md");
      const terminalIndex = [...index, {
        number: 6, title: "Generic Six", status: "approved", wordCount: finalCandidate.length,
        createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:03.000Z", auditIssues: [], lengthWarnings: [],
      }];
      const terminalManifest = JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 6 });
      await Promise.all([
        writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "book", language: "en" })),
        writeFile(terminalCandidatePath, finalCandidate),
        writeFile(terminalReceiptPath, JSON.stringify({
          schema_version: "1.0", chapter_number: 6, status: "APPROVED", grade: "A", revision_count: 1,
          hold_reason: null, invalid_reviewer_role: null,
          best_candidate: { label: "REVISION_1", sha256: finalCandidateSha, combined_score: 94 },
          candidates: [
            { label: "INITIAL", sha256: candidateSha, combined_score: 81, reviews: [logic, invalidCommercial] },
            { label: "REVISION_1", sha256: finalCandidateSha, combined_score: 94, reviews: [] },
          ],
          usage_by_role: {},
        }, null, 2)),
        writeFile(terminalChapterPath, `# Chapter 6: Generic Six\n\n${finalCandidate}`),
        writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(terminalIndex)),
        mkdir(join(bookDir, "story", "snapshots", "6", "state"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(bookDir, "story", "state", "manifest.json"), terminalManifest),
        writeFile(join(bookDir, "story", "snapshots", "6", "state", "manifest.json"), terminalManifest),
        writeFile(runtimePath, JSON.stringify({
          ...originalRuntime, status: "RUNNING", nextChapter: 6,
          recoveryOwnership: {
            kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", recoveryClass: "PRESERVED_BOUNDED_REVIEW",
            bookId: "book", jobId, pendingChapterNumber: 6,
          },
        })),
      ]);
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .resolves.toMatchObject({
          kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME",
          terminalReconciliation: { status: "approved", chapterFile: "0006_Generic_Six.md", candidateSha256: finalCandidateSha },
        });
      await writeFile(terminalChapterPath, "# Chapter 6: Generic Six\n\nTAMPERED");
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_TERMINAL_RECONCILIATION_CONFLICT");
      await Promise.all([
        rm(terminalReceiptPath), rm(terminalCandidatePath), rm(terminalChapterPath), rm(join(bookDir, "story", "snapshots", "6"), { recursive: true }),
        writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(index)),
        writeFile(join(bookDir, "story", "state", "manifest.json"), manifest),
        writeFile(runtimePath, JSON.stringify(originalRuntime)),
      ]);

      const runtimeEvidence = JSON.parse(await readFile(runtimePath, "utf-8"));
      await writeFile(runtimePath, JSON.stringify({ ...runtimeEvidence, providerAttemptHistory: [{
        transportAttemptId: "ambiguous", logicalStepId: `provider-step-${"9".repeat(64)}`, chapterNumber: 6,
        role: "commercial-reader", provider: "openrouter", requestedModel: "reader", attempt: 1,
        classification: "AMBIGUOUS_PROVIDER_OUTCOME", transportStarted: true, transportReturned: false,
        recordedAt: "2026-08-27T00:00:03.000Z",
      }] }));
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 6 }))
        .rejects.toThrow("PRESERVED_CANDIDATE_AMBIGUOUS_PROVIDER_OUTCOME");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives one stable job identity for the same book, mode, and dynamic volume", () => {
    const first = deriveAutonomousJobIdentity({ map, mode: "current-volume", nextChapter: 1 });
    const resumed = deriveAutonomousJobIdentity({ map, mode: "current-volume", nextChapter: 3 });
    expect(first).toBe(resumed);
    expect(deriveAutonomousJobIdentity({ map, mode: "full-book", nextChapter: 3 })).not.toBe(first);
  });

  it("never replays a COMPLETE Writer artifact across abandoned chapter attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-transaction-"));
    try {
      const bookDir = join(root, "books", "book");
      await mkdir(join(bookDir, "story", "snapshots", "4", "state"), { recursive: true });
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      for (const chapter of [1, 2, 3, 4]) await writeFile(join(bookDir, "chapters", `${String(chapter).padStart(4, "0")}_Legacy.md`), `legacy ${chapter}`);
      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([1, 2, 3, 4].map((number) => ({ number }))));
      await writeFile(join(bookDir, "story", "snapshots", "4", "current_state.md"), "state 4");
      await writeFile(join(bookDir, "story", "snapshots", "4", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 4 }));
      await createChapterGenesis({ bookDir, bookId: "book", lastTrustedChapter: 4, trustedSnapshotDir: join(bookDir, "story", "snapshots", "4") });
      const attempt1 = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 5, productionAuthority: "blueprint:v1" });
      const base = { projectRoot: root, bookId: "book", jobId: "same-job" };
      const first = createAutonomousProviderExecution({ ...base, getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId: attempt1.transactionId }) });
      const firstPath = first.responseArtifactPath("a".repeat(64), "test", "model", 5);
      let attempt1TransportCalls = 0;
      await first.runProviderCall(5, async () => {
        attempt1TransportCalls += 1;
        return { content: "first", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "a".repeat(64) });
      expect(JSON.parse(await readFile(firstPath, "utf-8"))).toMatchObject({ transaction_id: attempt1.transactionId, response_artifact_status: "COMPLETE" });

      await abandonChapterTransactionAttempt({
        bookDir, bookId: "book", chapterNumber: 5, transactionId: attempt1.transactionId, runtimeSnapshot: "{}\n",
      });
      const attempt2 = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 5, productionAuthority: "blueprint:v1" });
      const second = createAutonomousProviderExecution({ ...base, getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId: attempt2.transactionId }) });
      const secondPath = second.responseArtifactPath("a".repeat(64), "test", "model", 5);
      expect(secondPath).not.toBe(firstPath);
      expect(secondPath.split(/[\\/]/u).at(-1)).not.toBe(firstPath.split(/[\\/]/u).at(-1));
      let attempt2TransportCalls = 0;
      const result = await second.runProviderCall(5, async () => {
        attempt2TransportCalls += 1;
        return { content: "second", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "a".repeat(64) });
      expect(result.content).toBe("second");
      expect(attempt1TransportCalls).toBe(1);
      expect(attempt2TransportCalls).toBe(1);
      expect(JSON.parse(await readFile(secondPath, "utf-8"))).toMatchObject({ transaction_id: attempt2.transactionId, response_artifact_status: "COMPLETE" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never reuses an old v1 Chapter artifact as a new transaction operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-v1-quarantine-"));
    try {
      const base = { projectRoot: root, bookId: "book", jobId: "same-job" };
      const fingerprint = "f".repeat(64);
      const legacy = createAutonomousProviderExecution({
        ...base,
        getActiveStage: () => ({ stage: "PREPARING", role: "planner", provider: "test", model: "model" }),
      });
      await legacy.runProviderCall(5, async () => ({ content: "legacy-v1", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }), {
        provider: "test", model: "model", inputFingerprint: fingerprint,
      });
      let transactionalTransportCalls = 0;
      const transactional = createAutonomousProviderExecution({
        ...base,
        getActiveStage: () => ({ stage: "PREPARING", role: "planner", provider: "test", model: "model", transactionId: "chapter-txn-cutover" }),
      });
      const result = await transactional.runProviderCall(5, async () => {
        transactionalTransportCalls += 1;
        return { content: "transaction-v2", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: fingerprint });
      expect(result.content).toBe("transaction-v2");
      expect(transactionalTransportCalls).toBe(1);
      expect(transactional.responseArtifactPath(fingerprint, "test", "model", 5)).not.toBe(legacy.responseArtifactPath(fingerprint, "test", "model", 5));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before transport when a transaction operation was durably started but has no COMPLETE artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-ambiguous-transaction-"));
    try {
      const stage = { stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId: "chapter-txn-ambiguous" };
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stage });
      const fingerprint = "a".repeat(64);
      const logicalStepId = execution.responseArtifactPath(fingerprint, "test", "model", 5).split(/[\\/]/u).at(-1)!.replace(/\.json$/u, "");
      await saveAutonomousProductionState(root, "book", {
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5, updatedAt: "2026-08-28T00:00:00.000Z",
        providerAttemptHistory: [{
          transportAttemptId: `${logicalStepId}:transport-attempt:1`, logicalStepId, chapterNumber: 5, role: "writer",
          provider: "test", requestedModel: "model", attempt: 1, classification: "TRANSPORT_STARTED",
          transportStarted: true, transportReturned: false, recordedAt: "2026-08-28T00:00:00.000Z",
        }],
      });
      let transportCalls = 0;
      await expect(execution.runProviderCall(5, async () => {
        transportCalls += 1;
        return { content: "must-not-run", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: fingerprint })).rejects.toThrow(/AMBIGUOUS/i);
      expect(transportCalls).toBe(0);
      const unchanged = JSON.parse(await readFile(join(root, "books", "book", "story", "runtime", "bounded-autonomous", "production-state.json"), "utf-8"));
      expect(unchanged.providerAttemptHistory).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably closes a returned retry failure, starts attempt 2, then replays only COMPLETE", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-returned-retry-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId: "job",
        getActiveStage: () => ({ stage: "LOGIC_REVIEW", role: "auditor", provider: "test", model: "model" }),
      });
      const request = { provider: "test", model: "model", inputFingerprint: "7".repeat(64) };
      let transports = 0;
      await expect(execution.runProviderCall(5, async () => {
        transports += 1;
        throw Object.assign(new Error("HTTP 503 temporary failure"), { status: 503 });
      }, request)).rejects.toThrow(/503/);

      const afterFailure = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(afterFailure.providerAttemptHistory).toMatchObject([{
        attempt: 1, classification: "RETRYABLE_PROVIDER_HTTP", transportStarted: true, transportReturned: true,
      }]);

      const success = await execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "bounded success", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, request);
      const replay = await execution.runProviderCall(5, async () => {
        transports += 1;
        throw new Error("must not transport after COMPLETE");
      }, request);
      expect(success).toEqual(replay);
      expect(transports).toBe(2);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime.providerAttemptHistory).toMatchObject([
        { attempt: 1, classification: "RETRYABLE_PROVIDER_HTTP", transportStarted: true, transportReturned: true },
        { attempt: 2, classification: "SUCCESS", transportStarted: true, transportReturned: true },
      ]);
      expect(new Set(runtime.providerAttemptHistory.map((entry: { transportAttemptId: string }) => entry.transportAttemptId)).size).toBe(2);
      expect(runtime.responseArtifactStatus).toBe("COMPLETE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the fixed 18 logical-call budget per chapter transaction without charging COMPLETE replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-logical-budget-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      const stage = { stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId: "chapter-txn-budget" };
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stage });
      let transports = 0;
      const requests = Array.from({ length: 18 }, (_, index) => ({
        provider: "test", model: "model", inputFingerprint: index.toString(16).padStart(64, "0"),
      }));
      for (const request of requests) {
        await execution.runProviderCall(5, async () => {
          transports += 1;
          return { content: request.inputFingerprint, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        }, request);
      }
      const replay = await execution.runProviderCall(5, async () => {
        transports += 1;
        throw new Error("COMPLETE replay must not use transport");
      }, requests[0]!);
      expect(replay.content).toBe(requests[0]!.inputFingerprint);

      await expect(execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "over budget", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "f".repeat(64) }))
        .rejects.toThrow("CHAPTER_LOGICAL_MODEL_CALL_LIMIT_REACHED");
      expect(transports).toBe(18);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(new Set(runtime.providerAttemptHistory.map((entry: { logicalStepId: string }) => entry.logicalStepId)).size).toBe(18);
      expect(runtime.providerAttemptHistory.every((entry: { transactionId?: string }) => entry.transactionId === stage.transactionId)).toBe(true);

      // COMPLETE artifacts are the durable transaction authority. A restart from
      // pre-ceiling history that lacks transactionId must not reset admission.
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        ...runtime,
        providerAttemptHistory: runtime.providerAttemptHistory.map(({ transactionId: _ignored, ...entry }: { transactionId?: string }) => entry),
      }));
      const restarted = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stage });
      await expect(restarted.runProviderCall(5, async () => {
        transports += 1;
        return { content: "restart must remain capped", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "e".repeat(64) }))
        .rejects.toThrow("CHAPTER_LOGICAL_MODEL_CALL_LIMIT_REACHED");
      expect(transports).toBe(18);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the fixed 24 transport budget per transaction and resets it for a fresh attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-transport-budget-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      let transactionId = "chapter-txn-attempt-1";
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId: "job",
        getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId }),
      });
      let transports = 0;
      for (let logical = 0; logical < 8; logical += 1) {
        const request = { provider: "test", model: "model", inputFingerprint: logical.toString(16).padStart(64, "a") };
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(execution.runProviderCall(5, async () => {
            transports += 1;
            throw Object.assign(new Error("HTTP 503 bounded retry"), { status: 503 });
          }, request)).rejects.toThrow("503");
        }
      }
      await expect(execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "must not run", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "f".repeat(64) }))
        .rejects.toThrow("CHAPTER_PROVIDER_TRANSPORT_LIMIT_REACHED");
      expect(transports).toBe(24);

      transactionId = "chapter-txn-attempt-2";
      const fresh = await execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "fresh attempt", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "f".repeat(64) });
      expect(fresh.content).toBe("fresh attempt");
      expect(transports).toBe(25);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime.providerAttemptHistory.filter((entry: { transactionId?: string }) => entry.transactionId === "chapter-txn-attempt-1")).toHaveLength(24);
      expect(runtime.providerAttemptHistory.filter((entry: { transactionId?: string }) => entry.transactionId === "chapter-txn-attempt-2")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps COMPLETE admission evidence once per transaction executor instead of rescanning the book for every transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-admission-bootstrap-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      const transactionId = "chapter-txn-bootstrap";
      const execution = createAutonomousProviderExecution({
        projectRoot: root,
        bookId: "book",
        jobId: "job",
        getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId }),
      });
      providerResponseFsReads.directoryScans = 0;

      for (const fingerprint of ["1".repeat(64), "2".repeat(64)]) {
        await execution.runProviderCall(5, async () => ({
          content: fingerprint,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }), { provider: "test", model: "model", inputFingerprint: fingerprint });
      }

      expect(providerResponseFsReads.directoryScans).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not bootstrap the same transaction twice when one executor observes another transaction between calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-admission-multi-transaction-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      let transactionId = "chapter-txn-a";
      const execution = createAutonomousProviderExecution({
        projectRoot: root,
        bookId: "book",
        jobId: "job",
        getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId }),
      });
      providerResponseFsReads.directoryScans = 0;

      for (const [nextTransactionId, fingerprint] of [
        ["chapter-txn-a", "3".repeat(64)],
        ["chapter-txn-b", "4".repeat(64)],
        ["chapter-txn-a", "5".repeat(64)],
      ] as const) {
        transactionId = nextTransactionId;
        await execution.runProviderCall(5, async () => ({
          content: fingerprint,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }), { provider: "test", model: "model", inputFingerprint: fingerprint });
      }

      expect(providerResponseFsReads.directoryScans).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("charges pre-upgrade unbound returned failures to the active chapter transaction transport cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-upgrade-budget-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      const transactionId = "chapter-txn-upgrade";
      const history = Array.from({ length: 24 }, (_, index) => ({
        transportAttemptId: `legacy-step-${Math.floor(index / 3)}:transport-attempt:${index % 3 + 1}`,
        logicalStepId: `legacy-step-${Math.floor(index / 3)}`,
        chapterNumber: 5,
        role: "writer",
        provider: "test",
        requestedModel: "model",
        ...(index < 21 ? { transactionId } : {}),
        attempt: index % 3 + 1,
        classification: "RETRYABLE_PROVIDER_HTTP",
        transportStarted: true,
        transportReturned: true,
        recordedAt: "2026-08-30T00:00:00.000Z",
      }));
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
        chapterNumber: 5, providerAttemptHistory: history,
      }));
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId: "job",
        getActiveStage: () => ({ stage: "WRITING", role: "writer", provider: "test", model: "model", transactionId }),
      });
      let transports = 0;
      await expect(execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "must not run", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: "d".repeat(64) }))
        .rejects.toThrow("CHAPTER_PROVIDER_TRANSPORT_LIMIT_REACHED");
      expect(transports).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes one provable legacy empty-response record before a truthful bounded retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-provider-legacy-empty-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId: "job",
        getActiveStage: () => ({ stage: "LOGIC_REVIEW", role: "auditor", provider: "test", model: "model" }),
      });
      const request = { provider: "test", model: "model", inputFingerprint: "8".repeat(64) };
      const logicalStepId = execution.responseArtifactPath(request.inputFingerprint, request.provider, request.model, 5)
        .split(/[\\/]/u).at(-1)!.replace(/\.json$/u, "");
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "PAUSED_DETERMINISTIC_PROVIDER_ERROR", mode: "current-volume", nextChapter: 5,
        checkpoint: "DETERMINISTIC_PROVIDER_ERROR", responseArtifactStatus: "NONE",
        reason: "LLM returned empty response (usage=0+0)", lastErrorClassification: "DETERMINISTIC_PROVIDER_ERROR",
        providerAttemptHistory: [{
          transportAttemptId: `${logicalStepId}:transport-attempt:1`, logicalStepId, chapterNumber: 5,
          role: "auditor", provider: "test", requestedModel: "model", attempt: 1,
          classification: "TRANSPORT_STARTED", transportStarted: true, transportReturned: false,
          recordedAt: "2026-08-29T00:00:00.000Z",
        }],
      }));
      let transports = 0;
      const result = await execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "legacy retry success", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, request);
      expect(result.content).toBe("legacy retry success");
      expect(transports).toBe(1);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime.providerAttemptHistory).toMatchObject([
        { attempt: 1, classification: "RETRYABLE_PROVIDER_RESPONSE", transportStarted: true, transportReturned: true },
        { attempt: 2, classification: "SUCCESS", transportStarted: true, transportReturned: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks Chapter N predecessor authority before entering Provider execution for Writer N", async () => {
    const runChapter = vi.fn(async () => ({ status: "ready-for-review" }));
    let providerExecuteCalls = 0;
    await expect(runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 5,
      runChapter,
      verifyChapterStartAuthority: async () => { throw new Error("CHAPTER_4_COMMIT_TAMPERED"); },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: {
        execute: async <T>(_chapter: number, task: () => Promise<T>) => { providerExecuteCalls += 1; return task(); },
        loadPersistedProgress: async () => null,
        now: () => 0,
        sleep: async () => undefined,
      },
    })).rejects.toThrow("CHAPTER_4_COMMIT_TAMPERED");
    expect(providerExecuteCalls).toBe(0);
    expect(runChapter).not.toHaveBeenCalled();
  });

  it("resumes a settled audit-failed draft before generating the next chapter", async () => {
    let next = 5;
    const calls: string[] = [];
    let chapters: ChapterMeta[] = [
      { number: 4, title: "Four", status: "audit-failed" as const, wordCount: 1, createdAt: "now", updatedAt: "now", auditIssues: ["[warning] fix"], lengthWarnings: [] },
    ];
    const actions = await createAutonomousPipelineActions({
      bookId: "book",
      state: {
        loadChapterIndex: async () => chapters,
        saveChapterIndex: async (_bookId, updated) => { chapters = [...updated]; },
      },
      pipeline: {
        resumeAuditFailedChapterBounded: async () => { calls.push("resume:4"); return { status: "approved", chapterNumber: 4 }; },
        writeNextChapter: async () => {
          calls.push(`write:${next}`);
          const chapterNumber = next;
          chapters.push({ number: chapterNumber, title: `Chapter ${chapterNumber}`, status: "ready-for-review", wordCount: 1, createdAt: "now", updatedAt: "now", auditIssues: [], lengthWarnings: [] });
          next += 1;
          return { status: "ready-for-review", chapterNumber };
        },
      },
    });
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      resumePendingChapter: actions.resumePendingChapter,
      runChapter: actions.runChapter,
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(calls).toEqual(["resume:4", "write:5", "write:6"]);
    expect(chapters[0]?.status).toBe("approved");
    expect(result.status).toBe("BOOK_COMPLETE");
  });

  it("continues automatically after a final review accepts noncritical findings", async () => {
    let next = 5;
    const calls: string[] = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      resumePendingChapter: async () => ({ status: "accepted-with-findings", chapterNumber: 4 }),
      runChapter: async () => { calls.push(`write:${next}`); next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(calls).toEqual(["write:5", "write:6"]);
    expect(result.status).toBe("BOOK_COMPLETE");
  });

  it("refuses scope completion when a recovered chapter remains non-terminal", async () => {
    let next = 7;
    await expect(runBoundedAutonomousScope({
      map: {
        ...map,
        totalChapters: 6,
        volumes: [{ volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 6, chapterCount: 6 }],
      },
      mode: "current-volume",
      getNextChapter: async () => next,
      pendingChapterNumber: 6,
      resumePendingChapter: async () => ({ status: "ready-for-review", chapterNumber: 6 }),
      runChapter: async () => { next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async () => undefined,
    })).rejects.toThrow("AUTONOMOUS_RECOVERED_CHAPTER_NOT_TERMINAL");
  });

  it("uses the pending chapter identity for recovery while preserving the next cursor", async () => {
    let next = 5;
    const executedChapters: number[] = [];
    const progress: Array<{ nextChapter: number }> = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      pendingChapterNumber: 4,
      resumePendingChapter: async () => ({ status: "accepted-with-findings", chapterNumber: 4 }),
      runChapter: async () => { next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async (entry) => { progress.push(entry); },
      providerRecovery: {
        execute: async (chapterNumber, task) => { executedChapters.push(chapterNumber); return task(); },
        loadPersistedProgress: async () => null,
        now: () => 0,
        sleep: async () => undefined,
      },
    });
    expect(executedChapters[0]).toBe(4);
    expect(progress[0]?.nextChapter).toBe(5);
    expect(result.status).toBe("BOOK_COMPLETE");
  });

  it("stops before the next chapter when final review has critical findings", async () => {
    let next = 5;
    const runChapter = vi.fn();
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      resumePendingChapter: async () => ({ status: "blocked-critical-findings", chapterNumber: 4 }),
      runChapter,
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(runChapter).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "BLOCKED_CRITICAL_FINDINGS", nextChapter: 5, reason: "FINAL_REVIEW_CRITICAL_FINDINGS" });
  });

  it("runs exactly to the current dynamic volume boundary", async () => {
    let next = 2;
    const calls: number[] = [];
    const states: string[] = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => {
        calls.push(next);
        next += 1;
        return { status: "ready-for-review" };
      },
      shouldStop: () => false,
      persistProgress: async (state) => { states.push(state.status); },
    });
    expect(calls).toEqual([2, 3]);
    expect(result.status).toBe("VOLUME_COMPLETE");
    expect(result.nextChapter).toBe(4);
    expect(states.at(-1)).toBe("VOLUME_COMPLETE");
  });

  it("derives the formal 001-038 stop from its map and never starts chapter 039", async () => {
    const formalShape: BookProductionMap = {
      schemaVersion: "1.0", bookId: "formal-shape", authorityBookId: "authority", title: "Formal Shape", totalChapters: 156,
      volumes: [
        { volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 38, chapterCount: 38 },
        { volumeId: "volume-002", volumeNumber: 2, title: "Two", startChapter: 39, endChapter: 78, chapterCount: 40 },
        { volumeId: "volume-003", volumeNumber: 3, title: "Three", startChapter: 79, endChapter: 118, chapterCount: 40 },
        { volumeId: "volume-004", volumeNumber: 4, title: "Four", startChapter: 119, endChapter: 156, chapterCount: 38 },
      ],
    };
    let next = 5;
    const calls: number[] = [];
    const result = await runBoundedAutonomousScope({
      map: formalShape,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => { calls.push(next); next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(calls.at(0)).toBe(5);
    expect(calls.at(-1)).toBe(38);
    expect(calls).not.toContain(39);
    expect(result).toMatchObject({ status: "VOLUME_COMPLETE", nextChapter: 39, targetChapter: 38 });
  });

  it("stops after an atomic chapter when stop is requested", async () => {
    let next = 1;
    let stop = false;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "full-book",
      getNextChapter: async () => next,
      runChapter: async () => {
        next += 1;
        stop = true;
        return { status: "ready-for-review" };
      },
      shouldStop: () => stop,
      persistProgress: async () => undefined,
    });
    expect(result.status).toBe("PAUSED_BY_USER");
    expect(result.nextChapter).toBe(2);
  });

  it("crosses a volume boundary in full-book mode and stops at the mapped final chapter", async () => {
    let next = 1;
    const calls: number[] = [];
    const projectedVolumes: string[] = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "full-book",
      getNextChapter: async () => next,
      runChapter: async () => { calls.push(next); next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async (progress) => { projectedVolumes.push(progress.volumeId); },
    });
    expect(calls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.status).toBe("BOOK_COMPLETE");
    expect(result.nextChapter).toBe(7);
    expect(projectedVolumes).toContain("volume-002");
  });

  it("holds without advancing when two bounded revisions are exhausted", async () => {
    let next = 1;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "full-book",
      getNextChapter: async () => next,
      runChapter: async () => ({ status: "held-after-two-revisions", autonomousReview: { revisionCount: 2 } }),
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(result.status).toBe("HELD_AFTER_TWO_REVISIONS");
    expect(result.nextChapter).toBe(1);
    expect(result.reason).toBe("REVISION_LIMIT_REACHED");
    expect(result.revisionCount).toBe(2);
  });

  it("preserves a twice-invalid reviewer contract as REVIEW_OUTPUT_INVALID without advancing or revising", async () => {
    let calls = 0;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "full-book",
      getNextChapter: async () => 1,
      runChapter: async () => {
        calls += 1;
        return {
          status: "review-output-invalid",
          autonomousReview: { revisionCount: 0, holdReason: "INVALID_OUTPUT", invalidReviewerRole: "commercial-reader" },
        };
      },
      shouldStop: () => calls > 0,
      persistProgress: async () => undefined,
    });
    expect(result.status).toBe("REVIEW_OUTPUT_INVALID");
    expect(result.reason).toBe("INVALID_OUTPUT");
    expect(result.revisionCount).toBe(0);
    expect(result.invalidReviewerRole).toBe("commercial-reader");
    expect(result.nextChapter).toBe(1);
  });

  it("does not consult dollar-cost admission when budget is not configured", async () => {
    let next = 1;
    let calls = 0;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => { calls += 1; next += 1; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(result.status).toBe("VOLUME_COMPLETE");
  });

  it("persists HTTP 429 waiting for at least 300 seconds and retries automatically with a fake clock", async () => {
    let now = Date.parse("2026-08-23T00:00:00.000Z");
    let next = 1;
    let calls = 0;
    const waits: number[] = [];
    const states: Array<{ status: string; nextRetryAt?: string; attempt?: number }> = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => {
        calls += 1;
        if (calls === 1) throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 429, revisionRound: 1 });
        next += 1;
        return { status: "ready-for-review" };
      },
      shouldStop: () => false,
      persistProgress: async (state) => { states.push(state); },
      providerRecovery: {
        execute: async (_chapter, task) => task(),
        loadPersistedProgress: async () => null,
        now: () => now,
        sleep: async (ms) => { waits.push(ms); now += ms; },
      },
    });
    expect(waits[0]).toBe(300_000);
    expect(states).toContainEqual(expect.objectContaining({ status: "WAITING_PROVIDER_RETRY", attempt: 1, revisionRound: 1 }));
    expect(states.find((state) => state.status === "WAITING_PROVIDER_RETRY")?.nextRetryAt).toBe("2026-08-23T00:05:00.000Z");
    expect(calls).toBe(4);
    expect(result.status).toBe("VOLUME_COMPLETE");
  });

  it("applies the existing bounded retry policy to a returned empty-response failure", async () => {
    let now = 0;
    let next = 1;
    let calls = 0;
    const waits: number[] = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => {
        calls += 1;
        if (calls === 1) throw providerFailure({ classification: "RETRYABLE_PROVIDER_RESPONSE" });
        next = 4;
        return { status: "ready-for-review" };
      },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: {
        execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null,
        now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
      },
    });
    expect(waits).toEqual([300_000]);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "VOLUME_COMPLETE", nextChapter: 4 });
  });

  it("uses 300 then 900 seconds for HTTP 503 and pauses after the third failed transport", async () => {
    let now = 0;
    let calls = 0;
    const waits: number[] = [];
    const states: Array<{ status: string; attempt?: number; transportRetryCount?: number }> = [];
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 1,
      runChapter: async () => { calls += 1; throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 503 }); },
      shouldStop: () => false,
      persistProgress: async (state) => { states.push(state); },
      providerRecovery: {
        execute: async (_chapter, task) => task(),
        loadPersistedProgress: async () => null,
        now: () => now,
        sleep: async (ms) => { waits.push(ms); now += ms; },
      },
    });
    expect(waits).toEqual([300_000, 900_000]);
    expect(calls).toBe(3);
    expect(result).toMatchObject({ status: "PAUSED_PROVIDER_UNAVAILABLE", attempt: 3, transportRetryCount: 2 });
    expect(states.at(-1)).toMatchObject({ status: "PAUSED_PROVIDER_UNAVAILABLE", attempt: 3, transportRetryCount: 2 });
    expect((result as any).providerAttemptHistory).toHaveLength(3);
    expect(new Set((result as any).providerAttemptHistory.map((entry: any) => entry.transportAttemptId)).size).toBe(3);
    expect((result as any).providerAttemptHistory.map((entry: any) => entry.attempt)).toEqual([1, 2, 3]);
  });

  it.each([
    { retryAfterMs: 600_000, expected: 600_000 },
    { retryAfterMs: 10_000, expected: 300_000 },
  ])("applies Retry-After against the first retry lower bound", async ({ retryAfterMs, expected }) => {
    let now = 0;
    let next = 1;
    let calls = 0;
    const waits: number[] = [];
    await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => {
        calls += 1;
        if (calls === 1) throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 429, retryAfterMs });
        next = 4;
        return { status: "ready-for-review" };
      },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: { execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } },
    });
    expect(waits).toEqual([expected]);
  });

  it.each([
    { retryAfterMs: 1_200_000, expectedSecondWait: 1_200_000 },
    { retryAfterMs: 10_000, expectedSecondWait: 900_000 },
  ])("applies Retry-After against the second retry lower bound", async ({ retryAfterMs, expectedSecondWait }) => {
    let now = 0;
    let next = 1;
    let calls = 0;
    const waits: number[] = [];
    await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => {
        calls += 1;
        if (calls === 1) throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 503 });
        if (calls === 2) throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 503, retryAfterMs });
        next = 4;
        return { status: "ready-for-review" };
      },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: { execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } },
    });
    expect(waits).toEqual([300_000, expectedSecondWait]);
  });

  it("reloads one waiting job after a simulated server restart and continues without another click", async () => {
    let persisted: any = null;
    let now = 0;
    await expect(runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 1,
      runChapter: async () => { throw providerFailure({ classification: "RETRYABLE_PROVIDER_HTTP", status: 503 }); },
      shouldStop: () => false,
      persistProgress: async (state) => { persisted = state; },
      providerRecovery: {
        execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => now,
        sleep: async () => { throw new Error("SIMULATED_SERVER_RESTART"); },
      },
    })).rejects.toThrow("SIMULATED_SERVER_RESTART");
    expect(persisted).toMatchObject({ status: "WAITING_PROVIDER_RETRY", attempt: 1 });

    now = Date.parse(persisted.nextRetryAt);
    let next = 1;
    let resumedCalls = 0;
    const resumed = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => next,
      runChapter: async () => { resumedCalls += 1; next = 4; return { status: "ready-for-review" }; },
      shouldStop: () => false,
      persistProgress: async (state) => { persisted = state; },
      providerRecovery: {
        execute: async (_chapter, task) => task(), loadPersistedProgress: async () => persisted, now: () => now,
        sleep: async (ms) => { now += ms; },
      },
    });
    expect(resumed.jobId).toBe(persisted.jobId);
    expect(resumedCalls).toBe(1);
    expect(resumed.status).toBe("VOLUME_COMPLETE");
  });

  it("fails closed without retry when the provider outcome may be ambiguous", async () => {
    let calls = 0;
    const sleep = vi.fn();
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 1,
      runChapter: async () => { calls += 1; throw providerFailure({ classification: "AMBIGUOUS_PROVIDER_OUTCOME" }); },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: { execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => 0, sleep },
    });
    expect(result).toMatchObject({ status: "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", attempt: 1 });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves the durable attempt number when restart finds attempt 2 ambiguous", async () => {
    const logicalStepId = "step-ambiguous-restart";
    const history = [
      {
        transportAttemptId: `${logicalStepId}:transport-attempt:1`, logicalStepId, chapterNumber: 1, role: "auditor",
        provider: "openrouter", requestedModel: "provider/model", attempt: 1, classification: "RETRYABLE_PROVIDER_HTTP",
        transportStarted: true, transportReturned: true, recordedAt: "2026-08-29T00:00:00.000Z",
      },
      {
        transportAttemptId: `${logicalStepId}:transport-attempt:2`, logicalStepId, chapterNumber: 1, role: "auditor",
        provider: "openrouter", requestedModel: "provider/model", attempt: 2, classification: "TRANSPORT_STARTED",
        transportStarted: true, transportReturned: false, recordedAt: "2026-08-29T00:01:00.000Z",
      },
    ];
    const persisted = {
      jobId: deriveAutonomousJobIdentity({ map, mode: "current-volume", nextChapter: 1 }),
      status: "WAITING_PROVIDER_RETRY", mode: "current-volume", volumeId: "volume-001", startChapter: 1,
      targetChapter: 3, nextChapter: 1, completedThisRun: 0, logicalStepId, attempt: 2,
      providerAttemptHistory: history,
    } as AutonomousRunProgress;
    const states: AutonomousRunProgress[] = [];
    const result = await runBoundedAutonomousScope({
      map, mode: "current-volume", getNextChapter: async () => 1,
      runChapter: async () => { throw providerFailure({ classification: "AMBIGUOUS_PROVIDER_OUTCOME", logicalStepId }); },
      shouldStop: () => false, persistProgress: async (state) => { states.push(state); },
      providerRecovery: {
        execute: async (_chapter, task) => task(), loadPersistedProgress: async () => persisted,
        now: () => Date.parse("2026-08-29T00:02:00.000Z"), sleep: async () => undefined,
      },
    });
    expect(result).toMatchObject({ status: "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", attempt: 2 });
    expect(result.providerAttemptHistory).toHaveLength(2);
    expect(result.providerAttemptHistory?.map((entry) => entry.transportAttemptId)).not.toContain(`${logicalStepId}:transport-attempt:3`);
    expect(states.at(-1)).toMatchObject({ attempt: 2, providerAttemptHistory: history });
  });

  it.each([400, 401, 403])("does not retry deterministic HTTP %s", async (status) => {
    const sleep = vi.fn();
    let calls = 0;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 1,
      runChapter: async () => { calls += 1; throw providerFailure({ classification: "DETERMINISTIC_PROVIDER_ERROR", status }); },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: { execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => 0, sleep },
    });
    expect(result.status).toBe("PAUSED_DETERMINISTIC_PROVIDER_ERROR");
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("pauses a deterministic parser or business failure without a technical retry", async () => {
    const sleep = vi.fn();
    let calls = 0;
    const result = await runBoundedAutonomousScope({
      map,
      mode: "current-volume",
      getNextChapter: async () => 1,
      runChapter: async () => { calls += 1; throw new Error("DETERMINISTIC_PARSER_FAILURE"); },
      shouldStop: () => false,
      persistProgress: async () => undefined,
      providerRecovery: { execute: async (_chapter, task) => task(), loadPersistedProgress: async () => null, now: () => 0, sleep },
    });
    expect(result).toMatchObject({
      status: "PAUSED_PIPELINE_ERROR",
      checkpoint: "DETERMINISTIC_PIPELINE_ERROR",
      lastErrorClassification: "DETERMINISTIC_PIPELINE_ERROR",
    });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("atomically reuses a saved response artifact without a second transport or duplicate usage identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-response-artifact-"));
    try {
      let transportCalls = 0;
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", volumeId: "volume-001",
        startChapter: 4, targetChapter: 4, nextChapter: 4, completedThisRun: 0,
      }), "utf-8");
      const stages = { stage: "LOGIC_REVIEW", role: "auditor", provider: "openrouter", model: "provider/model", revisionRound: 0, reviewRound: 1 } as const;
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stages });
      const run = () => execution.runProviderCall(4, async () => {
        transportCalls += 1;
        return { content: "synthetic result", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: "b".repeat(64) });
      const first = await run();
      const second = await run();
      expect(second).toEqual(first);
      expect(transportCalls).toBe(1);
      const artifact = JSON.parse(await readFile(execution.responseArtifactPath("b".repeat(64), "openrouter", "provider/model", 4), "utf-8"));
      expect(artifact).toMatchObject({ response_artifact_status: "COMPLETE", usage_identity: artifact.logical_step_id });
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime).toMatchObject({
        responseArtifactStatus: "COMPLETE",
        checkpoint: "RESPONSE_ARTIFACT_PERSISTED",
        attempt: 1,
      });
      expect(runtime.providerAttemptHistory).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives one semantic reviewer retry a distinct durable identity and replays both outcomes without another transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-semantic-review-retry-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", volumeId: "volume-001",
        startChapter: 7, targetChapter: 7, nextChapter: 7, completedThisRun: 0,
      }), "utf-8");
      let stage: { stage: string; role: string; provider: string; model: string; reviewRound?: number } = {
        stage: "READER_REVIEW", role: "commercial-reader", provider: "openrouter", model: "provider/model",
      };
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stage });
      const fingerprint = "d".repeat(64);
      let transportCalls = 0;
      const run = (content: string) => execution.runProviderCall(7, async () => {
        transportCalls += 1;
        return { content, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: fingerprint });

      const invalid = await run('{"decision":"ACCEPT"}');
      const firstPath = execution.responseArtifactPath(fingerprint, "openrouter", "provider/model", 7);
      stage = { ...stage, reviewRound: 0 };
      const valid = await run('{"decision":"APPROVED_WITH_NOTES"}');
      const retryPath = execution.responseArtifactPath(fingerprint, "openrouter", "provider/model", 7);
      const replayedRetry = await run("TRANSPORT_MUST_NOT_REPLACE_RETRY");

      expect(firstPath).not.toBe(retryPath);
      expect(invalid.content).toContain("ACCEPT");
      expect(valid.content).toContain("APPROVED_WITH_NOTES");
      expect(replayedRetry).toEqual(valid);
      expect(transportCalls).toBe(2);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime.providerAttemptHistory).toHaveLength(2);
      expect(new Set(runtime.providerAttemptHistory.map((entry: { logicalStepId: string }) => entry.logicalStepId)).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves two semantically invalid state COMPLETE artifacts and repeated Resume creates no third call", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-state-semantic-exhaustion-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "RUNNING", mode: "current-volume", nextChapter: 5,
      }));
      let role = "final-state-extractor";
      const transactionId = "chapter-txn-semantic-state";
      const execution = createAutonomousProviderExecution({
        projectRoot: root, bookId: "book", jobId: "job",
        getActiveStage: () => ({ stage: "SETTLING_STATE", role, provider: "test", model: "model", transactionId }),
      });
      const fingerprint = "9".repeat(64);
      let transports = 0;
      const first = await execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: " ", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: fingerprint });
      const firstPath = execution.responseArtifactPath(fingerprint, "test", "model", 5);
      const firstBytes = await readFile(firstPath);

      role = "final-state-extractor-semantic-retry";
      const second = await execution.runProviderCall(5, async () => {
        transports += 1;
        return { content: "\n", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "test", model: "model", inputFingerprint: fingerprint });
      const secondPath = execution.responseArtifactPath(fingerprint, "test", "model", 5);
      const secondBytes = await readFile(secondPath);

      role = "final-state-extractor";
      const replayedFirst = await execution.runProviderCall(5, async () => {
        transports += 1;
        throw new Error("Resume must not transport first semantic identity");
      }, { provider: "test", model: "model", inputFingerprint: fingerprint });
      role = "final-state-extractor-semantic-retry";
      const replayedSecond = await execution.runProviderCall(5, async () => {
        transports += 1;
        throw new Error("Resume must not create semantic call three");
      }, { provider: "test", model: "model", inputFingerprint: fingerprint });

      expect(first.content).toBe(" ");
      expect(second.content).toBe("\n");
      expect(replayedFirst).toEqual(first);
      expect(replayedSecond).toEqual(second);
      expect(firstPath).not.toBe(secondPath);
      expect(await readFile(firstPath)).toEqual(firstBytes);
      expect(await readFile(secondPath)).toEqual(secondBytes);
      expect(transports).toBe(2);
      const runtime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(runtime.providerAttemptHistory).toHaveLength(2);
      expect(new Set(runtime.providerAttemptHistory.map((entry: { logicalStepId: string }) => entry.logicalStepId)).size).toBe(2);
      await expect(readdir(join(root, "books", "book", "story", "commits"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replay or bind an unreferenced next-cursor artifact through runProviderCall", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-unreferenced-runtime-replay-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      const responseDir = join(runtimeDir, "provider-responses");
      const evidenceDir = join(runtimeDir, "chapter-0004");
      await mkdir(responseDir, { recursive: true });
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "REVIEW_EXHAUSTED", mode: "current-volume", volumeId: "volume-002",
        startChapter: 4, targetChapter: 6, nextChapter: 5, chapterNumber: 5, completedThisRun: 0,
        responseArtifactStatus: "COMPLETE",
      }), "utf-8");
      await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
        schema_version: "1.0", chapter_number: 4, status: "REVIEW_EXHAUSTED", modelOutcomes: [],
      }), "utf-8");
      const stages = { stage: "RESCUE_REVISING_2", role: "reviser", provider: "openrouter", model: "provider/model", revisionRound: 2 } as const;
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stages });
      const fingerprint = "e".repeat(64);
      const legacyPath = execution.responseArtifactPath(fingerprint, "openrouter", "provider/model", 5);
      const legacyLogicalStepId = legacyPath.split(/[\\\\/]/).at(-1)!.replace(/\.json$/, "");
      const legacyContent = "=== REVISED_CONTENT ===\nUnreferenced next-cursor artifact.";
      const { createHash } = await import("node:crypto");
      await writeFile(legacyPath, `${JSON.stringify({
        schema_version: "1.0", job_id: "job", logical_step_id: legacyLogicalStepId,
        usage_identity: legacyLogicalStepId, chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2",
        provider: "openrouter", requested_model: "provider/model", input_fingerprint: fingerprint,
        response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(legacyContent).digest("hex"),
        response: { content: legacyContent }, completed_at: "2026-08-23T00:00:00.000Z",
      }, null, 2)}\n`, "utf-8");
      const freshResponse = { content: "fresh transport result", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
      let transportCalls = 0;

      const result = await execution.runProviderCall(4, async () => {
        transportCalls += 1;
        return freshResponse;
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: fingerprint });

      expect(result).toEqual(freshResponse);
      expect(transportCalls).toBe(1);
      await expect(readFile(execution.responseArtifactBindingPath(fingerprint, "openrouter", "provider/model", 4)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("corrected-binds a legacy next-cursor artifact to the pending chapter without copying its response", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-corrected-binding-"));
    try {
      const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
      const responseDir = join(runtimeDir, "provider-responses");
      const evidenceDir = join(runtimeDir, "chapter-0004");
      await mkdir(responseDir, { recursive: true });
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId: "job", status: "REVIEW_EXHAUSTED", mode: "current-volume", volumeId: "volume-002",
        startChapter: 4, targetChapter: 6, nextChapter: 5, chapterNumber: 5, completedThisRun: 0,
        responseArtifactStatus: "COMPLETE",
      }), "utf-8");
      const stages = { stage: "RESCUE_REVISING_2", role: "reviser", provider: "openrouter", model: "provider/model", revisionRound: 2 } as const;
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => stages });
      const fingerprint = "c".repeat(64);
      const legacyPath = execution.responseArtifactPath(fingerprint, "openrouter", "provider/model", 5);
      const legacyLogicalStepId = legacyPath.split(/[\\/]/).at(-1)!.replace(/\.json$/, "");
      const finalSourceStages = { stage: "RESCUE_REVISING_2", role: "reviser", provider: "openrouter", model: "provider/model", revisionRound: 2 } as const;
      const finalSourceExecution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => finalSourceStages });
      const finalStages = { stage: "LOGIC_REVIEW", role: "logicAuditor", provider: "openrouter", model: "provider/model", reviewRound: 2 } as const;
      const finalExecution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId: "job", getActiveStage: () => finalStages });
      const finalFingerprint = "f".repeat(64);
      const finalLegacyPath = finalSourceExecution.responseArtifactPath(finalFingerprint, "openrouter", "provider/model", 5);
      const finalLegacyLogicalStepId = finalLegacyPath.split(/[\\/]/).at(-1)!.replace(/\.json$/, "");
      const response = { content: "=== REVISED_CONTENT ===\nSynthetic Chapter 004 rescue.", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } };
      const finalResponse = { content: JSON.stringify({
        passed: true,
        overall_score: 92,
        dimension_scores: {
          blueprint_transition: 95, causal_logic: 90, canon_continuity: 92, character_motivation: 95,
          state_inheritance: 95, hooks_disclosure: 95, narrative_clarity: 93,
        },
        issues: [{ severity: "warning", category: "causal_logic", description: "Synthetic.", suggestion: "Track.", repair_scope: "structural" }],
        summary: "Passed with findings.",
      }), usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } };
      const { createHash } = await import("node:crypto");
      await writeFile(legacyPath, `${JSON.stringify({
        schema_version: "1.0", job_id: "job", logical_step_id: legacyLogicalStepId,
        usage_identity: legacyLogicalStepId, chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2",
        provider: "openrouter", requested_model: "provider/model", input_fingerprint: fingerprint,
        response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(response.content).digest("hex"),
        response, completed_at: "2026-08-23T00:00:00.000Z",
      }, null, 2)}\n`, "utf-8");
      await writeFile(finalLegacyPath, `${JSON.stringify({
        schema_version: "1.0", job_id: "job", logical_step_id: finalLegacyLogicalStepId,
        usage_identity: finalLegacyLogicalStepId, chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2",
        provider: "openrouter", requested_model: "provider/model", input_fingerprint: finalFingerprint,
        response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(finalResponse.content).digest("hex"),
        response: finalResponse, completed_at: "2026-08-23T00:00:00.000Z",
      }, null, 2)}\n`, "utf-8");
      const unrelatedIds: string[] = [];
      for (let index = 0; index < 14; index += 1) {
        const id = `provider-step-${(index + 1).toString(16).padStart(64, "0")}`;
        const content = index === 3
          ? "```json\n{\"passed\":true,\"overall_score\":95}\n```"
          : `Synthetic historical outcome ${index + 1}.`;
        const role = index === 3 ? "reviser" : "auditor";
        const stage = index === 3 ? "REVISING_1" : "LOGIC_REVIEW";
        await writeFile(join(responseDir, `${id}.json`), `${JSON.stringify({
          schema_version: "1.0", job_id: "job", logical_step_id: id, usage_identity: id,
          chapter_number: 5, role, stage, provider: "openrouter", requested_model: "provider/model",
          input_fingerprint: (index + 1).toString(16).repeat(64).slice(0, 64),
          response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(content).digest("hex"),
          response: { content }, completed_at: `2026-08-23T00:00:${String(index).padStart(2, "0")}.000Z`,
        }, null, 2)}\n`, "utf-8");
        unrelatedIds.push(id);
      }
      await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
        schema_version: "1.0",
        chapter_number: 4,
        status: "REVIEW_EXHAUSTED",
        modelOutcomes: [
          ...unrelatedIds.slice(0, 7).map((modelCallId) => ({ modelCallId })),
          { modelCallId: legacyLogicalStepId },
          ...unrelatedIds.slice(7).map((modelCallId) => ({ modelCallId })),
          { modelCallId: finalLegacyLogicalStepId },
        ],
      }), "utf-8");
      const unreferencedFingerprint = "d".repeat(64);
      const unreferencedPath = execution.responseArtifactPath(unreferencedFingerprint, "openrouter", "provider/model", 5);
      const unreferencedLogicalStepId = unreferencedPath.split(/[\\/]/).at(-1)!.replace(/\.json$/, "");
      const unreferencedContent = "=== REVISED_CONTENT ===\nUnreferenced next-cursor artifact.";
      await writeFile(unreferencedPath, `${JSON.stringify({
        schema_version: "1.0", job_id: "job", logical_step_id: unreferencedLogicalStepId,
        usage_identity: unreferencedLogicalStepId, chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2",
        provider: "openrouter", requested_model: "provider/model", input_fingerprint: unreferencedFingerprint,
        response_artifact_status: "COMPLETE", content_sha256: createHash("sha256").update(unreferencedContent).digest("hex"),
        response: { content: unreferencedContent }, completed_at: "2026-08-23T00:00:00.000Z",
      }, null, 2)}\n`, "utf-8");
      const original = await readFile(legacyPath);
      const finalOriginal = await readFile(finalLegacyPath);
      const corrected = await correctLegacyPendingChapterArtifactBindings({ projectRoot: root, bookId: "book", jobId: "job", pendingChapterNumber: 4 });
      expect(corrected).toHaveLength(2);
      await expect(readFile(execution.responseArtifactBindingPath(unreferencedFingerprint, "openrouter", "provider/model", 4)))
        .rejects.toMatchObject({ code: "ENOENT" });
      const runtimeBeforeReplay = await readFile(join(runtimeDir, "production-state.json"));
      let transportCalls = 0;
      let modelCalls = 0;
      const replayed = await execution.runProviderCall(4, async () => {
        transportCalls += 1;
        modelCalls += 1;
        return { content: "must not run", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: fingerprint });
      expect(replayed).toEqual(response);
      expect(transportCalls).toBe(0);
      expect(await readFile(legacyPath)).toEqual(original);
      const replayedFinal = await finalExecution.runProviderCall(4, async () => {
        transportCalls += 1;
        modelCalls += 1;
        return { content: "must not run", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: finalFingerprint });
      expect(replayedFinal).toEqual(finalResponse);
      expect(transportCalls).toBe(0);
      expect(modelCalls).toBe(0);
      expect(await readFile(finalLegacyPath)).toEqual(finalOriginal);
      expect(await readFile(join(runtimeDir, "production-state.json"))).toEqual(runtimeBeforeReplay);
      const replayRuntime = JSON.parse(await readFile(join(runtimeDir, "production-state.json"), "utf-8"));
      expect(replayRuntime.providerAttemptHistory ?? []).toEqual([]);
      expect((replayRuntime.providerAttemptHistory ?? []).filter((attempt: { transportStarted?: boolean }) => attempt.transportStarted)).toHaveLength(0);
      const binding = JSON.parse(await readFile(execution.responseArtifactBindingPath(fingerprint, "openrouter", "provider/model", 4), "utf-8"));
      expect(binding).toMatchObject({
        chapter_number: 4,
        source_chapter_number: 5,
        source_logical_step_id: legacyLogicalStepId,
        source_artifact_sha256: createHash("sha256").update(original).digest("hex"),
      });
      expect(binding).not.toHaveProperty("response");
      const bindingPath = execution.responseArtifactBindingPath(fingerprint, "openrouter", "provider/model", 4);
      const bindingBytes = await readFile(bindingPath);
      await writeFile(bindingPath, JSON.stringify({ ...binding, source_artifact_sha256: "0".repeat(64) }));
      await expect(execution.runProviderCall(4, async () => {
        throw new Error("transport must not run");
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: fingerprint }))
        .rejects.toThrow("AUTONOMOUS_PROVIDER_RESPONSE_BINDING_SOURCE_MISMATCH");
      await writeFile(bindingPath, bindingBytes);
      await writeFile(legacyPath, Buffer.concat([original, Buffer.from("altered")]));
      await expect(execution.runProviderCall(4, async () => {
        throw new Error("transport must not run");
      }, { provider: "openrouter", model: "provider/model", inputFingerprint: fingerprint }))
        .rejects.toThrow("AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_INVALID");
      await writeFile(legacyPath, original);
      expect(await readFile(legacyPath)).toEqual(original);
      expect(await readFile(finalLegacyPath)).toEqual(finalOriginal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a failed re-entry append-only and preserves every historical artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-offline-finalization-reentry-"));
    const { createHash } = await import("node:crypto");
    try {
      const bookDir = join(root, "books", "book");
      const runtimeDir = join(bookDir, "story", "runtime", "bounded-autonomous");
      const responseDir = join(runtimeDir, "provider-responses");
      const evidenceDir = join(runtimeDir, "chapter-0004");
      const chaptersDir = join(bookDir, "chapters");
      await mkdir(responseDir, { recursive: true });
      await mkdir(evidenceDir, { recursive: true });
      await mkdir(chaptersDir, { recursive: true });
      await mkdir(join(bookDir, "story", "outline"), { recursive: true });
      const recoveryMap: BookProductionMap = {
        schemaVersion: "1.0", bookId: "book", authorityBookId: "authority", title: "Book", totalChapters: 6,
        volumes: [{ volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 6, chapterCount: 6 }],
      };
      await writeFile(join(bookDir, "story", "outline", "book-production-map.json"), JSON.stringify({
        schema_version: recoveryMap.schemaVersion, book_id: recoveryMap.bookId, authority_book_id: recoveryMap.authorityBookId,
        title: recoveryMap.title, total_chapters: recoveryMap.totalChapters,
        volumes: recoveryMap.volumes.map((volume) => ({ volume_id: volume.volumeId, volume_number: volume.volumeNumber, title: volume.title, start_chapter: volume.startChapter, end_chapter: volume.endChapter, chapter_count: volume.chapterCount })),
      }), "utf-8");
      const jobId = deriveAutonomousJobIdentity({ map: recoveryMap, mode: "current-volume", nextChapter: 5 });
      const oldBody = "OLD_BODY_A";
      const rescueBody = "RESCUE_BODY_B";
      expect(oldBody).not.toBe(rescueBody);
      await writeFile(join(chaptersDir, "0004_Pending.md"), `# Chapter 4\n\n${oldBody}`, "utf-8");
      const snapshotDir = join(bookDir, "story", "snapshots", "4");
      const snapshotStateDir = join(snapshotDir, "state");
      await mkdir(snapshotStateDir, { recursive: true });
      const markdownState = [
        ["current_state.md", "# Current State\n\nSTATE_B"],
        ["pending_hooks.md", "# Pending Hooks\n\nSTATE_B"],
        ["chapter_summaries.md", "# Chapter Summaries\n\nSTATE_B"],
        ["particle_ledger.md", "# Particle Ledger\n\nSTATE_B"],
        ["subplot_board.md", "# Subplot Board\n\nSTATE_B"],
        ["emotional_arcs.md", "# Emotional Arcs\n\nSTATE_B"],
        ["character_matrix.md", "# Character Matrix\n\nSTATE_B"],
      ] as const;
      const structuredState = [
        ["manifest.json", JSON.stringify({ schemaVersion: 2, language: "en", lastAppliedChapter: 4, projectionVersion: 1, migrationWarnings: [] })],
        ["current_state.json", JSON.stringify({ chapter: 4, facts: [{ subject: "chapter", predicate: "state", object: "STATE_B", validFromChapter: 4, validUntilChapter: null, sourceChapter: 4 }] })],
        ["hooks.json", JSON.stringify({ hooks: [] })],
        ["chapter_summaries.json", JSON.stringify({ rows: [{ chapter: 4, title: "Pending", characters: "", events: "STATE_B", stateChanges: "STATE_B", hookActivity: "", mood: "", chapterType: "" }] })],
      ] as const;
      await Promise.all([
        ...markdownState.map(([name, content]) => writeFile(join(snapshotDir, name), content, "utf-8")),
        ...structuredState.map(([name, content]) => writeFile(join(snapshotStateDir, name), content, "utf-8")),
      ]);
      const settlementProof = Buffer.from(`${JSON.stringify({
        schema_version: "1.0",
        evidence_type: "OFFLINE_FINALIZATION_STATE_SETTLEMENT_PROOF",
        book_id: "book",
        job_id: jobId,
        chapter_number: 4,
        snapshot_id: "chapter-4-state-b",
        rescue_candidate_body_sha256: createHash("sha256").update(rescueBody).digest("hex"),
        artifacts: [
          ...markdownState.map(([name, content]) => ({ source_relative_path: `story/snapshots/4/${name}`, target_relative_path: `story/${name}`, sha256: createHash("sha256").update(content).digest("hex") })),
          ...structuredState.map(([name, content]) => ({ source_relative_path: `story/snapshots/4/state/${name}`, target_relative_path: `story/state/${name}`, sha256: createHash("sha256").update(content).digest("hex") })),
        ],
      }, null, 2)}\n`);
      await writeFile(join(evidenceDir, "state-settlement-proof.json"), settlementProof);
      const stateSettlementProof = { relativePath: "state-settlement-proof.json", sha256: createHash("sha256").update(settlementProof).digest("hex") };
      await writeFile(join(chaptersDir, "index.json"), JSON.stringify([{
        number: 4, title: "Pending", status: "audit-failed", wordCount: oldBody.length,
        createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", auditIssues: [], lengthWarnings: [],
      }]), "utf-8");
      const sourceStages = { stage: "RESCUE_REVISING_2", role: "reviser", provider: "openrouter", model: "model" } as const;
      const sourceExecution = createAutonomousProviderExecution({ projectRoot: root, bookId: "book", jobId, getActiveStage: () => sourceStages });
      const fingerprints = ["a".repeat(64), "b".repeat(64)] as const;
      const ids = fingerprints.map((fingerprint) => sourceExecution.responseArtifactPath(fingerprint, "openrouter", "model", 5).split(/[\\/]/).at(-1)!.replace(/\.json$/u, ""));
      const finalContent = JSON.stringify({
        passed: true, overall_score: 92,
        dimension_scores: { blueprint_transition: 95, causal_logic: 90, canon_continuity: 92, character_motivation: 95, state_inheritance: 95, hooks_disclosure: 95, narrative_clarity: 93 },
        issues: [{ severity: "warning", category: "causal_logic", description: "preserved", suggestion: "track", repair_scope: "structural" }],
        summary: "accepted",
      });
      const sourceContents = [`=== REVISED_CONTENT ===\n${rescueBody}`, finalContent] as const;
      for (const [index, id] of ids.entries()) {
        const content = sourceContents[index]!;
        await writeFile(join(responseDir, `${id}.json`), `${JSON.stringify({
          schema_version: "1.0", job_id: jobId, logical_step_id: id, usage_identity: id,
          chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2", provider: "openrouter", requested_model: "model",
          input_fingerprint: fingerprints[index], response_artifact_status: "COMPLETE",
          content_sha256: createHash("sha256").update(content).digest("hex"), response: { content }, completed_at: "2026-08-23T00:00:00.000Z",
        }, null, 2)}\n`, "utf-8");
      }
      const historicalIds: string[] = [];
      for (let index = 0; index < 14; index += 1) {
        const fingerprint = (index + 10).toString(16).padStart(64, "0");
        const id = sourceExecution.responseArtifactPath(fingerprint, "openrouter", "model", 5).split(/[\\/]/).at(-1)!.replace(/\.json$/u, "");
        const content = `Historical outcome ${index + 1}`;
        historicalIds.push(id);
        await writeFile(join(responseDir, `${id}.json`), `${JSON.stringify({
          schema_version: "1.0", job_id: jobId, logical_step_id: id, usage_identity: id,
          chapter_number: 5, role: "reviser", stage: "RESCUE_REVISING_2", provider: "openrouter", requested_model: "model",
          input_fingerprint: fingerprint, response_artifact_status: "COMPLETE",
          content_sha256: createHash("sha256").update(content).digest("hex"), response: { content }, completed_at: "2026-08-22T00:00:00.000Z",
        }, null, 2)}\n`, "utf-8");
      }
      const historicalOutcomeIds = [...historicalIds.slice(0, 7), ids[0]!, ...historicalIds.slice(7), ids[1]!];
      expect(historicalOutcomeIds).toHaveLength(16);
      const originalEvidence = `${JSON.stringify({
        schema_version: "1.0", chapter_number: 4, status: "REVIEW_EXHAUSTED",
        revisionCount: 2, logicReviewCount: 2, commercialReviewCount: 0,
        baselineRoleUsage: { writer: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
        roleUsage: { reviser: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
        stateSettlementProof,
        modelOutcomes: historicalOutcomeIds.map((modelCallId) => ({ modelCallId })),
      }, null, 2)}\n`;
      await writeFile(join(evidenceDir, "resume-review.json"), originalEvidence, "utf-8");
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId, status: "REVIEW_EXHAUSTED", mode: "current-volume", volumeId: "volume-001",
        startChapter: 4, targetChapter: 6, nextChapter: 5, chapterNumber: 5, completedThisRun: 0, responseArtifactStatus: "COMPLETE",
      }), "utf-8");
      await expect(correctLegacyPendingChapterArtifactBindings({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 4 })).resolves.toHaveLength(2);

      const failedSpecs = [
        { stage: "COMPOSING_CONTEXT", role: "composer", fingerprint: "c".repeat(64) },
        { stage: "COMPOSING_RULES", role: "composer", fingerprint: "d".repeat(64) },
        { stage: "RESCUE_REVISING_2", role: "reviser", fingerprint: "e".repeat(64) },
        { stage: "LOGIC_REVIEW", role: "logicAuditor", fingerprint: "f".repeat(64) },
      ] as const;
      const failedIds: string[] = [];
      for (const [index, failed] of failedSpecs.entries()) {
        const execution = createAutonomousProviderExecution({
          projectRoot: root, bookId: "book", jobId,
          getActiveStage: () => ({ stage: failed.stage, role: failed.role, provider: "openrouter", model: "model" }),
        });
        const id = execution.responseArtifactPath(failed.fingerprint, "openrouter", "model", 4).split(/[\\/]/).at(-1)!.replace(/\.json$/u, "");
        const content = index === failedSpecs.length - 1 ? JSON.stringify({ passed: false, overall_score: 10 }) : `Failed re-entry artifact ${index + 1}`;
        failedIds.push(id);
        await writeFile(join(responseDir, `${id}.json`), `${JSON.stringify({
          schema_version: "1.0", job_id: jobId, logical_step_id: id, usage_identity: id,
          chapter_number: 4, role: failed.role, stage: failed.stage, provider: "openrouter", requested_model: "model",
          input_fingerprint: failed.fingerprint, response_artifact_status: "COMPLETE",
          content_sha256: createHash("sha256").update(content).digest("hex"), response: { content }, completed_at: `2026-08-23T01:00:0${index}.000Z`,
        }, null, 2)}\n`, "utf-8");
      }
      expect(failedIds).toHaveLength(4);
      const currentEvidence = `${JSON.stringify({
        schema_version: "1.0", chapter_number: 4, status: "BLOCKED_CRITICAL_FINDINGS",
        revisionCount: 2, logicReviewCount: 3, commercialReviewCount: 0,
        baselineRoleUsage: { writer: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
        roleUsage: { reviser: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, "logic-canon-auditor": { promptTokens: 5, completionTokens: 6, totalTokens: 11 } },
        stateSettlementProof,
        modelOutcomes: [...historicalOutcomeIds, failedIds.at(-1)!].map((modelCallId) => ({ modelCallId })),
      }, null, 2)}\n`;
      await writeFile(join(evidenceDir, "resume-review.json"), currentEvidence, "utf-8");
      await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
        jobId, status: "BLOCKED_CRITICAL_FINDINGS", mode: "current-volume", volumeId: "volume-001",
        startChapter: 4, targetChapter: 6, nextChapter: 5, chapterNumber: 4, completedThisRun: 0, responseArtifactStatus: "COMPLETE",
        providerAttemptHistory: failedIds.map((logicalStepId, index) => ({ transportAttemptId: `attempt-${index + 1}`, logicalStepId, chapterNumber: 4, role: failedSpecs[index]!.role, provider: "openrouter", requestedModel: "model", attempt: 1, classification: "SUCCESS", transportStarted: true, transportReturned: true, recordedAt: `2026-08-23T01:00:0${index}.000Z` })),
      }), "utf-8");
      const preservedIds = [...historicalOutcomeIds, ...failedIds];
      const preserved = await Promise.all(preservedIds.map((id) => readFile(join(responseDir, `${id}.json`))));
      const bindingNames = (await readdir(responseDir)).filter((name) => name.endsWith(".binding.json"));
      const bindingPath = join(responseDir, bindingNames[0]!);
      const bindingBytes = await readFile(bindingPath);
      const inconsistentEvidence = JSON.parse(currentEvidence);
      const rescueIndex = historicalOutcomeIds.indexOf(ids[0]!);
      const finalIndex = historicalOutcomeIds.indexOf(ids[1]!);
      [inconsistentEvidence.modelOutcomes[rescueIndex], inconsistentEvidence.modelOutcomes[finalIndex]] = [
        inconsistentEvidence.modelOutcomes[finalIndex], inconsistentEvidence.modelOutcomes[rescueIndex],
      ];
      await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify(inconsistentEvidence), "utf-8");
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 4 }))
        .rejects.toThrow("OFFLINE_FINALIZATION_EVIDENCE_NOT_PROVABLE");
      await writeFile(join(evidenceDir, "resume-review.json"), currentEvidence, "utf-8");
      const binding = JSON.parse(bindingBytes.toString("utf-8"));
      await writeFile(bindingPath, JSON.stringify({ ...binding, resume_evidence_sha256: "0".repeat(64) }), "utf-8");
      await expect(resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 4 }))
        .rejects.toThrow("OFFLINE_FINALIZATION_EVIDENCE_NOT_PROVABLE");
      await writeFile(bindingPath, bindingBytes);
      const plan = await resolveFormalPendingChapterRecoveryPlan({ projectRoot: root, bookId: "book", jobId, pendingChapterNumber: 4 });
      expect(plan).toMatchObject({ recoveryClass: "FAILED_REENTRY" });
      expect(plan?.kind).not.toBe("FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME");
      if (!plan || plan.kind === "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME") throw new Error("expected offline recovery plan");
      expect(plan.failedReentryArtifacts.map((artifact) => artifact.logicalStepId)).toEqual(failedIds);
      const supersessionPath = join(evidenceDir, "offline-finalization-supersession.json");
      await writeFile(supersessionPath, JSON.stringify({ schema_version: "1.0", evidence_type: "CONFLICT" }), "utf-8");
      await expect(finalizePendingChapterOfflinePlan({ projectRoot: root, plan: plan! }))
        .rejects.toThrow("OFFLINE_FINALIZATION_SUPERSESSION_CONFLICT");
      await rm(supersessionPath);
      const result = await finalizePendingChapterOfflinePlan({ projectRoot: root, plan: plan! });
      expect(result.status).toBe("accepted-with-findings");
      expect(result).toMatchObject({ revisionCount: 2, logicReviewCount: 3, commercialReviewCount: 0 });
      expect(result.roleUsage).toEqual({
        writer: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        reviser: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        "logic-canon-auditor": { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
      });
      expect(await readFile(join(chaptersDir, "0004_Pending.md"), "utf-8")).toBe(`# Chapter 4\n\n${rescueBody}`);
      expect(await readFile(join(bookDir, "story", "current_state.md"), "utf-8")).toBe(markdownState[0][1]);
      expect(await readFile(join(evidenceDir, "resume-review.json"), "utf-8")).toBe(currentEvidence);
      for (const [index, id] of preservedIds.entries()) expect(await readFile(join(responseDir, `${id}.json`))).toEqual(preserved[index]);
      const supersession = JSON.parse(await readFile(supersessionPath, "utf-8"));
      expect(supersession).toMatchObject({
        evidence_type: "OFFLINE_FINALIZATION_SUPERSESSION",
        reason_code: "OFFLINE_RECOVERY_REENTRY_SUPERSEDED",
        historical_resume_evidence_sha256: createHash("sha256").update(originalEvidence).digest("hex"),
        current_resume_evidence_sha256: createHash("sha256").update(currentEvidence).digest("hex"),
        failed_reentry_artifacts: failedIds.map((logical_step_id) => ({ logical_step_id })),
      });
      expect((await readdir(evidenceDir)).filter((name) => name.includes("supersession"))).toEqual(["offline-finalization-supersession.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when formal pending evidence references the wrong legacy role, stage, or response type", async () => {
    const cases = [
      { label: "wrong rescue role", role: "auditor", stage: "RESCUE_REVISING_2", content: "=== REVISED_CONTENT ===\nSynthetic rescue." },
      { label: "wrong rescue stage", role: "reviser", stage: "LOGIC_REVIEW", content: "=== REVISED_CONTENT ===\nSynthetic rescue." },
      { label: "non-audit final review", role: "logicAuditor", stage: "LOGIC_REVIEW", content: JSON.stringify({ passed: true, message: "not an audit result" }) },
      { label: "content SHA mismatch", role: "reviser", stage: "RESCUE_REVISING_2", content: "=== REVISED_CONTENT ===\nSynthetic rescue.", contentSha: "0".repeat(64), expectedError: "AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_IDENTITY_MISMATCH" },
    ] as const;
    const { createHash } = await import("node:crypto");
    for (const [index, scenario] of cases.entries()) {
      const root = await mkdtemp(join(tmpdir(), `inkos-autonomous-invalid-binding-${index}-`));
      try {
        const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
        const responseDir = join(runtimeDir, "provider-responses");
        const evidenceDir = join(runtimeDir, "chapter-0004");
        await mkdir(responseDir, { recursive: true });
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify({
          jobId: "job", status: "REVIEW_EXHAUSTED", mode: "current-volume", volumeId: "volume-002",
          startChapter: 4, targetChapter: 6, nextChapter: 5, chapterNumber: 5, completedThisRun: 0,
          responseArtifactStatus: "COMPLETE",
        }), "utf-8");
        const id = `provider-step-${String(index + 1).repeat(64)}`;
        await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
          schema_version: "1.0", chapter_number: 4, status: "REVIEW_EXHAUSTED", modelOutcomes: [{ modelCallId: id }],
        }), "utf-8");
        await writeFile(join(responseDir, `${id}.json`), JSON.stringify({
          schema_version: "1.0", job_id: "job", logical_step_id: id, usage_identity: id,
          chapter_number: 5, role: scenario.role, stage: scenario.stage,
          provider: "openrouter", requested_model: "provider/model", input_fingerprint: "e".repeat(64),
          response_artifact_status: "COMPLETE", content_sha256: "contentSha" in scenario ? scenario.contentSha : createHash("sha256").update(scenario.content).digest("hex"),
          response: { content: scenario.content }, completed_at: "2026-08-23T00:00:00.000Z",
        }), "utf-8");
        await expect(correctLegacyPendingChapterArtifactBindings({
          projectRoot: root, bookId: "book", jobId: "job", pendingChapterNumber: 4,
        }), scenario.label).rejects.toThrow("expectedError" in scenario ? scenario.expectedError : "AUTONOMOUS_PROVIDER_RESPONSE_ARTIFACT_SEMANTIC_MISMATCH");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("fails closed across the formal historical-recovery authority matrix", async () => {
    const cases = [
      "no formal evidence", "REVIEW_EXHAUSTED only", "next cursor only", "wrong logical chapter",
      "wrong source chapter", "wrong book", "wrong job", "wrong logical step", "wrong content SHA",
      "wrong outcome provider", "unreferenced substitution", "out of order",
    ] as const;
    const { createHash } = await import("node:crypto");
    for (const [caseIndex, scenario] of cases.entries()) {
      const root = await mkdtemp(join(tmpdir(), `inkos-formal-recovery-negative-${caseIndex}-`));
      try {
        const runtimeDir = join(root, "books", "book", "story", "runtime", "bounded-autonomous");
        const responseDir = join(runtimeDir, "provider-responses");
        const evidenceDir = join(runtimeDir, "chapter-0004");
        await mkdir(responseDir, { recursive: true });
        await mkdir(evidenceDir, { recursive: true });
        const rescueId = `provider-step-${"a".repeat(63)}${caseIndex.toString(16)}`;
        const finalId = `provider-step-${"b".repeat(63)}${caseIndex.toString(16)}`;
        const rescueContent = "=== REVISED_CONTENT ===\nFaithful historical rescue candidate.";
        const finalContent = JSON.stringify({
          passed: true, overall_score: 92,
          dimension_scores: { blueprint_transition: 95, causal_logic: 90, canon_continuity: 92, character_motivation: 95, state_inheritance: 95, hooks_disclosure: 95, narrative_clarity: 93 },
          issues: [{ severity: "warning", category: "causal_logic", description: "Synthetic.", suggestion: "Track.", repair_scope: "structural" }],
          summary: "Passed with findings.",
        });
        const runtime = {
          jobId: "job", status: scenario === "next cursor only" ? "RUNNING" : "REVIEW_EXHAUSTED",
          nextChapter: 5, chapterNumber: 5, responseArtifactStatus: "COMPLETE",
        };
        await writeFile(join(runtimeDir, "production-state.json"), JSON.stringify(runtime));
        const artifacts = [
          { id: rescueId, content: rescueContent },
          { id: finalId, content: finalContent },
        ];
        for (const [artifactIndex, artifact] of artifacts.entries()) {
          await writeFile(join(responseDir, `${artifact.id}.json`), JSON.stringify({
            schema_version: "1.0", job_id: scenario === "wrong job" ? "other-job" : "job",
            logical_step_id: scenario === "wrong logical step" && artifactIndex === 0 ? finalId : artifact.id,
            usage_identity: artifact.id,
            chapter_number: scenario === "wrong source chapter" ? 4 : 5,
            role: "reviser", stage: "RESCUE_REVISING_2", provider: "openrouter", requested_model: "provider/model",
            input_fingerprint: String(artifactIndex + 1).repeat(64), response_artifact_status: "COMPLETE",
            content_sha256: scenario === "wrong content SHA" && artifactIndex === 0
              ? "0".repeat(64) : createHash("sha256").update(artifact.content).digest("hex"),
            response: { content: artifact.content }, completed_at: "2026-08-23T00:00:00.000Z",
          }));
        }
        if (scenario !== "no formal evidence" && scenario !== "REVIEW_EXHAUSTED only") {
          const modelOutcomes = scenario === "unreferenced substitution"
            ? [{ modelCallId: rescueId }, { modelCallId: `provider-step-${"c".repeat(64)}` }]
            : (scenario === "out of order" ? [finalId, rescueId] : [rescueId, finalId]).map((modelCallId) => ({
                modelCallId,
                provider: scenario === "wrong outcome provider" ? "other-provider" : "openrouter",
                model: "provider/model",
              }));
          await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
            chapter_number: scenario === "wrong logical chapter" ? 3 : 4,
            status: "REVIEW_EXHAUSTED", modelOutcomes,
          }));
        }
        await expect(verifyFormalPendingChapterRecoveryEvidence({
          projectRoot: root,
          bookId: scenario === "wrong book" ? "other-book" : "book",
          jobId: "job",
          pendingChapterNumber: 4,
        }), scenario).resolves.toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("grants one durable cross-process claim and rejects a concurrent owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-claim-"));
    try {
      const first = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      await expect(claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: () => true }))
        .rejects.toThrow("AUTONOMOUS_JOB_ALREADY_RUNNING");
      await releaseAutonomousJob(root, "book", first);
      const second = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: () => true });
      await releaseAutonomousJob(root, "book", second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims only a dead owner's durable claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-reclaim-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const replacement = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: (pid) => pid !== 101 });
      await releaseAutonomousJob(root, "book", stale);
      await expect(claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 303, isProcessAlive: () => true }))
        .rejects.toThrow("AUTONOMOUS_JOB_ALREADY_RUNNING");
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants exactly one successor when two processes race to reclaim the same dead claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-reclaim-race-"));
    try {
      await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const attempts = await Promise.allSettled([
        claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: (pid) => pid !== 101 }),
        claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 303, isProcessAlive: (pid) => pid !== 101 }),
      ]);
      const granted = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof claimAutonomousJob>>> => attempt.status === "fulfilled");
      expect(granted).toHaveLength(1);
      await releaseAutonomousJob(root, "book", granted[0]!.value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a stale heartbeat even when the operating system has reused the owner PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-pid-reuse-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${stale.claimId}`, JSON.stringify({ ...stale, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      const replacement = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      expect(replacement.claimId).not.toBe(stale.claimId);
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned reclaim guard left by a crashed owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-abandoned-guard-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${stale.claimId}`, JSON.stringify({ ...stale, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      const contenders = `${lease}.reclaim-contenders`;
      await mkdir(contenders, { recursive: true });
      await writeFile(join(contenders, "crashed-guard.json"), JSON.stringify({ token: "crashed-guard", ownerPid: 101, ownerIdentity: "old-101", ticket: 1, choosing: false, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");

      const replacement = await claimAutonomousJob({
        projectRoot: root,
        bookId: "book",
        jobId: "job",
        ownerPid: 202,
        isProcessAlive: (pid) => pid !== 101,
      });

      expect(replacement.ownerPid).toBe(202);
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("grants exactly one successor when two processes race past an abandoned reclaim guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-abandoned-guard-race-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${stale.claimId}`, JSON.stringify({ ...stale, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      const contenders = `${lease}.reclaim-contenders`;
      await mkdir(contenders, { recursive: true });
      await writeFile(join(contenders, "crashed-guard.json"), JSON.stringify({ token: "crashed-guard", ownerPid: 101, ownerIdentity: "old-101", ticket: 1, choosing: false, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");

      const attempts = await Promise.allSettled([
        claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: (pid) => pid !== 101 }),
        claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 303, isProcessAlive: (pid) => pid !== 101 }),
      ]);
      const granted = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof claimAutonomousJob>>> => attempt.status === "fulfilled");
      expect(granted).toHaveLength(1);
      await releaseAutonomousJob(root, "book", granted[0]!.value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an old truncated reclaim guard without treating a fresh partial write as abandoned", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-truncated-guard-"));
    try {
      await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      const contenders = `${lease}.reclaim-contenders`;
      await mkdir(contenders, { recursive: true });
      const guard = join(contenders, "truncated-guard.json");
      await writeFile(guard, "{", "utf-8");
      await expect(claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: (pid) => pid !== 101 }))
        .rejects.toThrow("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
      await utimes(guard, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
      const replacement = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: (pid) => pid !== 101 });
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expire a live contender when its process generation still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-suspended-guard-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${stale.claimId}`, JSON.stringify({ ...stale, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      const contenders = `${lease}.reclaim-contenders`;
      await mkdir(contenders, { recursive: true });
      await writeFile(join(contenders, "suspended.json"), JSON.stringify({ token: "suspended", ownerPid: 101, ownerIdentity: "generation-101", ticket: 1, choosing: false, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      await expect(claimAutonomousJob({
        projectRoot: root,
        bookId: "book",
        jobId: "job",
        ownerPid: 202,
        isProcessAlive: () => true,
        getProcessIdentity: async (pid) => pid === 101 ? "generation-101" : "current-generation",
      })).rejects.toThrow("AUTONOMOUS_JOB_RECLAIM_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a live PID whose process generation no longer matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-guard-pid-reuse-"));
    try {
      const stale = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 101, isProcessAlive: () => true });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${stale.claimId}`, JSON.stringify({ ...stale, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");
      const contenders = `${lease}.reclaim-contenders`;
      await mkdir(contenders, { recursive: true });
      await writeFile(join(contenders, "old-generation.json"), JSON.stringify({ token: "old-generation", ownerPid: 101, ownerIdentity: "old-101", ticket: 1, choosing: false, updatedAt: new Date().toISOString() }), "utf-8");
      const replacement = await claimAutonomousJob({
        projectRoot: root,
        bookId: "book",
        jobId: "job",
        ownerPid: 202,
        isProcessAlive: () => true,
        getProcessIdentity: async (pid) => pid === 101 ? "new-101" : "current-generation",
      });
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes an owner heartbeat refresh against stale-claim reclamation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-refresh-reclaim-race-"));
    try {
      const original = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: process.pid });
      const lease = join(root, "books", "book", "story", "runtime", "bounded-autonomous", "active-job.json");
      await writeFile(`${lease}.heartbeat.${original.claimId}`, JSON.stringify({ ...original, updatedAt: "2000-01-01T00:00:00.000Z" }), "utf-8");

      const outcomes = await Promise.allSettled([
        refreshAutonomousJobClaim(root, "book", original),
        claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job", ownerPid: 202, isProcessAlive: () => true }),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      if (outcomes[1]!.status === "fulfilled") {
        await releaseAutonomousJob(root, "book", outcomes[1].value);
      } else {
        await releaseAutonomousJob(root, "book", original);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drains same-owner refreshes before releasing the durable claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-autonomous-refresh-release-"));
    try {
      const claim = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job" });
      const refreshes = Array.from({ length: 8 }, () => refreshAutonomousJobClaim(root, "book", claim));
      const release = releaseAutonomousJob(root, "book", claim);
      const outcomes = await Promise.allSettled([...refreshes, release]);
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      const replacement = await claimAutonomousJob({ projectRoot: root, bookId: "book", jobId: "job" });
      await releaseAutonomousJob(root, "book", replacement);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
