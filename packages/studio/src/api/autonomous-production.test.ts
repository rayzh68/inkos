import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomousProviderExecution, deriveAutonomousJobIdentity } from "@actalk/inkos-core";
import { AUTONOMOUS_BUDGET_NOT_CONFIGURED, AutonomousJobRegistry, classifyStateRepairError, projectAutonomousProductionView, resolveOfflineFinalizationPlan, verifyOfflineFinalizationEvidence } from "./autonomous-production.js";

const map = {
  schemaVersion: "1.0" as const,
  bookId: "book",
  authorityBookId: "authority",
  title: "The House She Built",
  totalChapters: 156,
  volumes: [
    { volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 38, chapterCount: 38 },
    { volumeId: "volume-002", volumeNumber: 2, title: "Two", startChapter: 39, endChapter: 78, chapterCount: 40 },
    { volumeId: "volume-003", volumeNumber: 3, title: "Three", startChapter: 79, endChapter: 118, chapterCount: 40 },
    { volumeId: "volume-004", volumeNumber: 4, title: "Four", startChapter: 119, endChapter: 156, chapterCount: 38 },
  ],
};

const catalog = [
  { id: "gpt", name: "GPT", contextWindow: 128_000, maxOutputTokens: 16_000, inputPrice: "0.000001", outputPrice: "0.000004", inputModalities: ["text"], outputModalities: ["text"] },
  { id: "deepseek", name: "DeepSeek", contextWindow: 128_000, maxOutputTokens: 16_000, inputPrice: "0.0000005", outputPrice: "0.000002", inputModalities: ["text"], outputModalities: ["text"] },
  { id: "gemini", name: "Gemini", contextWindow: 128_000, maxOutputTokens: 16_000, inputPrice: "0.0000004", outputPrice: "0.0000015", inputModalities: ["text"], outputModalities: ["text"] },
  { id: "flash", name: "Flash", contextWindow: 128_000, maxOutputTokens: 16_000, inputPrice: "0.0000002", outputPrice: "0.000001", inputModalities: ["text"], outputModalities: ["text"] },
];

