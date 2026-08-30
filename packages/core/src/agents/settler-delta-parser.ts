import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function hasSettlerDeltaEnvelope(content: string): boolean {
  return content.includes("=== RUNTIME_STATE_DELTA ===");
}

function normalizePersistedHookStatusAlias(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const delta = value as Record<string, unknown>;
  const hookOps = delta.hookOps;
  if (!hookOps || typeof hookOps !== "object" || Array.isArray(hookOps)) return value;
  const upsert = (hookOps as Record<string, unknown>).upsert;
  if (!Array.isArray(upsert)) return value;

  return {
    ...delta,
    hookOps: {
      ...hookOps,
      upsert: upsert.map((hook) => hook && typeof hook === "object" && !Array.isArray(hook)
        && (hook as Record<string, unknown>).status === "pressured"
        ? { ...hook, status: "progressing" }
        : hook),
    },
  };
}

export function parseSettlerDeltaOutput(content: string): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    throw new Error("runtime state delta block is missing");
  }

  const jsonPayload = stripCodeFence(rawDelta);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeJSON(jsonPayload));
  } catch (error) {
    throw new Error(`runtime state delta is not valid JSON: ${String(error)}`);
  }

  try {
    return {
      postSettlement: extract("POST_SETTLEMENT"),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse(normalizePersistedHookStatusAlias(parsed)),
    };
  } catch (error) {
    throw new Error(`runtime state delta failed schema validation: ${String(error)}`);
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}
