import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { StateValidationAuthorityContext, ValidationDisposition, ValidationResult, StateValidatorAgent } from "../agents/state-validator.js";
import type { TokenUsage, WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildStateDegradedIssues,
  buildStateDegradedPersistenceOutput,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";
import type { SemanticAuthorityEnvelope } from "../agents/semantic-authority.js";

function isAutonomousStageAdmissionDenial(error: unknown): boolean {
  return error instanceof Error && error.message === "AUTONOMOUS_STAGE_ADMISSION_STOPPED";
}

export async function validateChapterTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly authorityContext?: StateValidationAuthorityContext;
  readonly authorityEnvelope?: SemanticAuthorityEnvelope;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: LengthLanguage;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
  readonly semanticRecovery?: {
    readonly allowSemanticRetry?: boolean;
    readonly onSemanticRetry?: () => Promise<void> | void;
    readonly onSettlementExtractorRetry?: () => Promise<void> | void;
    readonly onSettlementValidatorRetry?: () => Promise<void> | void;
  };
  readonly settlementRetryBudget?: { remaining: 0 | 1 };
}): Promise<{
  readonly validation: ValidationResult;
  readonly repairDisposition: ValidationDisposition;
  readonly chapterStatus: "state-degraded" | null;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
  readonly stateUsage: {
    readonly extractor: TokenUsage;
    readonly validator: TokenUsage;
  };
}> {
  const zeroUsage = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const addUsage = (left: TokenUsage, right: TokenUsage | undefined): TokenUsage => {
    if (!right) return left;
    const leftHasUsage = left.promptTokens > 0 || left.completionTokens > 0 || left.totalTokens > 0;
    const actualCostUsd = right.actualCostUsd !== undefined && (!leftHasUsage || left.actualCostUsd !== undefined)
      ? (left.actualCostUsd ?? 0) + right.actualCostUsd
      : undefined;
    return {
      promptTokens: left.promptTokens + right.promptTokens,
      completionTokens: left.completionTokens + right.completionTokens,
      totalTokens: left.totalTokens + right.totalTokens,
      ...(actualCostUsd !== undefined ? { actualCostUsd } : {}),
    };
  };
  let extractorUsage = addUsage(zeroUsage(), params.persistenceOutput.tokenUsage);
  let validatorUsage = zeroUsage();
  let validation: ValidationResult;
  let chapterStatus: "state-degraded" | null = null;
  let degradedIssues: ReadonlyArray<AuditIssue> = [];
  let persistenceOutput = params.persistenceOutput;
  let auditResult = params.auditResult;

  try {
    const validationArgs = [
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
      params.semanticRecovery,
      {
        oldLedger: params.previousTruth.oldLedger,
        newLedger: persistenceOutput.updatedLedger,
      },
      persistenceOutput.candidateFactEvidence,
    ] as const;
    validation = params.authorityEnvelope
      ? await params.validator.validate(...validationArgs, params.authorityEnvelope)
      : await params.validator.validate(...validationArgs);
    validatorUsage = addUsage(validatorUsage, validation.tokenUsage);
  } catch (error) {
    if (isAutonomousStageAdmissionDenial(error)) throw error;
    params.logger?.warn(`State validation error for chapter ${params.chapterNumber}: ${String(error)}`);
    const errorDescription = params.language === "en"
      ? `State validation unavailable: ${String(error)}`
      : `状态校验不可用：${String(error)}`;
    const errorIssue: AuditIssue = {
      severity: "warning",
      category: "state-validation",
      description: errorDescription,
      suggestion: params.language === "en"
        ? "Repair chapter state from the persisted body before continuing."
        : "请先基于已保存正文修复本章 state，再继续后续章节。",
    };
    return {
      validation: { passed: true, warnings: [] },
      repairDisposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      chapterStatus: "state-degraded",
      degradedIssues: [errorIssue],
      persistenceOutput: buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      }),
      auditResult: {
        ...params.auditResult,
        issues: [...params.auditResult.issues, errorIssue],
      },
      stateUsage: { extractor: extractorUsage, validator: validatorUsage },
    };
  }

  let repairDisposition: ValidationDisposition = validation.disposition
    ?? "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (repairDisposition === "CONTENT_REPAIR_REQUIRED"
    || repairDisposition === "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED") {
    return {
      validation,
      repairDisposition,
      chapterStatus,
      degradedIssues,
      persistenceOutput,
      auditResult,
      stateUsage: { extractor: extractorUsage, validator: validatorUsage },
    };
  }

  if (repairDisposition === "STATE_REPAIR_REQUIRED") {
    if (params.settlementRetryBudget?.remaining === 0) {
      const issues = buildStateDegradedIssues(validation.warnings, params.language);
      return {
        validation,
        repairDisposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
        chapterStatus: "state-degraded",
        degradedIssues: issues,
        persistenceOutput: buildStateDegradedPersistenceOutput({
          output: persistenceOutput,
          oldState: params.previousTruth.oldState,
          oldHooks: params.previousTruth.oldHooks,
          oldLedger: params.previousTruth.oldLedger,
        }),
        auditResult: {
          ...auditResult,
          issues: [...auditResult.issues, ...issues],
        },
        stateUsage: { extractor: extractorUsage, validator: validatorUsage },
      };
    }
    if (params.settlementRetryBudget) params.settlementRetryBudget.remaining = 0;
    const recovery = await retrySettlementAfterValidationFailure({
      writer: params.writer,
      validator: params.validator,
      book: params.book,
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      reducedControlInput: params.reducedControlInput,
      oldState: params.previousTruth.oldState,
      oldHooks: params.previousTruth.oldHooks,
      oldLedger: params.previousTruth.oldLedger,
      originalValidation: validation,
      authorityContext: params.authorityContext,
      candidateFactEvidence: persistenceOutput.candidateFactEvidence,
      authorityEnvelope: params.authorityEnvelope,
      language: params.language,
      logWarn: params.logWarn,
      logger: params.logger,
      onExtractorRetry: params.semanticRecovery?.onSettlementExtractorRetry,
      onValidatorRetry: params.semanticRecovery?.onSettlementValidatorRetry,
    });

    if (recovery.kind === "recovered" || recovery.kind === "content-repair-required") {
      extractorUsage = addUsage(extractorUsage, recovery.output.tokenUsage);
      validatorUsage = addUsage(validatorUsage, recovery.validation.tokenUsage);
      persistenceOutput = recovery.output;
      validation = recovery.validation;
      repairDisposition = recovery.validation.disposition ?? "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";
    } else {
      repairDisposition = "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";
      chapterStatus = "state-degraded";
      degradedIssues = recovery.issues;
      persistenceOutput = buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      });
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, ...recovery.issues],
      };
    }
  }

  return {
    validation,
    repairDisposition,
    chapterStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
    stateUsage: { extractor: extractorUsage, validator: validatorUsage },
  };
}
