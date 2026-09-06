
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

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import type { LLMMessage } from "../llm/provider.js";
import { canonicalJson, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import * as AdmissionModule from "../state/chapter-delta-admission.js";
import {
  runCanonicalTruthTransaction as runCanonicalTruthTransactionImpl,
  type CanonicalTruthExecutionIdentity,
} from "../pipeline/canonical-truth-transaction.js";
import { buildTruthExtractorMessages, type TruthExtractionRequest } from "../agents/truth-extractor.js";
import { buildTruthValidatorMessages, type TruthValidationRequest } from "../agents/truth-validator.js";
import {
  abandonChapterTransactionAttempt,
  beginChapterTransaction,
  loadCommittedTruthForWriter,
  createChapterGenesis,
  bindChapterTransactionProviderRequest,
  recordChapterTransactionCandidate,
  recordChapterTransactionReviewEvidence,
  reserveChapterTransactionProviderRequest,
} from "../production/chapter-transaction.js";
import { createAutonomousProviderExecution } from "../production/bounded-autonomous-controller.js";
import { fingerprintReviewProviderRequest } from "../agents/commercial-reader.js";

const projectionMarkerRace = vi.hoisted(() => ({
  targetPath: "",
  arrivals: 0,
  barrier: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (...args: unknown[]) => {
      try {
        return await (actual.access as (...accessArgs: unknown[]) => Promise<void>)(...args);
      } catch (error) {
        if (projectionMarkerRace.targetPath
          && String(args[0]) === projectionMarkerRace.targetPath
          && (error as NodeJS.ErrnoException).code === "ENOENT"
          && projectionMarkerRace.arrivals < 2) {
          projectionMarkerRace.arrivals += 1;
          if (projectionMarkerRace.arrivals === 2) projectionMarkerRace.release?.();
          else await projectionMarkerRace.barrier;
        }
        throw error;
      }
    },
  };
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const USAGE = { promptTokens: 2, completionTokens: 3, totalTokens: 5 } as const;

function emptyTruth(): StructuredTruthV1 {
  return {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: "book-1", throughChapter: 0,
    lineage: { kind: "BASELINE", predecessorCommitSha256: SHA_A, baselineSourceManifestSha256: SHA_B, seedVocabularyCatalogSha256: SHA_C, baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: SHA_D },
    vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
    provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
  };
}

const roots: string[] = [];
afterEach(async () => {
  projectionMarkerRace.targetPath = "";
  projectionMarkerRace.arrivals = 0;
  projectionMarkerRace.barrier = undefined;
  projectionMarkerRace.release = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function readyProposal() {
  return JSON.stringify({ schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [], evidence: [], ambiguities: [] });
}

function frozenExecution(
  role: "truth-extractor" | "truth-validator",
  messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>,
) {
  const provider = "test-provider";
  const model = `${role}-model`;
  const temperature = 0.1;
  const maxTokens = role === "truth-extractor" ? 16_384 : 2_048;
  const stream = false;
  const inputFingerprint = sha256Utf8(JSON.stringify({ provider, model, messages, temperature, maxTokens, stream }));
  const fullRequest = { provider, model, messages, temperature, maxTokens, stream, webSearch: false, extra: {} } as const;
  return { ...fullRequest, fullRequestSha256: canonicalSha256(fullRequest), inputFingerprint } as const;
}

/** Keeps legacy unit fixtures concise while production requires an explicit frozen execution spec. */
async function runCanonicalTruthTransaction(input: Record<string, any>) {
  const extractorExecution = input.extractorExecution ?? ((request: TruthExtractionRequest) =>
    frozenExecution("truth-extractor", buildTruthExtractorMessages(request)));
  const validatorExecution = input.validatorExecution ?? ((request: TruthValidationRequest) =>
    frozenExecution("truth-validator", buildTruthValidatorMessages(request)));
  const extractor = input.extractor as (
    request: TruthExtractionRequest,
    execution: CanonicalTruthExecutionIdentity,
  ) => Promise<Record<string, unknown>>;
  const validator = input.validator as (
    request: TruthValidationRequest,
    execution: CanonicalTruthExecutionIdentity,
  ) => Promise<Record<string, unknown>>;
  return runCanonicalTruthTransactionImpl({
    // Pure truth-unit fixtures explicitly provide their scripted host authority.
    revalidateProviderEvidence: async () => {},
    ...input,
    extractorExecution,
    validatorExecution,
    extractor: async (request: TruthExtractionRequest, execution: CanonicalTruthExecutionIdentity) => ({
      ...await extractor(request, execution),
      inputFingerprint: execution.inputFingerprint,
    }),
    validator: async (request: TruthValidationRequest, execution: CanonicalTruthExecutionIdentity) => ({
      ...await validator(request, execution),
      inputFingerprint: execution.inputFingerprint,
    }),
  } as unknown as Parameters<typeof runCanonicalTruthTransactionImpl>[0]);
}

async function installTerminalReviews(
  bookDir: string,
  transaction: Awaited<ReturnType<typeof beginChapterTransaction>>,
  candidate: string,
): Promise<void> {
  const candidateSha256 = sha256Utf8(candidate);
  const candidateRoot = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0002", "staging", "evidence", "candidates");
  const labels = ["INITIAL", "REVISION_1", "REVISION_2"] as const;
  const existing = await readdir(candidateRoot).catch(() => []);
  let candidateInstalled = false;
  for (const label of existing) {
    const current = await readFile(join(candidateRoot, label, "body.md"), "utf8").catch(() => null);
    if (current !== null && sha256Utf8(current) === candidateSha256) candidateInstalled = true;
  }
  if (!candidateInstalled) {
    const label = labels.find((candidateLabel) => !existing.some((entry) => entry === candidateLabel));
    if (!label) throw new Error("test candidate labels exhausted");
    await recordChapterTransactionCandidate({ bookDir, transactionId: transaction.transactionId, label, content: candidate, sha256: candidateSha256 });
  }
  const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
  await mkdir(responseDir, { recursive: true });
  const operations = [
    {
      role: "logic-canon-auditor" as const,
      stage: "LOGIC_REVIEW" as const,
      model: "logic-model",
      rawResponse: JSON.stringify({
        passed: true,
        overall_score: 92,
        dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 },
        issues: [],
        summary: "approved",
      }),
      evidence: {
        reviewerRole: "logic-canon-auditor" as const,
        provider: "test-provider",
        model: "logic-model",
        totalScore: 92,
        dimensionScores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 },
        decision: "APPROVED" as const,
        findings: [],
        reviewedCandidateSha: candidateSha256,
      },
    },
    {
      role: "commercial-reader" as const,
      stage: "READER_REVIEW" as const,
      model: "commercial-model",
      rawResponse: JSON.stringify({
        total_score: 92,
        dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 },
        decision: "APPROVED",
        findings: [],
      }),
      evidence: {
        reviewerRole: "commercial-reader" as const,
        provider: "test-provider",
        model: "commercial-model",
        totalScore: 92,
        dimensionScores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 },
        decision: "APPROVED" as const,
        findings: [],
        reviewedCandidateSha: candidateSha256,
      },
    },
  ];
  for (const operation of operations) {
    const logicalOperationId = `provider-step-${sha256Utf8(`${transaction.transactionId}:${operation.role}:${candidateSha256}`)}`;
    const requestUnsigned = {
      provider: "test-provider", model: operation.model,
      messages: [{ role: "user" as const, content: operation.role === "logic-canon-auditor" ? `## Chapter Content Under Review\n${candidate}` : `Candidate:\n${candidate}` }],
      temperature: operation.role === "logic-canon-auditor" ? 0.3 : 0.2,
      maxTokens: 4096, stream: false, webSearch: false, extra: {},
    };
    const inputFingerprint = fingerprintReviewProviderRequest(requestUnsigned);
    const providerRequest = { ...requestUnsigned, reviewLanguage: "en" as const, inputFingerprint };
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const artifact = {
      schema_version: "1.0",
      job_id: "test-job",
      logical_step_id: logicalOperationId,
      usage_identity: logicalOperationId,
      transaction_id: transaction.transactionId,
      chapter_number: transaction.chapterNumber,
      role: operation.role,
      stage: operation.stage,
      provider: "test-provider",
      requested_model: operation.model,
      input_fingerprint: inputFingerprint,
      response_artifact_status: "COMPLETE",
      content_sha256: sha256Utf8(operation.rawResponse),
      response: { content: operation.rawResponse },
      completed_at: "2026-09-04T00:00:00.000Z",
    };
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(join(bookDir, artifactRelativePath), bytes, "utf8");
    const providerEvidence = {
      transactionId: transaction.transactionId,
      logicalOperationId,
      chapterNumber: transaction.chapterNumber,
      role: operation.role,
      stage: operation.stage,
      provider: "test-provider",
      requestedModel: operation.model,
      inputFingerprint,
      artifactRelativePath,
      artifactSha256: sha256Utf8(bytes),
      responseContentSha256: sha256Utf8(operation.rawResponse),
      responseArtifactStatus: "COMPLETE" as const,
    };
    const reservation = await reserveChapterTransactionProviderRequest({
      bookDir,
      transactionId: transaction.transactionId,
      chapterNumber: transaction.chapterNumber,
      candidateSha256,
      role: operation.role,
      stage: operation.stage,
      requestOrdinal: 0,
      reviewLanguage: "en",
      request: requestUnsigned,
    });
    await bindChapterTransactionProviderRequest({
      bookDir,
      transactionId: transaction.transactionId,
      reservationId: reservation.reservationId,
      providerReference: providerEvidence,
    });
    await recordChapterTransactionReviewEvidence({
      bookDir,
      transactionId: transaction.transactionId,
      candidateSha256,
      reviewerRole: operation.role,
      evidence: operation.evidence,
      providerRequest,
      providerEvidence,
    });
  }
}

async function beginTruthTransaction(
  bookDir: string,
  predecessor = emptyTruth(),
  candidate = "Ada opens the gate.",
  withTerminalReviews = true,
  truthMode: "CANONICAL_V2" | "LEGACY_V1" = "CANONICAL_V2",
) {
  const snapshotDir = join(bookDir, "story", "snapshots", "0");
  await mkdir(snapshotDir, { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(snapshotDir, "baseline.txt"), "verified baseline", "utf8");
  await writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf8");
  const genesis = await createChapterGenesis({
    bookDir,
    bookId: predecessor.bookId,
    lastTrustedChapter: 0,
    trustedSnapshotDir: snapshotDir,
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  const firstV2Baseline = await installLegacyBaseline(bookDir, predecessor);
  const transaction = await beginChapterTransaction({
    bookDir,
    bookId: predecessor.bookId,
    chapterNumber: 2,
    productionAuthority: "test-authority",
    truthMode,
    ...(truthMode === "CANONICAL_V2" ? { firstV2Baseline } : {}),
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  if (withTerminalReviews) await installTerminalReviews(bookDir, transaction, candidate);
  return { genesis, transaction };
}

describe("canonical truth transaction", () => {
  it("rejects a legacy transaction before canonical extraction even when its reviews pass", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-mode-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const predecessor = emptyTruth();
    const { transaction } = await beginTruthTransaction(bookDir, predecessor, candidate, true, "LEGACY_V1");
    const extractor = vi.fn(async () => { throw new Error("forbidden extraction transport"); });
    const validator = vi.fn(async () => { throw new Error("forbidden validation transport"); });
    await expect(runCanonicalTruthTransaction({ bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor, extractor, validator })).resolves.toMatchObject({ status: "HOST_APPLICATION_DEFECT" });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });
  it("admits only one conflicting canonical context publication before either extractor transport", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-context-race-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    projectionMarkerRace.targetPath = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "context.json");
    projectionMarkerRace.barrier = new Promise<void>((resolve) => { projectionMarkerRace.release = resolve; });
    let transports = 0;
    const extractor = async (_request: unknown, execution: { inputFingerprint: string }) => {
      transports++;
      return { rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE };
    };
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = async (_request: unknown, execution: { inputFingerprint: string }) => ({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator };
    const results = await Promise.allSettled([
      runCanonicalTruthTransaction({ ...input, committedAuthority: "first immutable context" }),
      runCanonicalTruthTransaction({ ...input, committedAuthority: "second immutable context" }),
    ]);
    expect(transports).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.status === "PASS")).toHaveLength(1);
  });
  it.each(["FAIL", "AMBIGUOUS", "REPAIR_REQUIRED"])("returns ARTIFACT_EVIDENCE_DEFECT for unexpected durable %s validation without replay transport", async (verdict) => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-nonpass-replay-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const rawResponse = JSON.stringify({ verdict, diagnostics: ["legacy literal"] });
    const extractor = vi.fn(async (_request, execution) => ({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE }));
    const validator = vi.fn(async (_request, execution) => ({ verdict, diagnostics: ["legacy literal"], rawResponse, logicalOperationId: "validate", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(rawResponse), usage: USAGE }));
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator };
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
    await expect(readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted/result.json"))).rejects.toThrow();
  });

  it.each(["accepted-authority.json", "result.json"])("does not promote a non-PASS semantic artifact placed in %s on replay", async (fileName) => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-nonpass-accepted-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn(async (_request, execution) => ({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE }));
    const validator = vi.fn(async (_request, execution) => ({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE }));
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator };
    await runCanonicalTruthTransaction(input);
    const acceptedRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted");
    if (fileName !== "result.json") await rm(join(acceptedRoot, "result.json"));
    const path = join(acceptedRoot, fileName);
    const record = JSON.parse(await readFile(path, "utf8"));
    const rawResponse = '{"verdict":"PROSE_CONTENT_DEFECT","diagnostics":["repair prose"]}';
    record.semanticValidation = { ...record.semanticValidation, verdict: "PROSE_CONTENT_DEFECT", diagnostics: ["repair prose"], rawResponse, responseContentSha256: sha256Utf8(rawResponse) };
    await writeFile(path, canonicalJson(record) + "\n");
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    if (fileName !== "result.json") await expect(readFile(join(acceptedRoot, "result.json"))).rejects.toThrow();
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "contradictory"] as const)(
    "rejects %s terminal request authority before the first Truth transport",
    async (defect) => {
      const bookDir = await mkdtemp(join(tmpdir(), `inkos-canonical-terminal-${defect}-`)); roots.push(bookDir);
      const candidate = "Ada opens the gate.";
      const { transaction } = await beginTruthTransaction(bookDir, emptyTruth(), candidate);
      const requestRoot = join(
        bookDir,
        "story/runtime/chapter-transactions/chapter-0002/staging/evidence/provider-requests",
      );
      const reservationNames = await readdir(join(requestRoot, "reservations"));
      const logicReservationName = (await Promise.all(reservationNames.map(async (name) => ({
          name,
          record: JSON.parse(await readFile(join(requestRoot, "reservations", name), "utf8")),
        })))).find(({ record }) => record.role === "logic-canon-auditor")!.name;
      if (defect === "missing") {
        await rm(join(requestRoot, "reservations", logicReservationName));
      } else {
        const reservationPath = join(requestRoot, "reservations", logicReservationName);
        const reservation = JSON.parse(await readFile(reservationPath, "utf8"));
        await writeFile(reservationPath, `${JSON.stringify({
          ...reservation,
          request: { ...reservation.request, extra: { route: "contradictory" } },
        }, null, 2)}\n`, "utf8");
      }
      const extractor = vi.fn(async (_request, execution) => ({
        rawProposal: readyProposal(), logicalOperationId: "extract-must-not-run",
        inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C,
        responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
      }));
      const pass = '{"verdict":"PASS","diagnostics":[]}';
      const validator = vi.fn(async (_request, execution) => ({
        verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-must-not-run",
        inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D,
        responseContentSha256: sha256Utf8(pass), usage: USAGE,
      }));

      await expect(runCanonicalTruthTransaction({
        bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1,
        chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate),
        predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
      })).resolves.toMatchObject({
        status: "ARTIFACT_EVIDENCE_DEFECT",
        diagnostics: [expect.stringMatching(/bound Provider request|reservation|authority/iu)],
      });
      expect(extractor).not.toHaveBeenCalled();
      expect(validator).not.toHaveBeenCalled();
    },
  );

  it("persists the exact Truth execution identity before transport and rejects replay drift before another call", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-frozen-execution-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    let extractorModel = "truth-extractor-model";
    const extractor = vi.fn().mockImplementation(async (_request, execution) => ({
      rawProposal: readyProposal(), logicalOperationId: "extract-frozen",
      inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C,
      responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    }));
    const validator = vi.fn().mockImplementation(async (_request, execution) => ({
      verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-frozen",
      inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D,
      responseContentSha256: sha256Utf8(pass), usage: USAGE,
    }));
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }),
      extractorExecution: (request: TruthExtractionRequest) => ({ ...frozenExecution("truth-extractor", buildTruthExtractorMessages(request)), model: extractorModel,
        inputFingerprint: sha256Utf8(JSON.stringify({ provider: "test-provider", model: extractorModel, messages: buildTruthExtractorMessages(request), temperature: 0.1, maxTokens: 16_384, stream: false })) }),
      validatorExecution: (request: TruthValidationRequest) => frozenExecution("truth-validator", buildTruthValidatorMessages(request)),
      extractor, validator,
    } as const;
    let crashed = false;
    await expect(runCanonicalTruthTransaction({
      ...input,
      onDurableBoundary: (boundary: string) => {
        if (!crashed && boundary === "AFTER_DELTA_ADMISSION") { crashed = true; throw new Error("SIMULATED_CRASH"); }
      },
    } as never)).rejects.toThrow("SIMULATED_CRASH");
    const contextPath = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "initial/extraction-context.json");
    const context = JSON.parse(await readFile(contextPath, "utf8"));
    expect(context.execution).toMatchObject({
      provider: "test-provider", model: "truth-extractor-model", temperature: 0.1, maxTokens: 16_384,
      stream: false, messages: buildTruthExtractorMessages(context.request), inputFingerprint: context.execution.inputFingerprint,
    });

    extractor.mockClear(); validator.mockClear();
    extractorModel = "drifted-model";
    await expect(runCanonicalTruthTransaction(input as never)).rejects.toThrow(/execution|context|immutable|fingerprint/i);
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("consolidated N1 rejects cached extraction when host Provider revalidation fails before Validator", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-cached-provider-revalidation-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    await installTerminalReviews(bookDir, transaction, candidate);
    let validatorEffects = 0;
    let rejectEvidence = false;
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }),
      extractor: async () => ({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE }),
      validator: async () => { validatorEffects += 1; return { verdict: "PASS", diagnostics: [], rawResponse: '{"verdict":"PASS","diagnostics":[]}', logicalOperationId: "validate", inputFingerprint: SHA_B, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8('{"verdict":"PASS","diagnostics":[]}'), usage: USAGE }; },
      revalidateProviderEvidence: async () => { if (rejectEvidence) throw new Error("retained Provider artifact missing"); },
    };
    await expect(runCanonicalTruthTransaction({ ...input, onDurableBoundary: (boundary: string) => {
      if (boundary === "AFTER_DELTA_ADMISSION") throw new Error("cached-extraction-crash");
    } })).rejects.toThrow("cached-extraction-crash");
    rejectEvidence = true;
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    expect(validatorEffects).toBe(0);
  });

  it("consolidated N2 accepts canonical nested full-request identity independently of insertion order", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-extra-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    await installTerminalReviews(bookDir, transaction, candidate);
    let extra: Record<string, unknown> = { z: { second: 2, first: 1 }, a: 3 };
    const execution = (role: "truth-extractor" | "truth-validator", messages: readonly LLMMessage[]) => {
      const { fullRequestSha256: _full, inputFingerprint, ...base } = frozenExecution(role, messages);
      const request = { ...base, extra };
      return { ...request, inputFingerprint, fullRequestSha256: canonicalSha256(request) };
    };
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }),
      extractorExecution: (request: TruthExtractionRequest) => execution("truth-extractor", buildTruthExtractorMessages(request)),
      validatorExecution: (request: TruthValidationRequest) => execution("truth-validator", buildTruthValidatorMessages(request)),
      extractor: async () => ({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE }),
      validator: async () => ({ verdict: "PASS", diagnostics: [], rawResponse: '{"verdict":"PASS","diagnostics":[]}', logicalOperationId: "validate", inputFingerprint: SHA_B, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8('{"verdict":"PASS","diagnostics":[]}'), usage: USAGE }),
      revalidateProviderEvidence: async () => {},
    };
    const first = await runCanonicalTruthTransaction(input);
    expect(first.status).toBe("PASS");
    extra = { a: 3, z: { first: 1, second: 2 } };
    expect(await runCanonicalTruthTransaction(input)).toEqual(first);
    extra = { a: 4, z: { first: 1, second: 2 } };
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/identity|context|execution|immutable/i);
  });

  it("consolidated N1 rejects cached semantic defect before a repair Extractor effect", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-cached-semantic-revalidation-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    await installTerminalReviews(bookDir, transaction, candidate);
    let rejectEvidence = false;
    let repairEffects = 0;
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }),
      extractor: async (request: TruthExtractionRequest) => {
        if (request.repairOrdinal === 1) { repairEffects += 1; throw new Error("repair-admission-crash"); }
        return { rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE };
      },
      validator: async () => { const rawResponse = '{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["missing fact"]}'; return { verdict: "DELTA_EXTRACTION_DEFECT", diagnostics: ["missing fact"], rawResponse, logicalOperationId: "validate", inputFingerprint: SHA_B, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(rawResponse), usage: USAGE }; },
      revalidateProviderEvidence: async (evidence: { role: string }) => { if (rejectEvidence && evidence.role === "truth-validator") throw new Error("retained Validator authority missing"); },
    };
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow("repair-admission-crash");
    repairEffects = 0; rejectEvidence = true;
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
    expect(repairEffects).toBe(0);
  });

  it("re-enters the existing Provider COMPLETE cache after a post-transport crash and never repeats transport", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-canonical-provider-cache-")); roots.push(projectRoot);
    const bookDir = join(projectRoot, "books", "book-1");
    await mkdir(join(bookDir, "story/runtime/bounded-autonomous"), { recursive: true });
    await writeFile(join(bookDir, "story/runtime/bounded-autonomous/production-state.json"), JSON.stringify({ jobId: "truth-cache-job", status: "RUNNING", mode: "current-volume", nextChapter: 1 }), "utf8");
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    let stage = { stage: "TRUTH_EXTRACTION", role: "truth-extractor", provider: "test-provider", model: "truth-extractor-model", transactionId: transaction.transactionId };
    const execution = createAutonomousProviderExecution({ projectRoot, bookId: "book-1", jobId: "truth-cache-job", getActiveStage: () => stage });
    let transports = 0;
    let crashAfterProvider = true;
    let extractorModel = "truth-extractor-model";
    const extractorExecution = (request: TruthExtractionRequest) => {
      const messages = buildTruthExtractorMessages(request);
      const providerIdentity = { provider: "test-provider", model: extractorModel, messages, temperature: 0.1, maxTokens: 16_384, stream: false } as const;
      const identity = { ...providerIdentity, webSearch: false, extra: {} } as const;
      return { ...identity, fullRequestSha256: canonicalSha256(identity), inputFingerprint: sha256Utf8(JSON.stringify(providerIdentity)) };
    };
    const extractor = vi.fn(async (request, frozen) => {
      stage = { ...stage, model: frozen.model };
      const response = await execution.runProviderCall(transaction.chapterNumber, async () => {
        transports += 1;
        return { content: readyProposal(), usage: USAGE };
      }, { provider: frozen.provider, model: frozen.model, inputFingerprint: frozen.inputFingerprint });
      if (crashAfterProvider) { crashAfterProvider = false; throw new Error("SIMULATED_POST_PROVIDER_CRASH"); }
      const artifactPath = execution.responseArtifactPath(frozen.inputFingerprint, frozen.provider, frozen.model, transaction.chapterNumber);
      const bytes = await readFile(artifactPath);
      return { rawProposal: response.content, logicalOperationId: artifactPath.split(/[\\/]/u).at(-1)!.replace(/\.json$/u, ""), inputFingerprint: frozen.inputFingerprint, providerArtifactSha256: sha256Utf8(bytes.toString("utf8")), responseContentSha256: sha256Utf8(response.content), usage: response.usage };
    });
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = vi.fn(async (_request, frozen) => ({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-cache", inputFingerprint: frozen.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE }));
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractorExecution,
      validatorExecution: (request: TruthValidationRequest) => frozenExecution("truth-validator", buildTruthValidatorMessages(request)), extractor, validator,
    } as const;
    await expect(runCanonicalTruthTransaction(input as never)).rejects.toThrow("SIMULATED_POST_PROVIDER_CRASH");
    expect(transports).toBe(1);

    extractorModel = "drifted-before-replay";
    await expect(runCanonicalTruthTransaction(input as never)).rejects.toThrow(/execution|context|immutable|fingerprint/i);
    expect(transports).toBe(1);
    extractorModel = "truth-extractor-model";
    await expect(runCanonicalTruthTransaction(input as never)).resolves.toMatchObject({ status: "PASS" });
    expect(transports).toBe(1);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it("binds REPAIR to the exact persisted INITIAL defect context, artifact, raw Provider response, and diagnostics", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-repair-binding-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const malformed = "not-json";
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn()
      .mockImplementationOnce(async (_request, execution) => ({ rawProposal: malformed, logicalOperationId: "extract-initial-defect", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(malformed), usage: USAGE }))
      .mockImplementationOnce(async (_request, execution) => ({ rawProposal: readyProposal(), logicalOperationId: "extract-repair-pass", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE }));
    const validator = vi.fn().mockImplementation(async (_request, execution) => ({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-repair", inputFingerprint: execution.inputFingerprint, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE }));
    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractorExecution: (request: TruthExtractionRequest) => frozenExecution("truth-extractor", buildTruthExtractorMessages(request)),
      validatorExecution: (request: TruthValidationRequest) => frozenExecution("truth-validator", buildTruthValidatorMessages(request)), extractor, validator,
    } as never);
    expect(result.status).toBe("PASS");
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    const authorization = JSON.parse(await readFile(join(root, "repair-authorization.json"), "utf8"));
    const initialContext = JSON.parse(await readFile(join(root, "initial/extraction-context.json"), "utf8"));
    const initialArtifact = JSON.parse(await readFile(join(root, "initial/extraction.json"), "utf8"));
    const repairContext = JSON.parse(await readFile(join(root, "repair/extraction-context.json"), "utf8"));
    expect(authorization).toMatchObject({
      initialExtractionContextSha256: initialContext.contextSha256,
      initialExtractionArtifactSha256: canonicalSha256(initialArtifact),
      initialProviderResponseSha256: sha256Utf8(malformed),
      diagnostics: repairContext.request.repairDiagnostics,
    });
    expect(repairContext.request.repairAuthorization).toEqual(authorization);
  });

  it("uses real Package A admission, reducer, projections, manifest, and durable immutable replay", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-truth-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const predecessor = emptyTruth();
    const { transaction } = await beginTruthTransaction(bookDir, predecessor);
    const extract = vi.fn().mockResolvedValue({
      rawProposal: readyProposal(), logicalOperationId: "extract-initial", inputFingerprint: SHA_B,
      providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    });
    const validateRaw = '{"verdict":"PASS","diagnostics":[]}';
    const validate = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: validateRaw, logicalOperationId: "validate-1", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(validateRaw), usage: USAGE });
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor,
      extractor: extract, validator: validate,
    } as const;

    const first = await runCanonicalTruthTransaction(input);
    expect(first.status).toBe("PASS");
    if (first.status !== "PASS") throw new Error("expected PASS");
    expect(first.resultingTruth.throughChapter).toBe(2);
    expect(first.projections).toHaveLength(10);
    expect(first.projectionManifest.truthSha256).toBe(canonicalSha256(first.resultingTruth));
    expect(first.applicationReceipt.resultingTruthSha256).toBe(canonicalSha256(first.resultingTruth));
    expect(first.usageByRole).toEqual({ "truth-extractor": USAGE, "truth-validator": USAGE });
    const truthRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    expect(await readFile(join(truthRoot, "accepted/accepted-delta.json"), "utf8"))
      .toContain(first.acceptedDelta.deltaId);

    const replay = await runCanonicalTruthTransaction(input);
    expect(replay).toEqual(first);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);

    await writeFile(join(truthRoot, "accepted/accepted-delta.json"), "{}\n");
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/immutable|accepted delta|authority/i);
  });

  it("permits one candidate-bound delta-only repair and fails closed on the second defect", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-repair-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn()
      .mockResolvedValueOnce({ rawProposal: readyProposal(), logicalOperationId: "extract-initial", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE })
      .mockResolvedValueOnce({ rawProposal: readyProposal(), logicalOperationId: "extract-repair", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const validator = vi.fn()
      .mockResolvedValueOnce({ verdict: "DELTA_EXTRACTION_DEFECT", diagnostics: ["missing fact"], rawResponse: '{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["missing fact"]}', logicalOperationId: "validate-1", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8('{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["missing fact"]}'), usage: USAGE })
      .mockResolvedValueOnce({ verdict: "DELTA_EXTRACTION_DEFECT", diagnostics: ["still missing"], rawResponse: '{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["still missing"]}', logicalOperationId: "validate-2", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8('{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["still missing"]}'), usage: USAGE });

    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    });
    expect(result).toMatchObject({ status: "DELTA_EXTRACTION_DEFECT", repairExhausted: true });
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(extractor.mock.calls.map((call) => call[0].extractionKind)).toEqual(["INITIAL", "REPAIR"]);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(result.usageByRole).toEqual({
      "truth-extractor": { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
      "truth-validator": { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    });
  });

  it("replays durable accepted authority after a crash without another extractor or Validator call", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-accepted-replay-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const rawResponse = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn().mockResolvedValue({
      rawProposal: readyProposal(), logicalOperationId: "extract-once", inputFingerprint: SHA_B,
      providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    });
    const validator = vi.fn().mockResolvedValue({
      verdict: "PASS", diagnostics: [], rawResponse, logicalOperationId: "validate-once", inputFingerprint: SHA_C,
      providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(rawResponse), usage: USAGE,
    });
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    } as const;
    const first = await runCanonicalTruthTransaction(input);
    const candidateRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    const acceptedRoot = join(candidateRoot, "accepted");
    await rm(join(acceptedRoot, "result.json"));
    await Promise.all([
      rm(join(candidateRoot, "initial", "extraction.json")),
      rm(join(candidateRoot, "initial", "semantic-validation.json")),
    ]);
    extractor.mockClear(); validator.mockClear();

    await expect(runCanonicalTruthTransaction(input)).resolves.toEqual(first);
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("rejects changed durable admission bytes without reinterpreting them or calling either truth model", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-admission-conflict-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn().mockResolvedValue({
      rawProposal: readyProposal(), logicalOperationId: "extract-admission-conflict", inputFingerprint: SHA_B,
      providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    });
    const validator = vi.fn().mockResolvedValue({
      verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-admission-conflict",
      inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE,
    });
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const admissionSpy = vi.spyOn(AdmissionModule, "admitChapterDeltaV1");
    admissionSpy.mockClear();
    const truthRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    const admissionPath = join(truthRoot, "initial", "delta-admission.json");
    const admission = JSON.parse(await readFile(admissionPath, "utf8"));
    await writeFile(admissionPath, `${canonicalJson({ ...admission, canonicalProposalSha256: "f".repeat(64) })}\n`, "utf8");
    extractor.mockClear(); validator.mockClear();

    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/immutable|admission|identity/i);
    expect(admissionSpy).not.toHaveBeenCalled();
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it.each(["AFTER_DELTA_ADMISSION", "AFTER_APPLICATION_RECEIPT", "AFTER_VALIDATOR_COMPLETE", "AFTER_ACCEPTED_AUTHORITY"] as const)(
    "recovers exact-once at the actual %s durable boundary through autonomous Provider replay",
    async (boundary) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-canonical-crash-boundaries-")); roots.push(projectRoot);
    const bookDir = join(projectRoot, "books", "book-1");
    await mkdir(join(bookDir, "story", "runtime", "bounded-autonomous"), { recursive: true });
    await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({
      jobId: "truth-crash-job", status: "RUNNING", mode: "current-volume", nextChapter: 1,
    }), "utf8");
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const admissionSpy = vi.spyOn(AdmissionModule, "admitChapterDeltaV1");
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    let extractorTransports = 0;
    let validatorTransports = 0;
    let activeStage = { stage: "TRUTH_EXTRACTION", role: "truth-extractor", provider: "test", model: "model", transactionId: transaction.transactionId };
    const execution = createAutonomousProviderExecution({
      projectRoot, bookId: "book-1", jobId: "truth-crash-job", getActiveStage: () => activeStage,
    });
    const extractor = vi.fn().mockImplementation(async (request) => {
      activeStage = { ...activeStage, stage: "TRUTH_EXTRACTION", role: "truth-extractor" };
      const inputFingerprint = canonicalSha256(request);
      const response = await execution.runProviderCall(transaction.chapterNumber, async () => {
        extractorTransports += 1;
        return { content: readyProposal(), usage: USAGE };
      }, { provider: "test", model: "model", inputFingerprint });
      const artifactPath = execution.responseArtifactPath(inputFingerprint, "test", "model", transaction.chapterNumber);
      const bytes = await readFile(artifactPath);
      return {
        rawProposal: response.content,
        logicalOperationId: artifactPath.split(/[\\/]/u).at(-1)!.replace(/\.json$/u, ""),
        inputFingerprint, providerArtifactSha256: sha256Utf8(bytes.toString("utf8")),
        responseContentSha256: sha256Utf8(response.content), usage: response.usage,
      };
    });
    const validator = vi.fn().mockImplementation(async (request) => {
      activeStage = { ...activeStage, stage: "TRUTH_VALIDATION", role: "truth-validator" };
      const inputFingerprint = canonicalSha256(request);
      const response = await execution.runProviderCall(transaction.chapterNumber, async () => {
        validatorTransports += 1;
        return { content: pass, usage: USAGE };
      }, { provider: "test", model: "model", inputFingerprint });
      const artifactPath = execution.responseArtifactPath(inputFingerprint, "test", "model", transaction.chapterNumber);
      const bytes = await readFile(artifactPath);
      return {
        verdict: "PASS", diagnostics: [], rawResponse: response.content,
        logicalOperationId: artifactPath.split(/[\\/]/u).at(-1)!.replace(/\.json$/u, ""),
        inputFingerprint, providerArtifactSha256: sha256Utf8(bytes.toString("utf8")),
        responseContentSha256: sha256Utf8(response.content), usage: response.usage,
      };
    });
    let crashEnabled = true;
    const input = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
      onDurableBoundary: async (actual: string) => {
        if (crashEnabled && actual === boundary) throw new Error(`TEST_CRASH_${boundary}`);
      },
    } as const;
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(`TEST_CRASH_${boundary}`);
    const runtimePath = join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json");
    const before = await readFile(runtimePath, "utf8");
    crashEnabled = false;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    expect({ extractorTransports, validatorTransports }).toEqual({ extractorTransports: 1, validatorTransports: 1 });
    if (boundary === "AFTER_DELTA_ADMISSION") expect(admissionSpy).toHaveBeenCalledTimes(1);
    const after = await readFile(runtimePath, "utf8");
    const historyBefore = JSON.parse(before).providerAttemptHistory as Array<{ logicalStepId: string }>;
    const historyAfter = JSON.parse(after).providerAttemptHistory as Array<{ logicalStepId: string }>;
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(new Set(historyAfter.map((entry) => entry.logicalStepId)).size).toBe(historyAfter.length);
    const truthRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    const result = JSON.parse(await readFile(join(truthRoot, "accepted", "result.json"), "utf8"));
    const extractionContext = await readFile(join(truthRoot, result.extractionContext.extractionKind.toLowerCase(), "extraction-context.json"), "utf8");
    const validationContext = await readFile(join(truthRoot, result.validationContext.extractionKind.toLowerCase(), "validation-context.json"), "utf8");
    expect(JSON.parse(extractionContext)).toEqual(result.extractionContext);
    expect(JSON.parse(validationContext)).toEqual(result.validationContext);
  });

  it.each(["PROSE_CONTENT_DEFECT", "AUTHORITY_AMBIGUITY"] as const)("returns the typed %s route without a delta repair", async (verdict) => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-route-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn().mockResolvedValue({
      rawProposal: readyProposal(), logicalOperationId: "extract-initial", inputFingerprint: SHA_B,
      providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    });
    const validator = vi.fn().mockResolvedValue({
      verdict, diagnostics: ["typed routing evidence"], logicalOperationId: "validate-1",
      inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(JSON.stringify({ verdict, diagnostics: ["typed routing evidence"] })), rawResponse: JSON.stringify({ verdict, diagnostics: ["typed routing evidence"] }), usage: USAGE,
    });
    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    });
    expect(result).toMatchObject({ status: verdict, repairExhausted: false, diagnostics: ["typed routing evidence"] });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("isolates extraction evidence when the approved candidate SHA changes", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-candidates-")); roots.push(bookDir);
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn(async () => ({
      rawProposal: readyProposal(), logicalOperationId: `extract-${extractor.mock.calls.length}`,
      inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE,
    }));
    const validator = vi.fn().mockResolvedValue({ verdict: "PROSE_CONTENT_DEFECT", diagnostics: ["revise prose"], rawResponse: '{"verdict":"PROSE_CONTENT_DEFECT","diagnostics":["revise prose"]}', logicalOperationId: "validate", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8('{"verdict":"PROSE_CONTENT_DEFECT","diagnostics":["revise prose"]}'), usage: USAGE });
    for (const candidate of ["Ada opens the gate.", "Ada closes the gate."]) {
      await installTerminalReviews(bookDir, transaction, candidate);
      const result = await runCanonicalTruthTransaction({
        bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
        candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
        predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
      });
      expect(result.status).toBe("PROSE_CONTENT_DEFECT");
    }
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it("rejects a direct public truth transaction before either truth model when terminal reviews are missing", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-terminal-gate-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir, emptyTruth(), candidate, false);
    const extractor = vi.fn();
    const validator = vi.fn();

    const result = await runCanonicalTruthTransaction({
      bookDir,
      transactionId: transaction.transactionId,
      attemptId: "attempt-1",
      attemptNumber: 1,
      chapterNumber: 2,
      candidate,
      candidateSha256: sha256Utf8(candidate),
      predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }),
      extractor,
      validator,
    });

    expect(result).toMatchObject({
      status: "ARTIFACT_EVIDENCE_DEFECT",
      diagnostics: expect.arrayContaining([expect.stringMatching(/terminal|review|Logic|Reader/i)]),
    });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("routes terminal evidence I/O failures as artifact defects rather than host semantic defects", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-terminal-io-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir, emptyTruth(), candidate, false);
    await recordChapterTransactionCandidate({
      bookDir, transactionId: transaction.transactionId, label: "INITIAL",
      content: candidate, sha256: sha256Utf8(candidate),
    });
    const logicPath = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/reviews", sha256Utf8(candidate), "logic-canon-auditor");
    await mkdir(join(logicPath, ".."), { recursive: true });
    await writeFile(logicPath, "not a directory", "utf8");
    const extractor = vi.fn(); const validator = vi.fn();
    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    });
    expect(result).toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT", repairExhausted: false });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it.each(["mismatched-candidate", "rejected-raw-review"] as const)(
    "rejects %s terminal authority before either truth model",
    async (defect) => {
      const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-terminal-defect-")); roots.push(bookDir);
      const approvedCandidate = "Ada opens the gate.";
      const { transaction } = await beginTruthTransaction(bookDir, emptyTruth(), approvedCandidate, true);
      let candidate = approvedCandidate;
      if (defect === "mismatched-candidate") {
        candidate = "Ada closes the gate.";
      } else {
        const logicDir = join(
          bookDir,
          "story/runtime/chapter-transactions/chapter-0002/staging/evidence/reviews",
          sha256Utf8(candidate),
          "logic-canon-auditor",
        );
        const [name] = await readdir(logicDir);
        const path = join(logicDir, name!);
        const record = JSON.parse(await readFile(path, "utf8"));
        record.rawResponse = JSON.stringify({
          passed: false,
          overall_score: 20,
          dimension_scores: { blueprint_transition: 20, causal_logic: 20, canon_continuity: 20, character_motivation: 20, state_inheritance: 20, hooks_disclosure: 20, narrative_clarity: 20 },
          issues: [{ severity: "critical", description: "rejected" }],
          summary: "rejected",
        });
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      }
      const extractor = vi.fn().mockRejectedValue(new Error("TRUTH_MODEL_CALLED_BEFORE_TERMINAL_GATE"));
      const validator = vi.fn().mockRejectedValue(new Error("TRUTH_MODEL_CALLED_BEFORE_TERMINAL_GATE"));
      const result = await runCanonicalTruthTransaction({
        bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
        candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
        predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
      });
      expect(result).toMatchObject({ status: "ARTIFACT_EVIDENCE_DEFECT" });
      expect(extractor).not.toHaveBeenCalled();
      expect(validator).not.toHaveBeenCalled();
    },
  );

  it("returns typed host failure without invoking either model role when host input binding is invalid", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-host-defect-")); roots.push(bookDir);
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn(); const validator = vi.fn();
    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate: "Ada opens the gate.", candidateSha256: SHA_A, predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    });
    expect(result).toMatchObject({ status: "HOST_APPLICATION_DEFECT", diagnostics: expect.arrayContaining([expect.stringMatching(/candidate SHA/i)]) });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("regenerates a damaged deterministic projection once, then returns typed projection failure", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-projection-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: '{"verdict":"PASS","diagnostics":[]}', logicalOperationId: "validate", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8('{"verdict":"PASS","diagnostics":[]}'), usage: USAGE });
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const projectionPath = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted/projections/current_state.md");
    await writeFile(projectionPath, "damaged projection", "utf8");
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    await writeFile(projectionPath, "damaged again", "utf8");
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "PROJECTION_DEFECT", repairExhausted: true });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("shares the one durable projection-repair budget when accepted authority survives but result.json is lost", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-accepted-projection-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const acceptedRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted");
    const projectionPath = join(acceptedRoot, "projections/current_state.md");

    await rm(join(acceptedRoot, "result.json"));
    await writeFile(projectionPath, "damaged projection", "utf8");
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");

    await rm(join(acceptedRoot, "result.json"));
    await writeFile(projectionPath, "damaged again", "utf8");
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "PROJECTION_DEFECT", repairExhausted: true });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("spends the durable projection-repair budget before rewriting any projection bytes", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-projection-admission-crash-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const acceptedRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted");
    const resultPath = join(acceptedRoot, "result.json");
    const projectionPath = join(acceptedRoot, "projections/current_state.md");
    await rm(resultPath);
    await writeFile(projectionPath, "damaged before admitted repair", "utf8");

    const actualLink = fs.link;
    const crash = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to) === join(acceptedRoot, "projection-repair.json")) throw new Error("repair marker publish crash");
      return actualLink(from, to);
    });
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow("repair marker publish crash");
    crash.mockRestore();
    await expect(readFile(join(acceptedRoot, "projection-repair.json"))).rejects.toThrow();
    expect(await readFile(projectionPath, "utf8")).toBe("damaged before admitted repair");

    await expect(runCanonicalTruthTransaction({
      ...input,
      onDurableBoundary: async (boundary: string) => {
        if (boundary === "AFTER_PROJECTION_REPAIR_ADMISSION") throw new Error("injected projection write crash");
      },
    } as never)).rejects.toThrow("injected projection write crash");
    await expect(readFile(join(acceptedRoot, "projection-repair.json"), "utf8")).resolves.toContain("PROJECTION_REPAIR");
    await expect(readFile(projectionPath, "utf8")).resolves.toBe("damaged before admitted repair");
    await expect(runCanonicalTruthTransaction(input)).resolves.toMatchObject({ status: "PROJECTION_DEFECT", repairExhausted: true });
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("admits at most one projection repair when concurrent replays both observe a missing marker", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-projection-concurrency-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const repairBoundary = vi.fn();
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
      onDurableBoundary: async (boundary: string) => { if (boundary === "AFTER_PROJECTION_REPAIR_ADMISSION") repairBoundary(); } } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const acceptedRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "accepted");
    await writeFile(join(acceptedRoot, "projections/current_state.md"), "damaged projection", "utf8");
    projectionMarkerRace.targetPath = join(acceptedRoot, "projection-repair.json");
    projectionMarkerRace.barrier = new Promise<void>((resolve) => { projectionMarkerRace.release = resolve; });

    const results = await Promise.all([
      runCanonicalTruthTransaction(input),
      runCanonicalTruthTransaction(input),
    ]);

    expect(projectionMarkerRace.arrivals).toBe(2);
    expect(repairBoundary).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === "PASS")).toHaveLength(1);
    expect(results.filter((result) => result.status === "PROJECTION_DEFECT")).toHaveLength(1);
    await expect(readFile(join(acceptedRoot, "projection-repair.json"), "utf8"))
      .resolves.toContain("PROJECTION_REPAIR");
  });

  it("routes malformed extractor bytes through the one candidate-bound delta-only repair", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-malformed-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const malformed = "not-json";
    const extractor = vi.fn()
      .mockResolvedValueOnce({ rawProposal: malformed, logicalOperationId: "extract-initial", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(malformed), usage: USAGE })
      .mockResolvedValueOnce({ rawProposal: readyProposal(), logicalOperationId: "extract-repair", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-repair", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });

    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    });
    expect(result.status).toBe("PASS");
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(extractor.mock.calls[1]?.[0]).toMatchObject({ extractionKind: "REPAIR", repairOrdinal: 1, repairDiagnostics: expect.any(Array) });
  });

  it("fails closed after malformed INITIAL and malformed REPAIR without invoking Validator", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-malformed-twice-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const malformed = "not-json";
    const extractor = vi.fn().mockResolvedValue({
      rawProposal: malformed, logicalOperationId: "extract-malformed", inputFingerprint: SHA_B,
      providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(malformed), usage: USAGE,
    });
    const validator = vi.fn();
    await expect(runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator,
    })).resolves.toMatchObject({ status: "DELTA_EXTRACTION_DEFECT", repairExhausted: true });
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(validator).not.toHaveBeenCalled();
  });

  it("rejects missing, mutated, or self-consistent fabricated model context records on replay", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-context-records-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract-context-record", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-context-record", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const input = { bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2, candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256, predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator } as const;
    expect((await runCanonicalTruthTransaction(input)).status).toBe("PASS");
    const cycleRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate), "initial");
    const extractionPath = join(cycleRoot, "extraction-context.json");
    const original = await readFile(extractionPath, "utf8");
    await rm(extractionPath);
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/extraction context|model context|missing/i);
    await writeFile(extractionPath, original, "utf8");
    const fabricated = JSON.parse(original);
    fabricated.requestSha256 = "f".repeat(64);
    const { contextSha256: _old, ...unsigned } = fabricated;
    fabricated.contextSha256 = canonicalSha256(unsigned);
    await writeFile(extractionPath, `${canonicalJson(fabricated)}\n`, "utf8");
    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/extraction context|request|model context/i);

    const validationPath = join(cycleRoot, "validation-context.json");
    const originalExtractionContext = JSON.parse(original);
    const originalValidationContext = JSON.parse(await readFile(validationPath, "utf8"));
    const forgeContext = (record: Record<string, unknown>) => {
      const request = { ...(record.request as Record<string, unknown>), committedAuthority: "FORGED_EMBEDDED_AUTHORITY" };
      const withoutHash = { ...record, request, requestSha256: canonicalSha256(request) };
      delete (withoutHash as { contextSha256?: string }).contextSha256;
      return { ...withoutHash, contextSha256: canonicalSha256(withoutHash) };
    };
    const forgedExtractionContext = forgeContext(originalExtractionContext);
    const forgedValidationContext = forgeContext(originalValidationContext);
    await writeFile(extractionPath, `${canonicalJson(forgedExtractionContext)}\n`, "utf8");
    await writeFile(validationPath, `${canonicalJson(forgedValidationContext)}\n`, "utf8");

    const extractionArtifactPath = join(cycleRoot, "extraction.json");
    const extractionArtifact = JSON.parse(await readFile(extractionArtifactPath, "utf8"));
    await writeFile(extractionArtifactPath, `${canonicalJson({ ...extractionArtifact, contextSha256: forgedExtractionContext.contextSha256 })}\n`, "utf8");
    const semanticPath = join(cycleRoot, "semantic-validation.json");
    const semanticArtifact = JSON.parse(await readFile(semanticPath, "utf8"));
    const forgedSemantic = { ...semanticArtifact, contextSha256: forgedValidationContext.contextSha256 };
    await writeFile(semanticPath, `${canonicalJson(forgedSemantic)}\n`, "utf8");

    const acceptedRoot = join(cycleRoot, "..");
    const acceptedAuthorityPath = join(acceptedRoot, "accepted", "accepted-authority.json");
    const acceptedAuthority = JSON.parse(await readFile(acceptedAuthorityPath, "utf8"));
    await writeFile(acceptedAuthorityPath, `${canonicalJson({
      ...acceptedAuthority,
      extractionContext: forgedExtractionContext,
      validationContext: forgedValidationContext,
      extractorEvidence: { ...acceptedAuthority.extractorEvidence, contextSha256: forgedExtractionContext.contextSha256 },
      semanticValidation: forgedSemantic,
    })}\n`, "utf8");
    const resultPath = join(acceptedRoot, "accepted", "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    await writeFile(resultPath, `${canonicalJson({
      ...result,
      extractionContext: forgedExtractionContext,
      validationContext: forgedValidationContext,
      extractorEvidence: { ...result.extractorEvidence, contextSha256: forgedExtractionContext.contextSha256 },
      semanticValidation: forgedSemantic,
    })}\n`, "utf8");

    await expect(runCanonicalTruthTransaction(input)).rejects.toThrow(/current request|committed authority|context|preimage/i);
  });

  it("binds replay to immutable full context and rejects changed memo, committed authority, or predecessor truth", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-context-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const pass = '{"verdict":"PASS","diagnostics":[]}';
    const extractor = vi.fn().mockResolvedValue({ rawProposal: readyProposal(), logicalOperationId: "extract-context", inputFingerprint: SHA_B, providerArtifactSha256: SHA_C, responseContentSha256: sha256Utf8(readyProposal()), usage: USAGE });
    const validator = vi.fn().mockResolvedValue({ verdict: "PASS", diagnostics: [], rawResponse: pass, logicalOperationId: "validate-context", inputFingerprint: SHA_C, providerArtifactSha256: SHA_D, responseContentSha256: sha256Utf8(pass), usage: USAGE });
    const base = {
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), committedAuthority: "authority-a", chapterMemo: "memo-a", extractor, validator,
    } as const;
    expect((await runCanonicalTruthTransaction(base)).status).toBe("PASS");
    await expect(runCanonicalTruthTransaction({ ...base, chapterMemo: "memo-b" })).rejects.toThrow(/context|immutable|request/i);
    await expect(runCanonicalTruthTransaction({ ...base, committedAuthority: "authority-b" })).rejects.toThrow(/context|immutable|request/i);
    if (base.predecessor.lineage.kind !== "BASELINE") throw new Error("expected baseline fixture");
    const changedPredecessor: StructuredTruthV1 = {
      ...base.predecessor,
      lineage: { ...base.predecessor.lineage, baselineSourceManifestSha256: "e".repeat(64) },
    };
    await expect(runCanonicalTruthTransaction({
      ...base,
      predecessor: changedPredecessor,
    })).rejects.toThrow(/context|immutable|request/i);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(1);
  });

  it("fails closed before evidence or model admission for an abandoned attempt", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-canonical-abandoned-")); roots.push(bookDir);
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const predecessor = await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 });
    await abandonChapterTransactionAttempt({
      bookDir, bookId: "book-1", chapterNumber: 2, transactionId: transaction.transactionId,
      runtimeSnapshot: "{}\n", abandonedAt: "2026-09-04T00:01:00.000Z",
    });
    const extractor = vi.fn(); const validator = vi.fn();
    const result = await runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor, extractor, validator,
    });
    expect(result).toMatchObject({ status: "HOST_APPLICATION_DEFECT", diagnostics: expect.arrayContaining([expect.stringMatching(/abandon/i)]) });
    expect(extractor).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  it("rechecks current attempt after a model returns and before persisting its evidence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-canonical-abandon-inflight-")); roots.push(projectRoot);
    const bookDir = join(projectRoot, "books", "book-1");
    const candidate = "Ada opens the gate.";
    const { transaction } = await beginTruthTransaction(bookDir);
    const execution = createAutonomousProviderExecution({ projectRoot, bookId: "book-1", jobId: "late-complete",
      getActiveStage: () => ({ stage: "TRUTH_EXTRACTION", role: "truth-extractor", provider: "test-provider", model: "truth-extractor-model", transactionId: transaction.transactionId }) });
    let artifactPath = "";
    let freshTransactionId = "";
    const extractor = vi.fn().mockImplementation(async (_request, frozen) => {
      const response = await execution.runProviderCall(transaction.chapterNumber, async () => {
        await abandonChapterTransactionAttempt({
          bookDir, bookId: "book-1", chapterNumber: 2, transactionId: transaction.transactionId,
          runtimeSnapshot: "{}\n", abandonedAt: "2026-09-04T00:02:00.000Z",
        });
        const fresh = await beginChapterTransaction({ bookDir, bookId: "book-1", chapterNumber: 2, productionAuthority: "fixture" });
        freshTransactionId = fresh.transactionId;
        return { content: readyProposal(), usage: USAGE };
      }, { provider: frozen.provider, model: frozen.model, inputFingerprint: frozen.inputFingerprint });
      artifactPath = execution.responseArtifactPath(frozen.inputFingerprint, frozen.provider, frozen.model, transaction.chapterNumber);
      const bytes = await readFile(artifactPath);
      return { rawProposal: response.content, logicalOperationId: artifactPath.split(/[\\/]/u).at(-1)!.replace(/\.json$/u, ""), inputFingerprint: frozen.inputFingerprint, providerArtifactSha256: sha256Utf8(bytes.toString("utf8")), responseContentSha256: sha256Utf8(response.content), usage: response.usage };
    });
    const candidateRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0002/staging/evidence/truth", sha256Utf8(candidate));
    await expect(runCanonicalTruthTransaction({
      bookDir, transactionId: transaction.transactionId, attemptId: "attempt-1", attemptNumber: 1, chapterNumber: 2,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: transaction.previousAuthoritySha256,
      predecessor: await loadCommittedTruthForWriter({ bookDir, chapterNumber: 2 }), extractor, validator: vi.fn(),
    })).rejects.toThrow(/abandon|current attempt|authority/i);
    await expect(readFile(join(candidateRoot, "initial", "extraction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(artifactPath, "utf8"))).toMatchObject({ transaction_id: transaction.transactionId, response_artifact_status: "COMPLETE" });
    expect(freshTransactionId).not.toBe(transaction.transactionId);
    await expect(readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0002/attempts/attempt-2/staging/evidence/truth", sha256Utf8(candidate), "initial/extraction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(extractor).toHaveBeenCalledTimes(1);
  });
});
