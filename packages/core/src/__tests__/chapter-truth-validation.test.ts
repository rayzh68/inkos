import { describe, expect, it, vi } from "vitest";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ValidationResult } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import { validateChapterTruthPersistence } from "../pipeline/chapter-truth-validation.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createValidationResult(overrides?: Partial<ValidationResult>): ValidationResult {
  const passed = overrides?.passed ?? true;
  return {
    passed,
    warnings: [],
    disposition: overrides?.disposition ?? (passed ? "PASS" : "STATE_REPAIR_REQUIRED"),
    repairRequired: overrides?.repairRequired ?? !passed,
    ...overrides,
  };
}

function createWriterOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return {
    chapterNumber: 1,
    title: "Test Chapter",
    content: "Healthy chapter body with the copper token in his coat.",
    wordCount: "Healthy chapter body with the copper token in his coat.".length,
    preWriteCheck: "check",
    postSettlement: "settled",
    updatedState: "writer state",
    updatedLedger: "writer ledger",
    updatedHooks: "writer hooks",
    chapterSummary: "| 1 | Original summary |",
    updatedSubplots: "writer subplots",
    updatedEmotionalArcs: "writer emotions",
    updatedCharacterMatrix: "writer matrix",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

const BOOK: BookConfig = {
  id: "book-1",
  title: "Book",
  platform: "other",
  genre: "xuanhuan",
  status: "active",
  targetChapters: 10,
  chapterWordCount: 2000,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("validateChapterTruthPersistence", () => {
  it("preserves verified actual cost for one extractor and one validator call", async () => {
    const validate = vi.fn().mockResolvedValue(createValidationResult({
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, actualCostUsd: 0.02 },
    }));
    const result = await validateChapterTruthPersistence({
      writer: { settleChapterState: vi.fn() },
      validator: { validate },
      book: BOOK, bookDir: "/tmp/book", chapterNumber: 2, title: "Known costs", content: "Body.",
      persistenceOutput: createWriterOutput({
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, actualCostUsd: 0.01 },
      }),
      auditResult: createAuditResult(),
      previousTruth: { oldState: "old", oldHooks: "old hooks", oldLedger: "old ledger" },
      language: "en", logWarn: vi.fn(),
    });
    expect(result.stateUsage).toEqual({
      extractor: { promptTokens: 1, completionTokens: 2, totalTokens: 3, actualCostUsd: 0.01 },
      validator: { promptTokens: 3, completionTokens: 4, totalTokens: 7, actualCostUsd: 0.02 },
    });
    expect(validate).toHaveBeenCalledWith(
      "Body.", 2, "old", "writer state", "old hooks", "writer hooks", "en", undefined, undefined,
      { oldLedger: "old ledger", newLedger: "writer ledger" },
    );
  });

  it("retries settlement when the validator requests repair without a hard contradiction", async () => {
    const onSettlementExtractorRetry = vi.fn();
    const onSettlementValidatorRetry = vi.fn();
    const validator = {
      validate: vi.fn()
        .mockResolvedValueOnce(createValidationResult({
          passed: false,
          repairRequired: true,
          warnings: [{ category: "missing_state_update", description: "位置尚未更新。" }],
          tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, actualCostUsd: 0.01 },
        }))
        .mockResolvedValueOnce(createValidationResult({ tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 } })),
    };
    const writer = {
      settleChapterState: vi.fn().mockResolvedValue(createWriterOutput({
        updatedState: "码头",
        tokenUsage: { promptTokens: 6, completionTokens: 7, totalTokens: 13, actualCostUsd: 0.02 },
      })),
    };

    const result = await validateChapterTruthPersistence({
      writer,
      validator,
      book: BOOK,
      bookDir: "/tmp/book",
      chapterNumber: 2,
      title: "抵达码头",
      content: "林舟抵达码头。",
      persistenceOutput: createWriterOutput({
        updatedState: "车站",
        tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5, actualCostUsd: 0.01 },
      }),
      auditResult: createAuditResult(),
      previousTruth: { oldState: "车站", oldHooks: "hooks", oldLedger: "ledger" },
      language: "zh",
      logWarn: vi.fn(),
      semanticRecovery: { onSettlementExtractorRetry, onSettlementValidatorRetry },
    });

    expect(writer.settleChapterState).toHaveBeenCalledTimes(1);
    expect(result.chapterStatus).toBeNull();
    expect(result.persistenceOutput.updatedState).toBe("码头");
    expect(onSettlementExtractorRetry).toHaveBeenCalledTimes(1);
    expect(onSettlementValidatorRetry).toHaveBeenCalledTimes(1);
    expect(result.stateUsage.extractor).toMatchObject({ promptTokens: 8, completionTokens: 10, totalTokens: 18, actualCostUsd: 0.03 });
    expect(result.stateUsage.validator).toMatchObject({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    expect(result.stateUsage.validator.actualCostUsd).toBeUndefined();
  });

  it("routes a proven prose-authority contradiction to content repair without touching stale settlement", async () => {
    const writer = { settleChapterState: vi.fn() };
    const validation = createValidationResult({
      passed: false,
      repairRequired: false,
      disposition: "CONTENT_REPAIR_REQUIRED",
      warnings: [{ category: "ongoing_authority_contradiction", description: "candidate conflicts with committed authority" }],
      proseAuthorityEvidence: {
        status: "PROVEN",
        currentProse: ["candidate fact"],
        committedAuthority: ["committed fact"],
      },
    });

    const result = await validateChapterTruthPersistence({
      writer,
      validator: { validate: vi.fn().mockResolvedValue(validation) },
      book: BOOK, bookDir: "/tmp/book", chapterNumber: 8, title: "Conflict", content: "candidate fact",
      persistenceOutput: createWriterOutput({ updatedState: "stale settlement" }),
      auditResult: createAuditResult(),
      previousTruth: { oldState: "committed fact", oldHooks: "old hooks", oldLedger: "old ledger" },
      authorityContext: { chapterSummaries: "committed fact" },
      language: "en", logWarn: vi.fn(),
    });

    expect(result.repairDisposition).toBe("CONTENT_REPAIR_REQUIRED");
    expect(result.validation).toBe(validation);
    expect(writer.settleChapterState).not.toHaveBeenCalled();
  });

  it("propagates content repair when the settlement retry revalidation discovers a prose contradiction", async () => {
    const retryValidation = createValidationResult({
      passed: false,
      disposition: "CONTENT_REPAIR_REQUIRED",
      warnings: [{ category: "ongoing_authority_contradiction", description: "candidate conflicts with committed authority" }],
      proseAuthorityEvidence: {
        status: "PROVEN",
        currentProse: ["candidate fact"],
        committedAuthority: ["committed fact"],
      },
      tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
    });
    const validator = {
      validate: vi.fn()
        .mockResolvedValueOnce(createValidationResult({
          passed: false,
          disposition: "STATE_REPAIR_REQUIRED",
          repairRequired: true,
          warnings: [{ category: "missing_state_update", description: "settlement omission" }],
          tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        }))
        .mockResolvedValueOnce(retryValidation),
    };
    const retryOutput = createWriterOutput({
      updatedState: "retried state",
      updatedLedger: "retried ledger",
      tokenUsage: { promptTokens: 6, completionTokens: 7, totalTokens: 13 },
    });

    const result = await validateChapterTruthPersistence({
      writer: { settleChapterState: vi.fn().mockResolvedValue(retryOutput) },
      validator,
      book: BOOK, bookDir: "/tmp/book", chapterNumber: 8, title: "Conflict", content: "candidate fact",
      persistenceOutput: createWriterOutput({ updatedState: "stale state" }),
      auditResult: createAuditResult(),
      previousTruth: { oldState: "committed fact", oldHooks: "old hooks", oldLedger: "old ledger" },
      authorityContext: { chapterSummaries: "committed fact" },
      language: "en", logWarn: vi.fn(),
    });

    expect(result).toMatchObject({
      repairDisposition: "CONTENT_REPAIR_REQUIRED",
      chapterStatus: null,
      validation: retryValidation,
      persistenceOutput: retryOutput,
      stateUsage: {
        extractor: { promptTokens: 6, completionTokens: 7, totalTokens: 13 },
        validator: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      },
    });
  });

  it("uses recovered settlement output when retry succeeds", async () => {
    const validator = {
      validate: vi.fn()
        .mockResolvedValueOnce(createValidationResult({
          passed: false,
          warnings: [{
            category: "unsupported_change",
            description: "正文写铜牌在怀里，但 state 说未携带。",
          }],
        }))
        .mockResolvedValueOnce(createValidationResult()),
    };
    const writer = {
      settleChapterState: vi.fn().mockResolvedValue(
        createWriterOutput({
          updatedState: "fixed state",
          updatedHooks: "fixed hooks",
          updatedLedger: "fixed ledger",
        }),
      ),
    };
    const logWarn = vi.fn();
    const logger = { warn: vi.fn() };

    const result = await validateChapterTruthPersistence({
      writer,
      validator,
      book: BOOK,
      bookDir: "/tmp/book",
      chapterNumber: 3,
      title: "Test Chapter",
      content: "Healthy chapter body with the copper token in his coat.",
      persistenceOutput: createWriterOutput({
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
      auditResult: createAuditResult(),
      previousTruth: {
        oldState: "stable state",
        oldHooks: "stable hooks",
        oldLedger: "stable ledger",
      },
      language: "zh",
      logWarn,
      logger,
    });

    expect(writer.settleChapterState).toHaveBeenCalledTimes(1);
    expect(writer.settleChapterState).toHaveBeenCalledWith(expect.objectContaining({
      chapterNumber: 3,
      title: "Test Chapter",
      validationFeedback: expect.stringContaining("铜牌在怀里"),
    }));
    expect(result.chapterStatus).toBeNull();
    expect(result.persistenceOutput.updatedState).toBe("fixed state");
    expect(result.persistenceOutput.updatedHooks).toBe("fixed hooks");
    expect(result.auditResult.issues).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("  [unsupported_change] 正文写铜牌在怀里，但 state 说未携带。");
  });

  it("degrades gracefully when validator throws (e.g. LLM returned empty response)", async () => {
    const validator = {
      validate: vi.fn().mockRejectedValue(new Error("LLM returned empty response")),
    };
    const writer = {
      settleChapterState: vi.fn(),
    };
    const logWarn = vi.fn();
    const logger = { warn: vi.fn() };

    const result = await validateChapterTruthPersistence({
      writer,
      validator,
      book: BOOK,
      bookDir: "/tmp/book",
      chapterNumber: 1,
      title: "Test Chapter",
      content: "Chapter content.",
      persistenceOutput: createWriterOutput({
        updatedState: "new state",
        updatedHooks: "new hooks",
        updatedLedger: "new ledger",
      }),
      auditResult: createAuditResult(),
      previousTruth: {
        oldState: "old state",
        oldHooks: "old hooks",
        oldLedger: "old ledger",
      },
      language: "zh",
      logWarn,
      logger,
    });

    expect(result.chapterStatus).toBe("state-degraded");
    expect(result.persistenceOutput.updatedState).toBe("old state");
    expect(result.persistenceOutput.updatedHooks).toBe("old hooks");
    expect(result.persistenceOutput.updatedLedger).toBe("old ledger");
    expect(result.degradedIssues).toEqual([
      expect.objectContaining({
        severity: "warning",
        category: "state-validation",
      }),
    ]);
    // Should NOT have attempted settlement retry
    expect(writer.settleChapterState).not.toHaveBeenCalled();
  });

  it("degrades persistence output and appends audit issues when retry still fails", async () => {
    const validator = {
      validate: vi.fn()
        .mockResolvedValueOnce(createValidationResult({
          passed: false,
          warnings: [{
            category: "unsupported_change",
            description: "第一次校验失败。",
          }],
        }))
        .mockResolvedValueOnce(createValidationResult({
          passed: false,
          warnings: [{
            category: "unsupported_change",
            description: "重试后仍然失败。",
          }],
        })),
    };
    const writer = {
      settleChapterState: vi.fn().mockResolvedValue(
        createWriterOutput({
          updatedState: "still broken state",
          updatedHooks: "still broken hooks",
          updatedLedger: "still broken ledger",
        }),
      ),
    };
    const baseIssue: AuditIssue = {
      severity: "warning",
      category: "title-dedup",
      description: "title adjusted",
      suggestion: "check title",
    };

    const result = await validateChapterTruthPersistence({
      writer,
      validator,
      book: BOOK,
      bookDir: "/tmp/book",
      chapterNumber: 4,
      title: "Test Chapter",
      content: "Healthy chapter body with the copper token in his coat.",
      persistenceOutput: createWriterOutput({
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
      auditResult: createAuditResult({ issues: [baseIssue] }),
      previousTruth: {
        oldState: "stable state",
        oldHooks: "stable hooks",
        oldLedger: "stable ledger",
      },
      language: "zh",
      logWarn: vi.fn(),
      logger: { warn: vi.fn() },
    });

    expect(result.chapterStatus).toBe("state-degraded");
    expect(result.degradedIssues).toEqual([
      expect.objectContaining({
        severity: "warning",
        category: "state-validation",
        description: "重试后仍然失败。",
      }),
    ]);
    expect(result.persistenceOutput.updatedState).toBe("stable state");
    expect(result.persistenceOutput.updatedHooks).toBe("stable hooks");
    expect(result.persistenceOutput.updatedLedger).toBe("stable ledger");
    expect(result.auditResult.issues).toEqual([
      baseIssue,
      expect.objectContaining({
        category: "state-validation",
        description: "重试后仍然失败。",
      }),
    ]);
  });
});
