import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { ConfirmDialog } from "./ConfirmDialog";

interface Forecast { readonly lowUsd: number | null; readonly baseUsd: number | null; readonly highUsd: number | null; readonly sampleSize: number; readonly confidence: string }
interface Actual { readonly providerCalls: number; readonly totalTokens: number; readonly costUsd: number | null; readonly estimatedCostUsd?: number | null; readonly costStatus: string }
type AutonomousProductionMode = "current-volume" | "full-book";
export interface AutonomousView {
  readonly title: string; readonly totalChapters: number; readonly completedChapters: number; readonly nextChapter: number;
  readonly currentVolume: { readonly volumeId: string; readonly volumeNumber: number; readonly title: string; readonly startChapter: number; readonly endChapter: number; readonly chapterCount: number };
  readonly currentVolumeCompleted: number; readonly runtimeStatus: string;
  readonly runtime?: { readonly status?: string; readonly mode?: AutonomousProductionMode; readonly lastError?: string; readonly phase?: string; readonly activeRole?: string; readonly activeProvider?: string | null; readonly activeModel?: string | null; readonly updatedAt?: string; readonly nextRetryAt?: string; readonly attempt?: number; readonly maxAttempts?: number; readonly retryAfterMs?: number; readonly lastHttpStatus?: number; readonly lastErrorClassification?: string; readonly logicalStepId?: string; readonly transportAttemptId?: string; readonly providerAttemptHistory?: ReadonlyArray<{ readonly transportAttemptId: string; readonly transportStarted: boolean; readonly classification: string }>; readonly responseArtifactStatus?: string; readonly revisionRound?: number; readonly repairOutcome?: { readonly chapter: number; readonly status: string; readonly errorCode: string | null; readonly reservedCostUpperUsd?: number } } | null;
  readonly roles: Record<string, string | null>; readonly revisionPolicy: { readonly normal: number; readonly rescue: number; readonly maximum: number };
  readonly rolePricing?: Readonly<Record<string, { readonly modelId: string; readonly status: string; readonly inputUsdPerToken: number | null; readonly outputUsdPerToken: number | null; readonly pricingUnit: string; readonly contextWindow: number | null; readonly maxOutputTokens: number | null }>>;
  readonly budget: { readonly status: "BUDGET_NOT_CONFIGURED" };
  readonly economics: { readonly actual: Actual; readonly currentAttempt?: { readonly logicalCalls: number; readonly providerTransports: number; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly tokenDiscrepancy: number; readonly estimatedCostUsd: number | null; readonly actualCostUsd: number | null; readonly unknownLegacyTotal: number; readonly integrityWarnings?: ReadonlyArray<string> }; readonly historicalBook?: Actual; readonly currentVolumeForecast: Forecast; readonly remainingVolumeForecast?: Forecast; readonly currentVolumeEstimatedTotal?: Forecast; readonly fullBookForecast: Forecast; readonly repairForecast?: Forecast; readonly historicalRecordedActualUsd?: number | null; readonly historicalCalculatedEstimateUsd?: number | null; readonly currentVolumeActual: Actual; readonly byRole: Readonly<Record<string, { readonly providerCalls: number; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number; readonly actualCostUsd: number | null }>>; readonly budget?: { readonly guardStatus: string; readonly nextCallConservativeUsd: number | null; readonly allowNextProviderCall: boolean } };
  readonly repairOutcome?: { readonly chapter: number; readonly status: string; readonly errorCode: string | null; readonly reservedCostUpperUsd?: number };
  readonly chapterAttention?: { readonly chapter: number; readonly status: "AUDIT_FAILED_STATE_SETTLED" };
  readonly finalReviewRecovery?: { readonly recoveryMode?: "FORMAL_OFFLINE_FINALIZATION" | "FORMAL_BOUNDED_STATE_REBASELINE" | "FORMAL_PRESERVED_BOUNDED_REVIEW_RESUME"; readonly chapter: number; readonly rescueCandidate: "PRESERVED"; readonly rescueGeneration: "REUSED"; readonly rescueArtifactIdentity: string; readonly finalReview: "PRESERVED" | "RESUME_REQUIRED"; readonly finalReviewDecision: "APPROVED" | "ACCEPTED_WITH_FINDINGS" | "PASSED_WITH_NONBLOCKING_FINDINGS" | null; readonly existingValidReviewers?: readonly string[]; readonly invalidReviewerRoles?: readonly string[]; readonly writerRegeneration: false; readonly normalRevisionRegeneration: false; readonly rescueRevisionRegeneration: false; readonly nextAction: string; readonly additionalWriterCalls: 0 | 2; readonly additionalReviserCalls: 0 | 2; readonly additionalReviewerCalls: number; readonly normalProviderCalls?: number; readonly maximumProviderCalls?: number; readonly additionalRevisionAllowed: boolean; readonly recoveryClass?: "ORIGINAL_REVIEW_EXHAUSTED" | "FAILED_REENTRY" | "PRESERVED_BOUNDED_REVIEW" };
  readonly legacyDrafts?: ReadonlyArray<{ readonly chapter: number; readonly status: "LEGACY_DRAFT_PRESERVED" }>;
  readonly chapterTransaction?: { readonly state: "NOT_STARTED" | "STAGING" | "COMMITTED"; readonly activeTransactionId?: string; readonly canAbandonAttempt: boolean } | null;
  readonly runtimeBlockers: ReadonlyArray<string>; readonly startEnabled: boolean;
}

