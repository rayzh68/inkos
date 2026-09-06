
async function installLegacyBaseline(bookDir: string, truth: StructuredTruthV1) {
  const tx = await import("../production/chapter-transaction.js");
  const model = await import("../models/structured-truth.js");
  const transaction = await tx.beginChapterTransaction({ bookDir, bookId: truth.bookId, chapterNumber: 1, productionAuthority: "synthetic-legacy" });
  const body = "Legacy predecessor.";
  const hash = transaction.hash(body);
  const providerReferences = [];
  for (const [role, stage] of [["logic-canon-auditor", "LOGIC_REVIEW"], ["commercial-reader", "READER_REVIEW"]]) {
    const logicalOperationId = `provider-step-${transaction.hash(`legacy:${role}`)}`;
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const inputFingerprint = transaction.hash(`input:${role}`);
    const content = `synthetic legacy ${role} review`;
    const artifact = {
      schema_version: "1.0", transaction_id: transaction.transactionId, chapter_number: 1,
      logical_step_id: logicalOperationId, usage_identity: logicalOperationId, role, stage, provider: "fixture-provider",
      requested_model: "fixture-model", input_fingerprint: inputFingerprint, response_artifact_status: "COMPLETE",
      content_sha256: transaction.hash(content), response: { content },
    };
    const bytes = JSON.stringify(artifact);
    await mkdir(join(bookDir, "story/runtime/bounded-autonomous/provider-responses"), { recursive: true });
    await writeFile(join(bookDir, artifactRelativePath), bytes);
    providerReferences.push({ transactionId: transaction.transactionId, logicalOperationId, chapterNumber: 1,
      role: role!, stage: stage!, provider: "fixture-provider", requestedModel: "fixture-model", inputFingerprint,
      artifactRelativePath, artifactSha256: transaction.hash(bytes), responseContentSha256: transaction.hash(content),
      responseArtifactStatus: "COMPLETE" as const });
  }
  const manifest = JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 1, candidateSha256: hash, previousAuthoritySha256: transaction.previousAuthoritySha256 });
  const review = (reviewerRole: "logic-canon-auditor" | "commercial-reader") => ({
    reviewerRole, provider: "fixture-provider", model: "fixture-model", totalScore: 90,
    dimensionScores: { quality: 90 }, decision: "APPROVED" as const, findings: [], reviewedCandidateSha: hash,
  });
  await tx.stageChapterCommitCandidate({
    bookDir, transactionId: transaction.transactionId, title: "Legacy predecessor", body,
    lengthSpec: { target: 2, softMin: 2, softMax: 2, hardMin: 2, hardMax: 2, countingMode: "en_words" },
    review: { status: "APPROVED", grade: "A", revisionCount: 0, finalCandidateSha256: hash, findings: [],
      reviewerEvidence: [review("logic-canon-auditor"), review("commercial-reader")] },
    stateFiles: { "manifest.json": manifest, "current_state.json": JSON.stringify({ chapter: 1 }) },
    snapshotFiles: { "state/manifest.json": manifest, "state/current_state.json": JSON.stringify({ chapter: 1 }) },
    stateValidation: { chapterNumber: 1, finalCandidateSha256: hash, previousAuthoritySha256: transaction.previousAuthoritySha256, passed: true, warnings: [] },
    usage: {}, providerReferences, completedAt: "2026-09-04T00:00:00.000Z",
  });
  await tx.finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
  const chain = await tx.verifyChapterCommitChain({ bookDir });
  const commit = chain.commits.at(-1)!;
  if (commit.kind !== "CHAPTER_COMMIT") throw new Error("Synthetic predecessor must be a verified legacy Commit");
  const sourceFiles = Object.fromEntries(await Promise.all(commit.stateFiles.map(async (entry) =>
    [entry.relativePath, await readFile(join(bookDir, "story/commits/chapter-0001/state", entry.relativePath))] as const)));
  const sourceManifest: import("../models/structured-truth.js").BaselineSourceManifestV1 = {
    schemaVersion: "1.0", kind: "BASELINE_SOURCE_MANIFEST", bookId: truth.bookId, throughChapter: 1,
    predecessorCommitSha256: commit.commitSha256, sourceStateTreeSha256: commit.stateTreeSha256,
    entries: commit.stateFiles.map((entry) => ({ path: entry.relativePath, sha256: entry.sha256, byteLength: entry.bytes })),
  };
  const receipt: import("../models/structured-truth.js").BaselineConstructionReceiptV1 = {
    schemaVersion: "1.0", kind: "BASELINE_CONSTRUCTION_RECEIPT", bookId: truth.bookId, throughChapter: 1,
    predecessorCommitSha256: commit.commitSha256, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
    seedVocabularyCatalogSha256: canonicalSha256(truth.vocabulary),
    method: { kind: "DETERMINISTIC", builderId: "inkos.truth-baseline.builder.v1", builderVersion: "1.0" }, recordBindings: [],
  };
  Object.assign(truth, { throughChapter: 1, lineage: { kind: "BASELINE", predecessorCommitSha256: commit.commitSha256,
    baselineSourceManifestSha256: canonicalSha256(sourceManifest), seedVocabularyCatalogSha256: receipt.seedVocabularyCatalogSha256,
    baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: canonicalSha256(receipt) } });
  model.validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: commit });
  return { truth, sourceManifest, receipt, previousAuthoritySha256: commit.commitSha256,
    truthSha256: canonicalSha256(truth), vocabularyCatalogSha256: canonicalSha256(truth.vocabulary),
    predecessorChapterBody: body, predecessorChapterBodySha256: hash };
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TruthExtractorAgent } from "../agents/truth-extractor.js";
import { TruthValidatorAgent } from "../agents/truth-validator.js";
import { fingerprintReviewProviderRequest } from "../agents/commercial-reader.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { PipelineRunner } from "../pipeline/runner.js";
import {
  beginChapterTransaction,
  bindChapterTransactionProviderRequest,
  createChapterGenesis,
  recordChapterTransactionCandidate,
  recordChapterTransactionReviewEvidence,
  reserveChapterTransactionProviderRequest,
} from "../production/chapter-transaction.js";
import { canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import * as truthAuthority from "../interaction/truth-authority.js";

vi.mock("../interaction/truth-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../interaction/truth-authority.js")>(),
}));

