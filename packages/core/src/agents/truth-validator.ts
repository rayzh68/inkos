import { parseJsonRejectingDuplicates, sha256Utf8 } from "../state/canonical-json.js";
import { BaseAgent, type AgentContext } from "./base.js";
import type { TokenUsage } from "./writer.js";
import type { LLMMessage } from "../llm/provider.js";
import type { FinalProviderRequestObservation } from "../agent/worker-agent.js";
import { projectTruthSettlementContext } from "./truth-settlement-context.js";

export type TruthValidationVerdict = "PASS" | "DELTA_EXTRACTION_DEFECT" | "PROSE_CONTENT_DEFECT" | "AUTHORITY_AMBIGUITY";

export interface TruthValidationResult {
  readonly verdict: TruthValidationVerdict;
  readonly diagnostics: readonly string[];
}

export interface TruthValidationRequest {
  readonly candidate: string;
  readonly candidateSha256: string;
  readonly predecessorTruthJson: string;
  readonly predecessorTruthSha256: string;
  readonly acceptedDeltaJson: string;
  readonly acceptedDeltaSha256: string;
  readonly resultingTruthJson: string;
  readonly resultingTruthSha256: string;
  readonly committedAuthority: string;
  readonly applicationReceiptSha256: string;
  readonly projectionManifestSha256: string;
}

export interface TruthValidatorResponse extends TruthValidationResult {
  readonly rawResponse: string;
  readonly responseContentSha256: string;
  readonly usage: TokenUsage;
}

/** A completed transport whose response cannot supply semantic authority. */
export class TruthValidatorArtifactError extends Error {
  constructor(readonly rawResponse: string, readonly usage: TokenUsage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TruthValidatorArtifactError";
  }
}

export const TRUTH_VALIDATOR_OPTIONS = { temperature: 0.1, maxTokens: 2_048 } as const;

/** The exact immutable message preimage used by the Truth Validator transport. */
export function buildTruthValidatorMessages(input: TruthValidationRequest): readonly LLMMessage[] {
  const context = projectTruthSettlementContext(input);
  return [
    {
      role: "system",
      content: [
        "You are InkOS's independent post-application semantic Truth Validator.",
        "Return strict JSON with exactly verdict and diagnostics.",
        "verdict must be exactly PASS, DELTA_EXTRACTION_DEFECT, PROSE_CONTENT_DEFECT, or AUTHORITY_AMBIGUITY.",
        "Diagnose only. Never emit replacement delta operations, complete truth, projection bytes, or rewritten prose.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `candidateSha256=${input.candidateSha256}`,
        `predecessorTruthSha256=${input.predecessorTruthSha256}`,
        `acceptedDeltaSha256=${input.acceptedDeltaSha256}`,
        `resultingTruthSha256=${input.resultingTruthSha256}`,
        `applicationReceiptSha256=${input.applicationReceiptSha256}`,
        `projectionManifestSha256=${input.projectionManifestSha256}`,
        "## Exact approved candidate",
        input.candidate,
        "## Verified predecessor StructuredTruthV1",
        input.predecessorTruthJson,
        "## Accepted ChapterDeltaV1",
        input.acceptedDeltaJson,
        "## Deterministically resulting StructuredTruthV1",
        input.resultingTruthJson,
        "## Verified committed authority",
        context.committedAuthority,
      ].join("\n\n"),
    },
  ];
}

const VERDICTS = new Set<TruthValidationVerdict>(["PASS", "DELTA_EXTRACTION_DEFECT", "PROSE_CONTENT_DEFECT", "AUTHORITY_AMBIGUITY"]);

export function parseTruthValidatorResponse(raw: string): TruthValidationResult {
  const parsed = parseJsonRejectingDuplicates(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Truth Validator response must be one JSON object");
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "diagnostics" || keys[1] !== "verdict") {
    throw new Error("Truth Validator response contains an unknown field or omits an exact field");
  }
  if (typeof value.verdict !== "string" || !VERDICTS.has(value.verdict as TruthValidationVerdict)) throw new Error("Truth Validator verdict is invalid");
  if (!Array.isArray(value.diagnostics) || value.diagnostics.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("Truth Validator diagnostics must be nonempty strings");
  }
  if (value.verdict === "PASS" && value.diagnostics.length !== 0) throw new Error("PASS cannot contain diagnostics");
  if (value.verdict !== "PASS" && value.diagnostics.length === 0) throw new Error("Non-PASS requires diagnostics");
  return { verdict: value.verdict as TruthValidationVerdict, diagnostics: value.diagnostics as string[] };
}

export class TruthValidatorAgent extends BaseAgent {
  constructor(ctx: AgentContext) { super(ctx); }

  get name(): string { return "truth-validator"; }

  async validate(
    input: TruthValidationRequest,
    onFinalProviderRequest?: (request: FinalProviderRequestObservation) => void | Promise<void>,
  ): Promise<TruthValidatorResponse> {
    if (sha256Utf8(input.candidate) !== input.candidateSha256) throw new Error("Truth Validator candidate SHA mismatch");
    const response = await this.chat(buildTruthValidatorMessages(input), { ...TRUTH_VALIDATOR_OPTIONS, onFinalProviderRequest });
    try {
      return { ...parseTruthValidatorResponse(response.content), rawResponse: response.content, responseContentSha256: sha256Utf8(response.content), usage: response.usage };
    } catch (cause) { throw new TruthValidatorArtifactError(response.content, response.usage, cause); }
  }
}