export const ATTEMPT_ABANDON_CONFIRMATION = {
  en: "The current staged attempt will be preserved as history and will never be committed. The same chapter will restart from Writer only after you separately start Autonomous Production. Prior Provider cost cannot be recovered.",
  zh: "当前暂存尝试将作为历史证据保留且永不提交。之后需单独启动自动生产，才会从写作阶段重写同一章；已产生的模型费用无法追回。",
} as const;

const romans = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const ch = (n: number) => String(n).padStart(3, "0");
const money = (n: number | null | undefined) => n == null ? "Unavailable" : `$${n.toFixed(2)}`;
const forecastRange = (value: Forecast) => value.lowUsd == null || value.highUsd == null ? "Unavailable" : `${money(value.lowUsd)}–${money(value.highUsd)}`;
const humanBlocker = (code: string) => ({
  LOGIC_AUDITOR_MODEL_NOT_CONFIGURED: "Logic Auditor model is not configured.",
  COMMERCIAL_READER_MODEL_NOT_CONFIGURED: "Commercial Reader model is not configured.",
  OBSERVER_REFLECTOR_MODEL_NOT_CONFIGURED: "Observer / Reflector model is not configured.",
  COST_GUARD_UNAVAILABLE: "Verified cost data is unavailable; production remains safely paused.",
}[code] ?? code);