function mockCutoverProbe(probe: () => Promise<boolean>) {
  vi.spyOn(truthAuthority, "resolveTruthCutoverState").mockImplementation(async () => await probe() ? "VERIFIED_V2_COMMIT_EXISTS" : "LEGACY_V1_ONLY");
}

const SHA_A = "a".repeat(64); const SHA_B = "b".repeat(64); const SHA_C = "c".repeat(64); const SHA_D = "d".repeat(64);
function baseline(): StructuredTruthV1 {
  return {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: "book-1", throughChapter: 0,
    lineage: { kind: "BASELINE", predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: SHA_B, seedVocabularyCatalogSha256: SHA_C, baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: SHA_D },
    vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
    provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
  };
}

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function beginTerminalResolverFixture(bookDir: string, candidate = "candidate") {
  await mkdir(join(bookDir, "story", "snapshots", "0", "state"), { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "chapters", "index.json"), "[]", "utf8");
  await writeFile(join(bookDir, "story", "snapshots", "0", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 0 }), "utf8");
  await createChapterGenesis({ bookDir, bookId: "book-1", lastTrustedChapter: 0, trustedSnapshotDir: join(bookDir, "story", "snapshots", "0") });
  const transaction = await beginChapterTransaction({ bookDir, bookId: "book-1", chapterNumber: 1, productionAuthority: "test" });
  const candidateSha256 = sha256Utf8(candidate);
  await recordChapterTransactionCandidate({
    bookDir, transactionId: transaction.transactionId, label: "INITIAL", content: candidate, sha256: candidateSha256,
  });
  return { transaction, candidate, candidateSha256 };
}

