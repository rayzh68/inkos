import { createHash } from "node:crypto";
import { CurrentStateStateSchema, HooksStateSchema } from "../models/runtime-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface SemanticAuthorityEnvelopeIdentity {
  readonly transactionId: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly previousAuthoritySha256: string;
  readonly authorityKind: "CHAPTER_COMMIT" | "GENESIS";
  readonly authorityChapterNumber: number;
  readonly authoritySha256: string;
  readonly currentStateSha256: string;
  readonly hooksSha256: string;
  readonly catalogHash: string;
}

export interface SemanticAuthorityRecord {
  readonly recordId: string;
  readonly factKey: string;
  readonly fieldPath: string;
  readonly value: string;
  readonly source: "current_state.json" | "hooks.json";
  readonly sourceRelativePath: string;
  readonly sourceSha256: string;
  readonly tier: "COMMITTED_STRUCTURED_CURRENT_STATE" | "COMMITTED_STRUCTURED_HOOKS";
  readonly priority: number;
}

export interface SemanticAuthorityEnvelope {
  readonly status: "VERIFIED" | "UNAVAILABLE";
  readonly identity: SemanticAuthorityEnvelopeIdentity;
  readonly records: ReadonlyArray<SemanticAuthorityRecord>;
  readonly issues: ReadonlyArray<string>;
}

export interface CandidateFactAssertion {
  readonly assertionId: string;
  readonly kind: "CANDIDATE_ASSERTION" | "EXPLICIT_TRANSITION";
  readonly candidateSha256: string;
  readonly recordId: string;
  readonly factKey: string;
  readonly value: string;
  readonly quote: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly fromValue?: string;
}

export interface SemanticCandidateFactEvidence {
  readonly candidateSha256: string;
  readonly authorityEnvelopeIdentity: SemanticAuthorityEnvelopeIdentity;
  readonly assertions: ReadonlyArray<CandidateFactAssertion>;
  readonly issues: ReadonlyArray<string>;
}

export interface SemanticAuthorityNomination {
  readonly findingId: string;
  readonly description: string;
  readonly assertion: CandidateFactAssertion;
  readonly committedRecord: SemanticAuthorityRecord;
  readonly envelopeIdentity: SemanticAuthorityEnvelopeIdentity;
}

export interface SemanticAdjudicationItem {
  readonly findingId: string;
  readonly assertionId: string;
  readonly recordId: string;
  readonly factKey: string;
  readonly candidateSha256: string;
  readonly candidateValue: string;
  readonly committedValue: string;
  readonly quote: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly source: SemanticAuthorityRecord["source"];
  readonly sourceRelativePath: string;
  readonly sourceSha256: string;
  readonly fieldPath: string;
  readonly tier: SemanticAuthorityRecord["tier"];
  readonly priority: number;
  readonly transactionId: string;
  readonly previousAuthoritySha256: string;
  readonly authoritySha256: string;
  readonly catalogHash: string;
}

export interface SemanticAdjudicationBatch {
  readonly status: "READY" | "AMBIGUOUS";
  readonly batchHash: string;
  readonly envelopeIdentity: SemanticAuthorityEnvelopeIdentity;
  readonly candidateContent: string;
  readonly items: ReadonlyArray<SemanticAdjudicationItem>;
  readonly issues: ReadonlyArray<string>;
}

export interface SemanticAdjudicationResult {
  readonly status: "AUTHORIZED" | "AMBIGUOUS";
  readonly authorizedFindingIds: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<string>;
}

interface SourceFile {
  readonly relativePath: string;
  readonly content: string;
  readonly sha256: string;
  readonly authorityMember: boolean;
}