describe("autonomous production Studio projection", () => {
  it("projects an unindexed preserved candidate as resumable without prose regeneration", () => {
    const runtime = {
      jobId: "generic-job", status: "HELD_AFTER_TWO_REVISIONS", mode: "current-volume" as const,
      nextChapter: 6, updatedAt: "now",
    };
    const view = projectAutonomousProductionView({
      map, targetChapters: 156, nextChapter: 6,
      chapters: [1, 2, 3, 4, 5].map((number) => ({ number, status: "approved" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog, runtime,
      offlineFinalizationPlan: {
        kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", recoveryClass: "PRESERVED_BOUNDED_REVIEW",
        bookId: "book", jobId: "generic-job", pendingChapterNumber: 6, baselineChapterNumber: 5,
        productionMapSha256: "a".repeat(64),
        candidate: { content: "CANDIDATE_A", sha256: "b".repeat(64), title: "Generic Six", titleAuthorityLogicalStepId: `provider-step-${"c".repeat(64)}`, titleAuthorityArtifactSha256: "d".repeat(64) },
        reviewEvidence: { relativePath: "review.json", sha256: "e".repeat(64), runRelativePath: "run.json", runSha256: "f".repeat(64) },
        initialReviews: { "logic-canon-auditor": {
          reviewerRole: "logic-canon-auditor", provider: "test", model: "logic", totalScore: 80,
          dimensionScores: {}, decision: "REVISION_REQUIRED", findings: [], reviewedCandidateSha: "b".repeat(64), reviewedAt: "now",
        } },
        invalidReviewerRoles: ["commercial-reader"], historicalRoleUsage: {},
      },
      active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });

    expect(view.runtimeStatus).toBe("RECOVERY_READY_PRESERVED_BOUNDED_REVIEW");
    expect(view.startEnabled).toBe(true);
    expect(view.runtimeBlockers).not.toContain("REVIEW_EXHAUSTED");
    expect(view.finalReviewRecovery).toMatchObject({
      chapter: 6, recoveryMode: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME",
      rescueCandidate: "PRESERVED", existingValidReviewers: ["logic-canon-auditor"],
      invalidReviewerRoles: ["commercial-reader"], writerRegeneration: false,
      additionalWriterCalls: 0, additionalRevisionAllowed: true,
    });
  });

  it("projects a terminal length violation through the existing preserved-recovery product flow", () => {
    const runtime = { jobId: "generic-job", status: "PAUSED_BY_USER", mode: "current-volume" as const, nextChapter: 8, chapterNumber: 7, updatedAt: "now" };
    const view = projectAutonomousProductionView({
      map, targetChapters: 156, nextChapter: 8,
      chapters: [1, 2, 3, 4, 5].map((number) => ({ number, status: "approved" })).concat([
        { number: 6, status: "approved" }, { number: 7, status: "state-degraded" },
      ]),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog, runtime,
      offlineFinalizationPlan: {
        kind: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME", recoveryClass: "TERMINAL_LENGTH_VIOLATION",
        bookId: "book", jobId: "generic-job", pendingChapterNumber: 6, baselineChapterNumber: 5, productionMapSha256: "a".repeat(64),
        candidate: { content: "INITIAL", sha256: "b".repeat(64), title: "Generic Six", titleAuthorityLogicalStepId: `provider-step-${"c".repeat(64)}`, titleAuthorityArtifactSha256: "d".repeat(64) },
        reviewEvidence: { relativePath: "review.json", sha256: "e".repeat(64), runRelativePath: "run.json", runSha256: "f".repeat(64) },
        initialReviews: { "logic-canon-auditor": { reviewerRole: "logic-canon-auditor", provider: "test", model: "logic", totalScore: 80, dimensionScores: {}, decision: "REVISION_REQUIRED", findings: [], reviewedCandidateSha: "b".repeat(64), reviewedAt: "now" } },
        invalidReviewerRoles: ["commercial-reader"], historicalRoleUsage: {},
      terminalLengthRecovery: {
        bookConfigSha256: "b".repeat(64),
        baselineSnapshotFiles: [],
          currentChapterFile: "0006_Generic_Six.md", currentChapterSha256: "1".repeat(64), currentLengthCount: 700, candidateLengthCount: 2200, hardMin: 1600, hardMax: 2800,
          terminalReceiptRelativePath: "receipt.json", terminalReceiptSha256: "3".repeat(64), terminalCandidateSha256: "4".repeat(64),
          downstreamChapters: [{ chapterNumber: 7, chapterFile: "0007_Generic_Seven.md", chapterSha256: "2".repeat(64), action: "DISCARD_AND_REGENERATE" }], preparationStatus: "REQUIRED",
        },
      },
      active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });

    expect(view.runtimeStatus).toBe("RECOVERY_READY_PRESERVED_BOUNDED_REVIEW");
    expect(view.startEnabled).toBe(true);
    expect(view.runtimeBlockers).not.toContain("PENDING_STATE_REPAIR_CHAPTER_7");
    expect(view.finalReviewRecovery).toMatchObject({
      chapter: 6, recoveryClass: "TERMINAL_LENGTH_VIOLATION", currentInvalidTerminalLength: 700,
      recoveryCandidateLength: 2200, downstreamAction: "DISCARD_AND_REGENERATE", downstreamChapters: [7],
      writerRegeneration: false, additionalWriterCalls: 0,
    });
  });

  it("verifies preserved rescue and passed final-review artifacts without changing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-offline-finalization-view-"));
    const bookDir = join(root, "books", "book");
    const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    const evidenceDir = join(bookDir, "story", "runtime", "bounded-autonomous", "chapter-0004");
    await mkdir(responseDir, { recursive: true });
    await mkdir(evidenceDir, { recursive: true });
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    const recoveryMap = {
      schemaVersion: "1.0" as const, bookId: "book", authorityBookId: "authority", title: "Book", totalChapters: 6,
      volumes: [{ volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 6, chapterCount: 6 }],
    };
    const jobId = deriveAutonomousJobIdentity({ map: recoveryMap, mode: "current-volume", nextChapter: 5 });
    await writeFile(join(bookDir, "story", "outline", "book-production-map.json"), JSON.stringify({
      schema_version: "1.0", book_id: "book", authority_book_id: "authority", title: "Book", total_chapters: 6,
      volumes: [{ volume_id: "volume-001", volume_number: 1, title: "One", start_chapter: 1, end_chapter: 6, chapter_count: 6 }],
    }));
    await writeFile(join(bookDir, "chapters", "0004_Pending.md"), "# Chapter 4\n\nOLD_BODY_A");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{
      number: 4, title: "Pending", status: "audit-failed", wordCount: 10,
      createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", auditIssues: [], lengthWarnings: [],
    }]));
    const dimensions = { blueprint_transition: 95, causal_logic: 90, canon_continuity: 92, character_motivation: 95, state_inheritance: 95, hooks_disclosure: 95, narrative_clarity: 93 };
    const sourceExecution = createAutonomousProviderExecution({
      projectRoot: root, bookId: "book", jobId,
      getActiveStage: () => ({ role: "reviser", stage: "RESCUE_REVISING_2", provider: "openrouter", model: "model" }),
    });
    const fingerprints = ["a".repeat(64), "b".repeat(64)] as const;
    const responses = [
      [sourceExecution.responseArtifactPath(fingerprints[0], "openrouter", "model", 5).split(/[\\/]/).at(-1)!.replace(/\.json$/u, ""), "reviser", "RESCUE_REVISING_2", "=== REVISED_CONTENT ===\nSynthetic Chapter 004 rescue.", fingerprints[0]],
      [sourceExecution.responseArtifactPath(fingerprints[1], "openrouter", "model", 5).split(/[\\/]/).at(-1)!.replace(/\.json$/u, ""), "reviser", "RESCUE_REVISING_2", JSON.stringify({ passed: true, overall_score: 92, dimension_scores: dimensions, issues: [{ severity: "warning", category: "causal_logic", description: "synthetic", suggestion: "defer", repair_scope: "structural" }], summary: "pass" }), fingerprints[1]],
    ] as const;
    try {
      const snapshotDir = join(bookDir, "story", "snapshots", "4");
      const snapshotStateDir = join(snapshotDir, "state");
      await mkdir(snapshotStateDir, { recursive: true });
      const markdownState = ["current_state.md", "pending_hooks.md", "chapter_summaries.md", "particle_ledger.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md"]
        .map((name) => [name, `# ${name}\n\nSTATE_B`] as const);
      const structuredState = [
        ["manifest.json", JSON.stringify({ schemaVersion: 2, language: "en", lastAppliedChapter: 4, projectionVersion: 1, migrationWarnings: [] })],
        ["current_state.json", JSON.stringify({ chapter: 4, facts: [] })],
        ["hooks.json", JSON.stringify({ hooks: [] })],
        ["chapter_summaries.json", JSON.stringify({ rows: [{ chapter: 4, title: "Pending" }] })],
      ] as const;
      await Promise.all([
        ...markdownState.map(([name, content]) => writeFile(join(snapshotDir, name), content)),
        ...structuredState.map(([name, content]) => writeFile(join(snapshotStateDir, name), content)),
      ]);
      const rescueBody = "Synthetic Chapter 004 rescue.";
      const settlementProof = Buffer.from(JSON.stringify({
        schema_version: "1.0", evidence_type: "OFFLINE_FINALIZATION_STATE_SETTLEMENT_PROOF",
        book_id: "book", job_id: jobId, chapter_number: 4, snapshot_id: "chapter-4-state-b",
        rescue_candidate_body_sha256: createHash("sha256").update(rescueBody).digest("hex"),
        artifacts: [
          ...markdownState.map(([name, content]) => ({ source_relative_path: `story/snapshots/4/${name}`, target_relative_path: `story/${name}`, sha256: createHash("sha256").update(content).digest("hex") })),
          ...structuredState.map(([name, content]) => ({ source_relative_path: `story/snapshots/4/state/${name}`, target_relative_path: `story/state/${name}`, sha256: createHash("sha256").update(content).digest("hex") })),
        ],
      }));
      await writeFile(join(evidenceDir, "state-settlement-proof.json"), settlementProof);
      await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({
        jobId, status: "REVIEW_EXHAUSTED", mode: "current-volume", nextChapter: 5, chapterNumber: 5, responseArtifactStatus: "COMPLETE",
      }));
      await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
        chapter_number: 4, status: "REVIEW_EXHAUSTED", revisionCount: 2, logicReviewCount: 2, commercialReviewCount: 0,
        baselineRoleUsage: {}, roleUsage: {},
        stateSettlementProof: { relativePath: "state-settlement-proof.json", sha256: createHash("sha256").update(settlementProof).digest("hex") },
        modelOutcomes: responses.map(([modelCallId]) => ({ modelCallId })),
      }));
      for (const [id, role, stage, content, fingerprint] of responses) {
        await writeFile(join(responseDir, `${id}.json`), JSON.stringify({
          schema_version: "1.0", job_id: jobId, logical_step_id: id, usage_identity: id,
          chapter_number: 5, role, stage, provider: "openrouter", requested_model: "model",
          input_fingerprint: fingerprint, response_artifact_status: "COMPLETE",
          content_sha256: createHash("sha256").update(content).digest("hex"), response: { content }, completed_at: "now",
        }));
      }
      const runtime = { jobId, status: "REVIEW_EXHAUSTED", mode: "current-volume", nextChapter: 5, updatedAt: "now", phase: "RESCUE_REVISING_2", responseArtifactStatus: "COMPLETE" } as const;
      const verified = await verifyOfflineFinalizationEvidence({
        projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5,
        runtime,
      });
      expect(verified).toBe(true);
      const offlineFinalizationPlan = await resolveOfflineFinalizationPlan({
        projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5, runtime,
      });
      const view = projectAutonomousProductionView({
        map, targetChapters: 156, nextChapter: 5,
        chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
        config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
        catalog, runtime, offlineFinalizationPlan, active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
      });
      expect(view.runtimeBlockers).not.toContain("REVIEW_EXHAUSTED");
      expect(view.runtimeStatus).toBe("RECOVERY_READY_OFFLINE_FINALIZATION");
      await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
        chapter_number: 4, status: "REVIEW_EXHAUSTED", revisionCount: 2, logicReviewCount: 2, commercialReviewCount: 0,
        baselineRoleUsage: {}, roleUsage: {}, modelOutcomes: responses.map(([modelCallId]) => ({ modelCallId })),
      }));
      const rebaselinePlan = await resolveOfflineFinalizationPlan({
        projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5, runtime,
      });
      expect(rebaselinePlan).toMatchObject({
        kind: "FORMAL_BOUNDED_STATE_REBASELINE",
        pendingChapterNumber: 4,
        baselineChapterNumber: 3,
      });
      expect(await verifyOfflineFinalizationEvidence({
        projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5, runtime,
      })).toBe(true);
      for (const status of ["RUNNING", "WAITING_PROVIDER_RETRY", "PAUSED_PROVIDER_UNAVAILABLE", "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "PAUSED_DETERMINISTIC_PROVIDER_ERROR"] as const) {
        const ownedRuntime = {
          ...runtime,
          status,
          recoveryOwnership: {
            kind: "FORMAL_BOUNDED_STATE_REBASELINE" as const,
            recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED" as const,
            bookId: "book",
            jobId,
            pendingChapterNumber: 4,
          },
        };
        await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify(ownedRuntime));
        await expect(resolveOfflineFinalizationPlan({
          projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5, runtime: ownedRuntime,
        })).resolves.toMatchObject({ kind: "FORMAL_BOUNDED_STATE_REBASELINE", jobId, pendingChapterNumber: 4 });
      }
      const rebaselineReady = projectAutonomousProductionView({
        map, targetChapters: 156, nextChapter: 5,
        chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
        config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
        catalog, runtime, offlineFinalizationPlan: rebaselinePlan, active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
      });
      expect(rebaselineReady.runtimeStatus).toBe("RECOVERY_READY_BOUNDED_STATE_REBASELINE");
      expect(rebaselineReady.runtimeBlockers).not.toContain("REVIEW_EXHAUSTED");
      expect(rebaselineReady.finalReviewRecovery).toMatchObject({
        recoveryMode: "FORMAL_BOUNDED_STATE_REBASELINE",
        normalProviderCalls: 3,
        maximumProviderCalls: 6,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects offline finalization evidence when a referenced rescue has the wrong role or stage", async () => {
    const dimensions = { blueprint_transition: 95, causal_logic: 90, canon_continuity: 92, character_motivation: 95, state_inheritance: 95, hooks_disclosure: 95, narrative_clarity: 93 };
    for (const [index, identity] of [
      { role: "auditor", stage: "RESCUE_REVISING_2" },
      { role: "reviser", stage: "LOGIC_REVIEW" },
    ].entries()) {
      const root = await mkdtemp(join(tmpdir(), `inkos-offline-finalization-wrong-identity-${index}-`));
      const bookDir = join(root, "books", "book");
      const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
      const evidenceDir = join(bookDir, "story", "runtime", "bounded-autonomous", "chapter-0004");
      const rescueId = "provider-step-" + String(index + 1).repeat(64);
      const finalId = "provider-step-" + String(index + 3).repeat(64);
      const rescueContent = "=== REVISED_CONTENT ===\nSynthetic Chapter 004 rescue.";
      const finalContent = JSON.stringify({
        passed: true,
        overall_score: 92,
        dimension_scores: dimensions,
        issues: [{ severity: "warning", category: "causal_logic", description: "synthetic", suggestion: "track", repair_scope: "structural" }],
        summary: "pass",
      });
      try {
        await mkdir(responseDir, { recursive: true });
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({
          jobId: "job", status: "REVIEW_EXHAUSTED", nextChapter: 5, chapterNumber: 5, responseArtifactStatus: "COMPLETE",
        }));
        await writeFile(join(evidenceDir, "resume-review.json"), JSON.stringify({
          chapter_number: 4, status: "REVIEW_EXHAUSTED", modelOutcomes: [{ modelCallId: rescueId }, { modelCallId: finalId }],
        }));
        for (const artifact of [
          { id: rescueId, role: identity.role, stage: identity.stage, content: rescueContent },
          { id: finalId, role: "logicAuditor", stage: "LOGIC_REVIEW", content: finalContent },
        ]) {
          await writeFile(join(responseDir, `${artifact.id}.json`), JSON.stringify({
            schema_version: "1.0", job_id: "job", logical_step_id: artifact.id, usage_identity: artifact.id,
            chapter_number: 5, role: artifact.role, stage: artifact.stage, provider: "openrouter", requested_model: "model",
            input_fingerprint: "c".repeat(64), response_artifact_status: "COMPLETE",
            content_sha256: createHash("sha256").update(artifact.content).digest("hex"), response: { content: artifact.content }, completed_at: "now",
          }));
        }
        const runtime = { jobId: "job", status: "REVIEW_EXHAUSTED", mode: "current-volume", nextChapter: 5, updatedAt: "now", phase: "RESCUE_REVISING_2", responseArtifactStatus: "COMPLETE" } as const;
        const verified = await verifyOfflineFinalizationEvidence({
          projectRoot: root, bookId: "book", pendingChapter: 4, nextChapter: 5,
          runtime,
        });
        expect(verified).toBe(false);
        const view = projectAutonomousProductionView({
          map, targetChapters: 156, nextChapter: 5,
          chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
          config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
          catalog, runtime, offlineFinalizationPlan: null, active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
        });
        expect(view.runtimeBlockers).toContain("REVIEW_EXHAUSTED");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("projects a provable failed re-entry as offline finalization instead of a critical-findings dead end", () => {
    const runtime = {
      jobId: "job", status: "BLOCKED_CRITICAL_FINDINGS", mode: "current-volume", nextChapter: 5,
      updatedAt: "now", phase: "RESCUE_REVISING_2", responseArtifactStatus: "COMPLETE",
    } as const;
    const view = projectAutonomousProductionView({
      map, targetChapters: 156, nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog, runtime, offlineFinalizationPlan: {
        kind: "FORMAL_OFFLINE_FINALIZATION", recoveryClass: "FAILED_REENTRY", bookId: "book", jobId: "job",
        pendingChapterNumber: 4, finalReview: { decision: "ACCEPTED_WITH_FINDINGS" },
      } as never,
      active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeStatus).toBe("RECOVERY_READY_OFFLINE_FINALIZATION_AFTER_FAILED_REENTRY");
    expect(view.runtimeBlockers).not.toContain("BLOCKED_CRITICAL_FINDINGS");
    expect(view.finalReviewRecovery).toMatchObject({ recoveryClass: "FAILED_REENTRY", finalReviewDecision: "ACCEPTED_WITH_FINDINGS", additionalWriterCalls: 0, additionalReviserCalls: 0, additionalReviewerCalls: 0 });
  });

  it("projects a matching Core rebaseline plan without legacy runtime phase telemetry", () => {
    const recoveryMap = {
      schemaVersion: "1.0" as const, bookId: "projection-book", authorityBookId: "authority", title: "Generic Book", totalChapters: 8,
      volumes: [{ volumeId: "volume-001", volumeNumber: 1, title: "One", startChapter: 1, endChapter: 8, chapterCount: 8 }],
    };
    for (const runtime of [
      {
        jobId: "projection-job", status: "BLOCKED_CRITICAL_FINDINGS", mode: "current-volume", nextChapter: 7,
        updatedAt: "now", phase: "LOGIC_REVIEW", responseArtifactStatus: "COMPLETE",
      },
      {
        jobId: "projection-job", status: "PAUSED_DETERMINISTIC_PROVIDER_ERROR", mode: "current-volume", nextChapter: 7,
        updatedAt: "now",
      },
    ] as const) {
      const view = projectAutonomousProductionView({
        map: recoveryMap, targetChapters: 8, nextChapter: 7,
        chapters: [1, 2, 3, 4, 5, 6].map((number) => ({ number, status: number === 6 ? "audit-failed" as const : "approved" as const })),
        config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
        catalog, runtime,
        offlineFinalizationPlan: {
          kind: "FORMAL_BOUNDED_STATE_REBASELINE", recoveryClass: "FAILED_REENTRY", bookId: "projection-book",
          jobId: "projection-job", pendingChapterNumber: 6, finalReview: { decision: "ACCEPTED_WITH_FINDINGS" },
        } as never,
        active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
      });
      expect(view.runtimeStatus).toBe("RECOVERY_READY_BOUNDED_STATE_REBASELINE");
      expect(view.runtimeBlockers).not.toContain("BLOCKED_CRITICAL_FINDINGS");
      expect(view.startEnabled).toBe(true);
      expect(view.finalReviewRecovery).toMatchObject({ chapter: 6, normalProviderCalls: 3, maximumProviderCalls: 6 });
    }
  });

  it("keeps critical findings blocked when Core supplies no recovery plan", () => {
    const view = projectAutonomousProductionView({
      map, targetChapters: 156, nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: { jobId: "job", status: "BLOCKED_CRITICAL_FINDINGS", mode: "current-volume", nextChapter: 5, updatedAt: "now", phase: "LOGIC_REVIEW", responseArtifactStatus: "COMPLETE" },
      offlineFinalizationPlan: null, active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeBlockers).toContain("BLOCKED_CRITICAL_FINDINGS");
    expect(view.startEnabled).toBe(false);
    expect(view.finalReviewRecovery).toBeUndefined();
  });

  it("fails closed when a Core recovery plan does not match the projected identity", () => {
    for (const mismatch of [
      { bookId: "other-book", jobId: "job", pendingChapterNumber: 4 },
      { bookId: "book", jobId: "other-job", pendingChapterNumber: 4 },
      { bookId: "book", jobId: "job", pendingChapterNumber: 3 },
    ]) {
      const view = projectAutonomousProductionView({
        map, targetChapters: 156, nextChapter: 5,
        chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" as const : "approved" as const })),
        config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
        catalog,
        runtime: { jobId: "job", status: "BLOCKED_CRITICAL_FINDINGS", mode: "current-volume", nextChapter: 5, updatedAt: "now", phase: "LOGIC_REVIEW", responseArtifactStatus: "COMPLETE" },
        offlineFinalizationPlan: {
          kind: "FORMAL_BOUNDED_STATE_REBASELINE", recoveryClass: "FAILED_REENTRY", ...mismatch,
          finalReview: { decision: "ACCEPTED_WITH_FINDINGS" },
        } as never,
        active: false, budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
      });
      expect(view.runtimeBlockers).toContain("BLOCKED_CRITICAL_FINDINGS");
      expect(view.startEnabled).toBe(false);
      expect(view.finalReviewRecovery).toBeUndefined();
    }
  });

  it("derives current volume and budget without hard-coded chapter boundaries", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: "ready-for-review", tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })),
      config: {
        defaultModel: "gpt",
        modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" },
      },
      runtime: null,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.currentVolume).toMatchObject({ volumeId: "volume-001", startChapter: 1, endChapter: 38 });
    expect(view.completedChapters).toBe(4);
    expect(view.budget).toEqual({ status: "BUDGET_NOT_CONFIGURED" });
    expect(view.economics.actual.costStatus).toBe("COST_UNAVAILABLE");
    expect(view.runtimeBlockers).not.toContain("COST_GUARD_UNAVAILABLE");
    expect(view.startEnabled).toBe(true);
  });

  it("keeps unavailable forecast truthful without turning it into an admission blocker", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: "ready-for-review", tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      runtime: null,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeBlockers).not.toContain("COST_GUARD_UNAVAILABLE");
    expect(view.economics.budget.guardStatus).toBe("COST_UNAVAILABLE");
    expect(view.economics.budget.status).toBe("BUDGET_NOT_CONFIGURED");
    expect(view.startEnabled).toBe(true);
  });

  it("binds catalog pricing to legacy tokens and projects all required conservative estimates", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "state-degraded" : "approved", tokenUsage: { promptTokens: 1_000, completionTokens: 2_000, totalTokens: 3_000 } })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: null,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });

    expect(Object.values(view.rolePricing).every((entry) => entry.status === "VERIFIED_IN_CURRENT_CATALOG")).toBe(true);
    expect(view.economics.actual).toMatchObject({ costUsd: null, costStatus: "CALCULATED_ESTIMATE" });
    expect(view.economics.historicalCalculatedEstimateUsd).toBeGreaterThan(0);
    expect(view.economics.remainingVolumeForecast.highUsd).toBeGreaterThan(0);
    expect(view.economics.currentVolumeEstimatedTotal.highUsd!).toBeGreaterThan(view.economics.remainingVolumeForecast.highUsd!);
    expect(view.economics.fullBookForecast.highUsd!).toBeGreaterThan(view.economics.currentVolumeEstimatedTotal.highUsd!);
    expect(view.economics.repairForecast.highUsd).toBeCloseTo(0.4288, 10);
    expect(view.runtimeBlockers).not.toContain("COST_GUARD_UNAVAILABLE");
    expect(view.runtimeBlockers).toContain("PENDING_STATE_REPAIR_CHAPTER_4");
  });

  it("projects repaired state with its original audit failure truthfully instead of offering another repair", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" : "approved", tokenUsage: { promptTokens: 1_000, completionTokens: 2_000, totalTokens: 3_000 } })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: { status: "READY", mode: "current-volume", nextChapter: 5, updatedAt: "2026-08-21T08:35:53.107Z", repairOutcome: { chapter: 4, status: "STATE_REPAIRED_REVIEW_STILL_REQUIRED", errorCode: null } },
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.repairOutcome).toEqual({ chapter: 4, status: "STATE_REPAIRED_REVIEW_STILL_REQUIRED", errorCode: null });
    expect(view.runtimeBlockers).not.toContain("PENDING_STATE_REPAIR_CHAPTER_4");
    expect(view.runtimeBlockers).not.toContain("PENDING_CHAPTER_REVIEW_4");
    expect(view.chapterAttention).toEqual({ chapter: 4, status: "AUDIT_FAILED_STATE_SETTLED" });
    expect(view.startEnabled).toBe(true);
  });

  it("fails closed for repair when catalog context capacity is unavailable", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "state-degraded" : "approved", tokenUsage: { promptTokens: 1_000, completionTokens: 2_000, totalTokens: 3_000 } })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog: catalog.map((entry) => ({ ...entry, contextWindow: 0 })),
      runtime: null,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });

    expect(view.economics.repairForecast.highUsd).toBeNull();
    expect(view.startEnabled).toBe(false);
  });

  it("fails closed for state repair and missing independent role configuration", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [{ number: 4, status: "state-degraded" }],
      config: { defaultModel: "gpt", modelOverrides: {} },
      runtime: null,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.startEnabled).toBe(false);
    expect(view.runtimeStatus).toBe("BLOCKED");
    expect(view.runtimeBlockers).toEqual(expect.arrayContaining([
      "PENDING_STATE_REPAIR_CHAPTER_4",
      "LOGIC_AUDITOR_MODEL_NOT_CONFIGURED",
      "COMMERCIAL_READER_MODEL_NOT_CONFIGURED",
    ]));
  });

  it("disables both starts while one job is active", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 39,
      chapters: Array.from({ length: 38 }, (_, index) => ({ number: index + 1, status: "ready-for-review" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      runtime: { status: "RUNNING", mode: "full-book", nextChapter: 39, updatedAt: "2026-08-21T00:00:00.000Z" },
      active: true,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.currentVolume.volumeId).toBe("volume-002");
    expect(view.startEnabled).toBe(false);
    expect(view.runtimeBlockers).toContain("AUTONOMOUS_JOB_ALREADY_RUNNING");
  });

  it("reserves one job synchronously and rejects a double click", () => {
    const jobs = new AutonomousJobRegistry();
    expect(jobs.reserve("book")).toBe(true);
    expect(jobs.reserve("book")).toBe(false);
    expect(jobs.requestStop("book")).toBe(true);
    expect(jobs.shouldStop("book")).toBe(true);
    jobs.release("book");
    expect(jobs.isActive("book")).toBe(false);
  });

  it("classifies persisted repair failures without replacing the real message", () => {
    expect(classifyStateRepairError("Cannot repair chapter 4 safely: baseline snapshot 3 is unavailable")).toBe("STATE_REPAIR_BASELINE_UNAVAILABLE");
    expect(classifyStateRepairError("State repair still failed for chapter 4.")).toBe("STATE_REPAIR_VALIDATION_FAILED");
    expect(classifyStateRepairError("provider rejected request")).toBe("STATE_REPAIR_FAILED");
  });

  it("projects a persisted RUNNING state as resumable PAUSED after Studio restart", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 39,
      chapters: Array.from({ length: 38 }, (_, index) => ({ number: index + 1, status: "ready-for-review" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      runtime: { status: "RUNNING", mode: "full-book", nextChapter: 39, updatedAt: "2026-08-21T00:00:00.000Z" },
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeStatus).toBe("PAUSED");
    expect(view.startEnabled).toBe(true);
    expect(view.runtimeBlockers).not.toContain("COST_GUARD_UNAVAILABLE");
  });

  it("keeps a durable Provider wait non-resumable by the user while automatic recovery owns it", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" : "approved" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: {
        jobId: "autonomous-waiting", status: "WAITING_PROVIDER_RETRY", mode: "current-volume", nextChapter: 5,
        updatedAt: "2026-08-23T00:00:00.000Z", nextRetryAt: "2026-08-23T00:05:00.000Z",
        attempt: 1, maxAttempts: 3, phase: "LOGIC_REVIEW",
      },
      active: true,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeStatus).toBe("WAITING_PROVIDER_RETRY");
    expect(view.startEnabled).toBe(false);
    expect(view.runtimeBlockers).not.toContain("COST_GUARD_UNAVAILABLE");
  });

  it("blocks Start after bounded state rebaseline fails both state validations", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 8,
      chapters: [1, 2, 3, 4, 5, 6, 7].map((number) => ({
        number,
        status: number === 7 ? "audit-failed" : "approved",
      })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: {
        jobId: "autonomous-rebaseline-seven",
        status: "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
        mode: "current-volume",
        nextChapter: 8,
        updatedAt: "2026-08-27T00:00:00.000Z",
        lastError: "STATE_REBASELINE_VALIDATION_FAILED",
        recoveryOwnership: {
          kind: "FORMAL_BOUNDED_STATE_REBASELINE",
          recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED",
          bookId: "book",
          jobId: "autonomous-rebaseline-seven",
          pendingChapterNumber: 7,
        },
      },
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeBlockers).toContain("STATE_REBASELINE_VALIDATION_FAILED");
    expect(view.startEnabled).toBe(false);
  });

  it("projects legacy two-revision exhaustion with a complete rescue artifact as final-review recovery", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" : "approved" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: { jobId: "autonomous-deadbeef", status: "REVIEW_EXHAUSTED", mode: "current-volume", nextChapter: 5, updatedAt: "2026-08-21T00:00:00.000Z", phase: "RESCUE_REVISING_2", responseArtifactStatus: "COMPLETE" },
      offlineFinalizationPlan: {
        kind: "FORMAL_OFFLINE_FINALIZATION", recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED", bookId: "book",
        jobId: "autonomous-deadbeef", pendingChapterNumber: 4, finalReview: { decision: "APPROVED" },
      } as never,
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.runtimeBlockers).not.toContain("REVIEW_EXHAUSTED");
    expect(view.startEnabled).toBe(true);
    expect(view.runtimeStatus).toBe("RECOVERY_READY_OFFLINE_FINALIZATION");
    expect(view.finalReviewRecovery).toEqual({
      recoveryMode: "FORMAL_OFFLINE_FINALIZATION",
      chapter: 4,
      rescueCandidate: "PRESERVED",
      rescueGeneration: "REUSED",
      writerRegeneration: false,
      normalRevisionRegeneration: false,
      rescueRevisionRegeneration: false,
      rescueArtifactIdentity: "VERIFIED_CHAPTER_004",
      finalReview: "PRESERVED",
      finalReviewDecision: "APPROVED",
      nextAction: "FINALIZE_CHAPTER_004_AND_CONTINUE",
      additionalWriterCalls: 0,
      additionalReviserCalls: 0,
      additionalReviewerCalls: 0,
      normalProviderCalls: 0,
      maximumProviderCalls: 0,
      additionalRevisionAllowed: false,
      recoveryClass: "ORIGINAL_REVIEW_EXHAUSTED",
    });
  });

  it("keeps a contradictory review decision fail-closed", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 5,
      chapters: [1, 2, 3, 4].map((number) => ({ number, status: number === 4 ? "audit-failed" : "approved" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: { jobId: "autonomous-contradictory", status: "REVIEW_DECISION_CONTRADICTORY", mode: "current-volume", nextChapter: 5, updatedAt: "2026-08-21T00:00:00.000Z" },
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });
    expect(view.startEnabled).toBe(false);
    expect(view.runtimeBlockers).toContain("REVIEW_DECISION_CONTRADICTORY");
  });

  it("blocks a reviewer contract failure truthfully without projecting revision exhaustion", () => {
    const view = projectAutonomousProductionView({
      map,
      targetChapters: 156,
      nextChapter: 7,
      chapters: [1, 2, 3, 4, 5, 6].map((number) => ({ number, status: "approved" })),
      config: { defaultModel: "gpt", modelOverrides: { auditor: "deepseek", "commercial-reader": "gemini", reviser: "gpt", "observer-reflector": "flash" } },
      catalog,
      runtime: {
        jobId: "autonomous-review-invalid", status: "REVIEW_OUTPUT_INVALID", mode: "current-volume",
        nextChapter: 7, updatedAt: "2026-08-27T00:00:00.000Z", reason: "INVALID_OUTPUT",
        revisionCount: 0, invalidReviewerRole: "commercial-reader",
      },
      active: false,
      budget: AUTONOMOUS_BUDGET_NOT_CONFIGURED,
    });

    expect(view.startEnabled).toBe(false);
    expect(view.runtimeStatus).toBe("REVIEW_OUTPUT_INVALID");
    expect(view.runtimeBlockers).toContain("REVIEW_OUTPUT_INVALID");
    expect(view.runtimeBlockers).not.toContain("REVIEW_EXHAUSTED");
  });
});
