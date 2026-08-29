import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { StateValidationAuthorityContext, ValidationResult, StateValidatorAgent } from "../agents/state-validator.js";
import type { TokenUsage, WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildStateDegradedPersistenceOutput,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";

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
}): Promise<{
  readonly validation: ValidationResult;
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
    validation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
      params.semanticRecovery,
    );
    validatorUsage = addUsage(validatorUsage, validation.tokenUsage);
  } catch (error) {
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

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (!validation.passed || validation.repairRequired) {
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
      originalValidation: validation,
      language: params.language,
      logWarn: params.logWarn,
      logger: params.logger,
      onExtractorRetry: params.semanticRecovery?.onSettlementExtractorRetry,
      onValidatorRetry: params.semanticRecovery?.onSettlementValidatorRetry,
    });

    if (recovery.kind === "recovered") {
      extractorUsage = addUsage(extractorUsage, recovery.output.tokenUsage);
      validatorUsage = addUsage(validatorUsage, recovery.validation.tokenUsage);
      persistenceOutput = recovery.output;
      validation = recovery.validation;
    } else {
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
    chapterStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
    stateUsage: { extractor: extractorUsage, validator: validatorUsage },
  };
}
