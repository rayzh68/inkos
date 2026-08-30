import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AutonomousProductionCard,
  ATTEMPT_ABANDON_CONFIRMATION,
  autonomousFallbackPollMs,
  formatRetryCountdown,
  type AutonomousView,
} from "./AutonomousProductionPanel.js";

const blockedView: AutonomousView = {
  title: "The House She Built",
  totalChapters: 156,
  completedChapters: 4,
  nextChapter: 5,
  currentVolume: { volumeId: "volume-001", volumeNumber: 1, title: "The Price of Leaving", startChapter: 1, endChapter: 38, chapterCount: 38 },
  currentVolumeCompleted: 4,
  runtimeStatus: "BLOCKED",
  runtime: null,
  roles: { writer: "gpt", logicAuditor: null, commercialReader: null, reviser: "gpt", observerReflector: null },
  revisionPolicy: { normal: 1, rescue: 1, maximum: 2 },
  budget: { status: "BUDGET_NOT_CONFIGURED" },
  economics: {
    actual: { providerCalls: 4, totalTokens: 100, costUsd: null, estimatedCostUsd: null, costStatus: "COST_UNAVAILABLE" },
    currentVolumeForecast: { lowUsd: null, baseUsd: null, highUsd: null, sampleSize: 4, confidence: "LOW" },
    fullBookForecast: { lowUsd: null, baseUsd: null, highUsd: null, sampleSize: 4, confidence: "LOW" },
    currentVolumeActual: { providerCalls: 4, totalTokens: 100, costUsd: null, estimatedCostUsd: null, costStatus: "COST_UNAVAILABLE" },
    byRole: { writer: { providerCalls: 1, promptTokens: 10, completionTokens: 20, totalTokens: 30, actualCostUsd: null } },
    budget: { guardStatus: "COST_UNAVAILABLE", nextCallConservativeUsd: null, allowNextProviderCall: true },
  },
  runtimeBlockers: ["PENDING_STATE_REPAIR_CHAPTER_4", "LOGIC_AUDITOR_MODEL_NOT_CONFIGURED"],
  startEnabled: false,
};

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (!isValidElement(node)) return "";
  return nodeText((node.props as { readonly children?: ReactNode }).children);
}

function findButton(node: ReactNode, label: string): ReactElement<{ readonly onClick?: () => void }> {
  if (!isValidElement(node)) throw new Error(`Button ${label} not found`);
  if (node.type === "button" && nodeText(node) === label) {
    return node as ReactElement<{ readonly onClick?: () => void }>;
  }
  const children = Children.toArray((node.props as { readonly children?: ReactNode }).children);
  for (const child of children) {
    try {
      return findButton(child, label);
    } catch {
      // Keep searching this real component tree.
    }
  }
  throw new Error(`Button ${label} not found`);
}

function clickCardButton(
  view: AutonomousView,
  label: string,
  callbacks: { readonly onStart?: (mode: "current-volume" | "full-book") => void; readonly onStop?: () => void; readonly onAbandon?: () => void },
): void {
  const card = AutonomousProductionCard({
    view,
    pending: false,
    error: null,
    onStart: callbacks.onStart ?? (() => undefined),
    onStop: callbacks.onStop ?? (() => undefined),
    onRepair: () => undefined,
    ...(callbacks.onAbandon ? { onAbandon: callbacks.onAbandon } : {}),
    onConfigureModels: () => undefined,
  });
  findButton(card, label).props.onClick?.();
}

