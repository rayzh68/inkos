import { BaseAgent } from "./base.js";
import type { TokenUsage } from "./writer.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export type ValidationDisposition =
  | "PASS"
  | "CONTENT_REPAIR_REQUIRED"
  | "STATE_REPAIR_REQUIRED"
  | "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";

export interface ProseAuthorityEvidence {
  readonly status: "PROVEN" | "AMBIGUOUS";
  readonly currentProse: ReadonlyArray<string>;
  readonly committedAuthority: ReadonlyArray<string>;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly passed: boolean;
  readonly repairRequired?: boolean;
  readonly disposition?: ValidationDisposition;
  readonly stateRepairRequired?: boolean;
  readonly proseAuthorityEvidence?: ProseAuthorityEvidence;
  readonly tokenUsage?: TokenUsage;
}

export interface StateValidationAuthorityContext {
  readonly storyFrame?: string;
  readonly bookRules?: string;
  readonly chapterSummaries?: string;
}

export interface StateValidationLedgerContext {
  readonly oldLedger: string;
  readonly newLedger: string;
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * PASS remains compatible as a minimal verdict. Every non-PASS result must
 * use the structured disposition/evidence contract so the host never routes
 * prose repair from free-form wording.
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
    authorityContext?: StateValidationAuthorityContext,
    semanticRecovery?: {
      readonly allowSemanticRetry?: boolean;
      readonly onSemanticRetry?: () => Promise<void> | void;
    },
    ledgerContext?: StateValidationLedgerContext,
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");
    const ledgerDiff = this.computeDiff(
      ledgerContext?.oldLedger ?? "",
      ledgerContext?.newLedger ?? "",
      "Particle Ledger",
    );

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `You are a continuity validator for a novel writing system. ${langInstruction}

Given the chapter text, committed current truth, and the CHANGES made to truth files (state card + hooks pool + particle ledger), check for contradictions:

1. State change without narrative support — truth file says something changed but the chapter text doesn't describe it
2. Missing state change — chapter text describes something happening but the truth file didn't capture it
3. Temporal impossibility — character moves locations without transition, injury heals without time passing
4. Hook anomaly — a hook disappeared without being marked resolved, or a new hook has no basis in the chapter
5. Retroactive edit — truth file change implies something happened in a PREVIOUS chapter, not the current one
6. Cross-truth key-setting conflict — numbered rules, named laws, ranks, identities, locations, or relationship labels in the new truth files contradict the chapter text or the authority context

Output exactly one JSON object (legacy exact PASS is accepted only when there are no findings):
{
  "disposition": "PASS|CONTENT_REPAIR_REQUIRED|STATE_REPAIR_REQUIRED|NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
  "stateRepairRequired": false,
  "warnings": [{ "category": "typed_category", "description": "specific finding" }],
  "proseAuthorityEvidence": {
    "status": "PROVEN|AMBIGUOUS",
    "currentProse": ["exact evidence from the current candidate"],
    "committedAuthority": ["exact evidence from committed/current authority"]
  }
}

Routing semantics:
- PASS: truth projection is complete enough and consistent with the chapter and committed authority.
- CONTENT_REPAIR_REQUIRED: current prose itself contradicts committed/current authority without an explicitly narrated change. This disposition is valid only with status PROVEN and non-empty evidence on BOTH surfaces.
- STATE_REPAIR_REQUIRED: prose is valid, but truth settlement is missing, stale, or incomplete. This includes unchanged truth or ledger omissions after the prose explicitly establishes a change.
- NON_REPAIRABLE_OR_BUDGET_EXHAUSTED: evidence is missing, conflicting, ambiguous, or cannot prove whether prose or settlement is wrong.
- Mixed content+state findings use CONTENT_REPAIR_REQUIRED with stateRepairRequired=true; content must be repaired first and state rebuilt later.

A legitimate authority change explicitly narrated in the current prose is not a contradiction merely because it differs from prior state. Never infer a content route from category words alone.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);
    const committedTruthBlock = [
      "## Committed Current Truth",
      "### Current State Card",
      oldState || "(empty)",
      "",
      "### Current Hooks Pool",
      oldHooks || "(empty)",
      "",
      "### Current Particle Ledger",
      ledgerContext?.oldLedger || "(empty)",
    ].join("\n");
    const committedAuthoritySurface = [
      oldState,
      oldHooks,
      ledgerContext?.oldLedger ?? "",
      authorityContext?.storyFrame ?? "",
      authorityContext?.bookRules ?? "",
      authorityContext?.chapterSummaries ?? "",
    ].join("\n");

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

${committedTruthBlock}

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Particle Ledger Changes
${ledgerDiff || "(no changes)"}

## Chapter Text (for reference)
${chapterContent}`;

