/** Provider-reported total may include unclassified tokens; never infer their meaning. */
export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly actualCostUsd?: number;
}

export function isValidProviderUsage(value: unknown): value is ProviderUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as ProviderUsage;
  return [usage.promptTokens, usage.completionTokens, usage.totalTokens]
    .every((token) => Number.isSafeInteger(token) && token >= 0)
    && usage.totalTokens >= usage.promptTokens + usage.completionTokens
    && (usage.actualCostUsd === undefined || (typeof usage.actualCostUsd === "number"
      && Number.isFinite(usage.actualCostUsd) && usage.actualCostUsd >= 0));
}

/** Adapter boundary only: derive absent totals, preserving explicit malformed evidence
 * until the successful transport is persisted and can be rejected outside retry. */
export function normalizeProviderUsage(usage: {
  readonly promptTokens: unknown;
  readonly completionTokens: unknown;
  readonly totalTokens?: unknown;
  readonly actualCostUsd?: unknown;
}): ProviderUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens === undefined
      ? (usage.promptTokens as number) + (usage.completionTokens as number) : usage.totalTokens,
    ...(usage.actualCostUsd !== undefined ? { actualCostUsd: usage.actualCostUsd } : {}),
  } as ProviderUsage;
}
