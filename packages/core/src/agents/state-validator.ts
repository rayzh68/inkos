import { BaseAgent } from "./base.js";
import { createHash } from "node:crypto";
import type { CandidateFactAssertion, CandidateFactEvidence, TokenUsage } from "./writer.js";
import { parseCurrentStateFacts, parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import {
  bindCandidateFactEvidence as bindSemanticCandidateFactEvidence,
  renderSemanticAuthorityEnvelope,
  type SemanticAuthorityEnvelope,
  type SemanticAuthorityEnvelopeIdentity,
  type SemanticAuthorityRecord,
  type SemanticCandidateFactEvidence,
} from "./semantic-authority.js";

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

export type ValidationFindingKind =
  | "PROSE_AUTHORITY_CONTRADICTION"
  | "STATE_PROJECTION_DEFECT"
  | "AMBIGUOUS"
  | "NON_REPAIRABLE";

export interface ValidationFinding {
  readonly kind: ValidationFindingKind;
  readonly findingId: string;
  readonly description: string;
  readonly factKey?: string;
  readonly relation?: "CONFLICTING_VALUES" | "EXPLICIT_TRANSITION";
  readonly transitionQuote?: string;
  readonly candidate?: {
    readonly subject: string;
    readonly predicate: string;
    readonly value: string;
    readonly quote: string;
    readonly assertionId?: string;
    readonly kind?: "CANDIDATE_ASSERTION" | "EXPLICIT_TRANSITION";
    readonly candidateSha256?: string;
    readonly recordId?: string;
    readonly factKey?: string;
    readonly startUtf16?: number;
    readonly endUtf16?: number;
    readonly fromValue?: string;
  };
  readonly committed?: {
    readonly recordId: string;
    readonly value: string;
    readonly quote: string;
    readonly factKey?: string;
    readonly fieldPath?: string;
    readonly source?: "current_state.json" | "hooks.json";
    readonly sourceRelativePath?: string;
    readonly sourceSha256?: string;
    readonly tier?: "COMMITTED_STRUCTURED_CURRENT_STATE" | "COMMITTED_STRUCTURED_HOOKS";
    readonly priority?: number;
  };
  readonly authorityEnvelopeIdentity?: SemanticAuthorityEnvelopeIdentity;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly findings?: ReadonlyArray<ValidationFinding>;
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

export interface CommittedAuthorityRecord {
  readonly recordId: string;
  readonly factKey: string;
  readonly source: "current_state" | "pending_hooks";
  readonly tier: "COMMITTED_RUNTIME_CURRENT_STATE" | "COMMITTED_RUNTIME_PENDING_HOOKS";
  readonly priority: number;
  readonly value: string;
  readonly sourceSurface: string;
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
    candidateFactEvidence?: CandidateFactEvidence,
    authorityEnvelope?: SemanticAuthorityEnvelope,
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

    const authorityCatalog = authorityEnvelope
      ? authorityEnvelope.records.map((record) => semanticRecordAsLegacy(record))
      : buildCommittedAuthorityCatalog(oldState, oldHooks, chapterNumber);
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
  "findings": [{
    "kind": "PROSE_AUTHORITY_CONTRADICTION|STATE_PROJECTION_DEFECT|AMBIGUOUS|NON_REPAIRABLE",
    "findingId": "stable-id",
    "description": "specific finding",
    "candidateAssertionId": "exact host-issued assertion id",
    "committedRecordId": "exact id from the committed catalog"
  }]
}

Routing semantics:
- Return an empty findings array only when truth projection is complete enough and consistent with the chapter and committed authority.
- PROSE_AUTHORITY_CONTRADICTION requires a host-issued CANDIDATE_ASSERTION id and the matching committed catalog record id. You cannot authorize repair with your own subject, predicate, relation, value, or quote fields.
- STATE_PROJECTION_DEFECT means prose is valid but truth settlement is missing, stale, or incomplete. This includes unchanged truth or ledger omissions after prose establishes a change.
- A host-issued EXPLICIT_TRANSITION assertion always routes to state repair, even if you label it a prose contradiction.
- Use AMBIGUOUS or NON_REPAIRABLE whenever evidence is missing, stale, conflicting, lower-authority, or otherwise unprovable.
- Keep each finding's kind independent in mixed results. Only verified PROSE_AUTHORITY_CONTRADICTION findings may reach prose revision.

A legitimate authority change explicitly narrated in the current prose is not a contradiction merely because it differs from prior state. Never infer a content route from description/category words. Source and tier come only from the host catalog; do not invent or override them.`;

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
    const authorityCatalogBlock = authorityEnvelope
      ? renderSemanticAuthorityEnvelope(authorityEnvelope)
      : renderCommittedAuthorityCatalog(authorityCatalog);
    const candidateFactEvidenceBlock = renderCandidateFactEvidence(candidateFactEvidence);

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

${committedTruthBlock}

${authorityCatalogBlock}

${candidateFactEvidenceBlock}

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
          ...this.parseResult(response.content, { currentProse: chapterContent, authorityCatalog, candidateFactEvidence, authorityEnvelope }),
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
          ...this.parseResult(retryResponse.content, { currentProse: chapterContent, authorityCatalog, candidateFactEvidence, authorityEnvelope }),
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
    evidenceSurfaces: {
      readonly currentProse: string;
      readonly authorityCatalog: ReadonlyArray<CommittedAuthorityRecord>;
      readonly candidateFactEvidence?: CandidateFactEvidence;
      readonly authorityEnvelope?: SemanticAuthorityEnvelope;
    },
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
    if (verdictLine !== "PASS") {
      if (verdictLine === "REPAIR" || verdictLine === "FAIL") {
        throw new Error("State validator non-PASS result requires structured evidence");
      }
      throw new Error("State validator returned invalid response");
    }
    if (lines.length !== 1) throw new Error("State validator returned invalid response");
    const candidateEvidenceIssues = validateEvidenceSurfaces(evidenceSurfaces);
    if (candidateEvidenceIssues.length > 0) {
      const findings = candidateEvidenceIssues.map((description, index) => ({
        kind: "AMBIGUOUS" as const,
        findingId: `candidate-evidence-invalid-${index + 1}`,
        description,
      }));
      return {
        warnings: findings.map((finding) => ({ category: finding.kind, description: finding.description })),
        findings,
        passed: false,
        repairRequired: false,
        disposition: "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED",
      };
    }
    return { warnings: [], passed: true, repairRequired: false, disposition: "PASS" };
  }

  private tryParseJsonResult(
    text: string,
    evidenceSurfaces: {
      readonly currentProse: string;
      readonly authorityCatalog: ReadonlyArray<CommittedAuthorityRecord>;
      readonly candidateFactEvidence?: CandidateFactEvidence;
      readonly authorityEnvelope?: SemanticAuthorityEnvelope;
    },
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
    evidenceSurfaces: {
      readonly currentProse: string;
      readonly authorityCatalog: ReadonlyArray<CommittedAuthorityRecord>;
      readonly candidateFactEvidence?: CandidateFactEvidence;
      readonly authorityEnvelope?: SemanticAuthorityEnvelope;
    },
  ): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        findings?: unknown;
        warnings?: unknown;
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
      if (Array.isArray(parsed.findings)) {
        if (parsed.passed !== undefined || parsed.repairRequired !== undefined
          || parsed.stateRepairRequired !== undefined || parsed.proseAuthorityEvidence !== undefined
          || (parsed.warnings !== undefined && !Array.isArray(parsed.warnings))) {
          return null;
        }
        const candidateEvidenceIssues = validateEvidenceSurfaces(evidenceSurfaces);
        const verifiedFindings = parsed.findings.map((finding, index) => verifyValidationFinding(
          finding,
          index,
          evidenceSurfaces.authorityCatalog,
          evidenceSurfaces.candidateFactEvidence,
          candidateEvidenceIssues.length === 0,
          evidenceSurfaces.authorityEnvelope,
        ));
        const compatibilityWarnings = verifiedFindings.map((finding) => ({
          category: finding.kind,
          description: finding.description,
        }));
        const rawWarnings = (parsed.warnings ?? []) as ReadonlyArray<unknown>;
        const warningsMismatch = rawWarnings.length > 0
          && !warningsExactlyMatch(rawWarnings, compatibilityWarnings);
        const findings = [
          ...verifiedFindings,
          ...(parsed.disposition === undefined ? [] : [{
              kind: "AMBIGUOUS" as const,
              findingId: "result-wide-routing-not-authoritative",
              description: "Result-wide disposition cannot replace host-provable per-finding evidence.",
            }]),
          ...(warningsMismatch ? [{
              kind: "AMBIGUOUS" as const,
              findingId: "warnings-compatibility-mismatch",
              description: "Raw warnings do not match the host-derived compatibility projection.",
            }] : []),
          ...candidateEvidenceIssues.map((issue, index) => ({
            kind: "AMBIGUOUS" as const,
            findingId: `candidate-evidence-invalid-${index + 1}`,
            description: issue,
          })),
        ];
        const disposition = deriveValidationDisposition(findings);
        const proseFindings = findings.filter((finding) => finding.kind === "PROSE_AUTHORITY_CONTRADICTION");
        const stateRepairRequired = disposition === "CONTENT_REPAIR_REQUIRED"
          && findings.some((finding) => finding.kind === "STATE_PROJECTION_DEFECT");
        const proseAuthorityEvidence: ProseAuthorityEvidence | undefined = proseFindings.length > 0
          ? {
              status: "PROVEN",
              currentProse: proseFindings.map((finding) => finding.candidate!.quote),
              committedAuthority: proseFindings.map((finding) => finding.committed!.quote),
            }
          : findings.some((finding) => finding.kind === "AMBIGUOUS")
            ? { status: "AMBIGUOUS", currentProse: [], committedAuthority: [] }
            : undefined;
        return {
          findings,
          warnings: findings.map((finding) => ({ category: finding.kind, description: finding.description })),
          passed: disposition === "PASS",
          repairRequired: disposition === "STATE_REPAIR_REQUIRED",
          disposition,
          ...(stateRepairRequired ? { stateRepairRequired: true } : {}),
          ...(proseAuthorityEvidence ? { proseAuthorityEvidence } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

function normalizeEvidenceText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function evidenceOccursInSurface(evidence: string, surface: string): boolean {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return normalizedEvidence.length > 0
    && normalizeEvidenceText(surface).includes(normalizedEvidence);
}

function warningsExactlyMatch(
  rawWarnings: ReadonlyArray<unknown>,
  expectedWarnings: ReadonlyArray<ValidationWarning>,
): boolean {
  return rawWarnings.length === expectedWarnings.length
    && rawWarnings.every((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const warning = raw as Record<string, unknown>;
      const keys = Object.keys(warning).sort();
      return keys.length === 2
        && keys[0] === "category"
        && keys[1] === "description"
        && warning.category === expectedWarnings[index]?.category
        && warning.description === expectedWarnings[index]?.description;
    });
}

function stateFactKey(subject: string, predicate: string): string {
  return `state:${normalizeEvidenceText(subject)}::${normalizeEvidenceText(predicate)}`;
}

function hookFactKey(hookId: string, field: string): string {
  return `hook:${normalizeEvidenceText(hookId)}::${normalizeEvidenceText(field)}`;
}

export function buildCommittedAuthorityCatalog(
  oldState: string,
  oldHooks: string,
  chapterNumber: number,
): ReadonlyArray<CommittedAuthorityRecord> {
  const draft: CommittedAuthorityRecord[] = [];
  for (const fact of parseCurrentStateFacts(oldState, Math.max(0, chapterNumber - 1))) {
    const factKey = stateFactKey(fact.subject, fact.predicate);
    draft.push({
      recordId: factKey,
      factKey,
      source: "current_state",
      tier: "COMMITTED_RUNTIME_CURRENT_STATE",
      priority: 200,
      value: String(fact.object),
      sourceSurface: oldState,
    });
  }
  for (const hook of parsePendingHooksMarkdown(oldHooks)) {
    for (const [field, rawValue] of Object.entries(hook)) {
      if (rawValue === undefined || rawValue === null || typeof rawValue === "object") continue;
      const value = String(rawValue);
      if (!value.trim()) continue;
      const factKey = hookFactKey(hook.hookId, field);
      draft.push({
        recordId: factKey,
        factKey,
        source: "pending_hooks",
        tier: "COMMITTED_RUNTIME_PENDING_HOOKS",
        priority: 200,
        value,
        sourceSurface: oldHooks,
      });
    }
  }
  const occurrences = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const record of draft) totals.set(record.factKey, (totals.get(record.factKey) ?? 0) + 1);
  return draft.map((record) => {
    if ((totals.get(record.factKey) ?? 0) === 1) return record;
    const occurrence = (occurrences.get(record.factKey) ?? 0) + 1;
    occurrences.set(record.factKey, occurrence);
    return { ...record, recordId: `${record.factKey}#${occurrence}` };
  });
}