export function autonomousFallbackPollMs(status: string): number | null { return status === "RUNNING" || status === "REPAIRING" || status === "WAITING_PROVIDER_RETRY" ? 12_000 : null; }
export function formatRetryCountdown(nextRetryAt: string | undefined, now = Date.now()): string {
  if (!nextRetryAt) return "Unavailable";
  const remaining = Math.max(0, Date.parse(nextRetryAt) - now);
  const seconds = Math.ceil(remaining / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const IDENTITY_BOUND_RECOVERY_STATUSES = new Set([
  "WAITING_PROVIDER_RETRY",
  "PAUSED_PROVIDER_UNAVAILABLE",
  "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME",
  "PAUSED_DETERMINISTIC_PROVIDER_ERROR",
  "PAUSED_PIPELINE_ERROR",
]);

export function resolveAutonomousStartMode(view: AutonomousView): AutonomousProductionMode {
  const persistedMode = view.runtime?.mode;
  if (persistedMode && (view.finalReviewRecovery || IDENTITY_BOUND_RECOVERY_STATUSES.has(view.runtimeStatus))) {
    return persistedMode;
  }
  return "full-book";
}

function presentRuntimeStatus(status: string, tr: (en: string, zh: string) => string): string {
  if (status === "RUNNING" || status === "REPAIRING") return tr("Running", "运行中");
  if (status === "WAITING_PROVIDER_RETRY") return tr("Waiting", "等待中");
  if (status === "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME") return tr("Needs Attention", "需要处理");
  if (status === "BOOK_COMPLETE") return tr("Complete", "已完成");
  if (status === "VOLUME_COMPLETE") return tr("Volume Complete", "本卷完成");
  if (status === "PAUSED"
    || status === "PAUSED_BY_USER"
    || status === "PAUSED_PROVIDER_UNAVAILABLE"
    || status === "PAUSED_DETERMINISTIC_PROVIDER_ERROR"
    || status === "PAUSED_PIPELINE_ERROR"
    || status === "STOP_REQUESTED_AFTER_CURRENT_CHAPTER") return tr("Paused", "已暂停");
  if (status === "READY" || status === "READY_TO_REWRITE_SAME_CHAPTER" || status.startsWith("RECOVERY_READY_")) return tr("Ready", "就绪");
  return tr("Error", "错误");
}

function presentProductModel(model: string | null | undefined, tr: (en: string, zh: string) => string): string {
  if (!model) return tr("Not configured", "未配置");
  const normalized = model.toLocaleLowerCase();
  if (normalized.includes("deepseek")) return "DeepSeek";
  if (normalized.includes("gemini")) return "Gemini";
  if (normalized.includes("gpt") || normalized.includes("openai")) return "GPT";
  return tr("Custom", "自定义");
}

export function AutonomousProductionCard({ view, pending, error, onStart, onStop, onRepair, onAbandon, onConfigureModels, language = "en" }: {
  readonly view: AutonomousView; readonly pending: boolean; readonly error: string | null;
  readonly onStart: (mode: "current-volume" | "full-book") => void; readonly onStop: () => void; readonly onRepair: (chapter: number) => void; readonly onAbandon?: () => void; readonly onConfigureModels: () => void; readonly language?: "en" | "zh";
}) {
  const v = view.currentVolume;
  const repair = view.runtimeBlockers.map((b) => /^PENDING_STATE_REPAIR_CHAPTER_(\d+)$/.exec(b)).find(Boolean);
  const missingModels = view.runtimeBlockers.some((b) => b.endsWith("MODEL_NOT_CONFIGURED"));
  const repairNeedsReconciliation = view.runtimeBlockers.includes("STATE_REPAIR_RECONCILIATION_REQUIRED");
  const active = view.runtimeStatus === "RUNNING" || view.runtimeStatus === "REPAIRING" || view.runtimeStatus === "WAITING_PROVIDER_RETRY";
  const waiting = view.runtimeStatus === "WAITING_PROVIDER_RETRY";
  const ambiguous = view.runtimeStatus === "PAUSED_AMBIGUOUS_PROVIDER_OUTCOME";
  const progress = Math.min(100, Math.round((view.completedChapters / view.totalChapters) * 100));
  const tr = (en: string, zh: string) => language === "zh" ? zh : en;
  const localizedMoney = (value: number | null | undefined) => value == null ? tr("Unavailable", "不可用") : money(value);
  const localizedForecast = (forecast: Forecast) => forecast.lowUsd == null || forecast.highUsd == null
    ? tr("Unavailable", "不可用")
    : forecastRange(forecast);
  const status = presentRuntimeStatus(view.runtimeStatus, tr);
  const productRoles = [
    [tr("Production", "生产"), presentProductModel(view.roles.production, tr)],
    [tr("Review", "审核"), presentProductModel(view.roles.review, tr)],
    [tr("Reader", "读者"), presentProductModel(view.roles.reader, tr)],
  ] as const;
  return <section data-testid="autonomous-production" className="paper-sheet rounded-2xl border border-primary/20 p-5 shadow-sm space-y-4">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">{tr("Autonomous Production", "自动生产")}</h2><p className="text-sm text-muted-foreground">{tr("Volume", "卷")} {romans[v.volumeNumber] ?? v.volumeNumber} · {tr("Chapters", "章节")} {ch(v.startChapter)}–{ch(v.endChapter)}</p></div><span className="rounded-full border px-3 py-1 text-xs font-bold">{status}</span></div>
    <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3"><div><span className="text-muted-foreground">{tr("Current Chapter", "当前章节")}</span><div className="font-semibold">{ch(view.nextChapter)}</div></div><div><span className="text-muted-foreground">{tr("Volume Progress", "本卷进度")}</span><div className="font-semibold">{view.currentVolumeCompleted} / {v.chapterCount}</div></div><div><span className="text-muted-foreground">{tr("Book Progress", "全书进度")}</span><div className="font-semibold">{view.completedChapters} / {view.totalChapters}</div></div></div>
    <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary" style={{width:`${progress}%`}} /></div>
    <div className="grid grid-cols-3 gap-3 text-sm">{productRoles.map(([role,model]) => <div key={role}><span className="text-muted-foreground">{role}</span><div className="font-semibold">{model}</div></div>)}</div>
    <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4"><div><span className="text-muted-foreground">{tr("Volume Actual", "本卷实际")}</span><div className="font-semibold">{localizedMoney(view.economics.currentVolumeActual.costUsd)}</div></div><div><span className="text-muted-foreground">{tr("Volume Forecast", "本卷预测")}</span><div className="font-semibold">{localizedForecast(view.economics.currentVolumeEstimatedTotal ?? view.economics.currentVolumeForecast)}</div></div><div><span className="text-muted-foreground">{tr("Book Actual", "全书实际")}</span><div className="font-semibold">{localizedMoney(view.economics.actual.costUsd)}</div></div><div><span className="text-muted-foreground">{tr("Book Forecast", "全书预测")}</span><div className="font-semibold">{localizedForecast(view.economics.fullBookForecast)}</div></div></div>
    <p className="text-xs text-muted-foreground">{tr("Budget not configured; cost telemetry does not block production.", "未配置预算；费用遥测不会阻止生产。")}</p>
    {waiting && <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p className="font-semibold">{tr("Temporary Provider interruption", "模型服务暂时中断")}</p><p className="mt-1 text-xs text-muted-foreground">{tr("Next retry in", "下次重试倒计时")} {formatRetryCountdown(view.runtime?.nextRetryAt)}</p></div>}
    {ambiguous && <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm"><p className="font-semibold">{tr("Provider outcome is uncertain", "模型服务结果不确定")}</p><p className="mt-1 text-xs text-muted-foreground">{tr("Automatic retry is disabled. Check Provider records before resuming.", "已禁止自动重试。继续前请检查模型服务记录。")}</p></div>}
    {repairNeedsReconciliation ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{tr("A previous state repair requires reconciliation.", "先前的状态修复需要核对。")}</div>
      : missingModels ? <div className="rounded-xl border p-3 text-sm"><p>{tr("Configure the three production roles before starting.", "开始前请配置三个生产角色。")}</p><button onClick={onConfigureModels} className="mt-3 h-9 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground">{tr("Configure", "配置")}</button></div>
        : repair ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p>{tr(`Chapter ${ch(Number(repair[1]))} requires state repair.`, `第 ${ch(Number(repair[1]))} 章需要修复状态。`)}</p><button disabled={pending || active} onClick={() => onRepair(Number(repair[1]))} className="mt-3 h-9 rounded-lg bg-amber-600 px-4 text-sm font-bold text-white disabled:opacity-40">{tr("Repair", "修复")}</button></div>
      : view.repairOutcome ? <div className="rounded-xl border border-border/60 p-3 text-sm"><p>{tr(`Chapter ${ch(view.repairOutcome.chapter)} state repair finished.`, `第 ${ch(view.repairOutcome.chapter)} 章状态修复已结束。`)}</p></div>
      : null}
    {view.chapterAttention?.status === "AUDIT_FAILED_STATE_SETTLED" && <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{tr(`Chapter ${ch(view.chapterAttention.chapter)} will reuse its existing draft.`, `第 ${ch(view.chapterAttention.chapter)} 章将复用现有草稿。`)}</div>}
    {view.finalReviewRecovery && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"><p className="font-semibold">{tr("Recovery Ready", "恢复就绪")}</p><p className="mt-1 text-xs text-muted-foreground">{tr(`Pending Chapter ${ch(view.finalReviewRecovery.chapter)}; preserved evidence will be reused.`, `待处理第 ${ch(view.finalReviewRecovery.chapter)} 章；将复用已保留证据。`)}</p></div>}
    {view.legacyDrafts?.map((legacy) => <p key={legacy.chapter} className="text-xs text-muted-foreground">{tr(`Chapter ${ch(legacy.chapter)} legacy draft is preserved.`, `第 ${ch(legacy.chapter)} 章的历史草稿已保留。`)}</p>)}
    {view.chapterTransaction?.canAbandonAttempt && onAbandon && <button disabled={pending || active} onClick={onAbandon} className="h-9 rounded-lg border border-destructive/40 px-4 text-sm font-bold text-destructive disabled:opacity-40">{tr("Rewrite", "重写")}</button>}
    {!repair && !missingModels && !repairNeedsReconciliation && <div className="space-y-2"><div className="flex flex-wrap gap-2"><button disabled={!view.startEnabled || pending || waiting} onClick={() => onStart(resolveAutonomousStartMode(view))} className="h-9 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-40">{tr("Resume", "继续")}</button>{active && !waiting && <button disabled={pending} onClick={onStop} className="h-9 rounded-lg border px-4 text-sm font-bold">{tr("Stop", "停止")}</button>}</div></div>}
    {(error || view.runtime?.lastError) && <p className="text-sm text-destructive">{tr("Production needs attention. See Details.", "生产需要处理。请查看详情。")}</p>}
    <details className="rounded-xl border border-border/50 p-3 text-xs"><summary className="cursor-pointer font-semibold">{tr("Details", "详情")}</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>{tr("Raw status", "原始状态")}: {view.runtimeStatus} · {tr("phase", "阶段")}: {view.runtime?.phase ?? "none"} · {tr("role", "角色")}: {view.runtime?.activeRole ?? "none"} · Provider: {view.runtime?.activeProvider ?? "none"} · {tr("model", "模型")}: {view.runtime?.activeModel ?? "none"}</p>{view.runtime?.attempt !== undefined && <p>{tr("Transport attempt", "传输尝试")}: {view.runtime.attempt} / {view.runtime.maxAttempts ?? 3} · {tr("transport identity", "传输标识")}: {view.runtime.transportAttemptId ?? "Unavailable"} · {tr("recorded transports", "已记录传输")}: {view.runtime.providerAttemptHistory?.filter((entry) => entry.transportStarted).length ?? 0} · Retry-After: {view.runtime.retryAfterMs ?? "Unavailable"} ms · HTTP: {view.runtime.lastHttpStatus ?? "Unavailable"} · {tr("classification", "分类")}: {view.runtime.lastErrorClassification ?? view.runtime.providerAttemptHistory?.at(-1)?.classification ?? "Unavailable"} · logicalStepId: {view.runtime.logicalStepId ?? "Unavailable"} · {tr("response artifact", "响应证据")}: {view.runtime.responseArtifactStatus ?? "NONE"} · {tr("revision round", "修订轮次")}: {view.runtime.revisionRound ?? 0}</p>}<p>{tr("Historical calls", "历史调用")}: {view.economics.actual.providerCalls} · {tr("historical tokens", "历史 Token")}: {view.economics.actual.totalTokens} · {tr("recorded actual", "已记录实际费用")}: {money(view.economics.historicalRecordedActualUsd ?? view.economics.actual.costUsd)} · {tr("calculated estimate", "计算估算")}: {money(view.economics.historicalCalculatedEstimateUsd ?? view.economics.actual.estimatedCostUsd)}</p>{view.economics.currentAttempt && <p>{tr("Current logical calls", "当前逻辑调用")}: {view.economics.currentAttempt.logicalCalls} · {tr("Provider transports", "Provider 传输")}: {view.economics.currentAttempt.providerTransports} · {tr("Current token discrepancy", "当前 Token 差异")}: {view.economics.currentAttempt.tokenDiscrepancy} · {tr("Provider actual", "服务商实际费用")}: {money(view.economics.currentAttempt.actualCostUsd)}</p>}{view.economics.currentAttempt?.integrityWarnings?.map((warning) => <p key={warning}>{tr("Telemetry warning", "遥测警告")}: {warning}</p>)}<p>{tr("Roles", "角色")}: {Object.entries(view.roles).map(([r,m]) => `${r}=${m ?? "NOT_CONFIGURED"}`).join(" · ")}</p>{view.rolePricing && Object.entries(view.rolePricing).map(([role,price]) => <p key={`price-${role}`}>{role}: {price.modelId} · {price.status} · input {price.inputUsdPerToken ?? "Unavailable"} · output {price.outputUsdPerToken ?? "Unavailable"} {price.pricingUnit}</p>)}{Object.entries(view.economics.byRole).map(([role,usage]) => <p key={role}>{role}: {usage.providerCalls} calls · input {usage.promptTokens} · output {usage.completionTokens} · total {usage.totalTokens} · provider actual {money(usage.actualCostUsd)}</p>)}<p>{tr("Revision policy", "修订策略")}: normal {view.revisionPolicy.normal} · rescue {view.revisionPolicy.rescue} · maximum {view.revisionPolicy.maximum}</p>{view.runtimeBlockers.map((b) => <p key={b}>{humanBlocker(b)} <code>({b})</code></p>)}{(error || view.runtime?.lastError) && <p>{tr("Exception", "异常")}: {error ?? view.runtime?.lastError}</p>}<p>{tr("Last activity", "最近活动")}: {view.runtime?.updatedAt ?? tr("not started", "尚未开始")}</p></div></details>
  </section>;
}

export function AutonomousProductionPanel({ bookId, messages = [], onConfigureModels = () => undefined, language = "en" }: { readonly bookId: string; readonly messages?: ReadonlyArray<SSEMessage>; readonly onConfigureModels?: () => void; readonly language?: "en" | "zh" }) {
  const [view,setView]=useState<AutonomousView|null>(null); const [error,setError]=useState<string|null>(null); const [pending,setPending]=useState(false); const [confirmRepair,setConfirmRepair]=useState<number|null>(null); const [confirmAbandon,setConfirmAbandon]=useState(false); const [,setClock]=useState(0);
  const load=useCallback(async()=>{try{const next=await fetchJson<AutonomousView>(`/books/${encodeURIComponent(bookId)}/autonomous-production`);setView(next);setError(null);}catch(e){setError(e instanceof Error?e.message:String(e));}},[bookId]);
  useEffect(()=>{void load();},[load]);
  const recent=messages.at(-1); useEffect(()=>{if(recent && (recent.event.startsWith("autonomous:")||recent.event.startsWith("repair-state:"))) void load();},[recent,load]);
  useEffect(()=>{const ms=view?autonomousFallbackPollMs(view.runtimeStatus):null;if(ms===null)return;const timer=window.setInterval(()=>void load(),ms);return()=>window.clearInterval(timer);},[view?.runtimeStatus,load]);
  useEffect(()=>{if(view?.runtimeStatus!=="WAITING_PROVIDER_RETRY")return;const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[view?.runtimeStatus]);
  const action=async(path:string,body?:unknown)=>{if(pending)return;setPending(true);try{await fetchJson(path,{method:"POST",headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}};
  if(!view)return <section className="rounded-2xl border p-5 text-sm text-muted-foreground">{error ?? (language === "zh" ? "正在加载自动生产…" : "Loading autonomous production…")}</section>;
  const tr = (en: string, zh: string) => language === "zh" ? zh : en;
  return <><AutonomousProductionCard view={view} pending={pending} error={error} onStart={(mode)=>void action(`/books/${encodeURIComponent(bookId)}/autonomous-production/start`,{mode})} onStop={()=>void action(`/books/${encodeURIComponent(bookId)}/autonomous-production/stop`)} onRepair={setConfirmRepair} onAbandon={()=>setConfirmAbandon(true)} onConfigureModels={onConfigureModels} language={language}/><ConfirmDialog open={confirmRepair!==null} title={tr("Repair chapter state?", "修复章节状态？")} message={tr(`Repair Chapter ${ch(confirmRepair??0)} using the existing bounded state path. This may incur model cost.`, `使用现有有限状态路径修复第 ${ch(confirmRepair??0)} 章。这可能产生模型费用。`)} confirmLabel={tr("Repair", "修复")} cancelLabel={tr("Cancel", "取消")} variant="danger" onCancel={()=>setConfirmRepair(null)} onConfirm={()=>{const n=confirmRepair;setConfirmRepair(null);if(n!==null)void action(`/books/${encodeURIComponent(bookId)}/repair-state/${n}`);}}/><ConfirmDialog open={confirmAbandon} title={tr("Rewrite this chapter?", "重写本章？")} message={ATTEMPT_ABANDON_CONFIRMATION[language]} confirmLabel={tr("Rewrite", "重写")} cancelLabel={tr("Cancel", "取消")} variant="danger" onCancel={()=>setConfirmAbandon(false)} onConfirm={()=>{setConfirmAbandon(false);void action(`/books/${encodeURIComponent(bookId)}/autonomous-production/abandon-attempt`);}}/></>;
}
