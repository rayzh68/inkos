import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../state/manager.js";
import * as chapterTransactions from "../production/chapter-transaction.js";
import * as baselineBuilder from "../production/first-v2-baseline.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { createAutonomousPipelineActions, runBoundedAutonomousScope } from "../production/bounded-autonomous-controller.js";
import { parseBookProductionMap } from "../production/book-production-map.js";
import {
  beginChapterTransaction,
  abandonChapterTransactionAttempt,
  assertChapterAuthorityMutationAllowed,
  assertChapterWriterStartAllowed,
  createChapterGenesis,
  finalizeChapterTransaction,
  inspectChapterAuthority,
  reconcileChapterProjections,
  reserveChapterTransactionProviderRequest,
  bindChapterTransactionProviderRequest,
  collectChapterProviderReferences,
  collectBoundChapterProviderRequests,
  deriveChapterProviderUsage,
  recordChapterTransactionOperation,
  recordChapterTransactionCandidate,
  recordChapterTransactionReviewEvidence,
  recordChapterTransactionReviewResult,
  resolveChapterProviderOperation,
  revalidateCanonicalTruthProviderEvidence,
  stageChapterCommitCandidate,
  stageTruthChapterCommitV2,
  loadCommittedTruthForWriter,
  verifyChapterCommit,
  verifyChapterCommitChain,
  ChapterArtifactEvidenceError,
  type ChapterProviderReference,
} from "../production/chapter-transaction.js";
import { validateBaselineAuthorityV1, type BaselineSourceManifestV1, type BaselineConstructionReceiptV1, type StructuredTruthV1 } from "../models/structured-truth.js";
import { admitChapterDeltaV1 } from "../state/chapter-delta-admission.js";
import { canonicalJson, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { buildProjectionManifestV1 } from "../state/projection-manifest.js";
import { renderStructuredTruthProjectionsV1 } from "../state/structured-truth-projections.js";
import { reduceStructuredTruthV1 } from "../state/structured-truth-reducer.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import { buildTruthExtractorMessages, TRUTH_EXTRACTOR_OPTIONS } from "../agents/truth-extractor.js";
import { buildTruthValidatorMessages, TRUTH_VALIDATOR_OPTIONS } from "../agents/truth-validator.js";
import { parseContinuityAuditResponse } from "../agents/continuity.js";
import { scoredLogicReviewFromAudit } from "../pipeline/bounded-review.js";
import { fingerprintReviewProviderRequest } from "../agents/commercial-reader.js";

const providerArtifactReadRace = vi.hoisted(() => ({
  targetPath: "",
  readCount: 0,
  afterRead: undefined as undefined | ((readNumber: number) => Promise<void> | void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const value = await (actual.readFile as (...readArgs: unknown[]) => Promise<unknown>)(...args);
      if (providerArtifactReadRace.targetPath && String(args[0]) === providerArtifactReadRace.targetPath) {
        providerArtifactReadRace.readCount += 1;
        await providerArtifactReadRace.afterRead?.(providerArtifactReadRace.readCount);
      }
      return value;
    },
  };
});

describe("chapter transaction convergence", () => {
  const roots: string[] = [];
  afterEach(async () => {
    providerArtifactReadRace.targetPath = "";
    providerArtifactReadRace.readCount = 0;
    providerArtifactReadRace.afterRead = undefined;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(lastTrustedChapter = 4, nestedBook = false) {
    const root = await mkdtemp(join(tmpdir(), "inkos-chapter-txn-"));
    roots.push(root);
    const bookDir = nestedBook ? join(root, "books", "book-a") : root;
    await mkdir(join(bookDir, "story", "snapshots", "4", "state"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    for (const chapter of [1, 2, 3, 4]) await writeFile(join(bookDir, "chapters", `${String(chapter).padStart(4, "0")}_Legacy.md`), `legacy ${chapter}`, "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([1, 2, 3, 4].map((number) => ({ number, title: `Legacy ${number}` }))), "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "current_state.md"), "state 4", "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 4 }), "utf-8");
    if (lastTrustedChapter === 3) {
      await mkdir(join(bookDir, "story/snapshots/3"), { recursive: true });
      await writeFile(join(bookDir, "story/snapshots/3/baseline.txt"), "trusted chapter three");
    }
    const genesis = await createChapterGenesis({
      bookDir,
      bookId: "book-a",
      lastTrustedChapter,
      trustedSnapshotDir: join(bookDir, "story", "snapshots", String(lastTrustedChapter)),
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    return { root, bookDir, genesis };
  }

  it("centralizes Genesis and committed chapter denial and fails closed on corrupt cutover evidence", async () => {
    const { bookDir } = await fixture();
    await expect(assertChapterAuthorityMutationAllowed({ bookDir, chapterNumber: 6 })).resolves.toBeUndefined();
    await expect(assertChapterAuthorityMutationAllowed({ bookDir, chapterNumber: 4 }))
      .rejects.toThrow("TRANSACTION_AUTHORITY_MUTATION_FORBIDDEN");
    await mkdir(join(bookDir, "story", "commits", "chapter-0005"), { recursive: true });
    await writeFile(join(bookDir, "story", "commits", "chapter-0005", "commit.json"), "immutable");
    await expect(assertChapterAuthorityMutationAllowed({ bookDir, chapterNumber: 5 }))
      .rejects.toThrow("TRANSACTION_AUTHORITY_MUTATION_FORBIDDEN");
    await expect(assertChapterAuthorityMutationAllowed({ bookDir, chapterNumber: 6 })).rejects.toThrow();
  });

  it("abandons one immutable staging attempt and starts a separately identified rewrite attempt", async () => {
    const { bookDir } = await fixture();
    const first = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1",
      createdAt: "2026-08-29T00:00:00.000Z",
    });
    const initial = "preserved initial candidate";
    await recordChapterTransactionCandidate({
      bookDir, transactionId: first.transactionId, label: "INITIAL", content: initial, sha256: first.hash(initial),
    });
    await recordChapterTransactionOperation({
      bookDir, transactionId: first.transactionId, logicalOperationId: "attempt-1-writer",
      stage: "WRITING", inputFingerprint: "b".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "c".repeat(64),
    });
    const providerArtifactPath = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses", "attempt-1-writer.json");
    const providerArtifact = '{"transaction_id":"attempt-1","response_artifact_status":"COMPLETE"}\n';
    await mkdir(join(providerArtifactPath, ".."), { recursive: true });
    await writeFile(providerArtifactPath, providerArtifact);
    const providerArtifactSha = first.hash(providerArtifact);
    await recordChapterTransactionReviewEvidence({
      bookDir, transactionId: first.transactionId, candidateSha256: first.hash(initial), reviewerRole: "logic-canon-auditor",
      evidence: { decision: "REVISION_REQUIRED" },
    });
    const resumed = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    expect(resumed.transactionId).toBe(first.transactionId);

    const abandonment = await abandonChapterTransactionAttempt({
      bookDir,
      bookId: "book-a",
      chapterNumber: 5,
      transactionId: first.transactionId,
      runtimeSnapshot: '{"status":"PAUSED_AMBIGUOUS_PROVIDER_OUTCOME","nextChapter":5}\n',
      abandonedAt: "2026-08-29T01:00:00.000Z",
    });
    expect(abandonment).toMatchObject({ transactionId: first.transactionId, attemptNumber: 1, chapterNumber: 5 });
    expect(await readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "abandonment.json"), "utf-8"))
      .toContain("OPERATOR_DISCARDED_STAGING_ATTEMPT");
    await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "runtime-at-abandon.json"), "utf-8"))
      .resolves.toContain("PAUSED_AMBIGUOUS_PROVIDER_OUTCOME");
    await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "candidates", "INITIAL", "body.md"), "utf-8"))
      .resolves.toBe(initial);

    expect(await inspectChapterAuthority({ bookDir })).toMatchObject({ state: "NOT_STARTED", latestChapter: 4, nextChapter: 5 });
    await expect(recordChapterTransactionOperation({
      bookDir, transactionId: first.transactionId, logicalOperationId: "late-operation",
      stage: "WRITING", inputFingerprint: "b".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "c".repeat(64),
    })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");
    await expect(recordChapterTransactionCandidate({
      bookDir, transactionId: first.transactionId, label: "REVISION_1", content: initial, sha256: first.hash(initial),
    })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");
    await expect(recordChapterTransactionReviewEvidence({
      bookDir, transactionId: first.transactionId, candidateSha256: first.hash(initial), reviewerRole: "logic-canon-auditor", evidence: {},
    })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");
    await expect(recordChapterTransactionReviewResult({ bookDir, transactionId: first.transactionId, result: {} }))
      .rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: first.transactionId, title: "must not stage", body, lengthSpec,
      review: {} as never, stateFiles: {}, snapshotFiles: {}, usage: {}, stateValidation: {} as never,
      providerReferences: [], completedAt: "2026-08-29T01:01:00.000Z",
    })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");
    await expect(finalizeChapterTransaction({ bookDir, transactionId: first.transactionId }))
      .rejects.toThrow("CHAPTER_ATTEMPT_ABANDONED");

    const second = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1",
      createdAt: "2026-08-29T02:00:00.000Z",
    });
    expect(second.attemptNumber).toBe(2);
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(second.previousAuthoritySha256).toBe(first.previousAuthoritySha256);
    expect(second.completedOperations).toEqual([]);
    expect((await inspectChapterAuthority({ bookDir })).activeTransactionId).toBe(second.transactionId);
    await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "attempts", "attempt-0002", "transaction.json"), "utf-8"))
      .resolves.toContain(second.transactionId);
    expect(first.hash(await readFile(providerArtifactPath))).toBe(providerArtifactSha);
    await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "attempts", "attempt-0002", "staging", "evidence", "candidates", "INITIAL", "body.md")))
      .rejects.toThrow();
    await expect(readdir(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "attempts", "attempt-0002", "staging", "evidence", "reviews")))
      .rejects.toThrow();
    await expect(assertChapterWriterStartAllowed({ bookDir, chapterNumber: 6 })).rejects.toThrow("CHAPTER_TRANSACTION_WRITER_START_AUTHORITY_MISMATCH");
  });

  it("blocks abandonment for committed and Genesis-bound chapters", async () => {
    const { bookDir } = await fixture();
    const committed = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: committed.transactionId });
    await expect(abandonChapterTransactionAttempt({
      bookDir, bookId: "book-a", chapterNumber: 5, transactionId: committed.transactionId, runtimeSnapshot: "{}\n",
    })).rejects.toThrow("CHAPTER_ATTEMPT_COMMIT_SELECTED");
    await expect(abandonChapterTransactionAttempt({
      bookDir, bookId: "book-a", chapterNumber: 4, transactionId: "genesis", runtimeSnapshot: "{}\n",
    })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDON_NOT_ALLOWED");
  });

  it("fails closed when an abandoned attempt loses its transaction identity", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await abandonChapterTransactionAttempt({
      bookDir, bookId: "book-a", chapterNumber: 5, transactionId: transaction.transactionId, runtimeSnapshot: "{}\n",
    });
    await writeFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "transaction.json"), "{", "utf-8");
    await expect(inspectChapterAuthority({ bookDir })).rejects.toThrow("CHAPTER_ATTEMPT_ABANDONMENT_AUTHORITY_MISMATCH");
  });

  const body = Array.from({ length: 2200 }, (_, index) => `w${index}`).join(" ");
  const lengthSpec = { target: 2200, softMin: 1980, softMax: 2420, hardMin: 1760, hardMax: 2640, countingMode: "en_words" as const };
  const defaultProviderOperations = [
    { role: "writer", stage: "WRITING", provider: "test-provider", model: "test-model" },
    { role: "auditor", stage: "LOGIC_REVIEW", provider: "test-provider", model: "logic-model" },
    { role: "commercial-reader", stage: "READER_REVIEW", provider: "test-provider", model: "commercial-model" },
  ];

  async function stagePassing(
    bookDir: string,
    chapterNumber = 5,
    transform?: (input: Parameters<typeof stageChapterCommitCandidate>[0]) => Parameters<typeof stageChapterCommitCandidate>[0],
    providerOperations = defaultProviderOperations,
  ) {
    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber, productionAuthority: "blueprint:v1",
    });
    const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    await mkdir(responseDir, { recursive: true });
    const providerReferences = [];
    for (const operation of providerOperations) {
      const logicalOperationId = `provider-step-${transaction.hash(`${transaction.transactionId}:${operation.role}:${operation.stage}`)}`;
      const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
      const responseContent = `${operation.role} model output for chapter ${chapterNumber}`;
      const inputFingerprint = transaction.hash(`${transaction.transactionId}:${operation.role}:input`);
      const artifact = {
        schema_version: "1.0", job_id: "test-job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
        transaction_id: transaction.transactionId, chapter_number: chapterNumber, role: operation.role, stage: operation.stage,
        provider: operation.provider, requested_model: operation.model, input_fingerprint: inputFingerprint,
        response_artifact_status: "COMPLETE", content_sha256: transaction.hash(responseContent), response: { content: responseContent },
        completed_at: "2026-08-28T00:00:00.000Z",
      };
      const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
      await writeFile(join(bookDir, artifactRelativePath), artifactBytes);
      providerReferences.push({
        transactionId: transaction.transactionId, logicalOperationId, chapterNumber, role: operation.role, stage: operation.stage,
        provider: operation.provider, requestedModel: operation.model, inputFingerprint, artifactRelativePath,
        artifactSha256: transaction.hash(artifactBytes), responseContentSha256: transaction.hash(responseContent), responseArtifactStatus: "COMPLETE" as const,
      });
    }
    const stageInput: Parameters<typeof stageChapterCommitCandidate>[0] = {
      bookDir,
      transactionId: transaction.transactionId,
      title: `Chapter ${chapterNumber}`,
      body,
      lengthSpec,
      review: {
        status: "APPROVED",
        grade: "A",
        revisionCount: 1,
        finalCandidateSha256: transaction.hash(body),
        findings: [],
        reviewerEvidence: [
          {
            reviewerRole: "logic-canon-auditor", provider: "test-provider", model: "logic-model",
            totalScore: 92, dimensionScores: { causal_logic: 92 }, decision: "APPROVED",
            findings: [], reviewedCandidateSha: transaction.hash(body),
          },
          {
            reviewerRole: "commercial-reader", provider: "test-provider", model: "commercial-model",
            totalScore: 90, dimensionScores: { commercial_appeal: 90 }, decision: "APPROVED_WITH_NOTES",
            findings: [], reviewedCandidateSha: transaction.hash(body),
          },
        ],
      },
      stateFiles: {
        "manifest.json": JSON.stringify({ schemaVersion: 2, lastAppliedChapter: chapterNumber, candidateSha256: transaction.hash(body), previousAuthoritySha256: transaction.previousAuthoritySha256 }),
        "current_state.json": JSON.stringify({ chapter: chapterNumber }),
        "current_state.md": `state ${chapterNumber}`,
      },
      snapshotFiles: {
        "state/manifest.json": JSON.stringify({ schemaVersion: 2, lastAppliedChapter: chapterNumber, candidateSha256: transaction.hash(body), previousAuthoritySha256: transaction.previousAuthoritySha256 }),
        "state/current_state.json": JSON.stringify({ chapter: chapterNumber }),
        "current_state.md": `state ${chapterNumber}`,
      },
      usage: { totalTokens: 42 },
      stateValidation: {
        chapterNumber,
        finalCandidateSha256: transaction.hash(body),
        previousAuthoritySha256: transaction.previousAuthoritySha256,
        passed: true,
        warnings: [],
      },
      providerReferences,
      completedAt: `2026-08-28T00:00:0${chapterNumber}.000Z`,
    };
    await stageChapterCommitCandidate(transform ? transform(stageInput) : stageInput);
    return transaction;
  }

  function firstV2Truth(): StructuredTruthV1 {
    return {
      schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: "book-a", throughChapter: 4,
      lineage: {
        kind: "BASELINE", predecessorCommitSha256: "a".repeat(64), baselineSourceManifestSha256: "b".repeat(64),
        seedVocabularyCatalogSha256: "c".repeat(64), baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: "d".repeat(64),
      },
      vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
      provenance: {
        schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0",
        canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
      },
    };
  }


  async function hostBaseline(bookDir: string) {
    let chain = await verifyChapterCommitChain({ bookDir });
    if (chain.latestChapter === 3) {
      const legacy = await stagePassing(bookDir, 4);
      await finalizeChapterTransaction({ bookDir, transactionId: legacy.transactionId });
      chain = await verifyChapterCommitChain({ bookDir });
    }
    const commit = chain.commits.at(-1)!;
    if (commit.kind !== "CHAPTER_COMMIT") throw new Error("Fixture requires a verified legacy Commit");
    const sourceFiles = Object.fromEntries(await Promise.all(commit.stateFiles.map(async (entry) =>
      [entry.relativePath, await readFile(join(bookDir, "story/commits/chapter-0004/state", entry.relativePath))] as const)));
    const sourceManifest: BaselineSourceManifestV1 = {
      schemaVersion: "1.0", kind: "BASELINE_SOURCE_MANIFEST", bookId: commit.bookId, throughChapter: 4,
      predecessorCommitSha256: commit.commitSha256, sourceStateTreeSha256: commit.stateTreeSha256,
      entries: commit.stateFiles.map((entry) => ({ path: entry.relativePath, sha256: entry.sha256, byteLength: entry.bytes })),
    };
    const truth = firstV2Truth();
    const receipt: BaselineConstructionReceiptV1 = {
      schemaVersion: "1.0", kind: "BASELINE_CONSTRUCTION_RECEIPT", bookId: commit.bookId, throughChapter: 4,
      predecessorCommitSha256: commit.commitSha256, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
      seedVocabularyCatalogSha256: canonicalSha256(truth.vocabulary),
      method: { kind: "DETERMINISTIC", builderId: "inkos.truth-baseline.builder.v1", builderVersion: "1.0" }, recordBindings: [],
    };
    Object.assign(truth, { lineage: { kind: "BASELINE", predecessorCommitSha256: commit.commitSha256,
      baselineSourceManifestSha256: canonicalSha256(sourceManifest), seedVocabularyCatalogSha256: receipt.seedVocabularyCatalogSha256,
      baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: canonicalSha256(receipt) } });
    validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles, chapterCommit: commit });
    const predecessorChapterBody = await readFile(join(bookDir, "story/commits/chapter-0004/chapter.md"), "utf8");
    return { verified: true as boolean | undefined, previousAuthoritySha256: commit.commitSha256, truth,
      truthSha256: canonicalSha256(truth), vocabularyCatalogSha256: canonicalSha256(truth.vocabulary),
      predecessorChapterBody, predecessorChapterBodySha256: sha256Utf8(predecessorChapterBody), sourceManifest, receipt };
  }

  function rehashBaseline(baseline: Awaited<ReturnType<typeof hostBaseline>>) {
    Object.assign(baseline.receipt, { baselineSourceManifestSha256: canonicalSha256(baseline.sourceManifest) });
    Object.assign(baseline.truth.lineage, {
      baselineSourceManifestSha256: canonicalSha256(baseline.sourceManifest),
      baselineConstructionReceiptSha256: canonicalSha256(baseline.receipt),
    });
    baseline.truthSha256 = canonicalSha256(baseline.truth);
  }

  it("automatic first-V2 cutover retires legacy staging and binds only committed source bytes", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const old = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    const candidate = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/old-candidate.txt");
    await writeFile(candidate, "uncommitted material must stay history");
    const request = { bookDir, bookId: "book-a", productionAuthority: "blueprint:v1", runtimeSnapshot: JSON.stringify({ nextChapter: 5, providerAttemptHistory: [] }) };
    const transaction = await chapterTransactions.prepareFirstV2Cutover(request);
    expect(transaction).toMatchObject({ chapterNumber: 5, truthMode: "CANONICAL_V2", attemptNumber: 2 });
    expect(transaction!.transactionId).not.toBe(old.transactionId);
    expect(await readFile(candidate, "utf8")).toBe("uncommitted material must stay history");
    const baseline = JSON.parse(await readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/attempts/attempt-0002/first-v2-baseline.json"), "utf8"));
    expect(baseline.sourceManifest.entries.map((entry: { path: string }) => entry.path)).toEqual(["current_state.json", "current_state.md", "manifest.json"]);
    expect(baseline.truth).toMatchObject({ throughChapter: 4, entities: [], facts: [], relations: [] });
    expect(await chapterTransactions.prepareFirstV2Cutover(request)).toMatchObject({ transactionId: transaction!.transactionId });
    expect(await loadCommittedTruthForWriter({ bookDir, chapterNumber: 5 })).toEqual(baseline.truth);
  });

  it("automatic first-V2 cutover fails closed for missing or unresolved Provider history", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const old = await stagePassing(bookDir, 5);
    const request = { bookDir, bookId: "book-a", productionAuthority: "blueprint:v1" };
    await expect(chapterTransactions.prepareFirstV2Cutover({ ...request, runtimeSnapshot: "{}" })).rejects.toThrow(/PROVIDER|HISTORY/);
    await expect(chapterTransactions.prepareFirstV2Cutover({ ...request, runtimeSnapshot: JSON.stringify({ nextChapter: 5, providerAttemptHistory: [{ transactionId: old.transactionId, chapterNumber: 5, logicalStepId: "unresolved", transportStarted: true, transportReturned: false }] }) })).rejects.toThrow(/PROVIDER|HISTORY/);
    expect(await inspectChapterAuthority({ bookDir })).toMatchObject({ activeTransactionId: old.transactionId });
  });

  it("automatic first-V2 cutover resumes after terminal abandonment before its descriptive marker", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const old = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await abandonChapterTransactionAttempt({ bookDir, bookId: "book-a", chapterNumber: 5, transactionId: old.transactionId, runtimeSnapshot: "original snapshot" });
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/abandonment.json"));
    const next = await chapterTransactions.prepareFirstV2Cutover({ bookDir, bookId: "book-a", productionAuthority: "blueprint:v1", runtimeSnapshot: "different current runtime" });
    expect(next).toMatchObject({ truthMode: "CANONICAL_V2", attemptNumber: 2 });
    expect(await readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/runtime-at-abandon.json"), "utf8")).toBe("original snapshot");
    expect(JSON.parse(await readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/abandonment.json"), "utf8"))).toMatchObject({ transactionId: old.transactionId });
  });

  it("automatic first-V2 cutover verifies exact orphan authority for Studio admission and recovers the same transaction", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const request = { bookDir, bookId: "book-a", productionAuthority: "blueprint:v1" };
    const first = await chapterTransactions.prepareFirstV2Cutover(request);
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
    const baseline = await readFile(join(root, "first-v2-baseline.json"));
    await rm(join(root, "transaction.json"));
    await expect(inspectChapterAuthority({ bookDir })).rejects.toThrow("FIRST_V2_BASELINE_TRANSACTION_MISSING");
    expect(await inspectChapterAuthority({ bookDir, allowRecoverableFirstV2Baseline: true })).toMatchObject({ state: "COMMITTED", nextChapter: 5 });
    const recovered = await chapterTransactions.prepareFirstV2Cutover(request);
    expect(recovered).toMatchObject({ transactionId: first!.transactionId });
    expect(await readFile(join(root, "first-v2-baseline.json"))).toEqual(baseline);
    await rm(join(root, "transaction.json"));
    await writeFile(join(root, "first-v2-baseline.json"), "{}");
    await expect(inspectChapterAuthority({ bookDir, allowRecoverableFirstV2Baseline: true })).rejects.toThrow(/ORPHAN|BASELINE/);
  });

  it("automatic first-V2 cutover preserves completed Provider history and never reuses old settlement", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const old = await stagePassing(bookDir, 5);
    const references = await collectChapterProviderReferences({ bookDir, chapterNumber: 5, transactionId: old.transactionId });
    const before = await Promise.all(references.map((reference) => readFile(join(bookDir, reference.artifactRelativePath))));
    const providerAttemptHistory = references.map((reference, index) => ({
      transportAttemptId: `old-transport-${index}`, logicalStepId: reference.logicalOperationId, transactionId: old.transactionId,
      chapterNumber: 5, role: reference.role, provider: reference.provider, requestedModel: reference.requestedModel,
      attempt: 1, classification: "SUCCESS", transportStarted: true, transportReturned: true, recordedAt: "2026-09-04T00:00:00.000Z",
    }));
    const runtimeSnapshot = JSON.stringify({ nextChapter: 5, status: "PAUSED_PIPELINE_ERROR", phase: "SETTLING_STATE", role: "state-validator-settlement-repair", providerAttemptHistory });
    const next = await chapterTransactions.prepareFirstV2Cutover({ bookDir, bookId: "book-a", productionAuthority: "blueprint:v1", runtimeSnapshot });
    expect(next).toMatchObject({ truthMode: "CANONICAL_V2", attemptNumber: 2, completedOperations: [] });
    expect(await Promise.all(references.map((reference) => readFile(join(bookDir, reference.artifactRelativePath))))).toEqual(before);
    expect(await readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/runtime-at-abandon.json"), "utf8")).toBe(runtimeSnapshot);
  });

  it("automatic first-V2 cutover reuses an already validated durable baseline without reconstructing it", async () => {
    const { bookDir } = await fixture(3);
    const firstV2Baseline = await hostBaseline(bookDir);
    const request = { bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1", truthMode: "CANONICAL_V2" as const, firstV2Baseline };
    const first = await beginChapterTransaction(request);
    expect(await chapterTransactions.prepareFirstV2Cutover(request)).toMatchObject({ transactionId: first.transactionId });
  });

  it("automatic first-V2 cutover leaves Genesis-only books on their existing admission path", async () => {
    const { bookDir } = await fixture();
    expect(await chapterTransactions.prepareFirstV2Cutover({ bookDir, bookId: "book-a", productionAuthority: "blueprint:v1" })).toBeUndefined();
    expect(await inspectChapterAuthority({ bookDir })).toMatchObject({ state: "NOT_STARTED", nextChapter: 5 });
  });

  it("automatic first-V2 cutover rejects mismatching current-transaction history even under another chapter", async () => {
    const { bookDir } = await fixture(3);
    await hostBaseline(bookDir);
    const old = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    const runtimeSnapshot = JSON.stringify({ nextChapter: 5, providerAttemptHistory: [{ transactionId: old.transactionId, chapterNumber: 4, logicalStepId: "bad-history", transportStarted: true, transportReturned: false }] });
    await expect(chapterTransactions.prepareFirstV2Cutover({ bookDir, bookId: "book-a", productionAuthority: "blueprint:v1", runtimeSnapshot })).rejects.toThrow(/PROVIDER|HISTORY/);
    expect(await inspectChapterAuthority({ bookDir })).toMatchObject({ activeTransactionId: old.transactionId });
  });

  it.each(["forged truth", "wrong predecessor", "wrong source", "wrong book", "wrong chapter"] as const)(
    "first-V2 host authority rejects %s despite verified true and rehashed caller evidence", async (attack) => {
      const { bookDir } = await fixture(3);
      const baseline = await hostBaseline(bookDir);
      if (attack === "forged truth") Object.assign(baseline.truth.lineage, { baselineMethod: "SEMANTIC_EXTRACTION" });
      if (attack === "wrong predecessor") {
        Object.assign(baseline.sourceManifest, { predecessorCommitSha256: "e".repeat(64) });
        Object.assign(baseline.receipt, { predecessorCommitSha256: "e".repeat(64) });
        Object.assign(baseline.truth.lineage, { predecessorCommitSha256: "e".repeat(64) });
      }
      if (attack === "wrong source") Object.assign(baseline.sourceManifest.entries[0]!, { sha256: "e".repeat(64) });
      if (attack === "wrong book") {
        Object.assign(baseline.truth, { bookId: "different-book" });
        Object.assign(baseline.sourceManifest, { bookId: "different-book" });
        Object.assign(baseline.receipt, { bookId: "different-book" });
      }
      if (attack === "wrong chapter") {
        Object.assign(baseline.truth, { throughChapter: 3 });
        Object.assign(baseline.sourceManifest, { throughChapter: 3 });
        Object.assign(baseline.receipt, { throughChapter: 3 });
      }
      rehashBaseline(baseline);
      await expect(beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5,
        productionAuthority: "host-authority-test", truthMode: "CANONICAL_V2", firstV2Baseline: baseline }))
        .rejects.toThrow();
      await expect(readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/transaction.json"))).rejects.toThrow();
      expect((await inspectChapterAuthority({ bookDir })).latestChapter).toBe(4);
    });

  it.each([true, false, undefined])("first-V2 host authority admits valid evidence with descriptive verified=%s", async (verified) => {
    const { bookDir } = await fixture(3);
    const baseline = await hostBaseline(bookDir);
    if (verified === undefined) Reflect.deleteProperty(baseline, "verified");
    else baseline.verified = verified;
    const request = { bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "host-authority-test",
      truthMode: "CANONICAL_V2" as const, firstV2Baseline: baseline };
    const transaction = await beginChapterTransaction(request);
    expect(transaction.firstV2BaselineSha256).toBe(canonicalSha256(baseline));
    const { firstV2Baseline: _baseline, ...restart } = request;
    expect((await beginChapterTransaction(restart)).transactionId).toBe(transaction.transactionId);
    expect(await loadCommittedTruthForWriter({ bookDir, chapterNumber: 5 })).toEqual(baseline.truth);
  });

  it("first-V2 host authority rejects coordinated persisted tamper with recomputed baseline hash and transaction identity", async () => {
    const { bookDir } = await fixture(3);
    const baseline = await hostBaseline(bookDir);
    const request = { bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "host-authority-test", truthMode: "CANONICAL_V2" as const };
    await beginChapterTransaction({ ...request, firstV2Baseline: baseline });
    Object.assign(baseline.truth.lineage, { baselineMethod: "SEMANTIC_EXTRACTION" });
    rehashBaseline(baseline);
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
    const record = JSON.parse(await readFile(join(root, "transaction.json"), "utf8"));
    record.firstV2BaselineSha256 = canonicalSha256(baseline);
    record.transactionId = `chapter-txn-${canonicalSha256({ bookId: record.bookId, chapterNumber: record.chapterNumber,
      previousAuthoritySha256: record.previousAuthoritySha256, productionAuthority: record.productionAuthority,
      truthMode: record.truthMode, firstV2BaselineSha256: record.firstV2BaselineSha256 }).slice(0, 40)}`;
    await writeFile(join(root, "first-v2-baseline.json"), canonicalJson(baseline));
    await writeFile(join(root, "transaction.json"), canonicalJson(record));
    await expect(beginChapterTransaction(request)).rejects.toThrow();
    await expect(loadCommittedTruthForWriter({ bookDir, chapterNumber: 5 })).rejects.toThrow();
  });

  async function rehashAttackerControlledPayload(root: string): Promise<void> {
    const path = join(root, "commit.json");
    const { commitSha256: _old, ...unsigned } = JSON.parse(await readFile(path, "utf8"));
    unsigned.bundlePayloadFiles = await Promise.all(unsigned.bundlePayloadFiles.map(async (entry: { relativePath: string }) => {
      const bytes = await readFile(join(root, entry.relativePath));
      return { relativePath: entry.relativePath, sha256: sha256Utf8(bytes.toString("utf8")), bytes: bytes.length };
    }));
    unsigned.bundlePayloadTreeSha256 = canonicalSha256(unsigned.bundlePayloadFiles);
    await writeFile(path, JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }));
  }

  it("selects exactly one immutable terminal outcome when abandonment races Commit", async () => {
    const { bookDir } = await fixture();
    const transaction = await stagePassing(bookDir);
    const results = await Promise.allSettled([
      abandonChapterTransactionAttempt({ bookDir, bookId: "book-a", chapterNumber: 5, transactionId: transaction.transactionId, runtimeSnapshot: "{}" }),
      finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const root = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005");
    const terminal = JSON.parse(await readFile(join(root, "terminal-outcome.json"), "utf8"));
    expect(["ABANDONED", "COMMIT_SELECTED"]).toContain(terminal.outcome);
    expect(terminal.transactionId).toBe(transaction.transactionId);
    expect(terminal.previousAuthoritySha256).toBe(transaction.previousAuthoritySha256);
    if (terminal.outcome === "ABANDONED") {
      await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow();
      await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId })).rejects.toThrow();
    } else {
      expect((await verifyChapterCommit({ bookDir, chapterNumber: 5 })).commitSha256).toBe(terminal.commitSha256);
      await expect(abandonChapterTransactionAttempt({ bookDir, bookId: "book-a", chapterNumber: 5, transactionId: transaction.transactionId, runtimeSnapshot: "{}" })).rejects.toThrow();
    }
  });

  it("binds the complete 51-file first-V2 no-repair bundle and rejects unexpected files and empty directories", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const commit = await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    expect(commit.kind).toBe("TRUTH_CHAPTER_COMMIT");
    if (commit.kind !== "TRUTH_CHAPTER_COMMIT") throw new Error("not V2");
    expect(commit.bundlePayloadFiles).toHaveLength(50);
    const root = join(bookDir, "story", "commits", "chapter-0005");
    await writeFile(join(root, "unexpected.json"), "{}");
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/bundle|inventory/i);
    await rm(join(root, "unexpected.json"));
    await mkdir(join(root, "empty"));
    await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId })).rejects.toThrow(/bundle|directory/i);
  });

  it("rejects V2 staging when the transaction durable mode is not canonical", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    const path = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/transaction.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.truthMode = "LEGACY_V1";
    delete record.firstV2BaselineSha256;
    await writeFile(path, JSON.stringify(record));
    await expect(stageTruthChapterCommitV2(stageInput)).rejects.toThrow("CANONICAL_TRANSACTION_IDENTITY_MISMATCH");
  });

  it.each(["operation", "review-result", "candidate", "review-evidence"] as const)("publishes canonical %s only through complete no-clobber publication", async (kind) => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const common = { bookDir, transactionId: transaction.transactionId };
    const body = "new immutable candidate";
    const write = kind === "operation" ? () => recordChapterTransactionOperation({ ...common, logicalOperationId: "new-op", stage: "TRUTH_EXTRACTION", inputFingerprint: "a".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "b".repeat(64) })
      : kind === "candidate" ? () => recordChapterTransactionCandidate({ ...common, label: "REVISION_2", content: body, sha256: sha256Utf8(body) })
      : kind === "review-result" ? () => recordChapterTransactionReviewResult({ ...common, result: { status: "APPROVED" } })
      : () => recordChapterTransactionReviewEvidence({ ...common, candidateSha256: sha256Utf8(body), reviewerRole: "logic-canon-auditor", evidence: { decision: "REVISION_REQUIRED" } });
    const crash = vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("immutable publish crash"));
    try { await expect(write()).rejects.toThrow(); }
    finally { crash.mockRestore(); }
    await write();
    await write();
  });

  it.each(["reservation", "binding"])("publishes canonical Provider %s with complete immutable bytes", async (kind) => {
    const { bookDir } = await fixture(3);
    await stageV2Passing(bookDir);
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/evidence/provider-requests");
    const directory = join(root, kind === "reservation" ? "reservations" : "bindings");
    const path = join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    await rm(path);
    const write = () => kind === "reservation" ? reserveChapterTransactionProviderRequest({ ...record, bookDir }) : bindChapterTransactionProviderRequest({ ...record, bookDir });
    const crash = vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("immutable request publish crash"));
    try { await expect(write()).rejects.toThrow(); }
    finally { crash.mockRestore(); }
    await expect(readFile(path)).rejects.toThrow();
    await write();
    await write();
  });

  it("publishes canonical transaction marker last and converges identical claims after publication failure", async () => {
    const { bookDir } = await fixture(3);
    const firstV2Baseline = await hostBaseline(bookDir);
    const request = { bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "test", truthMode: "CANONICAL_V2" as const, firstV2Baseline };
    const path = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/transaction.json");
    const actualLink = fs.link;
    const crash = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to) === path) throw new Error("transaction marker publish crash");
      return actualLink(from, to);
    });
    try { await expect(beginChapterTransaction(request)).rejects.toThrow("transaction marker publish crash"); }
    finally { crash.mockRestore(); }
    await expect(readFile(path)).rejects.toThrow();
    const transactions = await Promise.all(Array.from({ length: 4 }, (_, index) => beginChapterTransaction({ ...request, createdAt: `2026-09-05T00:00:0${index}.000Z` })));
    expect(new Set(transactions.map((transaction) => transaction.transactionId)).size).toBe(1);
    expect(new Set(transactions.map((transaction) => transaction.createdAt)).size).toBe(1);
  });

  it("does not clean another V2 publisher's unique staging directory", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    const bundle = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle");
    await rm(bundle, { recursive: true });
    const other = `${bundle}.tmp-other-publisher`;
    await mkdir(other);
    await writeFile(join(other, "in-progress"), "owned by another call");
    await stageTruthChapterCommitV2(stageInput);
    expect(await readFile(join(other, "in-progress"), "utf8")).toBe("owned by another call");
  });

  async function stageV2Passing(
    bookDir: string,
    chapterNumber = 5,
    options: {
      providerExtractorRawResponse?: string;
      extractorProviderUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      providerActualCostUsd?: number;
      logicReviewLanguage?: "zh" | "en";
      omitTerminalRequestAuthorities?: boolean;
      productionAuthority?: string;
      lengthSpec?: Parameters<typeof stageTruthChapterCommitV2>[0]["lengthSpec"];
    } = {},
  ) {
    const firstV2Baseline = chapterNumber === 5 ? await hostBaseline(bookDir) : undefined;
    const chain = await verifyChapterCommitChain({ bookDir });
    const predecessor = firstV2Baseline?.truth ?? await loadCommittedTruthForWriter({ bookDir, chapterNumber });
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber, productionAuthority: options.productionAuthority ?? "blueprint:v2", truthMode: "CANONICAL_V2", firstV2Baseline });
    const candidate = body;
    const rawProposal = JSON.stringify({ schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", operations: [], evidence: [], ambiguities: [] });
    const extractionRequest = {
      transactionId: transaction.transactionId, attemptId: `attempt-${transaction.attemptNumber}`, chapterNumber,
      candidate, candidateSha256: sha256Utf8(candidate), predecessorTruthSha256: canonicalSha256(predecessor),
      predecessorCommitSha256: chain.latestAuthoritySha256, vocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
      extractionKind: "INITIAL" as const, repairOrdinal: 0 as const, predecessorTruthJson: canonicalJson(predecessor),
      vocabularyCatalogJson: canonicalJson(predecessor.vocabulary), committedAuthority: "",
    };
    const responseDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    await mkdir(responseDir, { recursive: true });
    await recordChapterTransactionCandidate({
      bookDir, transactionId: transaction.transactionId, label: "INITIAL", content: candidate, sha256: sha256Utf8(candidate),
    });
    const operations = [
      { role: "writer", stage: "WRITING", model: "writer-model" },
      { role: "logic-canon-auditor", stage: "LOGIC_REVIEW", model: "logic-model" },
      { role: "commercial-reader", stage: "READER_REVIEW", model: "commercial-model" },
      { role: "truth-extractor", stage: "TRUTH_EXTRACTION", model: "extractor-model" },
      { role: "truth-validator", stage: "TRUTH_VALIDATION", model: "validator-model" },
    ];
    const providerResponseUsage = (role: string) => ({
      ...(role === "truth-extractor" && options.extractorProviderUsage
        ? options.extractorProviderUsage
        : { promptTokens: 2, completionTokens: 3, totalTokens: 5 }),
      ...(options.providerActualCostUsd !== undefined ? { actualCostUsd: options.providerActualCostUsd } : {}),
    });
    const committedUsage = () => ({
      promptTokens: 2, completionTokens: 3, totalTokens: 5,
      ...(options.providerActualCostUsd !== undefined ? { actualCostUsd: options.providerActualCostUsd } : {}),
    });
    const providerReferences: ChapterProviderReference[] = [];
    const reviewRequests = new Map<string, {
      provider: string; model: string; messages: readonly { readonly role: "user"; readonly content: string }[];
      temperature: number; maxTokens: number; stream: boolean; inputFingerprint: string; reviewLanguage: "zh" | "en";
      webSearch: boolean; extra: Readonly<Record<string, unknown>>;
    }>();
    const logicReviewLanguage = options.logicReviewLanguage ?? "en";
    const logicRawResponse = JSON.stringify({
      passed: true,
      overall_score: 92,
      dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 },
      issues: logicReviewLanguage === "zh" ? [{ severity: "warning", description: "已核验", suggestion: "保留" }] : [],
      summary: "approved",
    });
    for (const operation of operations) {
      const logicalOperationId = `provider-step-${sha256Utf8(`${transaction.transactionId}:${operation.role}:${operation.stage}`)}`;
      const responseContent = operation.role === "truth-extractor"
        ? options.providerExtractorRawResponse ?? rawProposal
        : operation.role === "truth-validator"
          ? '{"verdict":"PASS","diagnostics":[]}'
          : operation.role === "logic-canon-auditor"
            ? logicRawResponse
            : operation.role === "commercial-reader"
              ? JSON.stringify({ total_score: 92, dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED", findings: [] })
              : `${operation.role} response`;
      const extractorExecutionBase = operation.role === "truth-extractor" ? {
        provider: "test-provider",
        model: operation.model,
        messages: buildTruthExtractorMessages(extractionRequest),
        temperature: TRUTH_EXTRACTOR_OPTIONS.temperature,
        maxTokens: TRUTH_EXTRACTOR_OPTIONS.maxTokens,
        stream: false,
        webSearch: false,
        extra: {},
      } : null;
      const reviewRequestBase = operation.role === "logic-canon-auditor" || operation.role === "commercial-reader" ? {
        provider: "test-provider", model: operation.model,
        messages: [{ role: "user" as const, content: operation.role === "logic-canon-auditor"
          ? `${logicReviewLanguage === "zh" ? "## 待审章节内容" : "## Chapter Content Under Review"}\n${candidate}`
          : `Candidate:\n${candidate}` }],
        temperature: operation.role === "logic-canon-auditor" ? 0.3 : 0.2,
        maxTokens: 4096, stream: false, webSearch: false, extra: {},
        reviewLanguage: operation.role === "logic-canon-auditor" ? logicReviewLanguage : "en" as const,
      } : null;
      const inputFingerprint = extractorExecutionBase
        ? sha256Utf8(JSON.stringify({ provider: extractorExecutionBase.provider, model: extractorExecutionBase.model,
            messages: extractorExecutionBase.messages, temperature: extractorExecutionBase.temperature,
            maxTokens: extractorExecutionBase.maxTokens, stream: extractorExecutionBase.stream }))
        : reviewRequestBase ? fingerprintReviewProviderRequest(reviewRequestBase) : sha256Utf8(`${operation.role}:${chapterNumber}`);
      if (reviewRequestBase) reviewRequests.set(operation.role, { ...reviewRequestBase, inputFingerprint });
      const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
      const artifact = {
        schema_version: "1.0", job_id: "test-job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
        transaction_id: transaction.transactionId, chapter_number: chapterNumber, role: operation.role, stage: operation.stage,
        provider: "test-provider", requested_model: operation.model, input_fingerprint: inputFingerprint,
        response_artifact_status: "COMPLETE", content_sha256: sha256Utf8(responseContent), response: {
          content: responseContent,
          usage: providerResponseUsage(operation.role),
        },
        completed_at: "2026-09-04T00:00:00.000Z",
      };
      const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
      await writeFile(join(bookDir, artifactRelativePath), bytes);
      providerReferences.push({
        transactionId: transaction.transactionId, logicalOperationId, chapterNumber, role: operation.role, stage: operation.stage,
        provider: "test-provider", requestedModel: operation.model, inputFingerprint, artifactRelativePath,
        artifactSha256: transaction.hash(bytes), responseContentSha256: sha256Utf8(responseContent), responseArtifactStatus: "COMPLETE" as const,
      });
    }
    const extractorReference = providerReferences.find((reference) => reference.role === "truth-extractor")!;
    let validatorReference = providerReferences.find((reference) => reference.role === "truth-validator")!;
    const admission = admitChapterDeltaV1({
      rawProposal, candidate, predecessor,
      host: {
        transactionId: transaction.transactionId, attemptId: `attempt-${transaction.attemptNumber}`, bookId: "book-a", chapterNumber,
        candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: chain.latestAuthoritySha256,
        predecessorTruthSha256: canonicalSha256(predecessor), predecessorVocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
        extractorLogicalOperationId: extractorReference.logicalOperationId, extractorInputFingerprint: extractorReference.inputFingerprint,
        providerArtifactSha256: extractorReference.artifactSha256, responseContentSha256: extractorReference.responseContentSha256,
      },
    });
    if (admission.status !== "ACCEPTED") throw new Error("expected accepted V2 fixture");
    const resultingTruth = reduceStructuredTruthV1({ predecessor, acceptedDelta: admission.acceptedDelta });
    const projections = renderStructuredTruthProjectionsV1(resultingTruth);
    const projectionManifest = buildProjectionManifestV1({ truthSha256: canonicalSha256(resultingTruth), projections });
    const applicationReceipt = {
      schemaVersion: "1.0" as const, kind: "TRUTH_APPLICATION_RECEIPT" as const,
      transactionId: transaction.transactionId, attemptId: `attempt-${transaction.attemptNumber}`,
      candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: chain.latestAuthoritySha256,
      predecessorTruthSha256: canonicalSha256(predecessor), acceptedDeltaSha256: canonicalSha256(admission.acceptedDelta),
      deltaId: admission.acceptedDelta.deltaId, admissionSha256: canonicalSha256(admission), resultingTruthSha256: canonicalSha256(resultingTruth),
      operationOutcomes: [], reducerId: "inkos.structured-truth.reducer.v1" as const, reducerVersion: "1.0" as const,
    };
    const { reviewedAt: _logicReviewedAt, tokenUsage: _logicTokenUsage, ...parsedLogicReview } = scoredLogicReviewFromAudit(
      parseContinuityAuditResponse(logicRawResponse, logicReviewLanguage),
      { candidateSha: sha256Utf8(candidate), provider: "test-provider", model: "logic-model" },
    );
    const logicReview = {
      ...parsedLogicReview,
      reviewerRole: "logic-canon-auditor" as const,
      provider: "test-provider",
      model: "logic-model",
      decision: parsedLogicReview.decision as "APPROVED" | "APPROVED_WITH_NOTES",
    };
    const commercialReview = { reviewerRole: "commercial-reader" as const, provider: "test-provider", model: "commercial-model", totalScore: 92, dimensionScores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED" as const, findings: [], reviewedCandidateSha: sha256Utf8(candidate) };
    const truthContext = {
      schemaVersion: "1.0", kind: "CANONICAL_TRUTH_CONTEXT", transactionId: transaction.transactionId,
      attemptId: `attempt-${transaction.attemptNumber}`, attemptNumber: transaction.attemptNumber,
      chapterNumber, candidateSha256: sha256Utf8(candidate), predecessorCommitSha256: chain.latestAuthoritySha256,
      predecessorTruthSha256: canonicalSha256(predecessor), predecessorVocabularyCatalogSha256: canonicalSha256(predecessor.vocabulary),
      committedAuthoritySha256: sha256Utf8(""), chapterMemoSha256: sha256Utf8(""),
      extractorPromptVersion: "inkos.truth-extractor.prompt.v1", extractorSchemaVersion: "ChapterDeltaProposalV1/1.0",
      validatorPromptVersion: "inkos.truth-validator.prompt.v1", validatorSchemaVersion: "TruthValidationResult/1.0",
    } as const;
    const truthContextSha256 = canonicalSha256(truthContext);
    const extractionContextUnsigned = {
      schemaVersion: "1.0" as const, kind: "CANONICAL_TRUTH_MODEL_CONTEXT" as const, baseContextSha256: truthContextSha256,
      role: "truth-extractor" as const, stage: "TRUTH_EXTRACTION" as const, extractionKind: "INITIAL" as const,
      repairOrdinal: 0 as const, requestSha256: canonicalSha256(extractionRequest), request: extractionRequest,
      execution: {
        provider: extractorReference.provider,
        model: extractorReference.requestedModel,
        messages: buildTruthExtractorMessages(extractionRequest),
        temperature: TRUTH_EXTRACTOR_OPTIONS.temperature,
        maxTokens: TRUTH_EXTRACTOR_OPTIONS.maxTokens,
        stream: false,
        webSearch: false,
        extra: {},
        fullRequestSha256: canonicalSha256({
          provider: extractorReference.provider, model: extractorReference.requestedModel,
          messages: buildTruthExtractorMessages(extractionRequest), temperature: TRUTH_EXTRACTOR_OPTIONS.temperature,
          maxTokens: TRUTH_EXTRACTOR_OPTIONS.maxTokens, stream: false, webSearch: false, extra: {},
        }),
        inputFingerprint: extractorReference.inputFingerprint,
      },
    };
    const extractionContext = { ...extractionContextUnsigned, contextSha256: canonicalSha256(extractionContextUnsigned) };
    const extraction = {
      logicalOperationId: extractorReference.logicalOperationId, inputFingerprint: extractorReference.inputFingerprint,
      providerArtifactSha256: extractorReference.artifactSha256, responseContentSha256: extractorReference.responseContentSha256,
      contextSha256: extractionContext.contextSha256,
    };
    const validationRequest = {
      candidate, candidateSha256: sha256Utf8(candidate), predecessorTruthJson: canonicalJson(predecessor),
      predecessorTruthSha256: canonicalSha256(predecessor), acceptedDeltaJson: canonicalJson(admission.acceptedDelta),
      acceptedDeltaSha256: canonicalSha256(admission.acceptedDelta), resultingTruthJson: canonicalJson(resultingTruth),
      resultingTruthSha256: canonicalSha256(resultingTruth), committedAuthority: "",
      applicationReceiptSha256: canonicalSha256(applicationReceipt), projectionManifestSha256: canonicalSha256(projectionManifest),
    };
    const validatorExecutionBase = {
      provider: validatorReference.provider,
      model: validatorReference.requestedModel,
      messages: buildTruthValidatorMessages(validationRequest),
      temperature: TRUTH_VALIDATOR_OPTIONS.temperature,
      maxTokens: TRUTH_VALIDATOR_OPTIONS.maxTokens,
      stream: false,
      webSearch: false,
      extra: {},
    };
    const validatorFingerprint = sha256Utf8(JSON.stringify({ provider: validatorExecutionBase.provider, model: validatorExecutionBase.model,
      messages: validatorExecutionBase.messages, temperature: validatorExecutionBase.temperature,
      maxTokens: validatorExecutionBase.maxTokens, stream: validatorExecutionBase.stream }));
    const validatorArtifactPath = join(bookDir, validatorReference.artifactRelativePath);
    const validatorArtifact = JSON.parse(await readFile(validatorArtifactPath, "utf8"));
    validatorArtifact.input_fingerprint = validatorFingerprint;
    const validatorArtifactBytes = Buffer.from(`${JSON.stringify(validatorArtifact, null, 2)}\n`);
    await writeFile(validatorArtifactPath, validatorArtifactBytes);
    const validatorReferenceIndex = providerReferences.indexOf(validatorReference);
    validatorReference = {
      ...validatorReference,
      inputFingerprint: validatorFingerprint,
      artifactSha256: transaction.hash(validatorArtifactBytes),
    };
    providerReferences[validatorReferenceIndex] = validatorReference;
    const validationContextUnsigned = {
      schemaVersion: "1.0" as const, kind: "CANONICAL_TRUTH_MODEL_CONTEXT" as const, baseContextSha256: truthContextSha256,
      role: "truth-validator" as const, stage: "TRUTH_VALIDATION" as const, extractionKind: "INITIAL" as const,
      repairOrdinal: 0 as const, requestSha256: canonicalSha256(validationRequest), request: validationRequest,
      execution: { ...validatorExecutionBase, fullRequestSha256: canonicalSha256(validatorExecutionBase), inputFingerprint: validatorFingerprint },
    };
    const validationContext = { ...validationContextUnsigned, contextSha256: canonicalSha256(validationContextUnsigned) };
    const truthContextDir = join(bookDir, "story", "runtime", "chapter-transactions", `chapter-${String(chapterNumber).padStart(4, "0")}`,
      "staging", "evidence", "truth", sha256Utf8(candidate));
    await mkdir(truthContextDir, { recursive: true });
    await writeFile(join(truthContextDir, "context.json"), `${canonicalJson({ ...truthContext, contextSha256: truthContextSha256 })}\n`, "utf8");
    await mkdir(join(truthContextDir, "initial"), { recursive: true });
    await writeFile(join(truthContextDir, "initial", "extraction-context.json"), `${canonicalJson(extractionContext)}\n`, "utf8");
    await writeFile(join(truthContextDir, "initial", "validation-context.json"), `${canonicalJson(validationContext)}\n`, "utf8");
    await writeFile(join(truthContextDir, "initial", "extraction.json"), JSON.stringify({
      rawProposal, ...extraction, usage: committedUsage(),
    }), "utf8");
    await writeFile(join(truthContextDir, "initial", "semantic-validation.json"), JSON.stringify({
      verdict: "PASS", diagnostics: [], rawResponse: '{"verdict":"PASS","diagnostics":[]}',
      logicalOperationId: validatorReference.logicalOperationId, inputFingerprint: validatorReference.inputFingerprint,
      providerArtifactSha256: validatorReference.artifactSha256, responseContentSha256: validatorReference.responseContentSha256,
      usage: committedUsage(), contextSha256: validationContext.contextSha256,
    }), "utf8");
    await recordChapterTransactionReviewEvidence({
      bookDir, transactionId: transaction.transactionId, candidateSha256: sha256Utf8(candidate),
      reviewerRole: logicReview.reviewerRole, evidence: logicReview,
      providerEvidence: providerReferences.find((reference) => reference.role === "logic-canon-auditor")!,
      providerRequest: reviewRequests.get("logic-canon-auditor")!,
    });
    await recordChapterTransactionReviewEvidence({
      bookDir, transactionId: transaction.transactionId, candidateSha256: sha256Utf8(candidate),
      reviewerRole: commercialReview.reviewerRole, evidence: commercialReview,
      providerEvidence: providerReferences.find((reference) => reference.role === "commercial-reader")!,
      providerRequest: reviewRequests.get("commercial-reader")!,
    });
    if (!options.omitTerminalRequestAuthorities) {
      for (const [role, stage] of [["logic-canon-auditor", "LOGIC_REVIEW"], ["commercial-reader", "READER_REVIEW"]] as const) {
        const reviewRequest = reviewRequests.get(role)!;
        const { inputFingerprint: _fingerprint, reviewLanguage, ...request } = reviewRequest;
        const reservation = await reserveChapterTransactionProviderRequest({
          bookDir, transactionId: transaction.transactionId, chapterNumber,
          candidateSha256: sha256Utf8(candidate), role, stage, requestOrdinal: 0, reviewLanguage, request,
        });
        await bindChapterTransactionProviderRequest({
          bookDir, transactionId: transaction.transactionId, reservationId: reservation.reservationId,
          providerReference: providerReferences.find((reference) => reference.role === role)!,
        });
      }
    }
    for (const [role, stage, execution] of [
      ["truth-extractor", "TRUTH_EXTRACTION", extractionContext.execution],
      ["truth-validator", "TRUTH_VALIDATION", validationContext.execution],
    ] as const) {
      const { inputFingerprint: _inputFingerprint, fullRequestSha256: _fullRequestSha256, ...request } = execution;
      const reservation = await reserveChapterTransactionProviderRequest({
        bookDir, transactionId: transaction.transactionId, chapterNumber,
        candidateSha256: sha256Utf8(candidate), role, stage, requestOrdinal: 0, request,
      });
      await bindChapterTransactionProviderRequest({
        bookDir, transactionId: transaction.transactionId, reservationId: reservation.reservationId,
        providerReference: providerReferences.find((reference) => reference.role === role)!,
      });
    }
    const stageInput = {
      bookDir, transactionId: transaction.transactionId, title: `Chapter ${chapterNumber}`, language: logicReviewLanguage, body: candidate, lengthSpec: options.lengthSpec ?? lengthSpec,
      ...(firstV2Baseline ? { firstV2Baseline } : {}),
      review: {
        status: "APPROVED", grade: "A", revisionCount: 0, finalCandidateSha256: sha256Utf8(candidate), findings: [],
        reviewerEvidence: [logicReview, commercialReview],
      },
      usage: {
        totalUsage: {
          promptTokens: 10, completionTokens: 15, totalTokens: 25,
          ...(options.providerActualCostUsd !== undefined ? { actualCostUsd: options.providerActualCostUsd * operations.length } : {}),
        },
        roleUsage: {
          writer: committedUsage(),
          "logic-canon-auditor": committedUsage(),
          "commercial-reader": committedUsage(),
          "truth-extractor": committedUsage(),
          "truth-validator": committedUsage(),
        },
      }, providerReferences, completedAt: "2026-09-04T00:00:00.000Z",
      truth: {
        contextSha256: truthContextSha256,
        predecessor, acceptedDelta: admission.acceptedDelta, deltaAdmission: admission, applicationReceipt,
        semanticValidation: { verdict: "PASS", diagnostics: [], rawResponse: '{"verdict":"PASS","diagnostics":[]}', logicalOperationId: validatorReference.logicalOperationId, inputFingerprint: validatorReference.inputFingerprint, providerArtifactSha256: validatorReference.artifactSha256, responseContentSha256: validatorReference.responseContentSha256, usage: committedUsage(), contextSha256: validationContext.contextSha256 },
        extractionContext, validationContext,
        resultingTruth, projections, projectionManifest,
        usageByRole: {
          "truth-extractor": committedUsage(),
          "truth-validator": committedUsage(),
        },
        extractorEvidence: extraction,
        validatorEvidence: { logicalOperationId: validatorReference.logicalOperationId, inputFingerprint: validatorReference.inputFingerprint, providerArtifactSha256: validatorReference.artifactSha256, responseContentSha256: validatorReference.responseContentSha256, contextSha256: validationContext.contextSha256 },
      },
    } as const;
    await stageTruthChapterCommitV2(stageInput);
    return { transaction, resultingTruth, stageInput };
  }

  it("consolidated K1 retains exact first-transition bytes and verifies without transaction runtime", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const attemptRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
    const baseline = await readFile(join(attemptRoot, "first-v2-baseline.json"));
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const committedRoot = join(bookDir, "story/commits/chapter-0005");
    expect(await readFile(join(committedRoot, "first-v2-baseline.json"))).toEqual(baseline);
    await rm(join(bookDir, "story/runtime/chapter-transactions"), { recursive: true });
    expect((await verifyChapterCommitChain({ bookDir })).latestChapter).toBe(5);
    await writeFile(join(committedRoot, "first-v2-baseline.json"), "{}");
    await rehashAttackerControlledPayload(committedRoot);
    await expect(verifyChapterCommitChain({ bookDir })).rejects.toThrow();
  });

  async function selectedCommitRunnerFixture(target: "missing" | "copied" | "promoted", statusFirst = false) {
    const { root, bookDir } = await fixture(3, true);
    const book = { id: "book-a", title: "Recovery", platform: "tomato" as const, genre: "xuanhuan", language: "en" as const,
      status: "active" as const, targetChapters: 6, chapterWordCount: 2200, createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" };
    await new StateManager(root).saveBookConfig("book-a", book);
    const productionAuthority = `pipeline:${sha256Utf8(JSON.stringify({ bookId: book.id, genre: book.genre, language: book.language,
      targetChapters: book.targetChapters, chapterWordCount: book.chapterWordCount, productionMapSha256: null }))}`;
    const { transaction } = await stageV2Passing(bookDir, 5, { productionAuthority,
      lengthSpec: { target: 2200, softMin: 1900, softMax: 2500, hardMin: 1600, hardMax: 2800, countingMode: "en_words" },
    });
    await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId,
      beforePromote: () => { throw new Error("TEST_SELECTED_BEFORE_PROMOTION"); },
    })).rejects.toThrow("TEST_SELECTED_BEFORE_PROMOTION");
    const attemptRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
    const source = join(attemptRoot, "staging/bundle");
    const commitRoot = join(bookDir, "story/commits/chapter-0005");
    const selectedCommitBytes = await readFile(join(source, "commit.json"));
    const selectedCommit = JSON.parse(selectedCommitBytes.toString("utf8"));
    if (target === "copied") await cp(source, commitRoot, { recursive: true });
    if (target === "promoted") await rename(source, commitRoot);
    const runtimePath = join(bookDir, "story/runtime/bounded-autonomous/production-state.json");
    await writeFile(runtimePath, JSON.stringify({ nextChapter: 5, chapterNumber: 5 }));
    if (statusFirst) await reconcileChapterProjections({ bookDir });
    const persistedRuntime = JSON.parse(await readFile(runtimePath, "utf8"));
    if (statusFirst) expect(persistedRuntime).toMatchObject({ nextChapter: 6, chapterNumber: 5 });
    let modelEffects = 0;
    const runner = new PipelineRunner({ projectRoot: root, model: "writer-model", boundedAutonomousReview: true,
      modelOverrides: { "truth-extractor": "extractor-model", "truth-validator": "validator-model" },
      client: { provider: "openai", service: "test-provider", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } as never,
      // Mirror the server capture separately covered by its actual GET/Start test.
      firstV2Cutover: { resumeChapterNumber: persistedRuntime.chapterNumber ?? persistedRuntime.nextChapter, legacyRuntimeSnapshot: JSON.stringify(persistedRuntime) },
      onAutonomousStage: async (event) => { if (event.provider !== null) { modelEffects += 1; throw new Error("UNEXPECTED_RECOVERY_MODEL_EFFECT"); } },
    });
    return { runner, root, bookDir, attemptRoot, source, commitRoot, selectedCommit, selectedCommitBytes, modelEffects: () => modelEffects };
  }

  it.each(["missing", "copied", "promoted"] as const)("first-V2 COMMIT_SELECTED Runner recovery finalizes exact authority with target %s", async (target) => {
    const fixture = await selectedCommitRunnerFixture(target);
    const begin = vi.spyOn(chapterTransactions, "beginChapterTransaction");
    const buildBaseline = vi.spyOn(baselineBuilder, "buildFirstV2Baseline");
    try {
      if (target === "missing") await expect(assertChapterWriterStartAllowed({ bookDir: fixture.bookDir, chapterNumber: 6 })).rejects.toThrow();
      if (target === "promoted") {
        const state = new StateManager(fixture.root);
        const actions = await createAutonomousPipelineActions({ bookId: "book-a", state, pipeline: fixture.runner });
        const completedChapterIds: number[] = [];
        const progress = await runBoundedAutonomousScope({
          map: parseBookProductionMap({ schema_version: "1.0", book_id: "book-a", authority_book_id: "authority", title: "Recovery",
            total_chapters: 6, volumes: [{ volume_id: "volume-001", volume_number: 1, title: "One", start_chapter: 1, end_chapter: 6, chapter_count: 6 }] }),
          mode: "full-book", getNextChapter: () => state.getNextChapterNumber("book-a"),
          verifyChapterStartAuthority: (chapterNumber) => assertChapterWriterStartAllowed({ bookDir: fixture.bookDir, chapterNumber }),
          runChapter: async () => { const result = await actions.runChapter(2200); completedChapterIds.push(result.chapterNumber); return result; },
          shouldStop: () => completedChapterIds.length > 0, persistProgress: async () => {},
        });
        expect(completedChapterIds).toEqual([5]);
        expect(progress).toMatchObject({ status: "PAUSED_BY_USER", nextChapter: 6, completedThisRun: 1 });
        expect((await state.loadChapterIndex("book-a")).filter((chapter) => chapter.number >= 5)).toMatchObject([{ number: 5, status: "approved" }]);
      } else {
        await expect(fixture.runner.writeNextChapter("book-a", 2200)).resolves.toMatchObject({ chapterNumber: 5, status: "ready-for-review" });
      }
      expect(fixture.modelEffects()).toBe(0);
      expect(begin).not.toHaveBeenCalled();
      expect(buildBaseline).not.toHaveBeenCalled();
      const committed = await verifyChapterCommit({ bookDir: fixture.bookDir, chapterNumber: 5 });
      expect(committed).toMatchObject({ transactionId: fixture.selectedCommit.transactionId, commitSha256: fixture.selectedCommit.commitSha256 });
      expect(await readFile(join(fixture.commitRoot, "commit.json"))).toEqual(fixture.selectedCommitBytes);
      await expect(assertChapterWriterStartAllowed({ bookDir: fixture.bookDir, chapterNumber: 6 })).resolves.toBeUndefined();
      begin.mockImplementationOnce(async (input) => {
        expect(input.chapterNumber).toBe(6);
        throw new Error("TEST_NEXT_CHAPTER_ADMISSION");
      });
      await expect(fixture.runner.writeNextChapter("book-a", 2200)).rejects.toThrow("TEST_NEXT_CHAPTER_ADMISSION");
      expect(fixture.modelEffects()).toBe(0);
    } finally { begin.mockRestore(); buildBaseline.mockRestore(); }
  });

  it.each(["clean", "source", "baseline"] as const)("first-V2 status projection before Start preserves selected recovery for %s evidence", async (attack) => {
    const fixture = await selectedCommitRunnerFixture("copied", true);
    if (attack === "source") await writeFile(join(fixture.source, "chapter.md"), "tampered retained source prose");
    if (attack === "baseline") await writeFile(join(fixture.attemptRoot, "first-v2-baseline.json"), "{}");
    const begin = vi.spyOn(chapterTransactions, "beginChapterTransaction");
    const buildBaseline = vi.spyOn(baselineBuilder, "buildFirstV2Baseline");
    try {
      const result = fixture.runner.writeNextChapter("book-a", 2200);
      if (attack === "clean") {
        await expect(result).resolves.toMatchObject({ chapterNumber: 5, status: "ready-for-review" });
        expect(await readFile(join(fixture.commitRoot, "commit.json"))).toEqual(fixture.selectedCommitBytes);
      } else await expect(result).rejects.toThrow(/BASELINE|hash|prose|integrity mismatch/i);
      expect(fixture.modelEffects()).toBe(0);
      expect(begin).not.toHaveBeenCalled();
      expect(buildBaseline).not.toHaveBeenCalled();
    } finally { begin.mockRestore(); buildBaseline.mockRestore(); }
  });

  it.each(["transaction", "baseline", "target"] as const)("first-V2 COMMIT_SELECTED Runner recovery rejects tampered %s before any model effect", async (attack) => {
    const fixture = await selectedCommitRunnerFixture(attack === "target" ? "promoted" : "missing");
    if (attack === "transaction") {
      const path = join(fixture.attemptRoot, "transaction.json");
      const transaction = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...transaction, transactionId: "tampered-selected-transaction" }));
    } else if (attack === "baseline") await writeFile(join(fixture.attemptRoot, "first-v2-baseline.json"), "{}");
    else await writeFile(join(fixture.commitRoot, "chapter.md"), "tampered target prose");
    const begin = vi.spyOn(chapterTransactions, "beginChapterTransaction");
    const buildBaseline = vi.spyOn(baselineBuilder, "buildFirstV2Baseline");
    try {
      await expect(fixture.runner.writeNextChapter("book-a", 2200)).rejects.toThrow(/IDENTITY|BASELINE|hash|prose|integrity mismatch/i);
      expect(fixture.modelEffects()).toBe(0);
      expect(begin).not.toHaveBeenCalled();
      expect(buildBaseline).not.toHaveBeenCalled();
    } finally { begin.mockRestore(); buildBaseline.mockRestore(); }
  });

  it("consolidated K3 reuses staged timestamp while rejecting changed deterministic inputs", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    const path = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle/commit.json");
    const original = await readFile(path);
    await expect(stageTruthChapterCommitV2({ ...stageInput, completedAt: "2099-01-01T00:00:00.000Z" })).resolves.toBeUndefined();
    expect(await readFile(path)).toEqual(original);
    await expect(stageTruthChapterCommitV2({ ...stageInput, title: "Changed title" })).rejects.toThrow(/conflict/i);
  });

  it.each(["operation", "candidate", "review-result", "reservation", "binding", "begin", "stage"] as const)(
    "consolidated K2 denies ordinary %s after selected Commit before promotion", async (kind) => {
      const { bookDir } = await fixture(3);
      const { transaction, stageInput } = await stageV2Passing(bookDir);
      await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId,
        beforePromote: () => { throw new Error("selected-crash"); },
      })).rejects.toThrow("selected-crash");
      const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
      const terminal = await readFile(join(root, "terminal-outcome.json"));
      const requests = join(root, "staging/evidence/provider-requests");
      const reservation = JSON.parse(await readFile(join(requests, "reservations", (await readdir(join(requests, "reservations")))[0]!), "utf8"));
      const binding = JSON.parse(await readFile(join(requests, "bindings", `${reservation.reservationId}.json`), "utf8"));
      const common = { bookDir, transactionId: transaction.transactionId };
      const action = kind === "operation" ? () => recordChapterTransactionOperation({ ...common, logicalOperationId: "new", stage: "WRITING", inputFingerprint: "a".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "b".repeat(64) })
        : kind === "candidate" ? () => recordChapterTransactionCandidate({ ...common, label: "REVISION_2", content: "new", sha256: sha256Utf8("new") })
        : kind === "review-result" ? () => recordChapterTransactionReviewResult({ ...common, result: {} })
        : kind === "reservation" ? () => reserveChapterTransactionProviderRequest({ ...reservation, bookDir })
        : kind === "binding" ? () => bindChapterTransactionProviderRequest({ ...binding, bookDir })
        : kind === "begin" ? () => beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2", truthMode: "CANONICAL_V2", firstV2Baseline: stageInput.firstV2Baseline })
        : () => stageTruthChapterCommitV2(stageInput);
      await expect(action()).rejects.toThrow(/COMMIT_SELECTED|terminal/i);
      expect(await readFile(join(root, "terminal-outcome.json"))).toEqual(terminal);
      const recovered = await finalizeChapterTransaction(common);
      expect(recovered.commitSha256).toBe(JSON.parse(terminal.toString()).commitSha256);
    },
  );

  it("consolidated N4 differing target does not publish terminal outcome", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await installConflictingCommitTarget(bookDir);
    await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId })).rejects.toThrow();
    await expect(readFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/terminal-outcome.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("consolidated K2 rejects a reservation admitted OPEN when terminal wins during candidate validation", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0005");
    const requests = join(root, "staging/evidence/provider-requests/reservations");
    const reservation = JSON.parse(await readFile(join(requests, (await readdir(requests))[0]!), "utf8"));
    const before = await readdir(requests);
    providerArtifactReadRace.targetPath = join(root, "staging/evidence/candidates/INITIAL/body.md");
    providerArtifactReadRace.afterRead = async () => {
      providerArtifactReadRace.targetPath = "";
      await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId,
        beforePromote: () => { throw new Error("selected-crash"); },
      })).rejects.toThrow("selected-crash");
    };
    await expect(reserveChapterTransactionProviderRequest({ ...reservation, bookDir, requestOrdinal: 99 }))
      .rejects.toThrow(/COMMIT_SELECTED|terminal/i);
    expect(await readdir(requests)).toEqual(before);
  });

  it("consolidated N2 replays exact request reservations with equivalent nested extra ordering", async () => {
    const { bookDir } = await fixture(3);
    await stageV2Passing(bookDir);
    const requests = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/evidence/provider-requests/reservations");
    const reservation = JSON.parse(await readFile(join(requests, (await readdir(requests))[0]!), "utf8"));
    const input = { ...reservation, bookDir, requestOrdinal: 22,
      request: { ...reservation.request, extra: { outer: { z: 2, a: 1 }, b: 3 } } };
    const first = await reserveChapterTransactionProviderRequest(input);
    await expect(reserveChapterTransactionProviderRequest({ ...input,
      request: { ...input.request, extra: { b: 3, outer: { a: 1, z: 2 } } },
    })).resolves.toEqual(first);
  });

  it.each(["truth-extractor", "truth-validator"] as const)("consolidated N1 host revalidates exact %s Provider and bound request authority", async (role) => {
    const { bookDir } = await fixture(3);
    const { transaction, stageInput } = await stageV2Passing(bookDir);
    const context = role === "truth-extractor" ? stageInput.truth.extractionContext : stageInput.truth.validationContext;
    const reference = stageInput.providerReferences.find((entry) => entry.role === role)!;
    const providerPath = join(bookDir, reference.artifactRelativePath);
    const provider = JSON.parse(await readFile(providerPath, "utf8"));
    const common = { logicalOperationId: reference.logicalOperationId, inputFingerprint: reference.inputFingerprint,
      providerArtifactSha256: reference.artifactSha256, responseContentSha256: reference.responseContentSha256,
      usage: provider.response.usage };
    const artifact = role === "truth-extractor" ? { ...common, rawProposal: provider.response.content }
      : { ...stageInput.truth.semanticValidation, ...common };
    const input = { bookDir, transactionId: transaction.transactionId, chapterNumber: 5, candidate: stageInput.body,
      evidence: { role, stage: context.stage, repairOrdinal: context.repairOrdinal, execution: context.execution, artifact } };
    await expect(revalidateCanonicalTruthProviderEvidence(input)).resolves.toBeUndefined();
    await writeFile(providerPath, "{}");
    await expect(revalidateCanonicalTruthProviderEvidence(input)).rejects.toThrow(/ARTIFACT_EVIDENCE_DEFECT/);
  });

  it("makes immutable final-path staging markers crash-safe and convergent", async () => {
    const { bookDir } = await fixture();
    const transactionRoot = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005");
    await mkdir(transactionRoot, { recursive: true });
    await writeFile(join(transactionRoot, "transaction.json"), "{\"truncated\"", "utf-8");

    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(JSON.parse(await readFile(join(transactionRoot, "transaction.json"), "utf-8"))).toMatchObject({
      transactionId: transaction.transactionId,
      state: "STAGING",
    });
    expect((await readdir(transactionRoot)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("recovers a truncated genesis final marker through atomic replacement", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-genesis-crash-"));
    roots.push(bookDir);
    await mkdir(join(bookDir, "story", "snapshots", "0", "state"), { recursive: true });
    await mkdir(join(bookDir, "story", "commits"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "index.json"), "[]", "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "0", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 0 }), "utf-8");
    await writeFile(join(bookDir, "story", "commits", "genesis.json"), "{", "utf-8");
    const genesis = await createChapterGenesis({ bookDir, bookId: "book-zero", lastTrustedChapter: 0, trustedSnapshotDir: join(bookDir, "story", "snapshots", "0"), createdAt: "2026-08-28T00:00:00.000Z" });
    expect(genesis.genesisSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(await readFile(join(bookDir, "story", "commits", "genesis.json"), "utf-8"))).toMatchObject({ kind: "CHAPTER_GENESIS" });
  });

  it.each(["body-only", "metadata-only"])("recovers %s partial candidate staging", async (partial) => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    const candidateRoot = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "candidates", "INITIAL");
    await mkdir(candidateRoot, { recursive: true });
    if (partial === "body-only") await writeFile(join(candidateRoot, "body.md"), body, "utf-8");
    else await writeFile(join(candidateRoot, "metadata.json"), JSON.stringify({ schemaVersion: 1, label: "INITIAL", sha256: transaction.hash(body) }), "utf-8");

    const { recordChapterTransactionCandidate } = await import("../production/chapter-transaction.js");
    await recordChapterTransactionCandidate({ bookDir, transactionId: transaction.transactionId, label: "INITIAL", content: body, sha256: transaction.hash(body) });
    await expect(readFile(join(candidateRoot, "body.md"), "utf-8")).resolves.toBe(body);
    await expect(readFile(join(candidateRoot, "metadata.json"), "utf-8")).resolves.toContain(transaction.hash(body));
  });

  it("recovers truncated bounded result and staged commit but rejects conflicting completed bytes", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    const evidenceRoot = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, "review-result.json"), "{", "utf-8");
    await recordChapterTransactionReviewResult({ bookDir, transactionId: transaction.transactionId, result: { status: "APPROVED" } });
    await expect(readFile(join(evidenceRoot, "review-result.json"), "utf-8")).resolves.toContain("APPROVED");

    const stagedBundle = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    await mkdir(stagedBundle, { recursive: true });
    await writeFile(join(stagedBundle, "commit.json"), "{", "utf-8");
    await stagePassing(bookDir);
    await expect(readFile(join(stagedBundle, "commit.json"), "utf-8")).resolves.toContain("CHAPTER_COMMIT");

    const operation = {
      bookDir, transactionId: transaction.transactionId, logicalOperationId: "provider-step-conflict",
      stage: "WRITING", inputFingerprint: "b".repeat(64), responseArtifactStatus: "COMPLETE" as const, responseSha256: "c".repeat(64),
    };
    await recordChapterTransactionOperation(operation);
    await expect(recordChapterTransactionOperation({ ...operation, responseSha256: "d".repeat(64) })).rejects.toThrow(/immutable|conflict/i);
  });

  it("requires complete self-proving literary, state-validation, revision, and Provider authority", async () => {
    const { bookDir } = await fixture();
    const transaction = await stagePassing(bookDir);
    const commit = await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    expect(commit.productionAuthority).toBe("blueprint:v1");
    expect(commit.revisionCount).toBe(1);
    expect(commit.stateValidationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(commit.providerReferenceCount).toBe(3);
    await reconcileChapterProjections({ bookDir });
    const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8"));
    expect(index.at(-1).autonomousReview.revisionCount).toBe(1);
  });

  it("rejects a Commit without both final reviewer authorities bound to the final candidate", async () => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, (input) => ({
      ...input,
      review: { ...input.review, reviewerEvidence: input.review.reviewerEvidence.filter((reviewer) => reviewer.reviewerRole !== "commercial-reader") },
    }) as unknown as Parameters<typeof stageChapterCommitCandidate>[0])).rejects.toThrow(/exactly two final reviewer authorities/i);
  });

  it.each([
    ["APPROVED", "CRITICAL"],
    ["APPROVED_WITH_NOTES", "MAJOR"],
  ] as const)("rejects exported staging authority when %s reviewer evidence contains %s despite an empty aggregate", async (decision, severity) => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, (input) => ({
      ...input,
      review: {
        ...input.review,
        findings: [],
        reviewerEvidence: input.review.reviewerEvidence.map((reviewer) => reviewer.reviewerRole === "commercial-reader"
          ? {
              ...reviewer,
              decision,
              findings: [{
                findingId: "reader-blocker",
                severity,
                evidence: "Contradicts committed authority.",
                impact: "canon",
                requiredOutcome: "Repair the contradiction.",
              }],
            }
          : reviewer),
      },
    }) as unknown as Parameters<typeof stageChapterCommitCandidate>[0])).rejects.toThrow(/blocking|commercial-reader.*authority/i);
  });

  it("rejects a Commit without canonical passing state-validation authority", async () => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, (input) => ({
      ...input,
      stateValidation: { ...input.stateValidation, passed: false },
    }) as unknown as Parameters<typeof stageChapterCommitCandidate>[0])).rejects.toThrow(/state validation authority/i);
  });

  it("rejects a Commit without complete transaction-scoped Provider references", async () => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, (input) => ({ ...input, providerReferences: [] })))
      .rejects.toThrow(/Provider operation authority/i);
  });

  it("does not let focused SETTLING_STATE adjudication satisfy final logic review authority", async () => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, undefined, [
      defaultProviderOperations[0]!,
      { role: "logic-canon-auditor", stage: "SETTLING_STATE", provider: "test-provider", model: "logic-model" },
      defaultProviderOperations[2]!,
    ])).rejects.toThrow(/logic-canon-auditor Provider authority is missing/i);
  });

  it("requires READER_REVIEW stage for final reader Provider authority", async () => {
    const { bookDir } = await fixture();
    await expect(stagePassing(bookDir, 5, undefined, [
      defaultProviderOperations[0]!,
      defaultProviderOperations[1]!,
      { role: "commercial-reader", stage: "SETTLING_STATE", provider: "test-provider", model: "commercial-model" },
    ])).rejects.toThrow(/commercial-reader Provider authority is missing/i);
  });

  it("fails semantic verification when a referenced Provider artifact is tampered", async () => {
    const { bookDir } = await fixture();
    const transaction = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const providerDir = join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses");
    const artifactName = (await readdir(providerDir)).find((name) => name.endsWith(".json"))!;
    const artifactPath = join(providerDir, artifactName);
    const artifact = JSON.parse(await readFile(artifactPath, "utf-8"));
    artifact.role = "tampered-role";
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/Provider artifact hash mismatch/i);
  });

  it("makes committed state and snapshot projections exact without deleting unrelated story assets", async () => {
    const { bookDir } = await fixture();
    const transaction = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await mkdir(join(bookDir, "story", "snapshots", "5"), { recursive: true });
    await writeFile(join(bookDir, "story", "state", "stale.json"), "stale", "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "5", "stale.json"), "stale", "utf-8");
    await writeFile(join(bookDir, "story", "particle_ledger.md"), "stale", "utf-8");
    await writeFile(join(bookDir, "story", "author_intent.md"), "preserve", "utf-8");
    await reconcileChapterProjections({ bookDir });
    await expect(stat(join(bookDir, "story", "state", "stale.json"))).rejects.toThrow();
    await expect(stat(join(bookDir, "story", "snapshots", "5", "stale.json"))).rejects.toThrow();
    await expect(stat(join(bookDir, "story", "particle_ledger.md"))).rejects.toThrow();
    await expect(readFile(join(bookDir, "story", "author_intent.md"), "utf-8")).resolves.toBe("preserve");
  });

  it("revalidates every independent projection reconcile without republishing identical bytes and repairs later drift", async () => {
    const { bookDir } = await fixture();
    const transaction = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    await reconcileChapterProjections({ bookDir });
    const writes = vi.spyOn(fs, "writeFile");
    const renames = vi.spyOn(fs, "rename");
    const reads = vi.spyOn(fs, "readFile");
    const enumerations = vi.spyOn(fs, "readdir");
    try {
      await reconcileChapterProjections({ bookDir });
      expect(writes).not.toHaveBeenCalled();
      expect(renames).not.toHaveBeenCalled();
      const observedReads = reads.mock.calls.map(([path]) => String(path));
      expect(observedReads).toContain(join(bookDir, "story", "commits", "genesis.json"));
      expect(observedReads.filter((path) => path === join(bookDir, "story", "commits", "chapter-0005", "commit.json"))).toHaveLength(2);
      expect(observedReads).toContain(join(bookDir, "story", "commits", "chapter-0005", "snapshot", "current_state.md"));
      expect(enumerations.mock.calls.map(([path]) => String(path))).toContain(join(bookDir, "story", "commits", "chapter-0005", "state"));

      await writeFile(join(bookDir, "story", "current_state.md"), "tampered public projection");
      await rm(join(bookDir, "story", "snapshots", "5", "current_state.md"));
      await writeFile(join(bookDir, "story", "state", "unexpected.json"), "stale");
      await reconcileChapterProjections({ bookDir });
      await expect(readFile(join(bookDir, "story", "current_state.md"), "utf8")).resolves.toBe("state 5");
      await expect(readFile(join(bookDir, "story", "snapshots", "5", "current_state.md"), "utf8")).resolves.toBe("state 5");
      await expect(stat(join(bookDir, "story", "state", "unexpected.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(renames).toHaveBeenCalled();

      await writeFile(join(bookDir, "story", "commits", "chapter-0005", "state", "current_state.md"), "tampered authority");
      writes.mockClear();
      renames.mockClear();
      await expect(reconcileChapterProjections({ bookDir })).rejects.toThrow(/State tree hash mismatch/);
      expect(writes).not.toHaveBeenCalled();
      expect(renames).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore(); renames.mockRestore(); reads.mockRestore(); enumerations.mockRestore();
    }
  });

  it.each(["LEGACY_V1", "CANONICAL_V2"] as const)("uses one fresh verified chain when beginning a %s successor and rejects later authority tampering", async (truthMode) => {
    const { bookDir } = await fixture(truthMode === "CANONICAL_V2" ? 3 : 4);
    const staged = truthMode === "CANONICAL_V2" ? await stageV2Passing(bookDir) : await stagePassing(bookDir);
    const transaction = "transaction" in staged ? staged.transaction : staged;
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const reads = vi.spyOn(fs, "readFile");
    const request = { bookDir, bookId: "book-a", chapterNumber: 6, productionAuthority: "next", truthMode };
    const genesisPath = join(bookDir, "story", "commits", "genesis.json");
    try {
      const next = await beginChapterTransaction(request);
      expect(next.chapterNumber).toBe(6);
      expect(reads.mock.calls.filter(([path]) => String(path) === genesisPath)).toHaveLength(1);
      expect(reads.mock.calls.filter(([path]) => String(path) === join(bookDir, "story", "commits", "chapter-0005", "commit.json"))).toHaveLength(2);
      await writeFile(join(bookDir, "story", "commits", "chapter-0005", "state", "current_state.json"), "tampered after admission");
      reads.mockClear();
      await expect(beginChapterTransaction(request)).rejects.toThrow(/State|payload|bundle/i);
      expect(reads.mock.calls.filter(([path]) => String(path) === genesisPath)).toHaveLength(1);
    } finally { reads.mockRestore(); }
  });

  it("reuses the private first-V2 observation only within admission and rechecks durable baseline on restart", async () => {
    const { bookDir } = await fixture(3);
    const firstV2Baseline = await hostBaseline(bookDir);
    const request = { bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2", truthMode: "CANONICAL_V2" as const };
    const reads = vi.spyOn(fs, "readFile");
    const genesisPath = join(bookDir, "story", "commits", "genesis.json");
    try {
      const initial = await beginChapterTransaction({ ...request, firstV2Baseline });
      expect(reads.mock.calls.filter(([path]) => String(path) === genesisPath)).toHaveLength(1);
      reads.mockClear();
      expect((await beginChapterTransaction(request)).transactionId).toBe(initial.transactionId);
      expect(reads.mock.calls.filter(([path]) => String(path) === genesisPath)).toHaveLength(1);
      await writeFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "first-v2-baseline.json"), JSON.stringify({ ...firstV2Baseline, predecessorChapterBody: "changed after the prior observation" }));
      await expect(beginChapterTransaction(request)).rejects.toThrow(/BASELINE|baseline/);
    } finally { reads.mockRestore(); }
  });

  it("A commits one verified chapter and rebuilds every public projection", async () => {
    const { bookDir, genesis } = await fixture();
    expect((await createChapterGenesis({ bookDir, bookId: "book-a", lastTrustedChapter: 4, trustedSnapshotDir: join(bookDir, "story", "snapshots", "4") })).genesisSha256).toBe(genesis.genesisSha256);
    const transaction = await stagePassing(bookDir);
    await expect(readFile(join(bookDir, "chapters", "0005_Chapter 5.md"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(bookDir, "story", "snapshots", "5", "current_state.md"), "utf-8")).rejects.toThrow();
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
    const restarted = await stagePassing(bookDir);
    expect(restarted.transactionId).toBe(transaction.transactionId);
    const commit = await finalizeChapterTransaction({ bookDir, transactionId: restarted.transactionId });
    expect((await verifyChapterCommit({ bookDir, chapterNumber: 5 })).commitSha256).toBe(commit.commitSha256);
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(6);
    await reconcileChapterProjections({ bookDir });
    await expect(readFile(join(bookDir, "chapters", "0005_Chapter 5.md"), "utf-8")).resolves.toContain(body);
    await expect(readFile(join(bookDir, "story", "snapshots", "5", "current_state.md"), "utf-8")).resolves.toBe("state 5");
  });

  it("B keeps authority at genesis after review exhaustion and never invokes Writer 6", async () => {
    const { bookDir } = await fixture();
    const tx = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: tx.transactionId, title: "held", body, lengthSpec,
      review: { status: "HELD_AFTER_TWO_REVISIONS", finalCandidateSha256: tx.hash(body), findings: [] } as never,
      stateFiles: {}, snapshotFiles: {}, usage: {}, stateValidation: {} as never, providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
    })).rejects.toThrow(/terminal review/i);
    const writer6 = vi.fn();
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
    expect(writer6).not.toHaveBeenCalled();
  });

  it("C rejects a terminal candidate outside the PR9 hard range", async () => {
    const { bookDir } = await fixture();
    const tx = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    const short = Array.from({ length: 700 }, (_, index) => `w${index}`).join(" ");
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: tx.transactionId, title: "short", body: short, lengthSpec,
      review: { status: "APPROVED", finalCandidateSha256: tx.hash(short), findings: [] } as never,
      stateFiles: {}, snapshotFiles: {}, usage: {}, stateValidation: {} as never, providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
    })).rejects.toThrow(/hard range/i);
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
  });

  it("D refuses commit when state settlement or validation evidence is incomplete", async () => {
    const { bookDir } = await fixture();
    const tx = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: tx.transactionId, title: "state failed", body, lengthSpec,
      review: {
        status: "APPROVED", grade: "A", revisionCount: 0, finalCandidateSha256: tx.hash(body), findings: [],
        reviewerEvidence: [
          { reviewerRole: "logic-canon-auditor", provider: "test", model: "logic", totalScore: 90, dimensionScores: { logic: 90 }, decision: "APPROVED", findings: [], reviewedCandidateSha: tx.hash(body) },
          { reviewerRole: "commercial-reader", provider: "test", model: "commercial", totalScore: 90, dimensionScores: { commercial: 90 }, decision: "APPROVED", findings: [], reviewedCandidateSha: tx.hash(body) },
        ],
      },
      stateFiles: { "manifest.json": "{}" }, snapshotFiles: {}, usage: {},
      stateValidation: { chapterNumber: 5, finalCandidateSha256: tx.hash(body), previousAuthoritySha256: tx.previousAuthoritySha256, passed: true },
      providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
    })).rejects.toThrow(/state|snapshot/i);
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
  });

  it.each([
    ["E Writer", "WRITER"],
    ["F Review", "LOGIC_REVIEW"],
    ["G Revision", "REVISION_1"],
    ["H Settlement", "STATE_SETTLEMENT"],
  ])("%s crash reuses the same transaction and completed operation", async (_name, stage) => {
    const { bookDir } = await fixture();
    const first = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await recordChapterTransactionOperation({
      bookDir, transactionId: first.transactionId, logicalOperationId: `${first.transactionId}:${stage}`,
      stage, inputFingerprint: "b".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "c".repeat(64),
    });
    if (stage === "LOGIC_REVIEW") {
      const candidateSha256 = first.hash(body);
      await recordChapterTransactionReviewEvidence({
        bookDir, transactionId: first.transactionId, candidateSha256, reviewerRole: "logic-canon-auditor",
        evidence: { decision: "INVALID_OUTPUT", reviewedCandidateSha: candidateSha256 },
      });
      await recordChapterTransactionReviewEvidence({
        bookDir, transactionId: first.transactionId, candidateSha256, reviewerRole: "logic-canon-auditor",
        evidence: { decision: "APPROVED", reviewedCandidateSha: candidateSha256 },
      });
      await recordChapterTransactionReviewResult({
        bookDir, transactionId: first.transactionId, result: { status: "APPROVED", bestCandidateSha256: candidateSha256 },
      });
      await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "review-result.json"), "utf-8")).resolves.toContain(candidateSha256);
      await expect(readdir(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "reviews", candidateSha256, "logic-canon-auditor"))).resolves.toHaveLength(2);
    }
    await recordChapterTransactionOperation({
      bookDir, transactionId: first.transactionId, logicalOperationId: `${first.transactionId}:${stage}`,
      stage, inputFingerprint: "b".repeat(64), responseArtifactStatus: "COMPLETE", responseSha256: "c".repeat(64),
    });
    const restarted = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    expect(restarted.transactionId).toBe(first.transactionId);
    expect(restarted.completedOperations).toContain(`${first.transactionId}:${stage}`);
  });

  it("I treats commit as authority after a crash and repairs projections without callbacks", async () => {
    const { bookDir } = await fixture();
    const tx = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: tx.transactionId });
    await rm(join(bookDir, "chapters", "0005_Chapter 5.md"), { force: true });
    await rm(join(bookDir, "chapters", "index.json"), { force: true });
    await reconcileChapterProjections({ bookDir });
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(6);
    await expect(readFile(join(bookDir, "chapters", "index.json"), "utf-8")).resolves.toContain('"number": 5');
  });

  it("J ignores stray chapter, index, snapshot, and runtime cursor files", async () => {
    const { bookDir } = await fixture();
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await mkdir(join(bookDir, "story", "snapshots", "5"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime", "bounded-autonomous"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0005_stray.md"), "stray", "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{ number: 5 }]), "utf-8");
    await writeFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({ nextChapter: 6 }), "utf-8");
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
    await writeFile(join(bookDir, "story", "current_state.md"), "wrong state", "utf-8");
    await reconcileChapterProjections({ bookDir });
    await expect(readFile(join(bookDir, "story", "current_state.md"), "utf-8")).resolves.toBe("state 4");
    await expect(readFile(join(bookDir, "chapters", "0005_stray.md"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(bookDir, "story", "runtime", "bounded-autonomous", "production-state.json"), "utf-8")).resolves.toContain('"nextChapter": 5');
  });

  it("makes StateManager cursor a commit projection for transaction-enabled books", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-chapter-txn-project-"));
    roots.push(projectRoot);
    const bookDir = join(projectRoot, "books", "book-a");
    await mkdir(join(bookDir, "story", "snapshots", "4", "state"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    for (const chapter of [1, 2, 3, 4]) await writeFile(join(bookDir, "chapters", `${String(chapter).padStart(4, "0")}_Legacy.md`), `legacy ${chapter}`, "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([1, 2, 3, 4].map((number) => ({ number }))), "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "current_state.md"), "state 4", "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 4 }), "utf-8");
    await createChapterGenesis({ bookDir, bookId: "book-a", lastTrustedChapter: 4, trustedSnapshotDir: join(bookDir, "story", "snapshots", "4"), createdAt: "2026-08-28T00:00:00.000Z" });
    await writeFile(join(bookDir, "chapters", "0005_stray.md"), "stray", "utf-8");
    expect(await new StateManager(projectRoot).getNextChapterNumber("book-a")).toBe(5);
  });

  it("K fails closed when a committed body is tampered", async () => {
    const { bookDir } = await fixture();
    const tx = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: tx.transactionId });
    await writeFile(join(bookDir, "story", "commits", "chapter-0005", "chapter.md"), "tampered", "utf-8");
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/hash/i);
    await expect(inspectChapterAuthority({ bookDir })).rejects.toThrow(/hash/i);
  });

  it("fails closed when a genesis-bound legacy chapter is tampered", async () => {
    const { bookDir } = await fixture();
    await writeFile(join(bookDir, "chapters", "0004_Legacy.md"), "tampered", "utf-8");
    await expect(verifyChapterCommitChain({ bookDir })).rejects.toThrow(/genesis legacy chapter/i);
  });

  it("L rebuilds a corrupt index and state projection from a valid commit", async () => {
    const { bookDir } = await fixture();
    const tx = await stagePassing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: tx.transactionId });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "index.json"), "corrupt", "utf-8");
    await writeFile(join(bookDir, "story", "current_state.md"), "wrong", "utf-8");
    await reconcileChapterProjections({ bookDir });
    await expect(readFile(join(bookDir, "story", "current_state.md"), "utf-8")).resolves.toBe("state 5");
  });

  it("M pauses an ambiguous Provider operation without allowing a duplicate call", () => {
    expect(resolveChapterProviderOperation({ transportStarted: true, transportReturned: false, responseArtifactStatus: "NONE" })).toBe("PAUSE_AMBIGUOUS");
    expect(resolveChapterProviderOperation({ transportStarted: false, transportReturned: false, responseArtifactStatus: "NONE" })).toBe("EXECUTE");
    expect(resolveChapterProviderOperation({ transportStarted: true, transportReturned: true, responseArtifactStatus: "COMPLETE" })).toBe("REPLAY_COMPLETE");
  });

  it("N verifies a contiguous genesis 4 to commit 8 chain and rejects missing commit 6", async () => {
    const { bookDir } = await fixture();
    for (const chapter of [5, 6, 7, 8]) {
      const tx = await stagePassing(bookDir, chapter);
      await finalizeChapterTransaction({ bookDir, transactionId: tx.transactionId });
    }
    expect((await verifyChapterCommitChain({ bookDir })).latestChapter).toBe(8);
    await rm(join(bookDir, "story", "commits", "chapter-0006"), { recursive: true, force: true });
    await expect(verifyChapterCommitChain({ bookDir })).rejects.toThrow(/contiguous|missing/i);
  });

  it("stages and verifies Commit V2 while preserving exact legacy V1 verification", async () => {
    const legacy = await fixture();
    const legacyTx = await stagePassing(legacy.bookDir);
    const legacyCommit = await finalizeChapterTransaction({ bookDir: legacy.bookDir, transactionId: legacyTx.transactionId });
    expect(legacyCommit).toMatchObject({ schemaVersion: 1, kind: "CHAPTER_COMMIT" });

    const current = await fixture(3);
    const { transaction, resultingTruth } = await stageV2Passing(current.bookDir);
    const commit = await finalizeChapterTransaction({ bookDir: current.bookDir, transactionId: transaction.transactionId });
    expect(commit).toMatchObject({ schemaVersion: 2, kind: "TRUTH_CHAPTER_COMMIT", truthSha256: canonicalSha256(resultingTruth) });
    await expect(readFile(join(current.bookDir, "story", "commits", "chapter-0005", "state", "truth.json"), "utf8"))
      .resolves.toBe(`${canonicalJson(resultingTruth)}\n`);
  });

  it.each([
    {
      label: "rejected Logic",
      reviewerRole: "logic-canon-auditor" as const,
      stage: "LOGIC_REVIEW" as const,
      model: "logic-model",
      rawResponse: JSON.stringify({
        passed: false,
        overall_score: 70,
        dimension_scores: {
          blueprint_transition: 70, causal_logic: 70, canon_continuity: 70, character_motivation: 70,
          state_inheritance: 70, hooks_disclosure: 70, narrative_clarity: 70,
        },
        issues: [{ severity: "warning", repair_scope: "local", category: "logic", description: "broken", suggestion: "repair" }],
        summary: "revision required",
      }),
    },
    {
      label: "malformed Logic",
      reviewerRole: "logic-canon-auditor" as const,
      stage: "LOGIC_REVIEW" as const,
      model: "logic-model",
      rawResponse: "not-json",
    },
    {
      label: "unrelated Logic approval",
      reviewerRole: "logic-canon-auditor" as const,
      stage: "LOGIC_REVIEW" as const,
      model: "logic-model",
      rawResponse: JSON.stringify({
        passed: true,
        overall_score: 91,
        dimension_scores: {
          blueprint_transition: 91, causal_logic: 91, canon_continuity: 91, character_motivation: 91,
          state_inheritance: 91, hooks_disclosure: 91, narrative_clarity: 91,
        },
        issues: [],
        summary: "different approved review",
      }),
    },
    {
      label: "rejected Commercial Reader",
      reviewerRole: "commercial-reader" as const,
      stage: "READER_REVIEW" as const,
      model: "commercial-model",
      rawResponse: JSON.stringify({
        total_score: 70,
        dimension_scores: {
          opening_hook: 70, pacing_tension: 70, emotional_investment: 70, plot_clarity: 70,
          dialogue_appeal: 70, western_cultural_naturalness: 70, commercial_appeal: 70, ending_hook: 70,
        },
        decision: "REVISION_REQUIRED",
        findings: [{ finding_id: "reader-1", severity: "MAJOR", evidence: "stalls", impact: "pacing", required_outcome: "advance" }],
      }),
    },
  ])("rejects fabricated terminal approval paired with $label raw response", async ({ reviewerRole, stage, model, rawResponse }) => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    const candidateSha256 = transaction.hash(body);
    const logicalOperationId = `provider-step-${transaction.hash(`${reviewerRole}:${stage}:${rawResponse}`)}`;
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const artifact = {
      schema_version: "1.0", job_id: "test-job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
      transaction_id: transaction.transactionId, chapter_number: 5, role: reviewerRole, stage,
      provider: "test-provider", requested_model: model, input_fingerprint: "a".repeat(64),
      response_artifact_status: "COMPLETE", content_sha256: transaction.hash(rawResponse), response: { content: rawResponse },
    };
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    await mkdir(join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses"), { recursive: true });
    await writeFile(join(bookDir, artifactRelativePath), bytes);
    const dimensions = reviewerRole === "logic-canon-auditor"
      ? { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 }
      : { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 };
    await expect(recordChapterTransactionReviewEvidence({
      bookDir, transactionId: transaction.transactionId, candidateSha256, reviewerRole,
      evidence: {
        reviewerRole, provider: "test-provider", model, totalScore: 92,
        dimensionScores: dimensions, decision: "APPROVED", findings: [], reviewedCandidateSha: candidateSha256,
      },
      providerEvidence: {
        transactionId: transaction.transactionId, logicalOperationId, chapterNumber: 5, role: reviewerRole, stage,
        provider: "test-provider", requestedModel: model, inputFingerprint: "a".repeat(64), artifactRelativePath,
        artifactSha256: transaction.hash(bytes), responseContentSha256: transaction.hash(rawResponse), responseArtifactStatus: "COMPLETE",
      },
    })).rejects.toThrow(/raw response|parsed|review binding/i);
  });

  it("rejects a raw approval whose exact Provider input belongs to a different candidate", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    const candidateSha256 = transaction.hash(body);
    const rawResponse = JSON.stringify({
      passed: true, overall_score: 92,
      dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 },
      issues: [], summary: "approved",
    });
    const logicalOperationId = `provider-step-${transaction.hash("old-candidate-logic")}`;
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const staleInputFingerprint = "a".repeat(64);
    const artifact = {
      schema_version: "1.0", job_id: "test-job", logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
      transaction_id: transaction.transactionId, chapter_number: 5, role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
      provider: "test-provider", requested_model: "logic-model", input_fingerprint: staleInputFingerprint,
      response_artifact_status: "COMPLETE", content_sha256: transaction.hash(rawResponse), response: { content: rawResponse },
    };
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    await mkdir(join(bookDir, artifactRelativePath, ".."), { recursive: true });
    await writeFile(join(bookDir, artifactRelativePath), bytes);
    const input = {
      bookDir, transactionId: transaction.transactionId, candidateSha256, reviewerRole: "logic-canon-auditor",
      evidence: {
        reviewerRole: "logic-canon-auditor", provider: "test-provider", model: "logic-model", totalScore: 92,
        dimensionScores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 },
        decision: "APPROVED", findings: [], reviewedCandidateSha: candidateSha256,
      },
      expectedInputFingerprint: "b".repeat(64),
      providerEvidence: {
        transactionId: transaction.transactionId, logicalOperationId, chapterNumber: 5, role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
        provider: "test-provider", requestedModel: "logic-model", inputFingerprint: staleInputFingerprint, artifactRelativePath,
        artifactSha256: transaction.hash(bytes), responseContentSha256: transaction.hash(rawResponse), responseArtifactStatus: "COMPLETE",
      },
    };

    await expect(recordChapterTransactionReviewEvidence(input as never)).rejects.toThrow(/input fingerprint|candidate request/i);
  });

  it.each(["malformed-json", "non-enoent-io"])("types terminal review Provider %s failures as artifact evidence defects", async (failure) => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    const logicalOperationId = `provider-step-${transaction.hash(failure)}`;
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const artifactPath = join(bookDir, artifactRelativePath);
    await mkdir(join(artifactPath, ".."), { recursive: true });
    let artifactSha256 = "a".repeat(64);
    if (failure === "malformed-json") {
      const bytes = Buffer.from("{not-json\n");
      await writeFile(artifactPath, bytes);
      artifactSha256 = transaction.hash(bytes);
    } else {
      await mkdir(artifactPath);
    }
    const input = {
      bookDir, transactionId: transaction.transactionId, candidateSha256: transaction.hash(body), reviewerRole: "logic-canon-auditor",
      evidence: {}, providerEvidence: {
        transactionId: transaction.transactionId, logicalOperationId, chapterNumber: 5, role: "logic-canon-auditor", stage: "LOGIC_REVIEW",
        provider: "test-provider", requestedModel: "logic-model", inputFingerprint: "a".repeat(64), artifactRelativePath,
        artifactSha256, responseContentSha256: "b".repeat(64), responseArtifactStatus: "COMPLETE" as const,
      },
    };

    await expect(recordChapterTransactionReviewEvidence(input)).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("rejects a committed V2 bundle when a committed model context record is mutated", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const contextPath = join(bookDir, "story", "commits", "chapter-0005", "extraction-context.json");
    const context = JSON.parse(await readFile(contextPath, "utf8"));
    await writeFile(contextPath, `${JSON.stringify({ ...context, requestSha256: "f".repeat(64) }, null, 2)}\n`, "utf8");
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/extraction context|evidence hash|artifact/i);
  });

  it("rejects a self-consistent model context whose full messages do not produce the committed Provider fingerprint", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const truthRoot = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "truth", stageInput.review.finalCandidateSha256);
    const contextPath = join(truthRoot, "initial", "extraction-context.json");
    const extractionPath = join(truthRoot, "initial", "extraction.json");
    const original = JSON.parse(await readFile(contextPath, "utf8"));
    const extractorReference = stageInput.providerReferences.find((reference) => reference.role === "truth-extractor")!;
    const unsigned = {
      ...original,
      execution: {
        provider: extractorReference.provider,
        model: extractorReference.requestedModel,
        messages: [{ role: "system", content: "FORGED_MESSAGES" }],
        temperature: 0.1,
        maxTokens: 16_384,
        stream: false,
        inputFingerprint: extractorReference.inputFingerprint,
      },
    };
    delete unsigned.contextSha256;
    const forgedContext = { ...unsigned, contextSha256: canonicalSha256(unsigned) };
    await writeFile(contextPath, `${canonicalJson(forgedContext)}\n`, "utf8");
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    await writeFile(extractionPath, `${canonicalJson({ ...extraction, contextSha256: forgedContext.contextSha256 })}\n`, "utf8");

    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      truth: {
        ...stageInput.truth,
        extractionContext: forgedContext,
        extractorEvidence: { ...stageInput.truth.extractorEvidence, contextSha256: forgedContext.contextSha256 },
      },
    } as never)).rejects.toThrow(/messages|fingerprint|execution|model context/i);
  });

  async function installConflictingCommitTarget(bookDir: string): Promise<void> {
    const other = await fixture();
    const otherTransaction = await stagePassing(other.bookDir);
    await finalizeChapterTransaction({ bookDir: other.bookDir, transactionId: otherTransaction.transactionId });
    await rm(join(bookDir, "story", "commits", "chapter-0005"), { recursive: true, force: true });
    await cp(join(other.bookDir, "story", "commits", "chapter-0005"), join(bookDir, "story", "commits", "chapter-0005"), { recursive: true });
    await cp(join(other.bookDir, "story", "runtime", "bounded-autonomous", "provider-responses"), join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses"), { recursive: true, force: true });
  }

  it("finalizes target-first after source vanished and fails closed on a differing target/source identity", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const first = await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const replay = await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    expect(replay.commitSha256).toBe(first.commitSha256);

    const conflicting = await fixture(3);
    const staged = await stageV2Passing(conflicting.bookDir);
    await installConflictingCommitTarget(conflicting.bookDir);
    await expect(finalizeChapterTransaction({ bookDir: conflicting.bookDir, transactionId: staged.transaction.transactionId }))
      .rejects.toThrow(/immutable chapter commit conflict|identity mismatch/i);
  });

  it("fails closed when a differing valid target wins the atomic promotion race", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    await expect(finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      beforePromote: () => installConflictingCommitTarget(bookDir),
    })).rejects.toThrow(/rename race conflict/i);
  });

  it("rechecks and verifies the retained target identity when source vanishes during source verification", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const source = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    const target = join(bookDir, "story", "commits", "chapter-0005");
    const duringVerification = vi.fn(async () => {
      await mkdir(join(bookDir, "story", "commits"), { recursive: true });
      await rename(source, target);
    });

    const commit = await finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      afterRetainSourceIdentity: duringVerification,
    } as never);

    expect(duringVerification).toHaveBeenCalledTimes(1);
    expect(commit.commitSha256).toBe((await verifyChapterCommit({ bookDir, chapterNumber: 5 })).commitSha256);
  });

  it("reverifies and returns a valid target when source vanishes after the target-first exists check", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const source = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    const target = join(bookDir, "story", "commits", "chapter-0005");
    await mkdir(join(bookDir, "story", "commits"), { recursive: true });
    await cp(source, target, { recursive: true });
    const afterTargetSourceExists = vi.fn(async () => rm(source, { recursive: true, force: true }));

    const commit = await finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      afterTargetSourceExists,
    } as never);

    expect(afterTargetSourceExists).toHaveBeenCalledTimes(1);
    await expect(stat(source)).rejects.toThrow();
    expect(commit.commitSha256).toBe((await verifyChapterCommit({ bookDir, chapterNumber: 5 })).commitSha256);
  });

  it("fails closed when the final target changes after target-first verification while the retained source remains", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const source = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    const target = join(bookDir, "story", "commits", "chapter-0005");
    await mkdir(join(bookDir, "story", "commits"), { recursive: true });
    await cp(source, target, { recursive: true });
    const initial = await verifyChapterCommit({ bookDir, chapterNumber: 5 });
    let replacementSha256 = "";
    const replaceVerifiedTarget = vi.fn(async () => {
      await installConflictingCommitTarget(bookDir);
      replacementSha256 = (await verifyChapterCommit({ bookDir, chapterNumber: 5 })).commitSha256;
    });

    await expect(finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      afterTargetSourceExists: replaceVerifiedTarget,
    })).rejects.toThrow(/immutable.*target|target.*conflict|immutable chapter commit conflict/i);

    expect(replaceVerifiedTarget).toHaveBeenCalledTimes(1);
    await expect(stat(source)).resolves.toBeDefined();
    expect(replacementSha256).not.toBe(initial.commitSha256);
  });

  it("fails closed when a fully verified source changes in beforePromote even if rename succeeds", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const source = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    const replaceVerifiedSource = vi.fn(async () => {
      const commitPath = join(source, "commit.json");
      const commit = JSON.parse(await readFile(commitPath, "utf8"));
      const { commitSha256: _oldCommitSha256, ...unsigned } = {
        ...commit,
        completedAt: "2026-09-05T00:00:01.000Z",
      };
      await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");
    });

    await expect(finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      beforePromote: replaceVerifiedSource,
    })).rejects.toThrow(/immutable.*target|source.*conflict|immutable.*identity/i);

    expect(replaceVerifiedSource).toHaveBeenCalledTimes(1);
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).resolves.toMatchObject({
      transactionId: staged.transaction.transactionId,
    });
  });

  it("fails closed when retained source identity is replaced by a different valid same-transaction bundle", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const source = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle");
    const replaceRetainedSource = vi.fn(async () => {
      const commitPath = join(source, "commit.json");
      const commit = JSON.parse(await readFile(commitPath, "utf8"));
      const { commitSha256: _oldCommitSha256, ...unsigned } = {
        ...commit,
        completedAt: "2026-09-05T00:00:00.000Z",
      };
      await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");
    });

    await expect(finalizeChapterTransaction({
      bookDir,
      transactionId: staged.transaction.transactionId,
      afterRetainSourceIdentity: replaceRetainedSource,
    })).rejects.toThrow(/staged source identity|source.*conflict|immutable/i);
    expect(replaceRetainedSource).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the final target Commit changes inside one verification call", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    const initial = await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const providerRefsPath = join(bookDir, "story", "commits", "chapter-0005", "provider-refs.json");
    providerArtifactReadRace.targetPath = providerRefsPath;
    providerArtifactReadRace.afterRead = async (readNumber) => {
      if (readNumber === 3) await installConflictingCommitTarget(bookDir);
    };

    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 }))
      .rejects.toThrow(/Commit artifact changed during verification|verification snapshot conflict/i);
    expect(providerArtifactReadRace.readCount).toBe(3);

    providerArtifactReadRace.targetPath = "";
    const replacement = await verifyChapterCommit({ bookDir, chapterNumber: 5 });
    expect(replacement.commitSha256).not.toBe(initial.commitSha256);
  });

  it("rejects Provider response usage that differs from truth artifacts and aggregated Commit V2 role totals", async () => {
    const { bookDir } = await fixture(3);
    await expect(stageV2Passing(bookDir, 5, {
      extractorProviderUsage: { promptTokens: 9, completionTokens: 9, totalTokens: 18 },
    })).rejects.toThrow(/Provider.*usage|usage.*Provider|truth-extractor.*usage/i);
  });

  it("persists the exact Chinese Logic review language and reparses identical stable evidence at stage and committed verification", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir, 5, { logicReviewLanguage: "zh" });
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });

    const record = JSON.parse(await readFile(join(bookDir, "story", "commits", "chapter-0005", "logic-review-evidence.json"), "utf8"));
    expect(record.providerRequest.reviewLanguage).toBe("zh");
    expect(record.evidence.findings).toContainEqual(expect.objectContaining({ impact: "未分类" }));
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).resolves.toMatchObject({ kind: "TRUTH_CHAPTER_COMMIT" });
  });

  it("types a missing terminal Provider reference before V2 staging", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const withoutLogicReference = {
      ...stageInput,
      providerReferences: stageInput.providerReferences.filter((reference) => reference.role !== "logic-canon-auditor"),
    };

    await expect(stageTruthChapterCommitV2(withoutLogicReference)).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("rejects duplicate Provider operation IDs, artifact paths/identities, and full references before Commit persistence", async () => {
    for (const duplicateKind of ["logicalOperationId", "artifactRelativePath", "artifactSha256", "full"] as const) {
      const { bookDir } = await fixture(3);
      const { stageInput } = await stageV2Passing(bookDir);
      await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
      const writer = stageInput.providerReferences.find((reference) => reference.role === "writer")!;
      const commercial = stageInput.providerReferences.find((reference) => reference.role === "commercial-reader")!;
      const replacement = duplicateKind === "full" ? writer : { ...commercial, [duplicateKind]: writer[duplicateKind] };
      const providerReferences = stageInput.providerReferences.map((reference) => reference === commercial ? replacement : reference);

      await expect(stageTruthChapterCommitV2({ ...stageInput, providerReferences })).rejects.toThrow(/duplicate Provider reference/i);
      await expect(readFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle", "commit.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rechecks duplicate Provider references during committed V2 verification", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const root = join(bookDir, "story", "commits", "chapter-0005");
    const providerPath = join(root, "provider-refs.json");
    const references = JSON.parse(await readFile(providerPath, "utf8"));
    const forgedReferences = [...references, references[0]];
    const providerBytes = `${JSON.stringify(forgedReferences, null, 2)}\n`;
    const commitPath = join(root, "commit.json");
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha256, ...unsignedCommit } = {
      ...commit,
      providerReferenceCount: forgedReferences.length,
      providerReferencesSha256: sha256Utf8(providerBytes),
    };
    const forgedCommit = { ...unsignedCommit, commitSha256: canonicalSha256(unsignedCommit) };
    await Promise.all([
      writeFile(providerPath, providerBytes, "utf8"),
      writeFile(commitPath, `${JSON.stringify(forgedCommit, null, 2)}\n`, "utf8"),
    ]);

    await rehashAttackerControlledPayload(root);
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/duplicate Provider reference/i);
  });

  it("types a structurally valid terminal review record with a tampered internal raw binding at staging", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const logicDir = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "reviews", stageInput.review.finalCandidateSha256, "logic-canon-auditor");
    const [recordName] = await readdir(logicDir);
    const recordPath = join(logicDir, recordName!);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, `${JSON.stringify({ ...record, rawResponseSha256: "f".repeat(64) }, null, 2)}\n`, "utf8");

    await expect(stageTruthChapterCommitV2(stageInput)).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("types a committed terminal review record with a tampered internal raw binding", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const commitRoot = join(bookDir, "story", "commits", "chapter-0005");
    const recordPath = join(commitRoot, "logic-review-evidence.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const recordText = `${JSON.stringify({ ...record, rawResponseSha256: "f".repeat(64) }, null, 2)}\n`;
    await writeFile(recordPath, recordText, "utf8");
    const commitPath = join(commitRoot, "commit.json");
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha256, ...unsigned } = { ...commit, logicReviewRecordSha256: sha256Utf8(recordText) };
    await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");

    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it.each(["extra", "webSearch"] as const)(
    "rejects a self-consistently rehashed committed review whose full request %s disagrees with its reservation",
    async (field) => {
      const { bookDir } = await fixture(3);
      const { transaction } = await stageV2Passing(bookDir);
      await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
      const commitRoot = join(bookDir, "story", "commits", "chapter-0005");
      const recordPath = join(commitRoot, "logic-review-evidence.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      const providerRequest = field === "extra"
        ? { ...record.providerRequest, extra: { route: "self-nominated-review-route" } }
        : { ...record.providerRequest, webSearch: !record.providerRequest.webSearch };
      const recordText = `${JSON.stringify({ ...record, providerRequest }, null, 2)}\n`;
      await writeFile(recordPath, recordText, "utf8");
      const commitPath = join(commitRoot, "commit.json");
      const commit = JSON.parse(await readFile(commitPath, "utf8"));
      const { commitSha256: _oldCommitSha256, ...unsigned } = {
        ...commit,
        logicReviewRecordSha256: sha256Utf8(recordText),
      };
      await writeFile(
        commitPath,
        `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`,
        "utf8",
      );

      await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 }))
        .rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
    },
  );

  it("rejects ghost nonzero role usage without durable Provider evidence at staging", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const ghostUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      usage: {
        totalUsage: {
          promptTokens: stageInput.usage.totalUsage.promptTokens + ghostUsage.promptTokens,
          completionTokens: stageInput.usage.totalUsage.completionTokens + ghostUsage.completionTokens,
          totalTokens: stageInput.usage.totalUsage.totalTokens + ghostUsage.totalTokens,
        },
        roleUsage: { ...stageInput.usage.roleUsage, "ghost-model-role": ghostUsage },
      },
    })).rejects.toThrow(/ghost-model-role|Provider.*usage|usage.*Provider/i);
  });

  it("rejects cost-only ghost role usage without durable Provider evidence at staging", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const ghostUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, actualCostUsd: 0.25 };

    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      usage: {
        totalUsage: { ...stageInput.usage.totalUsage, actualCostUsd: ghostUsage.actualCostUsd },
        roleUsage: { ...stageInput.usage.roleUsage, "cost-only-ghost-role": ghostUsage },
      },
    })).rejects.toThrow(/cost-only-ghost-role|Provider.*usage|usage.*Provider/i);
  });

  it("rejects ghost nonzero role usage without durable Provider evidence on committed replay", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const commitRoot = join(bookDir, "story", "commits", "chapter-0005");
    const usagePath = join(commitRoot, "usage.json");
    const usage = JSON.parse(await readFile(usagePath, "utf8"));
    const ghostUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const usageText = `${JSON.stringify({
      ...usage,
      totalUsage: {
        promptTokens: usage.totalUsage.promptTokens + ghostUsage.promptTokens,
        completionTokens: usage.totalUsage.completionTokens + ghostUsage.completionTokens,
        totalTokens: usage.totalUsage.totalTokens + ghostUsage.totalTokens,
      },
      roleUsage: { ...usage.roleUsage, "ghost-model-role": ghostUsage },
    }, null, 2)}\n`;
    await writeFile(usagePath, usageText, "utf8");
    const commitPath = join(commitRoot, "commit.json");
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha256, ...unsigned } = { ...commit, usageSha256: sha256Utf8(usageText) };
    await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");

    await rehashAttackerControlledPayload(commitRoot);
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).rejects.toThrow(/ghost-model-role|Provider.*usage|usage.*Provider/i);
  });

  it("rejects cost-only ghost role usage without durable Provider evidence on committed replay", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const root = join(bookDir, "story", "commits", "chapter-0005");
    const usagePath = join(root, "usage.json");
    const usage = JSON.parse(await readFile(usagePath, "utf8"));
    const ghostUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, actualCostUsd: 0.25 };
    const usageText = `${JSON.stringify({
      ...usage,
      totalUsage: { ...usage.totalUsage, actualCostUsd: ghostUsage.actualCostUsd },
      roleUsage: { ...usage.roleUsage, "cost-only-ghost-role": ghostUsage },
    }, null, 2)}\n`;
    await writeFile(usagePath, usageText, "utf8");
    const commitPath = join(root, "commit.json");
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha256, ...unsigned } = { ...commit, usageSha256: sha256Utf8(usageText) };
    await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");

    await rehashAttackerControlledPayload(root);
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 }))
      .rejects.toThrow(/cost-only-ghost-role|Provider.*usage|usage.*Provider/i);
  });

  it("admits Writer N+1 from verified committed V2 truth only and rejects V1 after V2", async () => {
    const { bookDir } = await fixture(3);
    const { transaction, resultingTruth } = await stageV2Passing(bookDir);
    await writeFile(join(bookDir, "story", "state", "truth.json"), JSON.stringify(firstV2Truth()), { encoding: "utf8", flag: "w" }).catch(async () => {
      await mkdir(join(bookDir, "story", "state"), { recursive: true });
      await writeFile(join(bookDir, "story", "state", "truth.json"), JSON.stringify(firstV2Truth()), "utf8");
    });
    await expect(loadCommittedTruthForWriter({ bookDir, chapterNumber: 6 })).rejects.toThrow(/committed V2 truth|predecessor/i);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    expect(await loadCommittedTruthForWriter({ bookDir, chapterNumber: 6 })).toEqual(resultingTruth);

    const next = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 6, productionAuthority: "blueprint:v2", truthMode: "CANONICAL_V2" });
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: next.transactionId, title: "legacy after V2", body, lengthSpec,
      review: {} as never, stateFiles: {}, snapshotFiles: {}, usage: {}, stateValidation: {} as never,
      providerReferences: [], completedAt: "2026-09-04T00:00:00.000Z",
    })).rejects.toThrow(/V1 after V2/i);
  });

  it("rejects a V2 successor whose supplied predecessor is not the previous committed truth", async () => {
    const { bookDir } = await fixture(3);
    const first = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: first.transaction.transactionId });
    const second = await stageV2Passing(bookDir, 6);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0006", "staging", "bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({
      ...second.stageInput,
      truth: {
        ...second.stageInput.truth,
        predecessor: { ...second.stageInput.truth.predecessor, lineage: { ...second.stageInput.truth.predecessor.lineage, predecessorCommitSha256: "f".repeat(64) } },
      },
    })).rejects.toThrow(/previous committed V2 truth|predecessor truth/i);
  });

  it("maps Package A state projections to one commit/state and public story/state prefix", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    await reconcileChapterProjections({ bookDir });
    await expect(readFile(join(bookDir, "story", "commits", "chapter-0005", "state", "current_state.json"))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(bookDir, "story", "state", "current_state.json"))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(bookDir, "story", "commits", "chapter-0005", "state", "state", "current_state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(bookDir, "story", "state", "state", "current_state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects first-V2 staging without the exact verified baseline predecessor authority", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const { firstV2Baseline: _omitted, ...withoutBaseline } = stageInput;
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/first-v2-baseline.json"));
    await expect(stageTruthChapterCommitV2(withoutBaseline)).rejects.toThrow(/baseline|predecessor authority/i);
  });

  it("rejects a supplied first-V2 baseline whose predecessor authority is not exact", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      firstV2Baseline: { ...stageInput.firstV2Baseline!, previousAuthoritySha256: "f".repeat(64) },
    })).rejects.toThrow(/baseline|predecessor authority/i);
  });

  it("rejects a supplied first-V2 baseline whose immutable predecessor prose hash is not exact", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      firstV2Baseline: { ...stageInput.firstV2Baseline!, predecessorChapterBodySha256: "f".repeat(64) },
    })).rejects.toThrow(/baseline|predecessor prose|hash/i);
  });

  it("binds Commit V2 to the current transaction attempt identity", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      truth: { ...stageInput.truth, applicationReceipt: { ...stageInput.truth.applicationReceipt, attemptId: "attempt-9999" } },
    })).rejects.toThrow(/attempt|context/i);
  });

  it("does not let an abandoned attempt's V2 artifacts authorize a fresh attempt", async () => {
    const { bookDir } = await fixture(3);
    const { transaction, stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    await abandonChapterTransactionAttempt({
      bookDir, bookId: "book-a", chapterNumber: 5, transactionId: transaction.transactionId,
      runtimeSnapshot: "abandoned V2 attempt", abandonedAt: "2026-09-04T01:00:00.000Z",
    });
    const fresh = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    expect(fresh.attemptNumber).toBe(2);
    await expect(stageTruthChapterCommitV2(stageInput)).rejects.toThrow(/abandoned/i);
    await expect(stageTruthChapterCommitV2({ ...stageInput, transactionId: fresh.transactionId })).rejects.toThrow(/transaction|attempt/i);
  });

  it("rejects fabricated semantic PASS when the durable Validator response is non-PASS", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const validator = stageInput.providerReferences.find((reference) => reference.role === "truth-validator")!;
    const path = join(bookDir, validator.artifactRelativePath);
    const artifact = JSON.parse(await readFile(path, "utf8"));
    const rawResponse = '{"verdict":"PROSE_CONTENT_DEFECT","diagnostics":["contradiction"]}';
    const updatedArtifact = { ...artifact, content_sha256: sha256Utf8(rawResponse), response: { ...artifact.response, content: rawResponse } };
    const bytes = Buffer.from(`${JSON.stringify(updatedArtifact, null, 2)}\n`);
    await writeFile(path, bytes);
    const updatedReference = { ...validator, artifactSha256: sha256Utf8(bytes.toString("utf8")), responseContentSha256: sha256Utf8(rawResponse) };
    const updatedSemanticValidation = { ...stageInput.truth.semanticValidation, providerArtifactSha256: updatedReference.artifactSha256, responseContentSha256: updatedReference.responseContentSha256 };
    await writeFile(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "truth",
      stageInput.review.finalCandidateSha256, "initial", "semantic-validation.json"), JSON.stringify(updatedSemanticValidation), "utf8");
    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      providerReferences: stageInput.providerReferences.map((reference) => reference === validator ? updatedReference : reference),
      truth: {
        ...stageInput.truth,
        semanticValidation: updatedSemanticValidation,
        validatorEvidence: { ...stageInput.truth.validatorEvidence, providerArtifactSha256: updatedReference.artifactSha256, responseContentSha256: updatedReference.responseContentSha256 },
      },
    })).rejects.toThrow(/Validator|semantic.*response|PASS binding/i);
  });

  it("rejects fabricated accepted truth whose exact Extractor Provider response admits different bytes", async () => {
    const { bookDir } = await fixture(3);
    const unrelatedProviderResponse = JSON.stringify({
      schemaVersion: "1.0",
      kind: "CHAPTER_DELTA_PROPOSAL",
      status: "AMBIGUOUS",
      operations: [],
      evidence: [{
        kind: "FINAL_PROSE_SPAN",
        evidenceId: "ev-0001",
        startUtf16: 0,
        endUtf16: body.length,
        quote: body,
      }],
      ambiguities: [{
        ambiguityId: "amb-0001",
        classification: "PROSE_SEMANTICS_UNRESOLVED",
        description: "The Provider did not authorize a READY delta.",
        proseEvidenceIds: ["ev-0001"],
        predecessorEvidenceIds: [],
        relatedOperationIds: [],
        relatedNodeRefs: [],
      }],
    });

    await expect(stageV2Passing(bookDir, 5, {
      providerExtractorRawResponse: unrelatedProviderResponse,
    })).rejects.toThrow(/Extractor|raw proposal|admission|Provider response/i);
  });

  it("rejects a mutated durable extraction rawProposal even when accepted downstream artifacts remain self-consistent", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle"), { recursive: true, force: true });
    const extractionPath = join(
      bookDir,
      "story/runtime/chapter-transactions/chapter-0005/staging/evidence/truth",
      stageInput.review.finalCandidateSha256,
      "initial/extraction.json",
    );
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    await writeFile(extractionPath, `${canonicalJson({ ...extraction, rawProposal: "not-the-provider-response" })}\n`, "utf8");

    await expect(stageTruthChapterCommitV2(stageInput)).rejects.toThrow(/Extractor|raw proposal|Provider response/i);
  });

  it("rejects a fully self-consistent staged context graph with a fabricated context schema", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    const truthRoot = join(
      bookDir,
      "story/runtime/chapter-transactions/chapter-0005/staging/evidence/truth",
      stageInput.review.finalCandidateSha256,
    );
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle"), { recursive: true, force: true });
    const contextPath = join(truthRoot, "context.json");
    const context = JSON.parse(await readFile(contextPath, "utf8"));
    const { contextSha256: _oldContextSha, ...unsignedContext } = context;
    const forgedUnsignedContext = { ...unsignedContext, schemaVersion: "9.9" };
    const forgedContextSha256 = canonicalSha256(forgedUnsignedContext);
    await writeFile(contextPath, `${canonicalJson({ ...forgedUnsignedContext, contextSha256: forgedContextSha256 })}\n`, "utf8");

    const rebaseModelContext = async (name: "extraction" | "validation") => {
      const path = join(truthRoot, "initial", `${name}-context.json`);
      const record = JSON.parse(await readFile(path, "utf8"));
      const { contextSha256: _oldSha, ...unsigned } = record;
      const forgedUnsigned = { ...unsigned, baseContextSha256: forgedContextSha256 };
      const forged = { ...forgedUnsigned, contextSha256: canonicalSha256(forgedUnsigned) };
      await writeFile(path, `${canonicalJson(forged)}\n`, "utf8");
      return forged;
    };
    const extractionContext = await rebaseModelContext("extraction");
    const validationContext = await rebaseModelContext("validation");
    const extractionPath = join(truthRoot, "initial", "extraction.json");
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    await writeFile(extractionPath, `${canonicalJson({ ...extraction, contextSha256: extractionContext.contextSha256 })}\n`, "utf8");
    const validationPath = join(truthRoot, "initial", "semantic-validation.json");
    const semanticValidation = JSON.parse(await readFile(validationPath, "utf8"));
    const forgedValidation = { ...semanticValidation, contextSha256: validationContext.contextSha256 };
    await writeFile(validationPath, `${canonicalJson(forgedValidation)}\n`, "utf8");

    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      truth: {
        ...stageInput.truth,
        contextSha256: forgedContextSha256,
        extractionContext,
        validationContext,
        semanticValidation: forgedValidation,
        extractorEvidence: { ...stageInput.truth.extractorEvidence, contextSha256: extractionContext.contextSha256 },
        validatorEvidence: { ...stageInput.truth.validatorEvidence, contextSha256: validationContext.contextSha256 },
      },
    } as never)).rejects.toThrow(/schema|complete canonical truth context|semantic/i);
  });

  it("requires Commit V2 terminal Logic and Reader records to bind the exact final candidate and Provider operation", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "bundle"), { recursive: true, force: true });
    const logicDir = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0005", "staging", "evidence", "reviews",
      stageInput.review.finalCandidateSha256, "logic-canon-auditor");
    const [recordName] = await readdir(logicDir);
    const recordPath = join(logicDir, recordName!);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const writerReference = stageInput.providerReferences.find((reference) => reference.role === "writer")!;
    await writeFile(recordPath, `${JSON.stringify({ ...record, providerEvidence: writerReference }, null, 2)}\n`, "utf8");

    await expect(stageTruthChapterCommitV2(stageInput)).rejects.toThrow(/candidate\/Provider review binding|Provider/i);
  });

  it("rejects any non-identical staged V2 replay rather than comparing a subset", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await expect(stageTruthChapterCommitV2({ ...stageInput, title: "Different immutable title" })).rejects.toThrow(/immutable.*conflict/i);
    await expect(stageTruthChapterCommitV2({ ...stageInput, usage: { totalTokens: 43 } })).rejects.toThrow(/immutable.*conflict/i);
  });

  it("immutably reserves the complete candidate-bound Provider request before transport and binds its artifact", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2",
    });
    const candidate = "reserved candidate";
    const candidateSha256 = sha256Utf8(candidate);
    await recordChapterTransactionCandidate({
      bookDir, transactionId: transaction.transactionId, label: "INITIAL", content: candidate, sha256: candidateSha256,
    });
    const request = {
      provider: "provider-a", model: "model-a",
      messages: [{ role: "user" as const, content: `## Chapter Content Under Review\n${candidate}` }],
      temperature: 0.2, maxTokens: 4096, stream: false, webSearch: true,
      extra: { routing: { pool: "authority" }, seed: 7 },
    };
    const reservation = await reserveChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5,
      candidateSha256, role: "logic-canon-auditor", stage: "LOGIC_REVIEW", requestOrdinal: 0, reviewLanguage: "en", request,
    });
    await expect(reserveChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5,
      candidateSha256, role: "logic-canon-auditor", stage: "LOGIC_REVIEW", requestOrdinal: 0, reviewLanguage: "en", request,
    })).resolves.toEqual(reservation);
    await expect(reserveChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5,
      candidateSha256, role: "logic-canon-auditor", stage: "LOGIC_REVIEW", requestOrdinal: 0, reviewLanguage: "en",
      request: { ...request, extra: { routing: { pool: "drifted" }, seed: 7 } },
    })).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);

    const logicalOperationId = `provider-step-${sha256Utf8("reserved-operation")}`;
    const responseContent = '{"passed":true}';
    const artifactPath = join(bookDir, "story/runtime/bounded-autonomous/provider-responses", `${logicalOperationId}.json`);
    const artifact = {
      schema_version: "1.0", transaction_id: transaction.transactionId, chapter_number: 5,
      logical_step_id: logicalOperationId, usage_identity: logicalOperationId,
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW", provider: request.provider, requested_model: request.model,
      input_fingerprint: reservation.providerInputFingerprint, response_artifact_status: "COMPLETE",
      content_sha256: sha256Utf8(responseContent), response: { content: responseContent, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    };
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, bytes);
    const reference: ChapterProviderReference = {
      transactionId: transaction.transactionId, logicalOperationId, chapterNumber: 5,
      role: "logic-canon-auditor", stage: "LOGIC_REVIEW", provider: request.provider, requestedModel: request.model,
      inputFingerprint: reservation.providerInputFingerprint,
      artifactRelativePath: `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`,
      artifactSha256: sha256Utf8(bytes.toString()), responseContentSha256: sha256Utf8(responseContent), responseArtifactStatus: "COMPLETE",
    };
    await expect(bindChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, reservationId: reservation.reservationId, providerReference: reference,
    })).resolves.toMatchObject({ reservationId: reservation.reservationId, logicalOperationId });
  });

  it("rejects a terminal request reservation whose role-specific messages do not bind the staged candidate bytes", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    const candidate = "candidate authority";
    const candidateSha256 = sha256Utf8(candidate);
    await recordChapterTransactionCandidate({ bookDir, transactionId: transaction.transactionId, label: "INITIAL", content: candidate, sha256: candidateSha256 });

    await expect(reserveChapterTransactionProviderRequest({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5, candidateSha256,
      role: "commercial-reader", stage: "READER_REVIEW", requestOrdinal: 0, reviewLanguage: "en",
      request: {
        provider: "provider-a", model: "model-a", messages: [{ role: "user", content: "Candidate:\nunrelated bytes" }],
        temperature: 0.2, maxTokens: 4096, stream: false, webSearch: false, extra: {},
      },
    })).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("requires terminal request reservations/bindings at stage and commits their exact bytes", async () => {
    const { bookDir } = await fixture(3);
    await expect(stageV2Passing(bookDir, 5, { omitTerminalRequestAuthorities: true }))
      .rejects.toBeInstanceOf(ChapterArtifactEvidenceError);

    const clean = await fixture(3);
    const staged = await stageV2Passing(clean.bookDir);
    await finalizeChapterTransaction({ bookDir: clean.bookDir, transactionId: staged.transaction.transactionId });
    const commitRoot = join(clean.bookDir, "story/commits/chapter-0005");
    for (const name of [
      "logic-review-request-reservation.json", "logic-review-request-binding.json",
      "commercial-review-request-reservation.json", "commercial-review-request-binding.json",
      "truth-extractor-request-reservation.json", "truth-extractor-request-binding.json",
      "truth-validator-request-reservation.json", "truth-validator-request-binding.json",
    ]) {
      await expect(readFile(join(commitRoot, name), "utf8")).resolves.toContain(staged.transaction.transactionId);
    }
  });

  it("requires committed Truth request authority and rejects self-consistently rehashed extra drift", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    const root = join(bookDir, "story", "commits", "chapter-0005");
    const matches = await collectBoundChapterProviderRequests({
      bookDir,
      transactionId: staged.transaction.transactionId,
      chapterNumber: 5,
      candidateSha256: staged.stageInput.review.finalCandidateSha256,
      role: "truth-extractor",
      stage: "TRUTH_EXTRACTION",
    });
    expect(matches).toHaveLength(1);
    await finalizeChapterTransaction({ bookDir, transactionId: staged.transaction.transactionId });
    const original = matches[0]!;
    const forgedRequest = { ...original.reservation.request, extra: { route: "forged" } };
    const forgedReservation = {
      ...original.reservation,
      request: forgedRequest,
      requestSha256: sha256Utf8(JSON.stringify(forgedRequest)),
      fullRequestSha256: canonicalSha256({
        provider: forgedRequest.provider,
        model: forgedRequest.model,
        messages: forgedRequest.messages,
        temperature: forgedRequest.temperature,
        maxTokens: forgedRequest.maxTokens,
        stream: forgedRequest.stream,
        webSearch: forgedRequest.webSearch,
        extra: forgedRequest.extra,
      }),
    };
    const reservationText = `${JSON.stringify(forgedReservation, null, 2)}\n`;
    const bindingText = `${JSON.stringify(original.binding, null, 2)}\n`;
    await writeFile(join(root, "truth-extractor-request-reservation.json"), reservationText, "utf8");
    await writeFile(join(root, "truth-extractor-request-binding.json"), bindingText, "utf8");
    const commitPath = join(root, "commit.json");
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha256, ...unsigned } = {
      ...commit,
      truthExtractorRequestReservationSha256: sha256Utf8(reservationText),
      truthExtractorRequestBindingSha256: sha256Utf8(bindingText),
    };
    await writeFile(commitPath, `${JSON.stringify({ ...unsigned, commitSha256: canonicalSha256(unsigned) }, null, 2)}\n`, "utf8");

    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 }))
      .rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("rejects a committed V2 bundle missing exact Truth request reservation bytes", async () => {
    const { bookDir } = await fixture(3);
    const staged = await stageV2Passing(bookDir);
    await finalizeChapterTransaction({ bookDir, transactionId: staged.transaction.transactionId });
    await rm(join(bookDir, "story", "commits", "chapter-0005", "truth-validator-request-reservation.json"), { force: true });

    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 }))
      .rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("revalidates every reservation hash and canonical extra while collecting bound terminal authority", async () => {
    const { bookDir } = await fixture(3);
    const { transaction, stageInput } = await stageV2Passing(bookDir);
    const candidateSha256 = stageInput.review.finalCandidateSha256;
    const matches = await collectBoundChapterProviderRequests({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5, candidateSha256,
      role: "commercial-reader", stage: "READER_REVIEW",
    });
    expect(matches).toHaveLength(1);
    const reservation = matches[0]!.reservation;
    const reservationPath = join(
      bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/evidence/provider-requests/reservations",
      `${reservation.reservationId}.json`,
    );
    const forgedRequest = { ...reservation.request, extra: { route: "forged" } };
    await writeFile(reservationPath, `${JSON.stringify({
      ...reservation,
      request: forgedRequest,
      requestSha256: sha256Utf8(JSON.stringify(forgedRequest)),
    }, null, 2)}\n`, "utf8");

    await expect(collectBoundChapterProviderRequests({
      bookDir, transactionId: transaction.transactionId, chapterNumber: 5, candidateSha256,
      role: "commercial-reader", stage: "READER_REVIEW",
    })).rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("rejects self-consistently rehashed Truth execution extra at staging", async () => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir);
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle"), { recursive: true, force: true });
    const truthRoot = join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/evidence/truth", stageInput.review.finalCandidateSha256);
    const contextPath = join(truthRoot, "initial/extraction-context.json");
    const extractionPath = join(truthRoot, "initial/extraction.json");
    const original = JSON.parse(await readFile(contextPath, "utf8"));
    const fullRequest = { ...original.execution, extra: { route: "forged" } };
    delete fullRequest.inputFingerprint;
    delete fullRequest.fullRequestSha256;
    const forgedUnsigned = {
      ...original,
      execution: { ...fullRequest, fullRequestSha256: canonicalSha256(fullRequest), inputFingerprint: original.execution.inputFingerprint },
    };
    delete forgedUnsigned.contextSha256;
    const forgedContext = { ...forgedUnsigned, contextSha256: canonicalSha256(forgedUnsigned) };
    await writeFile(contextPath, `${canonicalJson(forgedContext)}\n`, "utf8");
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    await writeFile(extractionPath, `${canonicalJson({ ...extraction, contextSha256: forgedContext.contextSha256 })}\n`, "utf8");

    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      truth: {
        ...stageInput.truth,
        extractionContext: forgedContext,
        extractorEvidence: { ...stageInput.truth.extractorEvidence, contextSha256: forgedContext.contextSha256 },
      },
    } as never)).rejects.toThrow(/execution|extra|request|context/i);
  });

  it("types provider-reference directory and JSON collection failures", async () => {
    const { bookDir } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v2" });
    const providerDir = join(bookDir, "story/runtime/bounded-autonomous/provider-responses");
    await mkdir(providerDir, { recursive: true });
    await writeFile(join(providerDir, `provider-step-${"a".repeat(64)}.json`), "{", "utf8");
    await expect(collectChapterProviderReferences({ bookDir, chapterNumber: 5, transactionId: transaction.transactionId }))
      .rejects.toBeInstanceOf(ChapterArtifactEvidenceError);
  });

  it("derives every durable transaction role and exact optional cost from Provider artifacts", async () => {
    const { bookDir } = await fixture(3);
    const { transaction, stageInput } = await stageV2Passing(bookDir);
    const providerDir = join(bookDir, "story/runtime/bounded-autonomous/provider-responses");
    for (const [index, role] of ["reference-selector", "context-compression"].entries()) {
      const logicalOperationId = `provider-step-${sha256Utf8(`${transaction.transactionId}:${role}`)}`;
      const responseContent = `${role} response`;
      const artifact = {
        schema_version: "1.0", transaction_id: transaction.transactionId, chapter_number: 5,
        logical_step_id: logicalOperationId, usage_identity: logicalOperationId, role, stage: role.toUpperCase(),
        provider: "test-provider", requested_model: `${role}-model`, input_fingerprint: sha256Utf8(role),
        response_artifact_status: "COMPLETE", content_sha256: sha256Utf8(responseContent),
        response: { content: responseContent, usage: { promptTokens: index + 1, completionTokens: 2, totalTokens: index + 3, actualCostUsd: 0.125 * (index + 1) } },
      };
      await writeFile(join(providerDir, `${logicalOperationId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    }
    const references = await collectChapterProviderReferences({ bookDir, chapterNumber: 5, transactionId: transaction.transactionId });
    const usage = await deriveChapterProviderUsage({ bookDir, transactionId: transaction.transactionId, references });
    expect(Object.keys(usage.roleUsage).sort()).toEqual([
      "commercial-reader", "context-compression", "logic-canon-auditor", "reference-selector", "truth-extractor", "truth-validator", "writer",
    ]);
    expect(usage.roleUsage["reference-selector"]).toMatchObject({ promptTokens: 1, completionTokens: 2, totalTokens: 3, actualCostUsd: 0.125 });
    expect(usage.roleUsage["context-compression"]).toMatchObject({ promptTokens: 2, completionTokens: 2, totalTokens: 4, actualCostUsd: 0.25 });
    expect(usage.totalUsage).toMatchObject({ promptTokens: 13, completionTokens: 19, totalTokens: 32, actualCostUsd: 0.375 });
    expect(stageInput.providerReferences).toHaveLength(5);
  });

  it("uses one hash-bound Provider artifact snapshot for usage aggregation, staging, and Commit", async () => {
    const { bookDir } = await fixture(3);
    const { transaction, stageInput } = await stageV2Passing(bookDir);
    const writerReference = stageInput.providerReferences.find((reference) => reference.role === "writer")!;
    const artifactPath = join(bookDir, writerReference.artifactRelativePath);
    const originalBytes = await readFile(artifactPath);
    const originalArtifact = JSON.parse(originalBytes.toString("utf8"));
    const originalUsage = originalArtifact.response.usage;
    const forgedUsage = {
      promptTokens: originalUsage.promptTokens + 100,
      completionTokens: originalUsage.completionTokens + 100,
      totalTokens: originalUsage.totalTokens + 200,
      ...(originalUsage.actualCostUsd !== undefined ? { actualCostUsd: originalUsage.actualCostUsd + 10 } : {}),
    };
    const forgedBytes = Buffer.from(`${JSON.stringify({
      ...originalArtifact,
      response: { ...originalArtifact.response, usage: forgedUsage },
    }, null, 2)}\n`);
    providerArtifactReadRace.targetPath = artifactPath;
    providerArtifactReadRace.afterRead = async (readNumber) => {
      if (readNumber === 1) await writeFile(artifactPath, forgedBytes);
    };
    const derived = await deriveChapterProviderUsage({
      bookDir,
      transactionId: transaction.transactionId,
      references: stageInput.providerReferences,
    });
    const artifactReads = providerArtifactReadRace.readCount;
    providerArtifactReadRace.targetPath = "";
    providerArtifactReadRace.afterRead = undefined;
    await writeFile(artifactPath, originalBytes);

    expect(artifactReads).toBe(1);
    expect(derived.roleUsage.writer).toEqual(originalUsage);
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({ ...stageInput, usage: derived })).resolves.toBeUndefined();
    await expect(finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId })).resolves.toMatchObject({
      transactionId: transaction.transactionId,
    });
    const committedUsage = JSON.parse(await readFile(join(bookDir, "story/commits/chapter-0005/usage.json"), "utf8"));
    expect(committedUsage.roleUsage.writer).toEqual(originalUsage);
  });

  it("commits and re-verifies exact Provider actual cost without dropping or doubling it", async () => {
    const { bookDir } = await fixture(3);
    const { transaction } = await stageV2Passing(bookDir, 5, { providerActualCostUsd: 0.125 });
    await finalizeChapterTransaction({ bookDir, transactionId: transaction.transactionId });
    const usage = JSON.parse(await readFile(join(bookDir, "story/commits/chapter-0005/usage.json"), "utf8"));
    expect(usage.roleUsage.writer.actualCostUsd).toBe(0.125);
    expect(usage.totalUsage.actualCostUsd).toBe(0.625);
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 5 })).resolves.toMatchObject({ chapterNumber: 5 });
  });

  it.each([
    ["missing", (usage: any) => {
      const { actualCostUsd: _missingCost, ...writerWithoutCost } = usage.roleUsage.writer;
      return { ...usage, roleUsage: { ...usage.roleUsage, writer: writerWithoutCost } };
    }],
    ["doubled", (usage: any) => ({
      ...usage,
      totalUsage: { ...usage.totalUsage, actualCostUsd: usage.totalUsage.actualCostUsd * 2 },
    })],
  ] as const)("rejects %s Provider actual cost authority before Commit", async (_label, mutate) => {
    const { bookDir } = await fixture(3);
    const { stageInput } = await stageV2Passing(bookDir, 5, { providerActualCostUsd: 0.125 });
    await rm(join(bookDir, "story/runtime/chapter-transactions/chapter-0005/staging/bundle"), { recursive: true, force: true });
    await expect(stageTruthChapterCommitV2({
      ...stageInput,
      usage: mutate(stageInput.usage),
    })).rejects.toThrow(/Provider response usage|aggregated role usage|total usage/i);
  });
});