describe("compact autonomous production card", () => {
  it.each([
    ["fresh ordinary start", "READY", null],
    ["READY ordinary resume", "READY", { status: "READY", mode: "current-volume" }],
    ["user-paused ordinary resume", "PAUSED_BY_USER", { status: "PAUSED_BY_USER", mode: "current-volume" }],
    ["new run after old volume completion", "VOLUME_COMPLETE", { status: "VOLUME_COMPLETE", mode: "current-volume" }],
  ] as const)("starts full-book for %s", (_case, runtimeStatus, runtime) => {
    const starts: Array<"current-volume" | "full-book"> = [];
    clickCardButton({
      ...blockedView,
      runtimeStatus,
      runtime: runtime as AutonomousView["runtime"],
      runtimeBlockers: [],
      startEnabled: true,
    }, "Resume", { onStart: (mode) => starts.push(mode) });

    expect(starts).toEqual(["full-book"]);
  });

  it.each([
    ["PAUSED_PROVIDER_UNAVAILABLE", "current-volume"],
    ["PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "full-book"],
    ["PAUSED_DETERMINISTIC_PROVIDER_ERROR", "current-volume"],
    ["PAUSED_PIPELINE_ERROR", "full-book"],
  ] as const)("preserves %s identity with persisted %s mode", (runtimeStatus, mode) => {
    const starts: Array<"current-volume" | "full-book"> = [];
    clickCardButton({
      ...blockedView,
      runtimeStatus,
      runtime: { status: runtimeStatus, mode },
      runtimeBlockers: [],
      startEnabled: true,
    }, "Resume", { onStart: (selected) => starts.push(selected) });

    expect(starts).toEqual([mode]);
  });

  it.each(["current-volume", "full-book"] as const)("preserves %s for formal preserved recovery", (persistedMode) => {
    const starts: Array<"current-volume" | "full-book"> = [];
    clickCardButton({
      ...blockedView,
      runtimeStatus: "RECOVERY_READY_PRESERVED_BOUNDED_REVIEW",
      runtime: { status: "REVIEW_EXHAUSTED", mode: persistedMode },
      runtimeBlockers: [],
      startEnabled: true,
      finalReviewRecovery: {
        recoveryMode: "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME",
        chapter: 5,
        rescueCandidate: "PRESERVED",
        rescueGeneration: "REUSED",
        rescueArtifactIdentity: "VERIFIED_CHAPTER_005",
        finalReview: "RESUME_REQUIRED",
        finalReviewDecision: null,
        writerRegeneration: false,
        normalRevisionRegeneration: false,
        rescueRevisionRegeneration: false,
        nextAction: "RESUME_PRESERVED_REVIEW",
        additionalWriterCalls: 0,
        additionalReviserCalls: 0,
        additionalReviewerCalls: 1,
        additionalRevisionAllowed: false,
      },
    }, "Resume", { onStart: (mode) => starts.push(mode) });

    expect(starts).toEqual([persistedMode]);
  });

  it("keeps Stop and Rewrite bound to their existing handlers", () => {
    let stops = 0;
    let rewrites = 0;
    clickCardButton({
      ...blockedView,
      runtimeStatus: "RUNNING",
      runtimeBlockers: [],
      startEnabled: false,
    }, "Stop", { onStop: () => { stops += 1; } });
    clickCardButton({
      ...blockedView,
      runtimeStatus: "PAUSED_BY_USER",
      runtimeBlockers: [],
      startEnabled: true,
      chapterTransaction: { state: "STAGING", activeTransactionId: "txn-one", canAbandonAttempt: true },
    }, "Rewrite", { onAbandon: () => { rewrites += 1; } });

    expect({ stops, rewrites }).toEqual({ stops: 1, rewrites: 1 });
  });

  it.each([
    ["RUNNING", "Running", "运行中"],
    ["REPAIRING", "Running", "运行中"],
    ["WAITING_PROVIDER_RETRY", "Waiting", "等待中"],
    ["PAUSED_BY_USER", "Paused", "已暂停"],
    ["PAUSED_PROVIDER_UNAVAILABLE", "Paused", "已暂停"],
    ["PAUSED_DETERMINISTIC_PROVIDER_ERROR", "Paused", "已暂停"],
    ["PAUSED_PIPELINE_ERROR", "Paused", "已暂停"],
    ["PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", "Needs Attention", "需要处理"],
    ["VOLUME_COMPLETE", "Volume Complete", "本卷完成"],
    ["BOOK_COMPLETE", "Complete", "已完成"],
    ["READY", "Ready", "就绪"],
    ["READY_TO_REWRITE_SAME_CHAPTER", "Ready", "就绪"],
    ["RECOVERY_READY_OFFLINE_FINALIZATION", "Ready", "就绪"],
  ] as const)("maps %s to locale-exclusive user status", (runtimeStatus, expectedEn, expectedZh) => {
    const render = (language: "en" | "zh") => renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view: { ...blockedView, runtimeStatus, runtimeBlockers: [], startEnabled: true },
      pending: false,
      error: null,
      onStart: () => undefined,
      onStop: () => undefined,
      onRepair: () => undefined,
      onConfigureModels: () => undefined,
      language,
    })).split("<details")[0];

    expect(render("en")).toContain(`>${expectedEn}<`);
    expect(render("zh")).toContain(`>${expectedZh}<`);
  });

  it("shows only the three product roles with compact model families on the main card", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
      runtimeBlockers: [],
      startEnabled: true,
      roles: {
        production: "openai/gpt-5.4",
        review: "deepseek/deepseek-v3",
        reader: "google/gemini-2.5-pro",
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view,
      pending: false,
      error: null,
      onStart: () => undefined,
      onStop: () => undefined,
      onRepair: () => undefined,
      onConfigureModels: () => undefined,
      language: "en",
    }));
    const main = html.split("<details")[0];

    expect(main).toContain("Production");
    expect(main).toContain("Review");
    expect(main).toContain("Reader");
    expect(main).toContain(">GPT<");
    expect(main).toContain(">DeepSeek<");
    expect(main).toContain(">Gemini<");
    expect(main).not.toContain("openai/gpt-5.4");
    expect(main).not.toContain("deepseek/deepseek-v3");
    expect(main).not.toContain("google/gemini-2.5-pro");
    expect(html).toContain("production=openai/gpt-5.4");
    expect(html).toContain("review=deepseek/deepseek-v3");
    expect(html).toContain("reader=google/gemini-2.5-pro");
  });

  it("uses a short collapsed Details entry while retaining raw audit evidence inside", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
      runtimeBlockers: [],
      runtime: {
        status: "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
        phase: "SETTLING_STATE",
        activeRole: "observer-reflector",
        activeProvider: "openrouter",
        activeModel: "deepseek/deepseek-v4-flash-0731",
        attempt: 1,
        logicalStepId: "chapter-005:settlement",
        transportAttemptId: "transport-attempt-one",
        responseArtifactStatus: "PERSISTED",
      },
      economics: {
        ...blockedView.economics,
        currentAttempt: {
          logicalCalls: 1,
          providerTransports: 1,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          tokenDiscrepancy: 0,
          estimatedCostUsd: 0.01,
          actualCostUsd: null,
          unknownLegacyTotal: 0,
        },
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view,
      pending: false,
      error: null,
      onStart: () => undefined,
      onStop: () => undefined,
      onRepair: () => undefined,
      onConfigureModels: () => undefined,
      language: "en",
    }));
    const main = html.split("<details")[0];

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain(">Details</summary>");
    expect(html).not.toContain(">Advanced Details</summary>");
    expect(main).not.toContain("PAUSED_DETERMINISTIC_PROVIDER_ERROR");
    expect(main).not.toContain("SETTLING_STATE");
    expect(main).not.toContain("observer-reflector");
    expect(main).not.toContain("openrouter");
    expect(main).not.toContain("transport-attempt-one");
    expect(main).not.toContain("chapter-005:settlement");
    expect(main).not.toContain("Logical Calls");
    expect(main).not.toContain("Provider Transports");
    expect(main).not.toContain("Tokens");
    expect(html).toContain("PAUSED_DETERMINISTIC_PROVIDER_ERROR");
    expect(html).toContain("SETTLING_STATE");
    expect(html).toContain("observer-reflector");
    expect(html).toContain("openrouter");
    expect(html).toContain("chapter-005:settlement");
    expect(html).toContain("Current logical calls");
    expect(html).toContain("Provider transports");
  });

  it.each(["HELD_AFTER_TWO_REVISIONS", "REVIEW_DECISION_CONTRADICTORY"])("renders terminal review status %s as Error", (runtimeStatus) => {
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view: { ...blockedView, runtimeStatus }, pending: false, error: null,
      onStart: () => undefined, onStop: () => undefined, onRepair: () => undefined,
      onConfigureModels: () => undefined,
    }));
    expect(html.slice(0, html.indexOf("<details"))).toContain("Error");
    expect(html.slice(0, html.indexOf("<details"))).not.toContain(runtimeStatus);
  });

  it.each([["en", "Paused"], ["zh", "已暂停"]] as const)("renders PAUSED_BY_USER in %s", (language, label) => {
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view: { ...blockedView, runtimeStatus: "PAUSED_BY_USER" }, pending: false, error: null,
      onStart: () => undefined, onStop: () => undefined, onRepair: () => undefined,
      onConfigureModels: () => undefined, language,
    }));
    expect(html.slice(0, html.indexOf("<details"))).toContain(label);
    expect(html.slice(0, html.indexOf("<details"))).not.toContain("PAUSED_BY_USER");
  });

  it("shows only operator essentials by default and keeps technical details collapsed", () => {
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view: blockedView,
      pending: false,
      error: null,
      onStart: () => undefined,
      onStop: () => undefined,
      onRepair: () => undefined,
      onConfigureModels: () => undefined,
    }));
    expect(html).toContain("Volume I · Chapters 001–038");
    expect(html).toContain("Current Chapter");
    expect(html).toContain("005");
    expect(html).toContain("4 / 38");
    expect(html).toContain("4 / 156");
    expect(html).toContain("Configure the three production roles before starting.");
    expect(html).toContain(">Configure<");
    expect(html).not.toContain(">Repair<");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("<table");
  });

  it("does not poll READY or BLOCKED pages and uses a 12 second fallback only while active", () => {
    expect(autonomousFallbackPollMs("READY")).toBeNull();
    expect(autonomousFallbackPollMs("BLOCKED")).toBeNull();
    expect(autonomousFallbackPollMs("RUNNING")).toBe(12_000);
    expect(autonomousFallbackPollMs("REPAIRING")).toBe(12_000);
  });

  it("keeps the compact cost surface truthful and shows the bounded repair forecast", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeBlockers: ["PENDING_STATE_REPAIR_CHAPTER_4"],
      economics: {
        ...blockedView.economics,
        historicalRecordedActualUsd: null,
        historicalCalculatedEstimateUsd: 0.42,
        remainingVolumeForecast: { lowUsd: 1, baseUsd: 2, highUsd: 3, sampleSize: 4, confidence: "MEDIUM" },
        currentVolumeEstimatedTotal: { lowUsd: 1.4, baseUsd: 2.4, highUsd: 3.6, sampleSize: 4, confidence: "MEDIUM" },
        fullBookForecast: { lowUsd: 4, baseUsd: 7, highUsd: 12, sampleSize: 4, confidence: "MEDIUM" },
        repairForecast: { lowUsd: 0.05, baseUsd: 0.08, highUsd: 0.16, sampleSize: 1, confidence: "LOW" },
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain("Volume Actual");
    expect(html).toContain("Volume Forecast");
    expect(html.indexOf("Book Forecast")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("Chapter 004 requires state repair");
    expect(html).not.toContain("<table");
  });

  it("keeps state repair available when its dollar forecast is unavailable", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeBlockers: ["PENDING_STATE_REPAIR_CHAPTER_4"],
      economics: {
        ...blockedView.economics,
        repairForecast: { lowUsd: null, baseUsd: null, highUsd: null, sampleSize: 0, confidence: "LOW" },
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain(">Repair<");
    expect(html).not.toMatch(/<button disabled/);
  });

  it("does not offer state repair again after settlement restored an audit-failed chapter", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "READY",
      runtimeBlockers: [],
      startEnabled: true,
      chapterAttention: { chapter: 4, status: "AUDIT_FAILED_STATE_SETTLED" },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain("Chapter 004 will reuse its existing draft");
    expect(html).toContain(">Resume<");
    expect(html).toContain("not configured");
    expect(html).not.toContain("requires state repair");
  });

  it("shows the preserved rescue candidate and final-review-only recovery action", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "RECOVERY_READY_OFFLINE_FINALIZATION",
      runtimeBlockers: [],
      startEnabled: true,
      chapterAttention: { chapter: 4, status: "AUDIT_FAILED_STATE_SETTLED" },
      finalReviewRecovery: {
        chapter: 4,
        rescueCandidate: "PRESERVED",
        rescueGeneration: "REUSED",
        rescueArtifactIdentity: "VERIFIED_CHAPTER_004",
        finalReview: "PRESERVED",
        finalReviewDecision: "PASSED_WITH_NONBLOCKING_FINDINGS",
        writerRegeneration: false,
        normalRevisionRegeneration: false,
        rescueRevisionRegeneration: false,
        nextAction: "FINALIZE_CHAPTER_004_AND_CONTINUE",
        additionalWriterCalls: 0,
        additionalReviserCalls: 0,
        additionalReviewerCalls: 0,
        additionalRevisionAllowed: false,
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain("RECOVERY_READY_OFFLINE_FINALIZATION");
    expect(html.split("<details")[0]).not.toContain("RECOVERY_READY_OFFLINE_FINALIZATION");
    expect(html).toContain("Recovery Ready");
    expect(html).toContain("Pending Chapter 004; preserved evidence will be reused.");
    expect(html).toContain(">Resume<");
  });

  it("shows a local retry countdown and disables Resume while the durable job waits", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "WAITING_PROVIDER_RETRY",
      runtimeBlockers: [],
      startEnabled: false,
      runtime: {
        status: "WAITING_PROVIDER_RETRY",
        phase: "LOGIC_REVIEW",
        activeRole: "auditor",
        activeProvider: "openrouter",
        activeModel: "provider/model",
        nextRetryAt: "2026-08-23T00:05:00.000Z",
        attempt: 1,
        maxAttempts: 3,
        lastHttpStatus: 429,
        responseArtifactStatus: "NONE",
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain("Temporary Provider interruption");
    expect(html).toContain("Next retry");
    expect(html).toMatch(/<button disabled=""/);
    expect(autonomousFallbackPollMs("WAITING_PROVIDER_RETRY")).toBe(12_000);
    expect(formatRetryCountdown("2026-08-23T00:05:00.000Z", Date.parse("2026-08-23T00:00:01.000Z"))).toBe("4m 59s");
  });

  it("warns that an ambiguous Provider outcome may have incurred cost and does not auto-retry", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME",
      runtimeBlockers: [],
      startEnabled: true,
      runtime: { status: "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME", attempt: 1 },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(html).toContain("Provider outcome is uncertain");
    expect(html).toContain("Automatic retry is disabled");
    expect(autonomousFallbackPollMs(view.runtimeStatus)).toBeNull();
  });

  it("uses locale-exclusive compact Rewrite and Resume actions for active STAGING authority", () => {
    const view: AutonomousView = {
      ...blockedView,
      runtimeStatus: "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME",
      runtimeBlockers: [],
      startEnabled: true,
      chapterTransaction: { state: "STAGING", activeTransactionId: "chapter-txn-one", canAbandonAttempt: true },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onAbandon: () => undefined, onConfigureModels: () => undefined, language: "en",
    }));
    expect(html).toContain(">Rewrite<");
    expect(html).toContain(">Resume<");
    expect(html).not.toMatch(/[\u3400-\u9fff]/u);
    expect(html.split("<details")[0]).not.toContain("PAUSED_AMBIGUOUS_PROVIDER_OUTCOME");
    expect(ATTEMPT_ABANDON_CONFIRMATION.en).toContain("preserved as history");

    const zhHtml = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onAbandon: () => undefined, onConfigureModels: () => undefined, language: "zh",
    }));
    expect(zhHtml).toContain(">重写<");
    expect(zhHtml).toContain(">继续<");
    expect(zhHtml).not.toContain(">Rewrite<");
    expect(zhHtml).not.toContain(">Resume<");
    expect(zhHtml.split("<details")[0]).not.toContain("PAUSED_AMBIGUOUS_PROVIDER_OUTCOME");

    const readyHtml = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view: { ...view, chapterTransaction: { state: "NOT_STARTED", canAbandonAttempt: false } },
      pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onAbandon: () => undefined, onConfigureModels: () => undefined,
    }));
    expect(readyHtml).not.toContain(">Rewrite<");
  });

  it("keeps logical calls and Provider transports separate inside Details", () => {
    const view: AutonomousView = {
      ...blockedView,
      economics: {
        ...blockedView.economics,
        currentAttempt: {
          logicalCalls: 1,
          providerTransports: 3,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          tokenDiscrepancy: 0,
          estimatedCostUsd: 0.01,
          actualCostUsd: null,
          unknownLegacyTotal: 0,
        },
      },
    };
    const html = renderToStaticMarkup(createElement(AutonomousProductionCard, {
      view, pending: false, error: null, onStart: () => undefined, onStop: () => undefined,
      onRepair: () => undefined, onConfigureModels: () => undefined,
    }));

    const main = html.split("<details")[0];
    expect(main).not.toContain("Logical Calls");
    expect(main).not.toContain("Provider Transports");
    expect(html).toContain("Current logical calls");
    expect(html).toContain("Provider transports");
    expect(html).not.toContain("Current Attempt Calls");
  });
});