export function renderCommittedAuthorityCatalog(catalog: ReadonlyArray<CommittedAuthorityRecord>): string {
  return [
    "## Host Committed Runtime Authority Catalog",
    "Only these structured records may authorize prose repair. Context prose outside this catalog is non-authorizing.",
    JSON.stringify(catalog.map(({ recordId, factKey, source, tier, value }) => ({
      recordId, factKey, source, tier, value,
    })), null, 2),
  ].join("\n");
}

export function renderCandidateFactEvidence(evidence?: CandidateFactEvidence): string {
  return [
    "## Host-Bound Candidate Fact Evidence",
    "Only these host-issued assertion ids may authorize prose repair. Validator-supplied fact fields are non-authorizing.",
    JSON.stringify(evidence ?? { candidateSha256: null, assertions: [], issues: [] }, null, 2),
  ].join("\n");
}

function candidateAssertionIdentity(assertion: Omit<CandidateFactAssertion, "assertionId">): string {
  return [
    assertion.kind,
    assertion.candidateSha256,
    assertion.recordId,
    assertion.factKey,
    String(assertion.startUtf16),
    String(assertion.endUtf16),
    normalizeEvidenceText(assertion.value),
    normalizeEvidenceText(assertion.fromValue ?? ""),
  ].join("\0");
}

