interface Summary {
  readonly totalChapters: number;
  readonly nextChapter: number;
  readonly currentVolume: { readonly volumeNumber: number; readonly startChapter: number; readonly endChapter: number };
  readonly runtimeStatus: string;
  readonly actualCostUsd: number | null;
  readonly currentVolumeForecast: { readonly lowUsd: number | null; readonly baseUsd: number | null; readonly highUsd: number | null };
}

const ch = (n: number) => String(n).padStart(3, "0");
const romans = ["0", "I", "II", "III", "IV", "V"];

function presentRuntimeStatus(status: string, tr: (en: string, zh: string) => string): string {
  if (status === "RUNNING" || status === "REPAIRING") return tr("Running", "运行中");
  if (status === "BOOK_COMPLETE" || status === "VOLUME_COMPLETE") return tr("Done", "完成");
  if (status === "PAUSED" || status === "PAUSED_BY_USER" || status === "WAITING_PROVIDER_RETRY" || status === "STOP_REQUESTED_AFTER_CURRENT_CHAPTER") return tr("Paused", "已暂停");
  if (status === "READY" || status === "READY_TO_REWRITE_SAME_CHAPTER" || status.startsWith("RECOVERY_READY_")) return tr("Ready", "就绪");
  return tr("Error", "错误");
}

export function AutonomousDashboardSummary({ autonomous, onOpen, language = "en" }: {
  readonly autonomous: Summary;
  readonly onOpen: () => void;
  readonly language?: "en" | "zh";
}) {
  const tr = (en: string, zh: string) => language === "zh" ? zh : en;
  const f = autonomous.currentVolumeForecast;
  const unavailable = tr("Unavailable", "不可用");
  const forecast = f.lowUsd == null || f.highUsd == null ? unavailable : `$${f.lowUsd.toFixed(2)}–$${f.highUsd.toFixed(2)}`;
  const status = presentRuntimeStatus(autonomous.runtimeStatus, tr);
  return <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-secondary/30 px-3 py-2 text-xs">
    <span>{tr("Volume", "卷")} {romans[autonomous.currentVolume.volumeNumber]} · {ch(autonomous.currentVolume.startChapter)}–{ch(autonomous.currentVolume.endChapter)}</span>
    <span>{tr("Next Chapter", "下一章")} {ch(autonomous.nextChapter)}</span>
    <strong>{status}</strong>
    <span>{tr("Actual", "实际")} {autonomous.actualCostUsd == null ? unavailable : `$${autonomous.actualCostUsd.toFixed(2)}`}</span>
    <span>{tr("Forecast", "预测")} {forecast}</span>
    <button onClick={onOpen} className="ml-auto font-bold text-primary">{tr("Open", "打开")}</button>
  </div>;
}