async function installBoundLogicArtifact(input: {
  readonly bookDir: string;
  readonly transaction: Awaited<ReturnType<typeof beginChapterTransaction>>;
  readonly candidate: string;
  readonly raw: string;
  readonly logicalOperationId: string;
  readonly requestOrdinal: number;
  readonly reviewLanguage?: "zh" | "en";
  readonly provider?: string;
  readonly model?: string;
}) {
  const provider = input.provider ?? "test";
  const model = input.model ?? "logic-model";
  const reviewLanguage = input.reviewLanguage ?? "en";
  const candidateSha256 = sha256Utf8(input.candidate);
  const request = {
    provider, model,
    messages: [{ role: "user" as const, content: `${reviewLanguage === "zh" ? "## 待审章节内容" : "## Chapter Content Under Review"}\n${input.candidate}` }],
    temperature: 0.3, maxTokens: 4096, stream: false, webSearch: false, extra: {},
  };
  const reservation = await reserveChapterTransactionProviderRequest({
    bookDir: input.bookDir, transactionId: input.transaction.transactionId, chapterNumber: 1,
    candidateSha256, role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
    requestOrdinal: input.requestOrdinal, reviewLanguage, request,
  });
  const responseDir = join(input.bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
  await mkdir(responseDir, { recursive: true });
  const artifact = {
    schema_version: "1.0", logical_step_id: input.logicalOperationId, usage_identity: input.logicalOperationId,
    transaction_id: input.transaction.transactionId, chapter_number: 1, role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
    provider, requested_model: model, input_fingerprint: reservation.providerInputFingerprint,
    response_artifact_status: "COMPLETE", content_sha256: sha256Utf8(input.raw),
    response: { content: input.raw, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } },
  };
  const bytes = `${JSON.stringify(artifact)}\n`;
  const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${input.logicalOperationId}.json`;
  await writeFile(join(input.bookDir, artifactRelativePath), bytes, "utf8");
  await bindChapterTransactionProviderRequest({
    bookDir: input.bookDir, transactionId: input.transaction.transactionId, reservationId: reservation.reservationId,
    providerReference: {
      transactionId: input.transaction.transactionId, logicalOperationId: input.logicalOperationId, chapterNumber: 1,
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW", provider, requestedModel: model,
      inputFingerprint: reservation.providerInputFingerprint, artifactRelativePath, artifactSha256: sha256Utf8(bytes),
      responseContentSha256: sha256Utf8(input.raw), responseArtifactStatus: "COMPLETE",
    },
  });
  return reservation;
}

async function installTerminalReviews(
  bookDir: string,
  transaction: Awaited<ReturnType<typeof beginChapterTransaction>>,
  candidate: string,
): Promise<void> {
  const candidateSha256 = sha256Utf8(candidate);
  await recordChapterTransactionCandidate({
    bookDir, transactionId: transaction.transactionId, label: "INITIAL",
    content: candidate, sha256: candidateSha256,
  });
  const reviews = [
    {
      role: "logic-canon-auditor" as const,
      stage: "LOGIC_REVIEW" as const,
      model: "logic-model",
      raw: JSON.stringify({ passed: true, overall_score: 92, dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }, issues: [], summary: "approved" }),
      evidence: { reviewerRole: "logic-canon-auditor" as const, provider: "test", model: "logic-model", totalScore: 92, dimensionScores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }, decision: "APPROVED" as const, findings: [], reviewedCandidateSha: candidateSha256 },
    },
    {
      role: "commercial-reader" as const,
      stage: "READER_REVIEW" as const,
      model: "reader-model",
      raw: JSON.stringify({ total_score: 92, dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED", findings: [] }),
      evidence: { reviewerRole: "commercial-reader" as const, provider: "test", model: "reader-model", totalScore: 92, dimensionScores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED" as const, findings: [], reviewedCandidateSha: candidateSha256 },
    },
  ];
  const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
  await mkdir(responseDir, { recursive: true });
  for (const review of reviews) {
    const logicalOperationId = `provider-step-${sha256Utf8(`${transaction.transactionId}:${review.role}:${candidateSha256}`)}`;
    const unsignedRequest = {
      provider: "test", model: review.model,
      messages: [{ role: "user" as const, content: review.role === "logic-canon-auditor"
        ? `## Chapter Content Under Review\n${candidate}`
        : `Candidate:\n${candidate}` }],
      temperature: review.role === "logic-canon-auditor" ? 0.3 : 0.2,
      maxTokens: 4096,
      stream: false,
      webSearch: false,
      extra: {},
    };
    const inputFingerprint = fingerprintReviewProviderRequest(unsignedRequest);
    const providerRequest = { ...unsignedRequest, reviewLanguage: "en" as const, inputFingerprint };
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const artifact = {
      schema_version: "1.0", job_id: "test-job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
      transaction_id: transaction.transactionId, chapter_number: transaction.chapterNumber, role: review.role, stage: review.stage,
      provider: "test", requested_model: review.model, input_fingerprint: inputFingerprint,
      response_artifact_status: "COMPLETE", content_sha256: sha256Utf8(review.raw), response: { content: review.raw }, completed_at: "2026-09-04T00:00:00.000Z",
    };
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(join(bookDir, artifactRelativePath), bytes, "utf8");
    const providerEvidence = {
      transactionId: transaction.transactionId, logicalOperationId, chapterNumber: transaction.chapterNumber,
      role: review.role, stage: review.stage, provider: "test", requestedModel: review.model, inputFingerprint,
      artifactRelativePath, artifactSha256: sha256Utf8(bytes), responseContentSha256: sha256Utf8(review.raw),
      responseArtifactStatus: "COMPLETE" as const,
    };
    const reservation = await reserveChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, chapterNumber: transaction.chapterNumber,
      candidateSha256, role: review.role, stage: review.stage, requestOrdinal: 0,
      reviewLanguage: "en", request: unsignedRequest,
    });
    await bindChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, reservationId: reservation.reservationId,
      providerReference: providerEvidence,
    });
    await recordChapterTransactionReviewEvidence({
      bookDir, transactionId: transaction.transactionId, candidateSha256, reviewerRole: review.role, evidence: review.evidence,
      providerEvidence,
      expectedInputFingerprint: inputFingerprint,
      providerRequest,
    });
  }
}