function deriveCandidateAssertionId(assertion: Omit<CandidateFactAssertion, "assertionId">): string {
  return createHash("sha256").update(candidateAssertionIdentity(assertion)).digest("hex");
}

function uniqueHighestRecord(
  catalog: ReadonlyArray<CommittedAuthorityRecord>,
  record: CommittedAuthorityRecord,
): boolean {
  const recordsForKey = catalog.filter((item) => item.factKey === record.factKey);
  const highestPriority = Math.max(-1, ...recordsForKey.map((item) => item.priority));
  const highestRecords = recordsForKey.filter((item) => item.priority === highestPriority);
  return highestRecords.length === 1 && highestRecords[0]?.recordId === record.recordId;
}

export function bindCandidateFactEvidence(
  candidateContent: string,
  catalog: ReadonlyArray<CommittedAuthorityRecord>,
  rawEvidence: unknown,
): CandidateFactEvidence {
  const candidateSha256 = createHash("sha256").update(candidateContent).digest("hex");
  if (rawEvidence === undefined) return { candidateSha256, assertions: [], issues: [] };
  if (!Array.isArray(rawEvidence)) {
    return { candidateSha256, assertions: [], issues: ["Candidate fact evidence section must be a JSON array."] };
  }

  const assertions: CandidateFactAssertion[] = [];
  const issues: string[] = [];
  for (const [index, raw] of rawEvidence.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`Candidate evidence ${index + 1} is not an object.`);
      continue;
    }
    const value = raw as Record<string, unknown>;
    const kind = value.kind;
    const recordId = nonEmptyString(value.recordId);
    const candidateValue = nonEmptyString(value.value);
    const quote = nonEmptyString(value.quote);
    const fromValue = nonEmptyString(value.fromValue);
    const startUtf16 = value.startUtf16;
    const endUtf16 = value.endUtf16;
    const record = recordId ? catalog.find((item) => item.recordId === recordId) : undefined;
    if ((kind !== "CANDIDATE_ASSERTION" && kind !== "EXPLICIT_TRANSITION")
      || !record || !uniqueHighestRecord(catalog, record) || !candidateValue || !quote
      || !Number.isInteger(startUtf16) || !Number.isInteger(endUtf16)
      || (startUtf16 as number) < 0 || (endUtf16 as number) > candidateContent.length
      || (startUtf16 as number) >= (endUtf16 as number)
      || candidateContent.slice(startUtf16 as number, endUtf16 as number) !== quote
      || !evidenceOccursInSurface(candidateValue, quote)
      || normalizeEvidenceText(candidateValue) === normalizeEvidenceText(record.value)
      || (kind === "EXPLICIT_TRANSITION"
        && (!fromValue
          || normalizeEvidenceText(fromValue) !== normalizeEvidenceText(record.value)
          || !evidenceOccursInSurface(fromValue, quote)))) {
      issues.push(`Candidate evidence ${index + 1} is not host-bindable.`);
      continue;
    }
    const assertionWithoutId: Omit<CandidateFactAssertion, "assertionId"> = {
      kind,
      candidateSha256,
      recordId: record.recordId,
      factKey: record.factKey,
      value: candidateValue,
      quote,
      startUtf16: startUtf16 as number,
      endUtf16: endUtf16 as number,
      ...(kind === "EXPLICIT_TRANSITION" ? { fromValue } : {}),
    };
    assertions.push({
      ...assertionWithoutId,
      assertionId: deriveCandidateAssertionId(assertionWithoutId),
    });
  }
  const bound = { candidateSha256, assertions, issues };
  return {
    ...bound,
    issues: validateCandidateFactEvidence(candidateContent, catalog, bound),
  };
}