export interface BuildSemanticAuthorityEnvelopeInput {
  readonly transaction: {
    readonly transactionId: string;
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly previousAuthoritySha256: string;
  };
  readonly authority: {
    readonly kind: "CHAPTER_COMMIT" | "GENESIS";
    readonly chapterNumber: number;
    readonly authoritySha256: string;
    readonly currentState: SourceFile;
    readonly hooks: SourceFile;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unavailableIdentity(input: BuildSemanticAuthorityEnvelopeInput): SemanticAuthorityEnvelopeIdentity {
  return {
    transactionId: input.transaction.transactionId,
    bookId: input.transaction.bookId,
    chapterNumber: input.transaction.chapterNumber,
    previousAuthoritySha256: input.transaction.previousAuthoritySha256,
    authorityKind: input.authority.kind,
    authorityChapterNumber: input.authority.chapterNumber,
    authoritySha256: input.authority.authoritySha256,
    currentStateSha256: input.authority.currentState.sha256,
    hooksSha256: input.authority.hooks.sha256,
    catalogHash: sha256("[]"),
  };
}

export function buildSemanticAuthorityEnvelope(
  input: BuildSemanticAuthorityEnvelopeInput,
): SemanticAuthorityEnvelope {
  const issues: string[] = [];
  const { transaction, authority } = input;
  if (!transaction.transactionId || !transaction.bookId) issues.push("Active transaction identity is incomplete.");
  if (transaction.chapterNumber !== authority.chapterNumber + 1) issues.push("Authority chapter is not the transaction predecessor.");
  if (!SHA256.test(transaction.previousAuthoritySha256)
    || transaction.previousAuthoritySha256 !== authority.authoritySha256) {
    issues.push("Previous authority SHA does not match the verified authority root.");
  }
  for (const [name, source] of [["current_state.json", authority.currentState], ["hooks.json", authority.hooks]] as const) {
    if (source.authorityMember !== true) {
      issues.push(`${name} is not a verified authority-tree member.`);
    }
    if (!SHA256.test(source.sha256) || sha256(source.content) !== source.sha256) {
      issues.push(`${name} SHA does not match its structured source bytes.`);
    }
  }

  let currentState: ReturnType<typeof CurrentStateStateSchema.parse> | undefined;
  let hooks: ReturnType<typeof HooksStateSchema.parse> | undefined;
  try {
    currentState = CurrentStateStateSchema.parse(JSON.parse(authority.currentState.content));
  } catch {
    issues.push("current_state.json is not a valid structured authority anchor.");
  }
  try {
    hooks = HooksStateSchema.parse(JSON.parse(authority.hooks.content));
  } catch {
    issues.push("hooks.json is not a valid structured authority anchor.");
  }
  if (!currentState || !hooks || issues.length > 0) {
    return { status: "UNAVAILABLE", identity: unavailableIdentity(input), records: [], issues };
  }

  const records: SemanticAuthorityRecord[] = [];
  for (const [index, fact] of currentState.facts.entries()) {
    const factKey = `state:${normalize(fact.subject)}::${normalize(fact.predicate)}`;
    const active = fact.validFromChapter <= authority.chapterNumber
      && (fact.validUntilChapter === null || fact.validUntilChapter >= authority.chapterNumber);
    records.push({
      recordId: `${factKey}@/facts/${index}/object`,
      factKey,
      fieldPath: `/facts/${index}/object`,
      value: fact.object,
      source: "current_state.json",
      sourceRelativePath: authority.currentState.relativePath,
      sourceSha256: authority.currentState.sha256,
      tier: "COMMITTED_STRUCTURED_CURRENT_STATE",
      priority: active ? 300 : 100,
    });
  }
  for (const [index, hook] of hooks.hooks.entries()) {
    for (const [field, rawValue] of Object.entries(hook)) {
      if (field === "hookId" || rawValue === undefined || rawValue === null || typeof rawValue === "object") continue;
      const value = String(rawValue);
      if (!value.trim()) continue;
      const factKey = `hook:${normalize(hook.hookId)}::${normalize(field)}`;
      records.push({
        recordId: `${factKey}@/hooks/${index}/${field}`,
        factKey,
        fieldPath: `/hooks/${index}/${field}`,
        value,
        source: "hooks.json",
        sourceRelativePath: authority.hooks.relativePath,
        sourceSha256: authority.hooks.sha256,
        tier: "COMMITTED_STRUCTURED_HOOKS",
        priority: 250,
      });
    }
  }
  records.sort((left, right) => left.recordId.localeCompare(right.recordId));
  if (records.length === 0) issues.push("Structured authority contains no host-bindable records.");
  const catalogHash = sha256(stable(records));
  const identity = { ...unavailableIdentity(input), catalogHash };
  return issues.length > 0
    ? { status: "UNAVAILABLE", identity, records: [], issues }
    : { status: "VERIFIED", identity, records, issues: [] };
}

export function renderSemanticAuthorityEnvelope(envelope: SemanticAuthorityEnvelope): string {
  return [
    "## Host Semantic Authority Envelope",
    "Only VERIFIED structured records in this transaction-bound envelope may authorize prose repair. Markdown context is non-authorizing.",
    JSON.stringify(envelope, null, 2),
  ].join("\n");
}

function highestRecord(envelope: SemanticAuthorityEnvelope, record: SemanticAuthorityRecord): boolean {
  const matching = envelope.records.filter((item) => item.factKey === record.factKey);
  const priority = Math.max(-1, ...matching.map((item) => item.priority));
  const highest = matching.filter((item) => item.priority === priority);
  return highest.length === 1 && highest[0]?.recordId === record.recordId;
}

function assertionId(assertion: Omit<CandidateFactAssertion, "assertionId">): string {
  return sha256(stable(assertion));
}

function occurs(value: string, quote: string): boolean {
  return normalize(quote).includes(normalize(value));
}

export function bindCandidateFactEvidence(
  candidateContent: string,
  envelope: SemanticAuthorityEnvelope,
  rawEvidence: unknown,
): SemanticCandidateFactEvidence {
  const candidateSha256 = sha256(candidateContent);
  const result = (assertions: CandidateFactAssertion[], issues: string[]): SemanticCandidateFactEvidence => ({
    candidateSha256,
    authorityEnvelopeIdentity: envelope.identity,
    assertions,
    issues,
  });
  if (envelope.status !== "VERIFIED") return result([], ["Semantic authority envelope is unavailable."]);
  if (rawEvidence === undefined) return result([], []);
  if (!Array.isArray(rawEvidence)) return result([], ["Candidate fact evidence section must be a JSON array."]);
  const assertions: CandidateFactAssertion[] = [];
  const issues: string[] = [];
  for (const [index, raw] of rawEvidence.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`Candidate evidence ${index + 1} is not host-bindable.`);
      continue;
    }
    const value = raw as Record<string, unknown>;
    const record = envelope.records.find((item) => item.recordId === value.recordId);
    const kind = value.kind;
    const candidateValue = typeof value.value === "string" ? value.value.trim() : "";
    const quote = typeof value.quote === "string" ? value.quote : "";
    const fromValue = typeof value.fromValue === "string" ? value.fromValue.trim() : undefined;
    const startUtf16 = value.startUtf16;
    const endUtf16 = value.endUtf16;
    const valid = (kind === "CANDIDATE_ASSERTION" || kind === "EXPLICIT_TRANSITION")
      && record !== undefined && highestRecord(envelope, record) && candidateValue.length > 0
      && Number.isInteger(startUtf16) && Number.isInteger(endUtf16)
      && (startUtf16 as number) >= 0 && (endUtf16 as number) <= candidateContent.length
      && (startUtf16 as number) < (endUtf16 as number)
      && candidateContent.slice(startUtf16 as number, endUtf16 as number) === quote
      && occurs(candidateValue, quote) && normalize(candidateValue) !== normalize(record?.value ?? "")
      && (kind !== "EXPLICIT_TRANSITION"
        || (fromValue !== undefined && normalize(fromValue) === normalize(record?.value ?? "") && occurs(fromValue, quote)));
    if (!valid || !record) {
      issues.push(`Candidate evidence ${index + 1} is not host-bindable.`);
      continue;
    }
    const withoutId: Omit<CandidateFactAssertion, "assertionId"> = {
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
    assertions.push({ ...withoutId, assertionId: assertionId(withoutId) });
  }
  const assertionCounts = new Map<string, number>();
  for (const assertion of assertions) {
    assertionCounts.set(assertion.recordId, (assertionCounts.get(assertion.recordId) ?? 0) + 1);
  }
  const conflictingRecordIds = new Set(
    [...assertionCounts.entries()].filter(([, count]) => count > 1).map(([recordId]) => recordId),
  );
  for (const recordId of [...conflictingRecordIds].sort()) {
    issues.push(`Candidate evidence contains duplicate or conflicting assertions for ${recordId}.`);
  }
  return result(assertions.filter((assertion) => !conflictingRecordIds.has(assertion.recordId)), issues);
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function ambiguousBatch(
  envelope: SemanticAuthorityEnvelope,
  candidateContent: string,
  issues: string[],
): SemanticAdjudicationBatch {
  return {
    status: "AMBIGUOUS",
    batchHash: sha256(stable({ candidateContent, envelopeIdentity: envelope.identity, items: [] })),
    envelopeIdentity: envelope.identity,
    candidateContent,
    items: [],
    issues,
  };
}

export function buildSemanticAdjudicationBatch(input: {
  readonly candidateContent: string;
  readonly envelope: SemanticAuthorityEnvelope;
  readonly nominations: ReadonlyArray<SemanticAuthorityNomination>;
}): SemanticAdjudicationBatch {
  if (input.envelope.status !== "VERIFIED") {
    return ambiguousBatch(input.envelope, input.candidateContent, ["Semantic authority envelope is unavailable."]);
  }
  const candidateSha256 = sha256(input.candidateContent);
  const items: SemanticAdjudicationItem[] = [];
  const seenFindingIds = new Set<string>();
  const seenRecordIds = new Set<string>();
  const seenFactKeys = new Set<string>();
  for (const nomination of input.nominations) {
    const canonicalRecord = input.envelope.records.find((record) => record.recordId === nomination.committedRecord.recordId);
    const rebound = bindCandidateFactEvidence(input.candidateContent, input.envelope, [{
      kind: nomination.assertion.kind,
      recordId: nomination.assertion.recordId,
      value: nomination.assertion.value,
      quote: nomination.assertion.quote,
      startUtf16: nomination.assertion.startUtf16,
      endUtf16: nomination.assertion.endUtf16,
      ...(nomination.assertion.fromValue !== undefined ? { fromValue: nomination.assertion.fromValue } : {}),
    }]);
    const canonicalAssertion = rebound.assertions[0];
    const valid = nomination.findingId.trim().length > 0 && !seenFindingIds.has(nomination.findingId)
      && same(nomination.envelopeIdentity, input.envelope.identity)
      && canonicalRecord !== undefined && same(nomination.committedRecord, canonicalRecord)
      && nomination.assertion.candidateSha256 === candidateSha256
      && canonicalAssertion !== undefined && same(nomination.assertion, canonicalAssertion);
    if (!valid || !canonicalRecord || !canonicalAssertion) {
      return ambiguousBatch(input.envelope, input.candidateContent, [`Semantic nomination ${nomination.findingId || "(missing)"} is not host-bindable.`]);
    }
    if (seenRecordIds.has(canonicalRecord.recordId) || seenFactKeys.has(canonicalRecord.factKey)) {
      return ambiguousBatch(input.envelope, input.candidateContent, [
        `Semantic adjudication contains duplicate or conflicting nominations for ${canonicalRecord.recordId}.`,
      ]);
    }
    seenFindingIds.add(nomination.findingId);
    seenRecordIds.add(canonicalRecord.recordId);
    seenFactKeys.add(canonicalRecord.factKey);
    items.push({
      findingId: nomination.findingId,
      assertionId: canonicalAssertion.assertionId,
      recordId: canonicalRecord.recordId,
      factKey: canonicalRecord.factKey,
      candidateSha256,
      candidateValue: canonicalAssertion.value,
      committedValue: canonicalRecord.value,
      quote: canonicalAssertion.quote,
      startUtf16: canonicalAssertion.startUtf16,
      endUtf16: canonicalAssertion.endUtf16,
      source: canonicalRecord.source,
      sourceRelativePath: canonicalRecord.sourceRelativePath,
      sourceSha256: canonicalRecord.sourceSha256,
      fieldPath: canonicalRecord.fieldPath,
      tier: canonicalRecord.tier,
      priority: canonicalRecord.priority,
      transactionId: input.envelope.identity.transactionId,
      previousAuthoritySha256: input.envelope.identity.previousAuthoritySha256,
      authoritySha256: input.envelope.identity.authoritySha256,
      catalogHash: input.envelope.identity.catalogHash,
    });
  }
  if (items.length === 0) {
    return ambiguousBatch(input.envelope, input.candidateContent, ["Semantic adjudication batch is empty."]);
  }
  items.sort((left, right) => left.findingId.localeCompare(right.findingId) || left.assertionId.localeCompare(right.assertionId));
  return {
    status: "READY",
    batchHash: sha256(stable({ candidateContent: input.candidateContent, envelopeIdentity: input.envelope.identity, items })),
    envelopeIdentity: input.envelope.identity,
    candidateContent: input.candidateContent,
    items,
    issues: [],
  };
}

function ambiguousResult(issue: string): SemanticAdjudicationResult {
  return { status: "AMBIGUOUS", authorizedFindingIds: [], issues: [issue] };
}

export function parseSemanticAdjudicationResponse(
  content: string,
  batch: SemanticAdjudicationBatch,
): SemanticAdjudicationResult {
  if (batch.status !== "READY") return ambiguousResult("Semantic adjudication batch was not ready.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return ambiguousResult("Semantic adjudication response is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ambiguousResult("Semantic adjudication response is malformed.");
  const root = parsed as Record<string, unknown>;
  if (!same(Object.keys(root).sort(), ["batchHash", "items"]) || root.batchHash !== batch.batchHash || !Array.isArray(root.items)) {
    return ambiguousResult("Semantic adjudication response does not match the focused batch.");
  }
  if (root.items.length !== batch.items.length) return ambiguousResult("Semantic adjudication response is incomplete or contains extra items.");
  const expectedKeys = [
    "assertionId", "authoritySha256", "batchHash", "candidateAssertsClaimedValue", "candidateSha256",
    "candidateValue", "catalogHash", "committedValue", "endUtf16", "explicitTransition", "factKey",
    "fieldPath", "findingId", "previousAuthoritySha256", "priority", "quote", "recordId", "semanticConflict",
    "source", "sourceRelativePath", "sourceSha256", "startUtf16", "tier", "transactionId", "uncertain",
  ].filter((key) => key !== "batchHash").sort();
  const authorized: string[] = [];
  const seen = new Set<string>();
  for (const raw of root.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ambiguousResult("Semantic adjudication item is malformed.");
    const response = raw as Record<string, unknown>;
    if (!same(Object.keys(response).sort(), expectedKeys)) return ambiguousResult("Semantic adjudication item has an unknown or missing field.");
    const findingId = typeof response.findingId === "string" ? response.findingId : "";
    const expected = batch.items.find((item) => item.findingId === findingId);
    if (!expected || seen.has(findingId)) return ambiguousResult("Semantic adjudication item is duplicate or unknown.");
    seen.add(findingId);
    const binding = Object.fromEntries(Object.keys(expected).map((key) => [key, response[key]]));
    if (!same(binding, expected)
      || response.candidateAssertsClaimedValue !== true
      || response.semanticConflict !== true
      || response.explicitTransition !== false
      || response.uncertain !== false) {
      return ambiguousResult("Semantic adjudication denied, differed, transitioned, or remained uncertain.");
    }
    authorized.push(findingId);
  }
  return { status: "AUTHORIZED", authorizedFindingIds: authorized.sort(), issues: [] };
}
