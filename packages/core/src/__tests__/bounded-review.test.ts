import { describe, expect, it, vi } from "vitest";
import * as boundedReviewModule from "../pipeline/bounded-review.js";
import { classifyFinalAuditDecision, runBoundedReviewCycle, scoredLogicReviewFromAudit, type BoundedReviewResult, type ScoredReview } from "../pipeline/bounded-review.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

const TEST_LENGTH_SPEC = {
  target: 1,
  softMin: 1,
  softMax: 100,
  hardMin: 1,
  hardMax: 100,
  countingMode: "en_words" as const,
};

function englishWords(count: number, word = "word"): string {
  return Array.from({ length: count }, () => word).join(" ");
}

function review(role: "logic-canon-auditor" | "commercial-reader", score: number, severity?: "CRITICAL" | "MAJOR" | "MINOR" | "NOTE"): ScoredReview {
  return {
    reviewerRole: role,
    provider: role === "logic-canon-auditor" ? "deepseek" : "google",
    model: role === "logic-canon-auditor" ? "deepseek-chat" : "gemini-flash",
    totalScore: score,
    dimensionScores: { one: score, two: score },
    decision: score >= 85 && !severity ? "APPROVED" : "REVISION_REQUIRED",
    findings: severity ? [{
      findingId: `${role}-1`, severity, evidence: "synthetic", impact: "synthetic", requiredOutcome: "fix",
      ...(role === "logic-canon-auditor" && (severity === "CRITICAL" || severity === "MAJOR")
        ? { repairScope: "structural" as const }
        : {}),
    }] : [],
    reviewedCandidateSha: "bound-by-runner",
    reviewedAt: "2026-08-21T00:00:00.000Z",
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function invalidReview(role: "logic-canon-auditor" | "commercial-reader"): ScoredReview {
  return {
    ...review(role, 0, "CRITICAL"),
    decision: "INVALID_OUTPUT",
  };
}

function repairableLogicHold(
  repairScope: "local" | "structural" | "unknown" | undefined,
  overrides: { readonly evidence?: string; readonly requiredOutcome?: string } = {},
): ScoredReview {
  const finding = {
    findingId: "logic-authority-1",
    severity: "CRITICAL" as const,
    evidence: overrides.evidence ?? "The current prose contradicts the supplied committed authority.",
    impact: "canon authority",
    requiredOutcome: overrides.requiredOutcome ?? "Rewrite the scene so it follows the supplied committed authority.",
    ...(repairScope ? { repairScope } : {}),
  };
  return {
    ...review("logic-canon-auditor", 40),
    decision: "HELD",
    findings: [finding],
    authorityBlocker: true,
  };
}

function groundedReaderHold(
  severity: "CRITICAL" | "MAJOR" = "MAJOR",
  overrides: {
    readonly evidence?: string;
    readonly requiredOutcome?: string;
    readonly authorityBlocker?: boolean;
  } = {},
): ScoredReview {
  return {
    ...review("commercial-reader", 40),
    decision: "HELD",
    findings: [{
      findingId: "reader-grounded-1",
      severity,
      evidence: overrides.evidence ?? "The midpoint stalls after the reveal.",
      impact: "pacing and emotional investment",
      requiredOutcome: overrides.requiredOutcome ?? "Make the reveal trigger an immediate irreversible choice.",
    }],
    ...(overrides.authorityBlocker ? { authorityBlocker: true } : {}),
  };
}

describe("bounded autonomous chapter review", () => {
  it("requires all seven logic dimensions without promoting a structural warning to MAJOR", () => {
    const valid = scoredLogicReviewFromAudit({
      passed: false,
      overallScore: 10,
      dimensionScores: {
        blueprint_transition: 82,
        causal_logic: 82,
        canon_continuity: 82,
        character_motivation: 82,
        state_inheritance: 82,
        hooks_disclosure: 82,
        narrative_clarity: 82,
      },
      issues: [{ severity: "warning", category: "logic", description: "synthetic", suggestion: "fix", repairScope: "structural" }],
      summary: "review",
    }, { candidateSha: "sha", provider: "deepseek", model: "deepseek-chat" });
    expect(valid.totalScore).toBe(82);
    expect(valid.findings[0]?.severity).toBe("MINOR");
    expect(valid.findings[0]).toMatchObject({ repairScope: "structural" });
    const incomplete = scoredLogicReviewFromAudit({
      passed: true,
      overallScore: 95,
      dimensionScores: { causal_logic: 95 },
      issues: [],
      summary: "incomplete",
    }, { candidateSha: "sha", provider: "deepseek", model: "deepseek-chat" });
    expect(incomplete.decision).toBe("INVALID_OUTPUT");
  });

  it.each([
    ["blocking=true", { severity: "warning" as const, blocking: true }, "CRITICAL"],
    ["explicit CRITICAL", { severity: "info" as const, explicitSeverity: "CRITICAL" as const }, "CRITICAL"],
    ["explicit MAJOR", { severity: "warning" as const, explicitSeverity: "MAJOR" as const }, "MAJOR"],
  ])("preserves the formal %s signal as a repairable scored blocker", async (_case, signal, expectedSeverity) => {
    const scored = scoredLogicReviewFromAudit({
      passed: false,
      overallScore: 92,
      dimensionScores: {
        blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92,
        state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92,
      },
      issues: [{
        ...signal,
        category: "canon source",
        description: "The prose contradicts proven committed authority.",
        suggestion: "Repair the prose against the committed authority.",
        repairScope: "structural",
      }],
      summary: "formal blocker",
    }, { candidateSha: "sha", provider: "test", model: "logic" });

    expect(scored.findings[0]).toMatchObject({
      severity: expectedSeverity,
      repairScope: "structural",
    });
    expect(scored.decision).toBe("REVISION_REQUIRED");
    const revise = vi.fn().mockResolvedValue({ content: "repaired candidate" });
    const result = await runBoundedReviewCycle({
      initialContent: "candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn()
        .mockResolvedValueOnce(scored)
        .mockResolvedValueOnce(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });
    expect(result).toMatchObject({ status: "APPROVED", revisionCount: 1 });
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unknown", "unknown" as const],
    ["missing", undefined],
  ])("fails closed when a scorer-path formal blocker has %s repair scope", async (_case, repairScope) => {
    const scored = scoredLogicReviewFromAudit({
      passed: false,
      overallScore: 92,
      dimensionScores: {
        blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92,
        state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92,
      },
      issues: [{
        severity: "warning", blocking: true, category: "canon source",
        description: "The authority basis cannot be proved.", suggestion: "Do not infer a repair.",
        ...(repairScope ? { repairScope } : {}),
      }],
      summary: "unproved formal blocker",
    }, { candidateSha: "sha", provider: "test", model: "logic" });
    const revise = vi.fn();

    const result = await runBoundedReviewCycle({
      initialContent: "candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(scored),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });
    expect(result).toMatchObject({
      status: "BLOCKED_CRITICAL_FINDINGS", revisionCount: 0, holdReason: "AUTHORITY_BLOCKER",
    });
    expect(revise).not.toHaveBeenCalled();
  });

  it("fails closed on passed=false with a high score but no formal blocking evidence", async () => {
    const scored = scoredLogicReviewFromAudit({
      passed: false,
      overallScore: 92,
      dimensionScores: {
        blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92,
        state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92,
      },
      issues: [{
        severity: "warning", category: "narrative_clarity", description: "Nonblocking note.",
        suggestion: "Track later.", repairScope: "local",
      }],
      summary: "passed=false contradicts the otherwise nonblocking evidence",
    }, { candidateSha: "sha", provider: "test", model: "logic" });
    const revise = vi.fn();

    expect(scored.decision).not.toBe("APPROVED_WITH_NOTES");
    const result = await runBoundedReviewCycle({
      initialContent: "candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(scored),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });
    expect(result).toMatchObject({ status: "BLOCKED_CRITICAL_FINDINGS", revisionCount: 0 });
    expect(revise).not.toHaveBeenCalled();
  });

  it("accepts a passed final review with score 92 and only nonblocking warning/info findings", () => {
    const result = classifyFinalAuditDecision({
      passed: true,
      overallScore: 92,
      dimensionScores: {
        blueprint_transition: 95,
        causal_logic: 90,
        canon_continuity: 92,
        character_motivation: 95,
        state_inheritance: 95,
        hooks_disclosure: 95,
        narrative_clarity: 93,
      },
      issues: [
        { severity: "warning", category: "causal_logic", description: "synthetic", suggestion: "defer", repairScope: "structural" },
        { severity: "info", category: "canon_continuity", description: "synthetic", suggestion: "track", repairScope: "local" },
      ],
      summary: "passed with findings",
    });
    expect(result).toBe("ACCEPTED_WITH_FINDINGS");
  });

  it("distinguishes explicit blockers, contradictory passes, and hard-dimension failures", () => {
    const dimensions = {
      blueprint_transition: 95,
      causal_logic: 90,
      canon_continuity: 92,
      character_motivation: 95,
      state_inheritance: 95,
      hooks_disclosure: 95,
      narrative_clarity: 93,
    };
    expect(classifyFinalAuditDecision({
      passed: false, overallScore: 70, dimensionScores: dimensions,
      issues: [{ severity: "warning", explicitSeverity: "MAJOR", category: "logic", description: "synthetic", suggestion: "fix" }], summary: "fail",
    })).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(classifyFinalAuditDecision({
      passed: false, overallScore: 70, dimensionScores: dimensions,
      issues: [{ severity: "warning", blocking: true, category: "logic", description: "synthetic", suggestion: "fix" }], summary: "fail",
    })).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(classifyFinalAuditDecision({
      passed: true, overallScore: 92, dimensionScores: dimensions,
      issues: [{ severity: "warning", blocking: true, category: "logic", description: "synthetic", suggestion: "fix" }], summary: "contradiction",
    })).toBe("REVIEW_DECISION_CONTRADICTORY");
    expect(classifyFinalAuditDecision({
      passed: false, overallScore: 88, dimensionScores: { ...dimensions, causal_logic: 79 }, issues: [], summary: "hard fail",
    })).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(classifyFinalAuditDecision({
      passed: true, overallScore: 92, dimensionScores: { ...dimensions, structural_integrity: 79 }, issues: [], summary: "contradictory structural pass",
    })).toBe("REVIEW_DECISION_CONTRADICTORY");
  });

  it("accepts A/B candidates without revision", async () => {
    const revise = vi.fn();
    const stages: string[] = [];
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 86)),
      revise,
      onStage: async (stage) => { stages.push(stage); },
    });
    expect(result.status).toBe("APPROVED");
    expect(result.grade).toBe("B");
    expect(result.revisionCount).toBe(0);
    expect(revise).not.toHaveBeenCalled();
    expect(stages).toEqual(["LOGIC_REVIEW", "READER_REVIEW"]);
  });

  it("consumes the next unused revision slot for a post-state content finding and binds two fresh reviews", async () => {
    const initial = await runBoundedReviewCycle({
      initialContent: "candidate before state validation",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 86)),
      revise: vi.fn(),
    });
    const revise = vi.fn().mockResolvedValue({ content: "candidate after content repair" });
    const reviewLogic = vi.fn().mockResolvedValue(review("logic-canon-auditor", 92));
    const reviewCommercial = vi.fn().mockResolvedValue(review("commercial-reader", 86));

    const result = await runBoundedReviewCycle({
      initialContent: initial.finalContent,
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic,
      reviewCommercial,
      revise,
      priorResult: initial,
      requiredContentRepairFinding: {
        findingId: "state-validator-content-1",
        severity: "CRITICAL",
        evidence: "current prose evidence: candidate fact",
        impact: "committed authority evidence: committed fact",
        requiredOutcome: "restore convergence with committed authority",
      },
    } as Parameters<typeof runBoundedReviewCycle>[0] & {
      priorResult: BoundedReviewResult;
      requiredContentRepairFinding: {
        findingId: string; severity: "CRITICAL"; evidence: string; impact: string; requiredOutcome: string;
      };
    });

    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith(initial.finalContent, [expect.objectContaining({
      findingId: "state-validator-content-1",
    })], 1);
    expect(result.revisionCount).toBe(1);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1"]);
    expect(result.bestCandidate.reviews).toHaveLength(2);
    expect(result.bestCandidate.reviews.every((item) => item.reviewedCandidateSha === result.bestCandidate.sha256)).toBe(true);
    expect(reviewLogic).toHaveBeenCalledWith("candidate after content repair", result.bestCandidate.sha256);
    expect(reviewCommercial).toHaveBeenCalledWith("candidate after content repair", result.bestCandidate.sha256);
  });

  it("fails closed without a third prose revision when post-state content repair finds revision two exhausted", async () => {
    const content = "revision two candidate";
    const candidate = {
      label: "REVISION_2" as const,
      content,
      sha256: "b".repeat(64),
      reviews: [review("logic-canon-auditor", 92), review("commercial-reader", 86)],
      combinedScore: 178,
      lengthCount: 3,
      lengthInHardRange: true,
    };
    const priorResult: BoundedReviewResult = {
      status: "APPROVED", grade: "B", finalContent: content, revisionCount: 2,
      candidates: [candidate], bestCandidate: candidate, usageByRole: {},
    };
    const revise = vi.fn();
    const reviewLogic = vi.fn().mockResolvedValue(review("logic-canon-auditor", 92));
    const reviewCommercial = vi.fn().mockResolvedValue(review("commercial-reader", 86));

    const result = await runBoundedReviewCycle({
      initialContent: content,
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic,
      reviewCommercial,
      revise,
      priorResult,
      requiredContentRepairFinding: {
        findingId: "state-validator-content-1", severity: "CRITICAL",
        evidence: "candidate fact", impact: "committed fact", requiredOutcome: "repair",
      },
    } as Parameters<typeof runBoundedReviewCycle>[0] & {
      priorResult: BoundedReviewResult;
      requiredContentRepairFinding: {
        findingId: string; severity: "CRITICAL"; evidence: string; impact: string; requiredOutcome: string;
      };
    });

    expect(result).toMatchObject({
      status: "HELD_AFTER_TWO_REVISIONS",
      revisionCount: 2,
      holdReason: "REVISION_LIMIT_REACHED",
    });
    expect(revise).not.toHaveBeenCalled();
    expect(reviewLogic).not.toHaveBeenCalled();
    expect(reviewCommercial).not.toHaveBeenCalled();
  });

  it("retries one commercial semantic contract failure on the same candidate without revising prose", async () => {
    const commercial = vi.fn()
      .mockResolvedValueOnce(invalidReview("commercial-reader"))
      .mockResolvedValueOnce(review("commercial-reader", 86));
    const revise = vi.fn();
    const stages: Array<{ stage: string; semanticRetry?: 1 }> = [];

    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: commercial,
      revise,
      onStage: async (stage, detail) => { stages.push({ stage, ...detail }); },
    });

    expect(result.status).toBe("APPROVED");
    expect(result.revisionCount).toBe(0);
    expect(commercial).toHaveBeenCalledTimes(2);
    expect(commercial.mock.calls[0]?.[1]).toBe(commercial.mock.calls[1]?.[1]);
    expect(revise).not.toHaveBeenCalled();
    expect(result.usageByRole["commercial-reader"]).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    expect(stages).toEqual([
      { stage: "LOGIC_REVIEW" },
      { stage: "READER_REVIEW" },
      { stage: "READER_REVIEW", semanticRetry: 1 },
    ]);
  });

  it("retries one logic semantic contract failure without invoking the Reviser", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(invalidReview("logic-canon-auditor"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 92));
    const revise = vi.fn();

    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 86)),
      revise,
    });

    expect(result.status).toBe("APPROVED");
    expect(result.revisionCount).toBe(0);
    expect(logic).toHaveBeenCalledTimes(2);
    expect(revise).not.toHaveBeenCalled();
  });

  it("fails closed truthfully when the same reviewer returns INVALID_OUTPUT twice", async () => {
    const commercial = vi.fn().mockResolvedValue(invalidReview("commercial-reader"));
    const revise = vi.fn();

    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: commercial,
      revise,
    });

    expect(result.status).toBe("REVIEW_OUTPUT_INVALID");
    expect(result.revisionCount).toBe(0);
    expect(result.holdReason).toBe("INVALID_OUTPUT");
    expect(result.invalidReviewerRole).toBe("commercial-reader");
    expect(commercial).toHaveBeenCalledTimes(2);
    expect(revise).not.toHaveBeenCalled();
  });

  it("runs one normal and one rescue revision, then reports true revision exhaustion without a third", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(review("logic-canon-auditor", 72, "MAJOR"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 78, "MAJOR"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 81, "MAJOR"));
    const commercial = vi.fn().mockResolvedValue(review("commercial-reader", 90));
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "revision one", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
      .mockResolvedValueOnce({ content: "revision two", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const result = await runBoundedReviewCycle({ initialContent: "draft", lengthSpec: TEST_LENGTH_SPEC, reviewLogic: logic, reviewCommercial: commercial, revise });
    expect(result.status).toBe("HELD_AFTER_TWO_REVISIONS");
    expect(result.revisionCount).toBe(2);
    expect(result.holdReason).toBe("REVISION_LIMIT_REACHED");
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1", "REVISION_2"]);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(logic).toHaveBeenCalledTimes(3);
    expect(commercial).toHaveBeenCalledTimes(3);
  });

  it("accepts only noncritical findings after the final rescue review without a third revision", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(review("logic-canon-auditor", 72, "MINOR"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 78, "MINOR"))
      .mockResolvedValueOnce({ ...review("logic-canon-auditor", 81, "MINOR"), decision: "APPROVED_WITH_NOTES" });
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "revision one" })
      .mockResolvedValueOnce({ content: "revision two" });
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });
    expect(result.status).toBe("ACCEPTED_WITH_FINDINGS");
    expect(result.finalContent).toBe("revision two");
    expect(result.revisionCount).toBe(2);
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it("re-reviews both roles when both supplied findings", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(review("logic-canon-auditor", 80, "MAJOR"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 92));
    const commercial = vi.fn()
      .mockResolvedValueOnce(review("commercial-reader", 80, "MINOR"))
      .mockResolvedValueOnce(review("commercial-reader", 90));
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise: vi.fn().mockResolvedValue({ content: "fixed", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    });
    expect(result.status).toBe("APPROVED");
    expect(result.revisionCount).toBe(1);
    expect(logic).toHaveBeenCalledTimes(2);
    expect(commercial).toHaveBeenCalledTimes(2);
  });

  it("holds authority blockers without revision", async () => {
    const revise = vi.fn();
    const unproved = review("logic-canon-auditor", 40, "CRITICAL");
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue({
        ...unproved,
        decision: "HELD",
        authorityBlocker: true,
        findings: unproved.findings.map(({ repairScope: _repairScope, ...finding }) => finding),
      }),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });
    expect(result.status).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(result.holdReason).toBe("AUTHORITY_BLOCKER");
    expect(revise).not.toHaveBeenCalled();
  });

  it("uses REVISION_1 for an INITIAL Logic authority hold whose blocking evidence is typed repairable", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(repairableLogicHold("structural"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 92));
    const commercial = vi.fn().mockResolvedValue(review("commercial-reader", 90));
    const revise = vi.fn().mockResolvedValue({ content: "revision one" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({ status: "APPROVED", revisionCount: 1 });
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith("initial candidate", [expect.objectContaining({
      repairScope: "structural",
      evidence: expect.stringContaining("current prose"),
      requiredOutcome: expect.stringContaining("committed authority"),
    })], 1);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1"]);
    expect(new Set(result.candidates.map((candidate) => candidate.sha256)).size).toBe(2);
    expect(result.bestCandidate.reviews.every((item) => item.reviewedCandidateSha === result.bestCandidate.sha256)).toBe(true);
  });

  it("uses the remaining REVISION_2 slot for a repairable Logic hold after REVISION_1 and binds fresh reviews", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(repairableLogicHold("local"))
      .mockResolvedValueOnce(repairableLogicHold("structural"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 92));
    const commercial = vi.fn().mockResolvedValue(review("commercial-reader", 90));
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "revision one" })
      .mockResolvedValueOnce({ content: "revision two" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({ status: "APPROVED", revisionCount: 2 });
    expect(revise).toHaveBeenCalledTimes(2);
    expect(logic).toHaveBeenCalledTimes(3);
    expect(commercial).toHaveBeenCalledTimes(3);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1", "REVISION_2"]);
    expect(new Set(result.candidates.map((candidate) => candidate.sha256)).size).toBe(3);
    for (const candidate of result.candidates) {
      expect(candidate.reviews).toHaveLength(2);
      expect(candidate.reviews.every((item) => item.reviewedCandidateSha === candidate.sha256)).toBe(true);
    }
  });

  it("fails closed after exactly two repairable Logic holds without admitting REVISION_3", async () => {
    const logic = vi.fn().mockResolvedValue(repairableLogicHold("structural"));
    const commercial = vi.fn().mockResolvedValue(review("commercial-reader", 90));
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "revision one" })
      .mockResolvedValueOnce({ content: "revision two" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({
      status: "HELD_AFTER_TWO_REVISIONS",
      revisionCount: 2,
      holdReason: "REVISION_LIMIT_REACHED",
    });
    expect(revise).toHaveBeenCalledTimes(2);
    expect(logic).toHaveBeenCalledTimes(3);
    expect(commercial).toHaveBeenCalledTimes(3);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1", "REVISION_2"]);
  });

  it.each([
    ["unknown", repairableLogicHold("unknown")],
    ["missing", repairableLogicHold(undefined)],
    ["empty evidence", repairableLogicHold("structural", { evidence: "" })],
    ["empty required outcome", repairableLogicHold("local", { requiredOutcome: "" })],
    ["mixed repairability", {
      ...repairableLogicHold("structural"),
      findings: [
        ...repairableLogicHold("structural").findings,
        ...repairableLogicHold("unknown").findings.map((finding) => ({ ...finding, findingId: "logic-authority-2" })),
      ],
    }],
  ])("fails closed for %s Logic authority evidence without invoking Reviser", async (_case, heldReview) => {
    const revise = vi.fn();
    const result = await runBoundedReviewCycle({
      initialContent: "candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(heldReview),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });

    expect(result).toMatchObject({
      status: "BLOCKED_CRITICAL_FINDINGS",
      revisionCount: 0,
      holdReason: "AUTHORITY_BLOCKER",
    });
    expect(revise).not.toHaveBeenCalled();
  });

  it("uses REVISION_1 for an INITIAL grounded Commercial Reader HELD and freshly reviews the new SHA", async () => {
    const logic = vi.fn().mockResolvedValue(review("logic-canon-auditor", 92));
    const commercial = vi.fn()
      .mockResolvedValueOnce(groundedReaderHold("CRITICAL"))
      .mockResolvedValueOnce(review("commercial-reader", 90));
    const revise = vi.fn().mockResolvedValue({ content: "reader revision one" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({ status: "APPROVED", revisionCount: 1 });
    expect(revise).toHaveBeenCalledWith("initial candidate", [expect.objectContaining({
      findingId: "reader-grounded-1",
      severity: "CRITICAL",
      evidence: expect.stringContaining("midpoint stalls"),
      requiredOutcome: expect.stringContaining("irreversible choice"),
    })], 1);
    expect(logic).toHaveBeenCalledTimes(2);
    expect(commercial).toHaveBeenCalledTimes(2);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1"]);
    expect(new Set(result.candidates.map((candidate) => candidate.sha256)).size).toBe(2);
    for (const candidate of result.candidates) {
      expect(candidate.reviews).toHaveLength(2);
      expect(candidate.reviews.every((item) => item.reviewedCandidateSha === candidate.sha256)).toBe(true);
    }
  });

  it("uses REVISION_2 for a second grounded Reader HELD and freshly reviews the rescue SHA", async () => {
    const logic = vi.fn().mockResolvedValue(review("logic-canon-auditor", 92));
    const commercial = vi.fn()
      .mockResolvedValueOnce(groundedReaderHold("MAJOR"))
      .mockResolvedValueOnce(groundedReaderHold("CRITICAL"))
      .mockResolvedValueOnce(review("commercial-reader", 90));
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "reader revision one" })
      .mockResolvedValueOnce({ content: "reader revision two" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({ status: "APPROVED", revisionCount: 2 });
    expect(revise).toHaveBeenCalledTimes(2);
    expect(revise.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(logic).toHaveBeenCalledTimes(3);
    expect(commercial).toHaveBeenCalledTimes(3);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1", "REVISION_2"]);
    expect(new Set(result.candidates.map((candidate) => candidate.sha256)).size).toBe(3);
    for (const candidate of result.candidates) {
      expect(candidate.reviews.every((item) => item.reviewedCandidateSha === candidate.sha256)).toBe(true);
    }
  });

  it("fails closed after REVISION_2 remains grounded Reader HELD without admitting REVISION_3", async () => {
    const logic = vi.fn().mockResolvedValue(review("logic-canon-auditor", 92));
    const commercial = vi.fn().mockResolvedValue(groundedReaderHold("MAJOR"));
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: "reader revision one" })
      .mockResolvedValueOnce({ content: "reader revision two" });

    const result = await runBoundedReviewCycle({
      initialContent: "initial candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise,
    });

    expect(result).toMatchObject({
      status: "HELD_AFTER_TWO_REVISIONS",
      revisionCount: 2,
      holdReason: "REVISION_LIMIT_REACHED",
    });
    expect(revise).toHaveBeenCalledTimes(2);
    expect(logic).toHaveBeenCalledTimes(3);
    expect(commercial).toHaveBeenCalledTimes(3);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(["INITIAL", "REVISION_1", "REVISION_2"]);
  });

  it.each([
    ["empty evidence", groundedReaderHold("CRITICAL", { evidence: "   " })],
    ["empty required outcome", groundedReaderHold("MAJOR", { requiredOutcome: "\t" })],
    ["no CRITICAL or MAJOR blocker", {
      ...groundedReaderHold(),
      findings: [{
        findingId: "reader-note-1", severity: "MINOR" as const, evidence: "A sentence repeats.",
        impact: "flow", requiredOutcome: "Remove the repetition.",
      }],
    }],
    ["authority blocker", groundedReaderHold("CRITICAL", { authorityBlocker: true })],
  ])("fails closed for Reader HELD with %s without invoking Reviser", async (_case, heldReview) => {
    const revise = vi.fn();
    const result = await runBoundedReviewCycle({
      initialContent: "candidate",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(heldReview),
      revise,
    });

    expect(result).toMatchObject({
      status: "BLOCKED_CRITICAL_FINDINGS",
      revisionCount: 0,
      holdReason: "AUTHORITY_BLOCKER",
    });
    expect(revise).not.toHaveBeenCalled();
  });

  it("does not approve a high-scoring review that explicitly says HELD", async () => {
    const revise = vi.fn();
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: vi.fn().mockResolvedValue({ ...review("logic-canon-auditor", 92), decision: "HELD" }),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });

    expect(result.status).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(revise).not.toHaveBeenCalled();
  });

  it("binds both terminal reviews to the exact revised candidate SHA", async () => {
    const logic = vi.fn()
      .mockResolvedValueOnce(review("logic-canon-auditor", 72, "MAJOR"))
      .mockResolvedValueOnce(review("logic-canon-auditor", 92));
    const commercial = vi.fn().mockResolvedValue(review("commercial-reader", 90));
    const result = await runBoundedReviewCycle({
      initialContent: "draft",
      lengthSpec: TEST_LENGTH_SPEC,
      reviewLogic: logic,
      reviewCommercial: commercial,
      revise: vi.fn().mockResolvedValue({ content: "revised candidate" }),
    });

    expect(result.status).toBe("APPROVED");
    expect(result.bestCandidate.label).toBe("REVISION_1");
    expect(result.bestCandidate.reviews.every((candidateReview) =>
      candidateReview.reviewedCandidateSha === result.bestCandidate.sha256)).toBe(true);
    expect(commercial).toHaveBeenCalledTimes(2);
  });

  it("approves an initially valid 2200-word English candidate", async () => {
    const result = await runBoundedReviewCycle({
      initialContent: englishWords(2200, "initial"),
      lengthSpec: buildLengthSpec(2200, "en"),
      reviewLogic: vi.fn().mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise: vi.fn(),
    });

    expect(result.status).toBe("APPROVED");
    expect(result.bestCandidate).toMatchObject({ label: "INITIAL", lengthCount: 2200, lengthInHardRange: true });
  });

  it("keeps a viable in-range candidate ahead of an approved 700-word revision", async () => {
    const result = await runBoundedReviewCycle({
      initialContent: englishWords(2200, "initial"),
      lengthSpec: buildLengthSpec(2200, "en"),
      reviewLogic: vi.fn()
        .mockResolvedValueOnce({ ...review("logic-canon-auditor", 81, "MINOR"), decision: "APPROVED_WITH_NOTES" })
        .mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise: vi.fn().mockResolvedValue({ content: englishWords(700, "short") }),
    });

    expect(result.status).toBe("ACCEPTED_WITH_FINDINGS");
    expect(result.candidates.find((candidate) => candidate.label === "REVISION_1")).toMatchObject({
      lengthCount: 700,
      lengthInHardRange: false,
    });
    expect(result.bestCandidate).toMatchObject({ label: "INITIAL", lengthCount: 2200, lengthInHardRange: true });
  });

  it("approves revision two when a short first revision is repaired into hard range", async () => {
    const revise = vi.fn()
      .mockResolvedValueOnce({ content: englishWords(700, "short") })
      .mockResolvedValueOnce({ content: englishWords(1900, "recovered") });
    const result = await runBoundedReviewCycle({
      initialContent: englishWords(2200, "initial"),
      lengthSpec: buildLengthSpec(2200, "en"),
      reviewLogic: vi.fn()
        .mockResolvedValueOnce(review("logic-canon-auditor", 72, "MAJOR"))
        .mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise,
    });

    expect(result.status).toBe("APPROVED");
    expect(result.revisionCount).toBe(2);
    expect(result.bestCandidate).toMatchObject({ label: "REVISION_2", lengthCount: 1900, lengthInHardRange: true });
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it("fails closed when both bounded revisions remain below hard minimum", async () => {
    const result = await runBoundedReviewCycle({
      initialContent: englishWords(2200, "initial"),
      lengthSpec: buildLengthSpec(2200, "en"),
      reviewLogic: vi.fn()
        .mockResolvedValueOnce(review("logic-canon-auditor", 72, "MAJOR"))
        .mockResolvedValue(review("logic-canon-auditor", 92)),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise: vi.fn()
        .mockResolvedValueOnce({ content: englishWords(700, "short") })
        .mockResolvedValueOnce({ content: englishWords(900, "stillshort") }),
    });

    expect(result.status).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(result.holdReason).toBe("LENGTH_BUDGET_VIOLATION");
    expect(result.candidates.map((candidate) => candidate.lengthCount)).toEqual([2200, 700, 900]);
  });

  it("does not accept a 1500-word candidate with only nonblocking findings", async () => {
    const result = await runBoundedReviewCycle({
      initialContent: englishWords(1500, "initial"),
      lengthSpec: buildLengthSpec(2200, "en"),
      reviewLogic: vi.fn().mockResolvedValue({
        ...review("logic-canon-auditor", 81, "MINOR"),
        decision: "APPROVED_WITH_NOTES",
      }),
      reviewCommercial: vi.fn().mockResolvedValue(review("commercial-reader", 90)),
      revise: vi.fn().mockResolvedValue({ content: englishWords(1500, "short") }),
    });

    expect(result.status).toBe("BLOCKED_CRITICAL_FINDINGS");
    expect(result.holdReason).toBe("LENGTH_BUDGET_VIOLATION");
  });

  it("rejects a synthetic terminal result whose final count is outside the hard range", () => {
    const finalContent = englishWords(702, "short");
    const candidate = {
      label: "REVISION_2" as const,
      content: finalContent,
      sha256: "a".repeat(64),
      reviews: [],
      combinedScore: 190,
      lengthCount: 702,
      lengthInHardRange: false,
    };
    const result: BoundedReviewResult = {
      status: "APPROVED", grade: "A", finalContent, revisionCount: 2,
      candidates: [candidate], bestCandidate: candidate, usageByRole: {},
    };
    const assertTerminalLength = (boundedReviewModule as unknown as {
      assertBoundedReviewTerminalLength: (
        result: BoundedReviewResult,
        finalCount: number,
        lengthSpec: ReturnType<typeof buildLengthSpec>,
      ) => void;
    }).assertBoundedReviewTerminalLength;

    expect(() => assertTerminalLength(result, 702, buildLengthSpec(2200, "en")))
      .toThrow("BOUNDED_AUTONOMOUS_LENGTH_BUDGET_VIOLATION");
  });
});