describe("PipelineRunner canonical truth V2 reachability", () => {
  it("binds terminal review evidence to the exact raw Provider response when a normal outcome supplies the logical ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-terminal-raw-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    const { transaction, candidate, candidateSha256: candidateSha } = await beginTerminalResolverFixture(bookDir);
    const raw = JSON.stringify({ passed: true, overall_score: 92, dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }, issues: [], summary: "approved" });
    const stableReview = { reviewerRole: "logic-canon-auditor", provider: "test", model: "logic-model", totalScore: 92, dimensionScores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }, decision: "APPROVED", findings: [], reviewedCandidateSha: candidateSha };
    const logicalOperationId = `provider-step-${"1".repeat(64)}`;
    const reservation = await installBoundLogicArtifact({ bookDir, transaction, candidate, raw, logicalOperationId, requestOrdinal: 0 });
    const runner = new PipelineRunner({ client: { provider: "test", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } as never, model: "scripted", projectRoot: root });
    const reference = await (runner as never as { resolveTerminalReviewProviderEvidence(input: Record<string, unknown>): Promise<{ responseContentSha256: string }> }).resolveTerminalReviewProviderEvidence({
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW", outcome: { modelCallId: logicalOperationId, provider: "test", model: "logic-model", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 }, returnedAt: "2026-09-04" },
      fallbackProvider: "test", fallbackModel: "logic-model", stableReview, expectedInputFingerprint: reservation.providerInputFingerprint, reviewLanguage: "en", bookDir, transactionId: transaction.transactionId, chapterNumber: 1,
    });
    expect(reference.responseContentSha256).toBe(sha256Utf8(raw));
  });

  it("retains malformed retry evidence but admits the one unique valid terminal approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-terminal-retry-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    const { transaction, candidate, candidateSha256: candidateSha } = await beginTerminalResolverFixture(bookDir);
    const stableReview = { reviewerRole: "logic-canon-auditor", provider: "test", model: "logic-model", totalScore: 92, dimensionScores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }, decision: "APPROVED", findings: [], reviewedCandidateSha: candidateSha };
    const raws = ["not-json", JSON.stringify({ passed: true, overall_score: 92, dimension_scores: stableReview.dimensionScores, issues: [], summary: "approved" })];
    let expectedInputFingerprint = "";
    for (const [index, raw] of raws.entries()) {
      const logicalOperationId = `provider-step-${String(index + 3).repeat(64)}`;
      expectedInputFingerprint = (await installBoundLogicArtifact({
        bookDir, transaction, candidate, raw, logicalOperationId, requestOrdinal: index,
      })).providerInputFingerprint;
    }
    const runner = new PipelineRunner({ client: { provider: "test", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } as never, model: "scripted", projectRoot: root });
    await expect((runner as never as { resolveTerminalReviewProviderEvidence(input: Record<string, unknown>): Promise<unknown> }).resolveTerminalReviewProviderEvidence({
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW", fallbackProvider: "test", fallbackModel: "logic-model", stableReview, expectedInputFingerprint, reviewLanguage: "en", bookDir, transactionId: transaction.transactionId, chapterNumber: 1,
    })).resolves.toMatchObject({ responseContentSha256: sha256Utf8(raws[1]!) });
  });

  it("rejects conflicting parseable terminal outputs and propagates non-ENOENT evidence directory failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-terminal-conflict-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    const { transaction, candidate, candidateSha256: candidateSha } = await beginTerminalResolverFixture(bookDir);
    const dimensions = { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 };
    const stableReview = { reviewerRole: "logic-canon-auditor", provider: "test", model: "logic-model", totalScore: 92, dimensionScores: dimensions, decision: "APPROVED", findings: [], reviewedCandidateSha: candidateSha };
    let expectedInputFingerprint = "";
    for (const [index, score] of [92, 93].entries()) {
      const raw = JSON.stringify({ passed: true, overall_score: score, dimension_scores: Object.fromEntries(Object.keys(dimensions).map((key) => [key, score])), issues: [], summary: "approved" });
      const logicalOperationId = `provider-step-${String(index + 7).repeat(64)}`;
      expectedInputFingerprint = (await installBoundLogicArtifact({
        bookDir, transaction, candidate, raw, logicalOperationId, requestOrdinal: index,
      })).providerInputFingerprint;
    }
    const runner = new PipelineRunner({ client: { provider: "test", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } as never, model: "scripted", projectRoot: root });
    const call = () => (runner as never as { resolveTerminalReviewProviderEvidence(input: Record<string, unknown>): Promise<unknown> }).resolveTerminalReviewProviderEvidence({ role: "logic-canon-auditor", stage: "LOGIC_REVIEW", fallbackProvider: "test", fallbackModel: "logic-model", stableReview, expectedInputFingerprint, reviewLanguage: "en", bookDir, transactionId: transaction.transactionId, chapterNumber: 1 });
    await expect(call()).rejects.toThrow(/ambiguous|conflict|multiple/i);

    await rm(responseDir, { recursive: true, force: true });
    await writeFile(responseDir, "not a directory", "utf8");
    await expect(call()).rejects.toThrow(/ENOTDIR|artifact|I\/O/i);
  });

  it("resolves identical response bytes by the exact observed logical operation identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-exact-provider-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    const responseContent = '{"schemaVersion":"1.0"}';
    const responseContentSha256 = sha256Utf8(responseContent);
    const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    await mkdir(responseDir, { recursive: true });
    const ids = [`provider-step-${"1".repeat(64)}`, `provider-step-${"2".repeat(64)}`];
    const bytesById = new Map<string, string>();
    for (const [index, logicalOperationId] of ids.entries()) {
      const artifact = {
        schema_version: "1.0", job_id: "job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
        transaction_id: "txn-1", chapter_number: 1, role: "truth-extractor", stage: index === 0 ? "TRUTH_EXTRACTION" : "TRUTH_EXTRACTION_REPAIR",
        provider: "test", requested_model: "scripted", input_fingerprint: `${index + 3}`.repeat(64),
        response_artifact_status: "COMPLETE", content_sha256: responseContentSha256,
        response: { content: responseContent, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }, completed_at: "2026-09-04T00:00:00.000Z",
      };
      const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
      bytesById.set(logicalOperationId, bytes);
      await writeFile(join(responseDir, `${logicalOperationId}.json`), bytes, "utf8");
    }
    const runner = new PipelineRunner({ client: { provider: "test", defaults: { maxTokens: 4096 } } as never, model: "scripted", projectRoot: root });
    const evidence = await (runner as unknown as { resolveCanonicalTruthEvidence(input: Record<string, unknown>): Promise<{ logicalOperationId: string; providerArtifactSha256: string }> }).resolveCanonicalTruthEvidence({
      role: "truth-extractor", stage: "TRUTH_EXTRACTION", responseContent, bookDir, transactionId: "txn-1", chapterNumber: 1,
      logicalOperationId: ids[0], provider: "test", model: "scripted",
    });
    expect(evidence).toMatchObject({ logicalOperationId: ids[0], providerArtifactSha256: sha256Utf8(bytesById.get(ids[0])!) });
  });

  it.each(["PASS", "FAIL", "AMBIGUOUS", "REPAIR_REQUIRED"])("runs scripted raw extractor and %s validator through real Package A without old truth constructors", async (verdict) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-runner-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    await mkdir(join(bookDir, "story", "snapshots", "0"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "story", "snapshots", "0", "current_state.md"), "# state\n", "utf8");
    const genesis = await createChapterGenesis({
      bookDir, bookId: "book-1", lastTrustedChapter: 0,
      trustedSnapshotDir: join(bookDir, "story", "snapshots", "0"),
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const firstV2Baseline = await installLegacyBaseline(bookDir, baseline());
    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-1", chapterNumber: 2, productionAuthority: "test",
      truthMode: "CANONICAL_V2", firstV2Baseline: firstV2Baseline,
      createdAt: "2026-09-04T00:00:01.000Z",
    });
    const candidate = "Ada opens the gate.";
    await installTerminalReviews(bookDir, transaction, candidate);
    const rawProposal = JSON.stringify({ schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [], evidence: [], ambiguities: [] });
    const truthContexts: unknown[] = [];
    vi.spyOn(TruthExtractorAgent.prototype as never, "chat" as never).mockImplementation(function (this: { ctx?: { activatedSkills?: unknown } }) {
      truthContexts.push(this.ctx?.activatedSkills);
      return Promise.resolve({ content: rawProposal, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } } as never);
    } as never);
    vi.spyOn(TruthValidatorAgent.prototype as never, "chat" as never).mockImplementation(function (this: { ctx?: { activatedSkills?: unknown } }) {
      truthContexts.push(this.ctx?.activatedSkills);
      return Promise.resolve({ content: JSON.stringify({ verdict, diagnostics: verdict === "PASS" ? [] : ["unsupported literal"] }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as never);
    } as never);
    const runner = new PipelineRunner({
      client: { provider: "test", service: "test", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } as never, model: "scripted", projectRoot: root,
      canonicalTruthEvidenceResolver: async ({ role, stage, responseContent, expectedInputFingerprint, transactionId, chapterNumber, provider, model }) => {
        const logicalOperationId = `provider-step-${sha256Utf8(`${role}:1`)}`;
        const artifact = {
          schema_version: "1.0", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
          transaction_id: transactionId, chapter_number: chapterNumber, role, stage, provider, requested_model: model,
          input_fingerprint: expectedInputFingerprint, response_artifact_status: "COMPLETE", content_sha256: sha256Utf8(responseContent),
          response: { content: responseContent, usage: role === "truth-extractor"
            ? { promptTokens: 2, completionTokens: 3, totalTokens: 5 }
            : { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        };
        const bytes = `${JSON.stringify(artifact)}\n`;
        const responseDir = join(bookDir, "story/runtime/bounded-autonomous/provider-responses");
        await mkdir(responseDir, { recursive: true });
        await writeFile(join(responseDir, `${logicalOperationId}.json`), bytes, "utf8");
        return {
          logicalOperationId, inputFingerprint: expectedInputFingerprint!, providerArtifactSha256: sha256Utf8(bytes), responseContentSha256: sha256Utf8(responseContent),
        };
      },
    });
    const result = await runner.runWithAgentContext({ activatedSkills: [{ skillId: "mutable-skill", guidance: "MUST_NOT_ENTER_TRUTH" }] } as never, () => runner.runCanonicalTruthSettlement({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1,
      chapterNumber: 2, candidate, predecessorCommitSha256: firstV2Baseline.previousAuthoritySha256, predecessor: firstV2Baseline.truth, committedAuthority: "verified",
    }));
    if (verdict !== "PASS") {
      expect(result).toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT", usageByRole: { "truth-validator": { totalTokens: 2 } } });
      expect(truthContexts).toEqual([undefined, undefined]);
      return;
    }
    expect(result.status).toBe("PASS");
    if (result.status !== "PASS") throw new Error("expected PASS");
    expect(result.resultingTruth.throughChapter).toBe(2);
    expect(result.projectionManifest.truthSha256).toBe(canonicalSha256(result.resultingTruth));
    expect(truthContexts).toEqual([undefined, undefined]);
    const source = PipelineRunner.prototype.runCanonicalTruthSettlement.toString();
    for (const forbidden of ["ChapterAnalyzerAgent", "StateValidatorAgent", "rewriteStructuredStateFromMarkdown", "rerunPromotionPass", "retrySettlementAfterValidationFailure"]) expect(source).not.toContain(forbidden);
  });

  it("fails the public PipelineRunner settlement before truth-model admission without exact terminal reviews", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-runner-terminal-gate-")); roots.push(root);
    const bookDir = join(root, "books", "book-1");
    await mkdir(join(bookDir, "story", "snapshots", "0"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "story", "snapshots", "0", "current_state.md"), "# state\n", "utf8");
    const genesis = await createChapterGenesis({
      bookDir, bookId: "book-1", lastTrustedChapter: 0,
      trustedSnapshotDir: join(bookDir, "story", "snapshots", "0"),
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const firstV2Baseline = await installLegacyBaseline(bookDir, baseline());
    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-1", chapterNumber: 2, productionAuthority: "test",
      truthMode: "CANONICAL_V2", firstV2Baseline: firstV2Baseline,
      createdAt: "2026-09-04T00:00:01.000Z",
    });
    const extractor = vi.spyOn(TruthExtractorAgent.prototype, "extract")
      .mockRejectedValue(new Error("TRUTH_MODEL_CALLED_BEFORE_TERMINAL_GATE"));
    const validator = vi.spyOn(TruthValidatorAgent.prototype, "validate")
      .mockRejectedValue(new Error("TRUTH_MODEL_CALLED_BEFORE_TERMINAL_GATE"));
    const runner = new PipelineRunner({
      client: { provider: "test", defaults: { maxTokens: 4096 } } as never,
      model: "scripted",
      projectRoot: root,
    });

    const result = await runner.runCanonicalTruthSettlement({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1,
      chapterNumber: 2, candidate: "Ada opens the gate.", predecessorCommitSha256: firstV2Baseline.previousAuthoritySha256,
      predecessor: firstV2Baseline.truth, committedAuthority: "verified",
    });

    expect(result).toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("fails manual repair/resync closed for transaction books instead of direct-writing V2 truth", async () => {
    const source = await readFile(new URL("../pipeline/runner.ts", import.meta.url), "utf8");
    expect(source).toContain("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
    const start = source.indexOf("if (chapterTransaction && canonicalTruthV2)");
    const end = source.indexOf("\n    } else {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const reachableV2Flow = source.slice(start, end);
    expect(reachableV2Flow).toContain("stageTruthChapterCommitV2");
    expect(reachableV2Flow).toContain("finalizeChapterTransaction");
    expect(reachableV2Flow).toContain("reconcileChapterProjections");
    for (const forbidden of [
      "ChapterAnalyzerAgent", "settleChapterState", "StateValidatorAgent", "rewriteStructuredStateFromMarkdown",
      "syncNarrativeMemoryIndex", "syncCurrentStateFactHistory", "rerunPromotionPass", "retrySettlementAfterValidationFailure",
    ]) expect(reachableV2Flow).not.toContain(forbidden);
  });

  it.each(["repairChapterState", "resyncChapterArtifacts", "resyncChapterStateAndAudit"] as const)(
    "checks V2 authority inside the acquired book lock for %s",
    async (method) => {
      const root = await mkdtemp(join(tmpdir(), "inkos-v2-manual-lock-")); roots.push(root);
      const runner = new PipelineRunner({ client: { provider: "test", defaults: { maxTokens: 4096 } } as never, model: "scripted", projectRoot: root });
      const events: string[] = [];
      (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
        events.push("lock");
        return async () => { events.push("release"); };
      };
      mockCutoverProbe(async () => {
        events.push("check");
        return true;
      });
      await expect((runner[method] as (bookId: string, chapterNumber: number) => Promise<unknown>).call(runner, "book-1", 1))
        .rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
      expect(events).toEqual(["lock", "check", "release"]);
    },
  );

  it("keeps a waiting manual repair behind the lock and observes a concurrently landed first V2 commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-manual-concurrency-")); roots.push(root);
    const runner = new PipelineRunner({ client: { provider: "test", defaults: { maxTokens: 4096 } } as never, model: "scripted", projectRoot: root });
    let allowLock!: () => void;
    const lockReady = new Promise<void>((resolve) => { allowLock = resolve; });
    let v2Landed = false;
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      await lockReady;
      return async () => {};
    };
    mockCutoverProbe(async () => v2Landed);
    const legacyWrite = vi.spyOn(runner as never, "_repairChapterStateLocked" as never);

    const waitingRepair = runner.repairChapterState("book-1", 1);
    await Promise.resolve();
    expect(legacyWrite).not.toHaveBeenCalled();
    v2Landed = true;
    allowLock();

    await expect(waitingRepair).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
    expect(legacyWrite).not.toHaveBeenCalled();
  });

  it("blocks the public state-rebaseline path inside the lock before plan resolution or Provider admission for V2", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-rebaseline-lock-")); roots.push(root);
    const onAutonomousStage = vi.fn();
    const runner = new PipelineRunner({
      client: { provider: "test", defaults: { maxTokens: 4096 } } as never,
      model: "scripted",
      projectRoot: root,
      onAutonomousStage,
    });
    const events: string[] = [];
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      events.push("lock");
      return async () => { events.push("release"); };
    };
    mockCutoverProbe(async () => {
      events.push("check");
      return true;
    });

    await expect(runner.rebaselinePendingChapterState({
      kind: "FORMAL_BOUNDED_STATE_REBASELINE",
      bookId: "book-1",
      jobId: "job-1",
      pendingChapterNumber: 1,
    } as never)).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");

    expect(events).toEqual(["lock", "check", "release"]);
    expect(onAutonomousStage).not.toHaveBeenCalled();
  });

  it("keeps a waiting public state rebaseline behind the lock and observes a concurrently landed first V2 commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-rebaseline-concurrency-")); roots.push(root);
    const onAutonomousStage = vi.fn();
    const runner = new PipelineRunner({
      client: { provider: "test", defaults: { maxTokens: 4096 } } as never,
      model: "scripted",
      projectRoot: root,
      onAutonomousStage,
    });
    let allowLock!: () => void;
    const lockReady = new Promise<void>((resolve) => { allowLock = resolve; });
    let v2Landed = false;
    const events: string[] = [];
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      events.push("waiting");
      await lockReady;
      events.push("lock");
      return async () => { events.push("release"); };
    };
    mockCutoverProbe(async () => {
      events.push("check");
      return v2Landed;
    });
    const waitingRebaseline = runner.rebaselinePendingChapterState({
      kind: "FORMAL_BOUNDED_STATE_REBASELINE",
      bookId: "book-1",
      jobId: "job-1",
      pendingChapterNumber: 1,
    } as never);
    await Promise.resolve();
    expect(events).toEqual(["waiting"]);
    v2Landed = true;
    allowLock();

    await expect(waitingRebaseline).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
    expect(events).toEqual(["waiting", "lock", "check", "release"]);
    expect(onAutonomousStage).not.toHaveBeenCalled();
  });

  it.each(["audit-failed", "preserved-candidate"])("blocks legacy %s recovery before legacy reads or Provider admission for V2", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-resume-admission-")); roots.push(root);
    const runner = new PipelineRunner({ client: { provider: "test", defaults: { maxTokens: 4096 } } as never, model: "scripted", projectRoot: root });
    const events: string[] = [];
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      events.push("lock");
      return async () => { events.push("release"); };
    };
    mockCutoverProbe(async () => { events.push("check"); return true; });
    const operation = kind === "audit-failed"
      ? runner.resumeAuditFailedChapterBounded("book-1", 1)
      : runner.resumePreservedBoundedCandidateReview({ bookId: "book-1", pendingChapterNumber: 1 } as never);
    await expect(operation).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
    expect(events).toEqual(kind === "audit-failed" ? ["check"] : ["lock", "check", "release"]);
  });

  it("blocks the public offline finalizer inside the acquired lock before the legacy finalizer for V2", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-offline-finalize-lock-")); roots.push(root);
    const runner = new PipelineRunner({
      client: { provider: "test", defaults: { maxTokens: 4096 } } as never,
      model: "scripted",
      projectRoot: root,
    });
    const events: string[] = [];
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      events.push("lock");
      return async () => { events.push("release"); };
    };
    mockCutoverProbe(async () => {
      events.push("check");
      return true;
    });

    await expect(runner.finalizePendingChapterOffline({ bookId: "book-1" } as never))
      .rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");

    expect(events).toEqual(["lock", "check", "release"]);
  });

  it("keeps the public offline finalizer behind the lock and observes a concurrently landed first V2 commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-offline-finalize-concurrency-")); roots.push(root);
    const runner = new PipelineRunner({
      client: { provider: "test", defaults: { maxTokens: 4096 } } as never,
      model: "scripted",
      projectRoot: root,
    });
    let allowLock!: () => void;
    const lockReady = new Promise<void>((resolve) => { allowLock = resolve; });
    let v2Landed = false;
    const events: string[] = [];
    (runner as unknown as { state: { acquireBookLock(bookId: string): Promise<() => Promise<void>> } }).state.acquireBookLock = async () => {
      events.push("waiting");
      await lockReady;
      events.push("lock");
      return async () => { events.push("release"); };
    };
    mockCutoverProbe(async () => {
      events.push("check");
      return v2Landed;
    });

    const waitingFinalization = runner.finalizePendingChapterOffline({ bookId: "book-1" } as never);
    await Promise.resolve();
    expect(events).toEqual(["waiting"]);
    v2Landed = true;
    allowLock();

    await expect(waitingFinalization).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
    expect(events).toEqual(["waiting", "lock", "check", "release"]);
  });
});