function validateCandidateFactEvidence(
  candidateContent: string,
  catalog: ReadonlyArray<CommittedAuthorityRecord>,
  evidence?: CandidateFactEvidence,
): ReadonlyArray<string> {
  if (!evidence) return [];
  const expectedSha = createHash("sha256").update(candidateContent).digest("hex");
  const issues = [...evidence.issues];
  if (evidence.candidateSha256 !== expectedSha) issues.push("Candidate evidence SHA does not match final content.");
  const seenIds = new Set<string>();
  const seenRecords = new Set<string>();
  for (const assertion of evidence.assertions) {
    const record = catalog.find((item) => item.recordId === assertion.recordId);
    const assertionWithoutId: Omit<CandidateFactAssertion, "assertionId"> = {
      kind: assertion.kind,
      candidateSha256: assertion.candidateSha256,
      recordId: assertion.recordId,
      factKey: assertion.factKey,
      value: assertion.value,
      quote: assertion.quote,
      startUtf16: assertion.startUtf16,
      endUtf16: assertion.endUtf16,
      ...(assertion.fromValue !== undefined ? { fromValue: assertion.fromValue } : {}),
    };
    const valid = record !== undefined
      && uniqueHighestRecord(catalog, record)
      && assertion.candidateSha256 === expectedSha
      && assertion.factKey === record.factKey
      && assertion.assertionId === deriveCandidateAssertionId(assertionWithoutId)
      && Number.isInteger(assertion.startUtf16)
      && Number.isInteger(assertion.endUtf16)
      && assertion.startUtf16 >= 0
      && assertion.endUtf16 <= candidateContent.length
      && assertion.startUtf16 < assertion.endUtf16
      && candidateContent.slice(assertion.startUtf16, assertion.endUtf16) === assertion.quote
      && evidenceOccursInSurface(assertion.value, assertion.quote)
      && normalizeEvidenceText(assertion.value) !== normalizeEvidenceText(record.value)
      && (assertion.kind !== "EXPLICIT_TRANSITION"
        || (assertion.fromValue !== undefined
          && normalizeEvidenceText(assertion.fromValue) === normalizeEvidenceText(record.value)
          && evidenceOccursInSurface(assertion.fromValue, assertion.quote)));
    if (!valid) issues.push(`Candidate assertion ${assertion.assertionId} failed host verification.`);
    if (seenIds.has(assertion.assertionId)) issues.push(`Duplicate candidate assertion id ${assertion.assertionId}.`);
    if (seenRecords.has(assertion.recordId)) issues.push(`Duplicate or conflicting candidate assertions for ${assertion.recordId}.`);
    seenIds.add(assertion.assertionId);
    seenRecords.add(assertion.recordId);
  }
  return [...new Set(issues)];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function semanticRecordAsLegacy(record: SemanticAuthorityRecord): CommittedAuthorityRecord {
  return {
    recordId: record.recordId,
    factKey: record.factKey,
    source: record.source === "current_state.json" ? "current_state" : "pending_hooks",
    tier: record.source === "current_state.json"
      ? "COMMITTED_RUNTIME_CURRENT_STATE"
      : "COMMITTED_RUNTIME_PENDING_HOOKS",
    priority: record.priority,
    value: record.value,
    sourceSurface: record.value,
  };
}

function validateEvidenceSurfaces(evidenceSurfaces: {
  readonly currentProse: string;
  readonly authorityCatalog: ReadonlyArray<CommittedAuthorityRecord>;
  readonly candidateFactEvidence?: CandidateFactEvidence;
  readonly authorityEnvelope?: SemanticAuthorityEnvelope;
}): ReadonlyArray<string> {
  if (!evidenceSurfaces.authorityEnvelope) {
    return validateCandidateFactEvidence(
      evidenceSurfaces.currentProse,
      evidenceSurfaces.authorityCatalog,
      evidenceSurfaces.candidateFactEvidence,
    );
  }
  const envelope = evidenceSurfaces.authorityEnvelope;
  const evidence = evidenceSurfaces.candidateFactEvidence as SemanticCandidateFactEvidence | undefined;
  if (envelope.status !== "VERIFIED") return ["Semantic authority envelope is unavailable."];
  if (!evidence) return [];
  const issues = [...evidence.issues];
  const expectedSha = createHash("sha256").update(evidenceSurfaces.currentProse).digest("hex");
  if (evidence.candidateSha256 !== expectedSha) issues.push("Candidate evidence SHA does not match final content.");
  if (JSON.stringify(evidence.authorityEnvelopeIdentity) !== JSON.stringify(envelope.identity)) {
    issues.push("Candidate evidence authority envelope identity mismatch.");
  }
  const seen = new Set<string>();
  const seenRecordIds = new Set<string>();
  const seenFactKeys = new Set<string>();
  for (const assertion of evidence.assertions) {
    const rebound = bindSemanticCandidateFactEvidence(evidenceSurfaces.currentProse, envelope, [{
      kind: assertion.kind,
      recordId: assertion.recordId,
      value: assertion.value,
      quote: assertion.quote,
      startUtf16: assertion.startUtf16,
      endUtf16: assertion.endUtf16,
      ...(assertion.fromValue !== undefined ? { fromValue: assertion.fromValue } : {}),
    }]).assertions[0];
    if (!rebound || JSON.stringify(rebound) !== JSON.stringify(assertion)) {
      issues.push(`Candidate assertion ${assertion.assertionId} failed host verification.`);
    }
    if (seen.has(assertion.assertionId)) issues.push(`Duplicate candidate assertion id ${assertion.assertionId}.`);
    if (seenRecordIds.has(assertion.recordId) || seenFactKeys.has(assertion.factKey)) {
      issues.push(`Candidate evidence contains duplicate or conflicting assertions for ${assertion.recordId}.`);
    }
    seen.add(assertion.assertionId);
    seenRecordIds.add(assertion.recordId);
    seenFactKeys.add(assertion.factKey);
  }
  return [...new Set(issues)];
}

function ambiguousFinding(raw: unknown, index: number): ValidationFinding {
  const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const findingId = nonEmptyString(candidate?.findingId) ?? `unprovable-finding-${index + 1}`;
  const description = nonEmptyString(candidate?.description) ?? `Validation finding ${findingId} is not host-provable.`;
  return { kind: "AMBIGUOUS", findingId, description };
}

function verifyValidationFinding(
  raw: unknown,
  index: number,
  catalog: ReadonlyArray<CommittedAuthorityRecord>,
  candidateFactEvidence: CandidateFactEvidence | undefined,
  candidateEvidenceValid: boolean,
  authorityEnvelope?: SemanticAuthorityEnvelope,
): ValidationFinding {
  if (!raw || typeof raw !== "object") return ambiguousFinding(raw, index);
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  const findingId = nonEmptyString(value.findingId);
  const description = nonEmptyString(value.description);
  if (!findingId || !description) return ambiguousFinding(raw, index);
  if (kind === "STATE_PROJECTION_DEFECT" || kind === "AMBIGUOUS" || kind === "NON_REPAIRABLE") {
    return { kind, findingId, description };
  }
  if (kind !== "PROSE_AUTHORITY_CONTRADICTION") return ambiguousFinding(raw, index);
  const candidateAssertionId = nonEmptyString(value.candidateAssertionId);
  const committedRecordId = nonEmptyString(value.committedRecordId);
  if (!candidateAssertionId || !committedRecordId || !candidateEvidenceValid) return ambiguousFinding(raw, index);
  const assertion = candidateFactEvidence?.assertions.find((item) => item.assertionId === candidateAssertionId);
  const record = catalog.find((item) => item.recordId === committedRecordId);
  if (!assertion || !record
    || assertion.recordId !== record.recordId
    || assertion.factKey !== record.factKey
    || !uniqueHighestRecord(catalog, record)
    || normalizeEvidenceText(assertion.value) === normalizeEvidenceText(record.value)) {
    return ambiguousFinding(raw, index);
  }
  if (assertion.kind === "EXPLICIT_TRANSITION") {
    return { kind: "STATE_PROJECTION_DEFECT", findingId, description };
  }
  const semanticRecord = authorityEnvelope?.records.find((item) => item.recordId === committedRecordId);
  if (authorityEnvelope && !semanticRecord) return ambiguousFinding(raw, index);
  const factParts = record.factKey.split("::");
  const subject = factParts[0]?.replace(/^(state|hook):/u, "") ?? record.factKey;
  const predicate = factParts.slice(1).join("::") || record.factKey;
  return {
    kind: "PROSE_AUTHORITY_CONTRADICTION",
    findingId,
    description,
    factKey: record.factKey,
    relation: "CONFLICTING_VALUES",
    candidate: {
      subject,
      predicate,
      value: assertion.value,
      quote: assertion.quote,
      ...(authorityEnvelope ? assertion : {}),
    },
    committed: {
      recordId: record.recordId,
      value: record.value,
      quote: record.value,
      ...(semanticRecord ?? {}),
    },
    ...(authorityEnvelope ? { authorityEnvelopeIdentity: authorityEnvelope.identity } : {}),
  };
}

function deriveValidationDisposition(findings: ReadonlyArray<ValidationFinding>): ValidationDisposition {
  if (findings.some((finding) => finding.kind === "AMBIGUOUS" || finding.kind === "NON_REPAIRABLE")) {
    return "NON_REPAIRABLE_OR_BUDGET_EXHAUSTED";
  }
  if (findings.some((finding) => finding.kind === "PROSE_AUTHORITY_CONTRADICTION")) {
    return "CONTENT_REPAIR_REQUIRED";
  }
  if (findings.some((finding) => finding.kind === "STATE_PROJECTION_DEFECT")) {
    return "STATE_REPAIR_REQUIRED";
  }
  return "PASS";
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