    try {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1 },
      );

      try {
        return {
          ...this.parseResult(response.content, { currentProse: chapterContent, committedAuthority: committedAuthoritySurface }),
          tokenUsage: response.usage,
        };
      } catch (semanticError) {
        if (!semanticRecovery?.allowSemanticRetry) throw semanticError;
        await semanticRecovery.onSemanticRetry?.();
        const retryResponse = await this.chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: `${userPrompt}\n\nSEMANTIC_RETRY_1: The prior returned output could not be parsed. Return exactly one JSON object using the structured disposition/evidence contract, or exact PASS only when there are no findings.` },
          ],
          { temperature: 0.1 },
        );
        return {
          ...this.parseResult(retryResponse.content, { currentProse: chapterContent, committedAuthority: committedAuthoritySurface }),
          tokenUsage: {
            promptTokens: response.usage.promptTokens + retryResponse.usage.promptTokens,
            completionTokens: response.usage.completionTokens + retryResponse.usage.completionTokens,
            totalTokens: response.usage.totalTokens + retryResponse.usage.totalTokens,
            ...(response.usage.actualCostUsd !== undefined && retryResponse.usage.actualCostUsd !== undefined
              ? { actualCostUsd: response.usage.actualCostUsd + retryResponse.usage.actualCostUsd }
              : {}),
          },
        };
      }
    } catch (error) {
      this.log?.warn(`State validation failed: ${error}`);
      throw error;
    }
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const chapterSummaries = (authorityContext.chapterSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Authority precedence: Committed continuing truth controls by default. Candidate prose may supersede runtime truth files/current summaries only when the current candidate explicitly narrates the transition. A silent contradiction does not override committed truth. Within committed authority, runtime truth files/current summaries > story_frame/book_rules > legacy story_bible intro or marketing-style prose.",
      "",
      "### story_frame / legacy story_bible excerpt",
      storyFrame || "(empty)",
      "",
      "### book_rules excerpt",
      bookRules || "(empty)",
      "",
      "### recent chapter_summaries excerpt",
      chapterSummaries || "(empty)",
    ].join("\n");
  }

  private parseResult(
    content: string,
    evidenceSurfaces: { readonly currentProse: string; readonly committedAuthority: string },
  ): ValidationResult {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const jsonResult = this.tryParseJsonResult(trimmed, evidenceSurfaces);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    const verdictLine = lines[0]!;
    if (!/^(PASS|REPAIR|FAIL)$/i.test(verdictLine)) {
      throw new Error("State validator returned invalid response");
    }
    if (!/^PASS$/i.test(verdictLine)) {
      throw new Error("State validator non-PASS result requires structured evidence");
    }
    if (lines.length !== 1) throw new Error("State validator returned invalid response");
    return { warnings: [], passed: true, repairRequired: false, disposition: "PASS" };
  }

  private tryParseJsonResult(
    text: string,
    evidenceSurfaces: { readonly currentProse: string; readonly committedAuthority: string },
  ): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text, evidenceSurfaces);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate, evidenceSurfaces);
  }

  private tryParseExactJsonResult(
    text: string,
    evidenceSurfaces: { readonly currentProse: string; readonly committedAuthority: string },
  ): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        warnings?: Array<{ category?: string; description?: string }>;
        passed?: boolean;
        repairRequired?: boolean;
        disposition?: unknown;
        stateRepairRequired?: unknown;
        proseAuthorityEvidence?: {
          status?: unknown;
          currentProse?: unknown;
          committedAuthority?: unknown;
        };
      };
      const warnings = (parsed.warnings ?? []).map((w) => ({
        category: w.category ?? "unknown",
        description: w.description ?? "",
      }));
      if (isValidationDisposition(parsed.disposition)) {
        let disposition = parsed.disposition;
        const canonicalPassed = disposition === "PASS";
        const canonicalRepairRequired = disposition === "STATE_REPAIR_REQUIRED";
        if ((parsed.passed !== undefined && parsed.passed !== canonicalPassed)
          || (parsed.repairRequired !== undefined && parsed.repairRequired !== canonicalRepairRequired)
          || (parsed.stateRepairRequired === true
            && disposition !== "CONTENT_REPAIR_REQUIRED"
            && disposition !== "STATE_REPAIR_REQUIRED")) {
          return null;
        }
        const rawEvidence = parsed.proseAuthorityEvidence;
        const currentProse = Array.isArray(rawEvidence?.currentProse)
          ? rawEvidence.currentProse.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        const committedAuthority = Array.isArray(rawEvidence?.committedAuthority)
          ? rawEvidence.committedAuthority.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        const proseAuthorityEvidence: ProseAuthorityEvidence | undefined = rawEvidence
          && (rawEvidence.status === "PROVEN" || rawEvidence.status === "AMBIGUOUS")
          ? { status: rawEvidence.status, currentProse, committedAuthority }
          : undefined;
        const evidenceHostVerified = proseAuthorityEvidence?.status === "PROVEN"
          && proseAuthorityEvidence.currentProse.length > 0
          && proseAuthorityEvidence.committedAuthority.length > 0
          && proseAuthorityEvidence.currentProse.every((quote) => evidenceOccursInSurface(quote, evidenceSurfaces.currentProse))
          && proseAuthorityEvidence.committedAuthority.every((quote) => evidenceOccursInSurface(quote, evidenceSurfaces.committedAuthority))
          && !hasConflictingEvidence(proseAuthorityEvidence);
        if (disposition === "CONTENT_REPAIR_REQUIRED" && !evidenceHostVerified) {
          disposition = "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";
        }
        const verifiedEvidence = proseAuthorityEvidence && !evidenceHostVerified
          ? { ...proseAuthorityEvidence, status: "AMBIGUOUS" as const }
          : proseAuthorityEvidence;
        return {
          warnings,
          passed: disposition === "PASS",
          repairRequired: disposition === "STATE_REPAIR_REQUIRED",
          disposition,
          ...(parsed.stateRepairRequired === true ? { stateRepairRequired: true } : {}),
          ...(verifiedEvidence ? { proseAuthorityEvidence: verifiedEvidence } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

function isValidationDisposition(value: unknown): value is ValidationDisposition {
  return value === "PASS"
    || value === "CONTENT_REPAIR_REQUIRED"
    || value === "STATE_REPAIR_REQUIRED"
    || value === "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";
}

function normalizeEvidenceText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function evidenceOccursInSurface(evidence: string, surface: string): boolean {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return normalizedEvidence.length > 0
    && normalizeEvidenceText(surface).includes(normalizedEvidence);
}

function hasConflictingEvidence(evidence: ProseAuthorityEvidence): boolean {
  const current = new Set(evidence.currentProse.map(normalizeEvidenceText));
  return evidence.committedAuthority.some((item) => current.has(normalizeEvidenceText(item)));
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (endIndex < 0) return null;

  // Only accept the candidate if what follows the closing brace is
  // nothing, whitespace, or a structural JSON terminator.
  // This rejects trailing content like "{...} more text here"
  const followingChar = text[endIndex + 1];
  if (
    followingChar !== undefined &&
    followingChar !== "\n" &&
    followingChar !== "\r" &&
    followingChar !== "\t" &&
    followingChar !== " " &&
    followingChar !== "," &&
    followingChar !== "]" &&
    followingChar !== "}"
  ) {
    return null;
  }

  return text.slice(start, endIndex + 1);
}
