
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

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommercialReaderAgent, parseCommercialReaderResponse } from "../agents/commercial-reader.js";
import { ContinuityAuditor, parseContinuityAuditResponse } from "../agents/continuity.js";
import { PlannerAgent } from "../agents/planner.js";
import { ReviserAgent } from "../agents/reviser.js";
import { buildTruthExtractorMessages, TRUTH_EXTRACTOR_OPTIONS, TruthExtractorAgent } from "../agents/truth-extractor.js";
import { buildTruthValidatorMessages, TRUTH_VALIDATOR_OPTIONS, TruthValidatorAgent } from "../agents/truth-validator.js";
import type { LLMMessage } from "../llm/provider.js";
import { parseTruthValidatorResponse } from "../agents/truth-validator.js";
import { WriterAgent } from "../agents/writer.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { createChapterGenesis, verifyChapterCommit, verifyChapterCommitChain, type FirstV2BaselineContext } from "../production/chapter-transaction.js";
import * as transactionModule from "../production/chapter-transaction.js";
import { createAutonomousProviderExecution } from "../production/bounded-autonomous-controller.js";
import * as llmProvider from "../llm/provider.js";
import { canonicalJson, canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { StateManager } from "../state/manager.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import * as canonicalModule from "../state/canonical-json.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;
const VALID_PLANNER_MEMO = [
  "# Chapter 1 memo",
  "## Chapter goal", "Open the watched gate without losing the clock.",
  "## Thread refs", "none",
  "## Scene and length budget", "Plan three concrete scenes with distinct actions, consequences, and measured word budgets.",
  "## Current task", "Open the watched gate while preserving the witnessed authority carried by the clock.",
  "## What the reader is waiting for right now", "The reader is waiting to see whether the gate opens before the clock expires.",
  "## To pay off / to keep buried", "Pay off the gate action while keeping the deeper authority conflict buried for later.",
  "## What the slow / transitional beats carry", "Any slower beat must carry pressure, evidence, relationship movement, or the next action.",
  "## Three-question check on the key choice", "The choice has a clear reason, serves the protagonist's interest, and matches established behavior.",
  "## Required end-of-chapter change", "End with a concrete change in access, pressure, evidence, relationship, objective, or risk.",
  "## Hook ledger for this chapter", "Advance the watched-gate promise, resolve only proved facts, and defer the hidden authority.",
  "## Do not", "Do not contradict established facts.",
].join("\n\n");
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function words(chapter: number): string {
  return Array.from({ length: 2_200 }, () => `chapter${chapter}`).join(" ");
}

function baselineTruth(bookId: string): StructuredTruthV1 {
  return {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId, throughChapter: 0,
    lineage: { kind: "BASELINE", predecessorCommitSha256: "a".repeat(64), baselineSourceManifestSha256: "b".repeat(64), seedVocabularyCatalogSha256: "c".repeat(64), baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: "d".repeat(64) },
    vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
    provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
  };
}

describe("synthetic canonical V2 continuity", () => {
  it.each([2, 3])("replays completed stages after BookRules authority failure with no new transports (reported total %i)", async (reportedTotal) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-bookrules-replay-")); roots.push(root);
    const state = new StateManager(root);
    const bookId = "island-authority";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await state.saveBookConfig(bookId, {
      id: bookId, title: "Island Archive", platform: "tomato", genre: "xuanhuan", status: "active",
      targetChapters: 10, chapterWordCount: 2_200, language: "en",
      createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
    });
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await mkdir(join(storyDir, "snapshots", "0"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(storyDir, "snapshots", "0", "baseline.txt"), "synthetic baseline");
    await writeFile(join(bookDir, "chapters", "index.json"), "[]\n");
    await writeFile(join(storyDir, "book_rules.md"), "# Book Rules\n## Era Constraints\n- Period: 1920\n");
    await writeFile(join(storyDir, "outline", "story_frame.md"), [
      "# Story Frame — Final Locked Projection", "Locked projection authority.",
      "## Product promise", "Keep the gate under pressure.",
      "## Two-level dramatic question", "The visible clock and hidden gate authority collide.",
      "## World anchor", "Witnessed rules cannot be erased.",
      "### Volume I — One (Chapters 1–10 center)", "Open the gate without losing the clock.",
    ].join("\n"));
    await writeFile(join(storyDir, "outline", "volume_map.md"), [
      "# Volume Map and Complete Chapter Blueprint Authority", "# PROJECTED VOLUME 1", "Status: locked.",
      "# Island Archive — Volume I Chapter Blueprint Set v1.1", "Closure: the gate opens.",
      ...Array.from({ length: 10 }, (_, i) => [`## Chapter ${String(i + 1).padStart(3, "0")} — Fixture ${i + 1}`, "Advance the gate."]).flat(),
    ].join("\n"));
    await writeFile(join(storyDir, "outline", "book-production-map.json"), JSON.stringify({
      schema_version: "1.0", book_id: bookId, authority_book_id: "island", title: "Island Archive", total_chapters: 10,
      volumes: [{ volume_id: "volume-001", volume_number: 1, title: "One", start_chapter: 1, end_chapter: 10, chapter_count: 10 }],
    }));
    await createChapterGenesis({ bookDir, bookId, lastTrustedChapter: 0, trustedSnapshotDir: join(storyDir, "snapshots", "0") });
    const firstV2Baseline = await installLegacyBaseline(bookDir, baselineTruth(bookId));
    let stage = { stage: "NOT_STARTED", role: "none", provider: "custom" as string | null, model: "scripted" as string | null, transactionId: undefined as string | undefined, reviewRound: undefined as number | undefined };
    const client = {
      provider: "openai", service: "custom", configSource: "studio", apiFormat: "chat", stream: false,
      _apiKey: "test-only", _piModel: { id: "scripted", name: "scripted", api: "openai-completions", provider: "openai", baseUrl: "https://transport.invalid/v1", contextWindow: 128_000, maxTokens: 16_384 },
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    } as ConstructorParameters<typeof PipelineRunner>[0]["client"];
    const roles: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      roles.push(stage.role);
      const responses: Record<string, string> = {
        planner: VALID_PLANNER_MEMO,
        writer: `<!-- PRE_WRITE_CHECK -->\nChecked.\n<!-- CHAPTER_TITLE -->\nIsland Gate\n<!-- CHAPTER_CONTENT -->\n${words(2)}`,
        "logic-canon-auditor": JSON.stringify({ passed: true, issues: [], summary: "approved", overall_score: 92, dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 } }),
        "commercial-reader": JSON.stringify({ total_score: 92, dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED", findings: [] }),
      };
      if (!responses[stage.role]) throw new Error(`Unexpected transport: ${stage.role}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: responses[stage.role] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: reportedTotal } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const run = () => {
      const runner = new PipelineRunner({ client, model: "scripted", projectRoot: root, boundedAutonomousReview: true, firstV2Baseline,
        onAutonomousStage: (event) => { stage = { ...event, transactionId: event.transactionId, reviewRound: event.reviewRound }; },
      });
      const execution = createAutonomousProviderExecution({ projectRoot: root, bookId, jobId: "bookrules-replay", getActiveStage: () => ({ ...stage, provider: "custom", model: "scripted" }) });
      return execution.execute(2, () => runner.writeNextChapter(bookId, 2_200));
    };
    await mkdir(join(storyDir, "runtime", "bounded-autonomous"), { recursive: true });
    await writeFile(join(storyDir, "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({ jobId: "bookrules-replay", status: "RUNNING", mode: "full-book", nextChapter: 2 }));
    const originalCanonical = canonicalModule.canonicalJson;
    const fault = vi.spyOn(canonicalModule, "canonicalJson").mockImplementation((value) => {
      if ((value as { kind?: string })?.kind === "CANONICAL_TRUTH_COMMITTED_AUTHORITY") throw new Error("bookrules-authority-checkpoint");
      return originalCanonical(value);
    });
    try {
      await expect(run()).rejects.toThrow("bookrules-authority-checkpoint");
      expect(roles).toEqual(["planner", "writer", "logic-canon-auditor", "commercial-reader"]);
      const evidenceDir = join(storyDir, "runtime", "chapter-transactions", "chapter-0002");
      const immutable = async () => {
        const paths = (await readdir(evidenceDir, { recursive: true })).filter((path) => /\.(json|md)$/.test(path)).sort();
        return Promise.all(paths.map(async (path) => [path, sha256Utf8(await readFile(join(evidenceDir, path), "utf8"))]));
      };
      const before = await immutable();
      expect(before.length).toBeGreaterThan(4);
      const responseDir = join(storyDir, "runtime", "bounded-autonomous", "provider-responses");
      const responses = async () => Promise.all((await readdir(responseDir)).sort().map(async (path) => [path, sha256Utf8(await readFile(join(responseDir, path), "utf8"))]));
      const responsesBefore = await responses();
      fault.mockRestore();
      const settlement = vi.spyOn(PipelineRunner.prototype, "runCanonicalTruthSettlement").mockImplementation(async (input) => {
        if (input.committedAuthority === undefined) throw new Error("Missing committed authority");
        expect(JSON.parse(input.committedAuthority).bookRules).toMatchObject({ eraConstraints: { enabled: true, period: "1920" } });
        expect(JSON.parse(input.committedAuthority).bookRules.eraConstraints).not.toHaveProperty("region");
        throw new Error("canonical-safe-settlement-reached");
      });
      await expect(run()).rejects.toThrow("canonical-safe-settlement-reached");
      expect(settlement).toHaveBeenCalledTimes(1);
      expect(roles).toEqual(["planner", "writer", "logic-canon-auditor", "commercial-reader"]);
      expect(await immutable()).toEqual(before);
      expect(await responses()).toEqual(responsesBefore);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["SEMANTIC_VALIDATION", "DELTA_ADMISSION"] as const)("advances three contiguous chapters through public PipelineRunner with %s repair and synthetic scripted local Provider transports", async (repairSource) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-v2-continuity-")); roots.push(root);
    const state = new StateManager(root);
    const bookId = "book-1";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await state.saveBookConfig(bookId, {
      id: bookId, title: "Test Book", platform: "tomato", genre: "xuanhuan", status: "active",
      targetChapters: 10, chapterWordCount: 2_200, language: "en",
      createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
    });
    await Promise.all([
      mkdir(join(storyDir, "outline"), { recursive: true }),
      mkdir(join(storyDir, "snapshots", "0"), { recursive: true }),
      mkdir(join(bookDir, "chapters"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(storyDir, "snapshots", "0", "baseline.txt"), "synthetic verified baseline", "utf8"),
      writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf8"),
      writeFile(join(storyDir, "outline", "story_frame.md"), [
        "# Story Frame — Final Locked Projection", "Locked projection authority.",
        "## Product promise", "Keep the gate under pressure.",
        "## Two-level dramatic question", "The visible clock and hidden gate authority collide.",
        "## World anchor", "Witnessed rules cannot be erased.",
        "### Volume I — One (Chapters 1–10 center)", "Open the gate without losing the clock.",
      ].join("\n"), "utf8"),
      writeFile(join(storyDir, "outline", "volume_map.md"), [
        "# Volume Map and Complete Chapter Blueprint Authority", "# PROJECTED VOLUME 1", "Status: locked.",
        "# Test Book — Volume I Chapter Blueprint Set v1.1", "Closure: the gate opens.",
        ...Array.from({ length: 10 }, (_, index) => [`## Chapter ${String(index + 1).padStart(3, "0")} — Fixture ${index + 1}`, `Advance fixture chapter ${index + 1}.`]).flat(),
      ].join("\n"), "utf8"),
      writeFile(join(storyDir, "outline", "book-production-map.json"), JSON.stringify({
        schema_version: "1.0", book_id: bookId, authority_book_id: "authority", title: "Test Book", total_chapters: 10,
        volumes: [{ volume_id: "volume-001", volume_number: 1, title: "One", start_chapter: 1, end_chapter: 10, chapter_count: 10 }],
      }), "utf8"),
    ]);

    const truth = baselineTruth(bookId);
    const genesis = await createChapterGenesis({ bookDir, bookId, lastTrustedChapter: 0, trustedSnapshotDir: join(storyDir, "snapshots", "0"), createdAt: "2026-09-04T00:00:00.000Z" });
    const firstV2Baseline = await installLegacyBaseline(bookDir, truth);

    let activeChapter = 0;
    let activeStage = { stage: "NOT_STARTED", role: "none", provider: "custom" as string | null, model: "scripted" as string | null, transactionId: undefined as string | undefined, reviewRound: undefined as number | undefined };
    let pendingResponseContent = "";
    let plannerTransportCount = 0;
    const client = {
      provider: "openai", service: "custom", configSource: "studio", apiFormat: "chat", stream: false,
      _apiKey: "test-only", _piModel: { id: "scripted", name: "scripted", api: "openai-completions", provider: "openai", baseUrl: "https://transport.invalid/v1", contextWindow: 128_000, maxTokens: 16_384 },
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    } as ConstructorParameters<typeof PipelineRunner>[0]["client"];
    const execution = createAutonomousProviderExecution({ projectRoot: root, bookId, jobId: "continuity", getActiveStage: () => ({
      stage: activeStage.stage, role: activeStage.role, provider: activeStage.provider ?? "custom", model: activeStage.model ?? "scripted",
      ...(activeStage.transactionId ? { transactionId: activeStage.transactionId } : {}),
      ...(activeStage.reviewRound !== undefined ? { reviewRound: activeStage.reviewRound } : {}),
    }) });
    await mkdir(join(storyDir, "runtime", "bounded-autonomous"), { recursive: true });
    await writeFile(join(storyDir, "runtime", "bounded-autonomous", "production-state.json"), JSON.stringify({ jobId: "continuity", status: "RUNNING", mode: "current-volume", nextChapter: 2 }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => {
      const plannerAttempt = activeStage.role === "planner" ? plannerTransportCount++ : -1;
      const content = plannerAttempt === 0 ? "malformed planner memo" : plannerAttempt > 0 ? VALID_PLANNER_MEMO : pendingResponseContent;
      const usage = plannerAttempt === 0
        ? { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
        : plannerAttempt > 0 ? { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
          : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    const invokeLocalProvider = async (
      content: string,
      messages: readonly LLMMessage[] = [],
      options: { readonly temperature?: number; readonly maxTokens?: number } = {},
      onFinalProviderRequest?: (request: any) => void | Promise<void>,
    ) => {
      pendingResponseContent = content;
      const providerRequestIdentity = {
        provider: "custom", model: "scripted", messages,
        temperature: options.temperature ?? client.defaults.temperature,
        maxTokens: options.maxTokens ?? client.defaults.maxTokens,
        stream: client.stream,
      };
      const requestUnsigned = { ...providerRequestIdentity, webSearch: false, extra: client.defaults.extra };
      await onFinalProviderRequest?.(requestUnsigned);
      const response = await llmProvider.chatCompletion(client, "scripted", messages, options);
      return { ...response, providerRequest: { ...requestUnsigned, reviewLanguage: "en" as const, inputFingerprint: sha256Utf8(JSON.stringify(providerRequestIdentity)) } };
    };
    const plannerTruthChapters: number[] = [];
    const writerTruthChapters: number[] = [];
    const logicTruthChapters: number[] = [];
    const plannerPredecessorBodies: string[] = [];
    const writerPredecessorBodies: string[] = [];
    const writerRecentAuthorityBodies: ReadonlyArray<string>[] = [];
    const logicPredecessorBodies: string[] = [];
    const observedTruthStages: string[] = [];
    let chapterOneLogicAttempt = 0;
    const realPlanChapter = PlannerAgent.prototype.planChapter;
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async function (this: PlannerAgent, input) {
      if (!input.authoritativeTruth) throw new Error("missing committed planner authority");
      plannerTruthChapters.push(input.authoritativeTruth.throughChapter);
      plannerPredecessorBodies.push(input.predecessorChapterBody ?? "MISSING");
      return realPlanChapter.call(this, input);
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockImplementation(async (input) => {
      if (!input.authoritativeTruth) throw new Error("missing committed writer authority");
      writerTruthChapters.push(input.authoritativeTruth.throughChapter);
      writerPredecessorBodies.push(input.predecessorChapterBody ?? "MISSING");
      writerRecentAuthorityBodies.push(input.immutableRecentChapterBodies ?? []);
      return ({
      chapterNumber: input.chapterNumber, title: `Chapter ${input.chapterNumber}`, content: words(input.chapterNumber), wordCount: 2_200,
      preWriteCheck: "checked", postSettlement: "deferred", updatedState: "", updatedLedger: "", updatedHooks: "",
      chapterSummary: "", updatedSubplots: "", updatedEmotionalArcs: "", updatedCharacterMatrix: "",
      postWriteErrors: [], postWriteWarnings: [], tokenUsage: ZERO_USAGE,
    }); });
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockImplementation(async (_dir, content, _chapter, _genre, options) => {
      if (!options?.authoritativeTruth) throw new Error("missing committed Logic authority");
      logicTruthChapters.push(options.authoritativeTruth.throughChapter);
      logicPredecessorBodies.push(options?.predecessorChapterBody ?? "MISSING");
      const raw = _chapter === 2 && chapterOneLogicAttempt++ === 0
        ? "malformed logic review"
        : JSON.stringify({ passed: true, issues: [], summary: "approved", overall_score: 92, dimension_scores: { blueprint_transition: 92, causal_logic: 92, canon_continuity: 92, character_motivation: 92, state_inheritance: 92, hooks_disclosure: 92, narrative_clarity: 92 } });
      const response = await invokeLocalProvider(raw, [{ role: "user", content: `## Chapter Content Under Review\n${content}` }], { temperature: 0.2 }, options.onFinalProviderRequest);
      return { ...parseContinuityAuditResponse(response.content, "en"), tokenUsage: response.usage, providerRequest: response.providerRequest, providerInputFingerprint: response.providerRequest.inputFingerprint };
    });
    vi.spyOn(CommercialReaderAgent.prototype, "reviewChapter").mockImplementation(async (input) => {
      const raw = JSON.stringify({ total_score: 92, dimension_scores: { opening_hook: 92, pacing_tension: 92, emotional_investment: 92, plot_clarity: 92, dialogue_appeal: 92, western_cultural_naturalness: 92, commercial_appeal: 92, ending_hook: 92 }, decision: "APPROVED", findings: [] });
      const response = await invokeLocalProvider(raw, [{ role: "user", content: `Candidate:\n${input.content}` }], { temperature: 0.2 }, input.onFinalProviderRequest);
      return { ...parseCommercialReaderResponse(response.content, { candidateSha: input.candidateSha, provider: "custom", model: "scripted" }), tokenUsage: response.usage, providerRequest: response.providerRequest, providerInputFingerprint: response.providerRequest.inputFingerprint };
    });
    const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(async (_bookDir, _content, chapterNumber) => ({
      revisedContent: Array.from({ length: 2_200 }, () => `revised${chapterNumber}`).join(" "),
      wordCount: 2_200, fixedIssues: ["truth semantic prose defect"],
      tokenUsage: ZERO_USAGE,
    }));
    let initialExtractionCount = 0;
    const extractorCall = vi.spyOn(TruthExtractorAgent.prototype, "extract").mockImplementation(async (request) => {
      const quote = request.candidate.slice(0, request.candidate.indexOf(" "));
      const proseEvidence = { kind: "FINAL_PROSE_SPAN", evidenceId: "ev-0001", startUtf16: 0, endUtf16: quote.length, quote };
      let proposal: Record<string, unknown>;
      if (request.chapterNumber === 2) {
        proposal = {
          schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", ambiguities: [], evidence: [proseEvidence],
          operations: [
            { kind: "DECLARE_ENTITY", operationId: "op-0001", localRef: "local:op-0001", before: { state: "ABSENT" }, after: { state: "PRESENT", definition: { definitionType: "NARRATIVE_ENTITY", entityKind: "story.character", identityKey: "ada", canonicalName: "Ada", aliases: [] } }, evidenceIds: ["ev-0001"] },
            { kind: "DECLARE_ENTITY", operationId: "op-0002", localRef: "local:op-0002", before: { state: "ABSENT" }, after: { state: "PRESENT", definition: { definitionType: "VOCABULARY_FACT_KEY", metaKind: "system.vocabulary.fact-key", canonicalName: "custom.character.status", semanticDefinition: "The character's current operational status.", valueContract: { contractType: "STRING" } } }, evidenceIds: ["ev-0001"] },
            { kind: "SET_FACT", operationId: "op-0003", subject: { refType: "LOCAL_ENTITY", localRef: "local:op-0001" }, factKey: { refType: "LOCAL_FACT_KEY", localRef: "local:op-0002" }, before: { state: "UNKNOWN" }, after: { state: "VALUE", value: { valueType: "STRING", value: "active" } }, evidenceIds: ["ev-0001"] },
          ],
        };
      } else {
        const predecessor = JSON.parse(request.predecessorTruthJson) as StructuredTruthV1;
        const fact = predecessor.facts[0]!;
        const predecessorEvidence = { kind: "PREDECESSOR_TRUTH_RECORD", evidenceId: "ev-0002", recordRef: { nodeKind: "FACT_SLOT", nodeId: fact.factSlotId }, recordSha256: canonicalSha256(fact) };
        proposal = {
          schemaVersion: "1.0", kind: "CHAPTER_DELTA_PROPOSAL", status: "READY", ambiguities: [], evidence: [proseEvidence, predecessorEvidence],
          operations: request.chapterNumber === 3 ? [{
            kind: "SET_FACT", operationId: "op-0001", subject: { refType: "ENTITY_ID", entityId: fact.subject.nodeId },
            factKey: { refType: "FACT_KEY_ENTRY_ID", entryId: fact.factKeyEntryId }, before: fact.assertion,
            after: { state: "VALUE", value: { valueType: "STRING", value: "injured" } }, evidenceIds: ["ev-0001", "ev-0002"],
          }] : [{
            kind: "RETRACT_FACT", operationId: "op-0001", subject: { refType: "ENTITY_ID", entityId: fact.subject.nodeId },
            factKey: { refType: "FACT_KEY_ENTRY_ID", entryId: fact.factKeyEntryId }, before: fact.assertion,
            after: { state: "UNKNOWN" }, evidenceIds: ["ev-0001", "ev-0002"],
          }],
        };
      }
      if (repairSource === "DELTA_ADMISSION" && request.chapterNumber === 2 && initialExtractionCount++ === 0) {
        proposal.evidence = [{ ...proseEvidence, quote: "not-in-final-prose" }];
      }
      const rawProposal = JSON.stringify(proposal);
      const response = await invokeLocalProvider(rawProposal, buildTruthExtractorMessages(request), TRUTH_EXTRACTOR_OPTIONS);
      return { rawProposal: response.content, responseContentSha256: sha256Utf8(response.content), usage: response.usage };
    });
    let chapterOneValidationCount = 0;
    let chapterTwoValidationCount = 0;
    const validatorCall = vi.spyOn(TruthValidatorAgent.prototype, "validate").mockImplementation(async (request) => {
      const truth = JSON.parse(request.predecessorTruthJson) as StructuredTruthV1;
      const extractionDefect = repairSource === "SEMANTIC_VALIDATION" && truth.throughChapter === 1 && chapterOneValidationCount++ === 0;
      const proseDefect = (JSON.parse(request.predecessorTruthJson) as StructuredTruthV1).throughChapter === 2
        && chapterTwoValidationCount++ === 0;
      const rawResponse = extractionDefect
        ? '{"verdict":"DELTA_EXTRACTION_DEFECT","diagnostics":["repair chapter one delta"]}'
        : proseDefect ? '{"verdict":"PROSE_CONTENT_DEFECT","diagnostics":["repair chapter two prose"]}'
        : '{"verdict":"PASS","diagnostics":[]}';
      const response = await invokeLocalProvider(rawResponse, buildTruthValidatorMessages(request), TRUTH_VALIDATOR_OPTIONS);
      return { ...parseTruthValidatorResponse(response.content), rawResponse: response.content, responseContentSha256: sha256Utf8(response.content), usage: response.usage };
    });
    const runner = new PipelineRunner({
      client,
      model: "scripted", projectRoot: root, boundedAutonomousReview: true, firstV2Baseline,
      onAutonomousStage: async (event) => {
        activeStage = { ...event, transactionId: event.transactionId, reviewRound: event.reviewRound };
        if (event.role === "truth-extractor") observedTruthStages.push(event.stage);
      },
    });

    const committedBodies: string[] = [firstV2Baseline.predecessorChapterBody];
    for (activeChapter = 2; activeChapter <= 4; activeChapter += 1) {
      if (activeChapter > 2) {
        const previousFile = (await readdir(join(bookDir, "chapters")))
          .find((file) => file.startsWith(String(activeChapter - 1).padStart(4, "0")) && file.endsWith(".md"));
        if (previousFile) await writeFile(join(bookDir, "chapters", previousFile), `POISON PUBLIC CHAPTER ${activeChapter - 1}`, "utf8");
      }
      let retainedCommitBytes: Buffer | undefined;
      if (activeChapter === 3 || activeChapter === 2 && repairSource === "SEMANTIC_VALIDATION") {
        const realFinalize = transactionModule.finalizeChapterTransaction;
        const crash = vi.spyOn(transactionModule, "finalizeChapterTransaction").mockImplementationOnce(async (input) => {
          if (activeChapter === 2) throw new Error("consolidated-stage-crash");
          return realFinalize({ ...input, beforePromote: () => { throw new Error("consolidated-selected-crash"); } });
        });
        await expect(execution.execute(activeChapter, () => runner.writeNextChapter(bookId, 2_200)))
          .rejects.toThrow(/consolidated-(stage|selected)-crash/);
        crash.mockRestore();
        retainedCommitBytes = await readFile(join(bookDir, "story/runtime/chapter-transactions",
          `chapter-${String(activeChapter).padStart(4, "0")}`, "staging/bundle/commit.json"));
      }
      const transportsBeforeRecovery = vi.mocked(fetch).mock.calls.length;
      const writerCallsBeforeRecovery = vi.mocked(WriterAgent.prototype.writeChapter).mock.calls.length;
      const result = await execution.execute(activeChapter, () => runner.writeNextChapter(bookId, 2_200));
      if (retainedCommitBytes) {
        expect(vi.mocked(fetch).mock.calls.length, "finalize-only adds zero Provider transports").toBe(transportsBeforeRecovery);
        expect(vi.mocked(WriterAgent.prototype.writeChapter).mock.calls.length, "finalize-only never enters Writer").toBe(writerCallsBeforeRecovery);
        expect(await readFile(join(bookDir, "story/commits", `chapter-${String(activeChapter).padStart(4, "0")}`, "commit.json"))).toEqual(retainedCommitBytes);
      }
      expect(result.status).toBe("ready-for-review");
      const commit = await verifyChapterCommit({ bookDir, chapterNumber: activeChapter });
      expect(commit).toMatchObject({ kind: "TRUTH_CHAPTER_COMMIT", chapterNumber: activeChapter, attemptId: "attempt-1" });
      if (commit.kind !== "TRUTH_CHAPTER_COMMIT") throw new Error("expected V2 commit");
      expect(commit.bundlePayloadFiles).toHaveLength(activeChapter === 2 ? (repairSource === "SEMANTIC_VALIDATION" ? 64 : 57) : 49);
      const inventoryRoot = join(bookDir, "story", "commits", `chapter-${String(activeChapter).padStart(4, "0")}`);
      const inventory = (await readdir(inventoryRoot, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(inventory).toHaveLength(activeChapter === 2 ? (repairSource === "SEMANTIC_VALIDATION" ? 65 : 58) : 50);
      committedBodies.push(await readFile(join(bookDir, "story", "commits", `chapter-${String(activeChapter).padStart(4, "0")}`, "chapter.md"), "utf8"));
      const providerReferences = JSON.parse(await readFile(join(bookDir, "story", "commits", `chapter-${String(activeChapter).padStart(4, "0")}`, "provider-refs.json"), "utf8")) as ReadonlyArray<{ readonly logicalOperationId: string; readonly role: string; readonly stage: string }>;
      expect(providerReferences.map((reference) => reference.role)).toEqual(expect.arrayContaining([
        "planner", "logic-canon-auditor", "commercial-reader", "truth-extractor", "truth-validator",
      ]));
      expect(new Set(providerReferences.map((reference) => reference.logicalOperationId)).size).toBe(providerReferences.length);
      if (activeChapter === 2 && repairSource === "SEMANTIC_VALIDATION") {
        expect(providerReferences).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "truth-extractor", stage: "TRUTH_EXTRACTION_REPAIR" }),
        ]));
        const repairRoot = join(bookDir, "story", "commits", "chapter-0002");
        const [authorization, initialContext, initialExtraction, initialValidationContext, initialDefect,
          initialAdmission, initialApplication, initialTruth, initialProjection,
          initialReference, initialProviderArtifact, initialExtractorReference, initialExtractorArtifact, repairManifest] = await Promise.all([
          readFile(join(repairRoot, "repair-authorization.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "extraction-context.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "extraction.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "validation-context.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "semantic-validation.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "delta-admission.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "truth-application.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "resulting-truth.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "projection-manifest.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "provider-reference.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "provider-response.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "extractor-provider-reference.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "initial", "extractor-provider-response.json"), "utf8").then(JSON.parse),
          readFile(join(repairRoot, "repair-authority", "manifest.json"), "utf8").then(JSON.parse),
        ]);
        expect(authorization).toMatchObject({
          source: "SEMANTIC_VALIDATION",
          initialExtractionContextSha256: initialContext.contextSha256,
          initialExtractionArtifactSha256: canonicalSha256(initialExtraction),
          initialValidationContextSha256: initialValidationContext.contextSha256,
          initialValidationArtifactSha256: canonicalSha256(initialDefect),
          initialDefectArtifactSha256: canonicalSha256(initialDefect),
          diagnostics: initialDefect.diagnostics,
        });
        expect(initialReference.logicalOperationId).toBe(initialDefect.logicalOperationId);
        expect(initialProviderArtifact.logical_step_id).toBe(initialReference.logicalOperationId);
        expect(initialProviderArtifact.response.content).toBe(initialDefect.rawResponse);
        expect(initialExtractorReference.logicalOperationId).toBe(initialExtraction.logicalOperationId);
        expect(initialExtractorArtifact.response.content).toBe(initialExtraction.rawProposal);
        expect(initialAdmission.status).toBe("ACCEPTED");
        expect(initialApplication.resultingTruthSha256).toBe(canonicalSha256(initialTruth));
        expect(initialProjection.truthSha256).toBe(canonicalSha256(initialTruth));
        expect(repairManifest.files).toHaveLength(13);
        const [acceptedExtractorRequest, acceptedValidatorRequest] = await Promise.all([
          readFile(join(bookDir, "story", "commits", "chapter-0002", "truth-extractor-request-reservation.json"), "utf8").then(JSON.parse),
          readFile(join(bookDir, "story", "commits", "chapter-0002", "truth-validator-request-reservation.json"), "utf8").then(JSON.parse),
        ]);
        expect(acceptedExtractorRequest).toMatchObject({
          role: "truth-extractor",
          stage: "TRUTH_EXTRACTION_REPAIR",
          requestOrdinal: 1,
        });
        expect(acceptedValidatorRequest).toMatchObject({
          role: "truth-validator",
          stage: "TRUTH_VALIDATION",
          requestOrdinal: 1,
        });
      }
      const usage = JSON.parse(await readFile(join(bookDir, "story", "commits", `chapter-${String(activeChapter).padStart(4, "0")}`, "usage.json"), "utf8"));
      expect(usage).toMatchObject({ roleUsage: {
        planner: { totalTokens: activeChapter === 2 ? 17 : 5 },
        "truth-extractor": { totalTokens: activeChapter <= 3 ? 4 : 2 },
        "truth-validator": { totalTokens: activeChapter === 3 || (activeChapter === 2 && repairSource === "SEMANTIC_VALIDATION") ? 4 : 2 },
      } });
      if (activeChapter === 3) expect(usage.roleUsage.reviser).toBeUndefined();
      const publicProjectionBytes = await readFile(join(bookDir, "story", "state", "current_state.json"));
      const committedProjectionBytes = await readFile(join(bookDir, "story", "commits", `chapter-${String(activeChapter).padStart(4, "0")}`, "state", "current_state.json"));
      expect(publicProjectionBytes.equals(committedProjectionBytes)).toBe(true);
      const publicProjection = JSON.parse(publicProjectionBytes.toString("utf8"));
      if (activeChapter === 2) expect(publicProjection.facts[0]?.assertion).toMatchObject({ state: "VALUE", value: { value: "active" } });
      if (activeChapter === 3) expect(publicProjection.facts[0]?.assertion).toMatchObject({ state: "VALUE", value: { value: "injured" } });
      if (activeChapter === 4) expect(publicProjection.facts).toEqual([]);
    }
    const chain = await verifyChapterCommitChain({ bookDir });
    expect(chain.latestChapter).toBe(4);
    expect(plannerTruthChapters).toEqual([1, 2, 3]);
    expect(writerTruthChapters).toEqual([1, 2, 3]);
    expect(logicTruthChapters).toEqual([1, 1, 2, 2, 3]);
    expect(plannerPredecessorBodies).toEqual([committedBodies[0], committedBodies[1], committedBodies[2]]);
    expect(writerPredecessorBodies).toEqual([committedBodies[0], committedBodies[1], committedBodies[2]]);
    expect(writerRecentAuthorityBodies).toEqual([
      [committedBodies[0]],
      [committedBodies[1]],
      [committedBodies[1], committedBodies[2]],
    ]);
    expect(logicPredecessorBodies).toEqual([committedBodies[0], committedBodies[0], committedBodies[1], committedBodies[1], committedBodies[2]]);
    expect([...plannerPredecessorBodies, ...writerPredecessorBodies, ...logicPredecessorBodies].some((body) => body.includes("POISON PUBLIC"))).toBe(false);
    expect(extractorCall).toHaveBeenCalledTimes(5);
    expect(validatorCall).toHaveBeenCalledTimes(repairSource === "SEMANTIC_VALIDATION" ? 5 : 4);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(observedTruthStages.slice(0, 2)).toEqual(["TRUTH_EXTRACTION", "TRUTH_EXTRACTION_REPAIR"]);
    const chapterOneTruth = JSON.parse(await readFile(join(bookDir, "story", "commits", "chapter-0002", "state", "truth.json"), "utf8")) as StructuredTruthV1;
    const chapterTwoTruth = JSON.parse(await readFile(join(bookDir, "story", "commits", "chapter-0003", "state", "truth.json"), "utf8")) as StructuredTruthV1;
    const chapterThreeTruth = JSON.parse(await readFile(join(bookDir, "story", "commits", "chapter-0004", "state", "truth.json"), "utf8")) as StructuredTruthV1;
    expect(chapterOneTruth.entities[0]).toMatchObject({ canonicalName: "Ada" });
    expect(chapterOneTruth.facts[0]?.assertion).toMatchObject({ state: "VALUE", value: expect.objectContaining({ value: "active" }) });
    expect(chapterTwoTruth.facts[0]?.assertion).toMatchObject({ state: "VALUE", value: expect.objectContaining({ value: "injured" }) });
    expect(chapterThreeTruth.facts).toEqual([]);
    await expect(readFile(join(bookDir, "story", "state", "current_state.json"))).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(join(bookDir, "story", "state", "state", "current_state.json"))).rejects.toMatchObject({ code: "ENOENT" });

    if (repairSource === "DELTA_ADMISSION") {
      const commitRoot = join(bookDir, "story", "commits", "chapter-0002");
      const manifest = JSON.parse(await readFile(join(commitRoot, "repair-authority", "manifest.json"), "utf8"));
      expect(manifest.source).toBe("DELTA_ADMISSION");
      expect(manifest.files.map((entry: { relativePath: string }) => entry.relativePath).sort()).toEqual([
        "initial/delta-admission-defect.json", "initial/extraction-context.json", "initial/extraction.json",
        "initial/provider-reference.json", "initial/provider-response.json", "repair-authorization.json",
      ]);
      return;
    }
    // A fully rehashed INITIAL Validator record still cannot nominate unrelated execution bytes.
    const repairRoot = join(bookDir, "story", "commits", "chapter-0002");
    const validationContextPath = join(repairRoot, "initial", "validation-context.json");
    const defectPath = join(repairRoot, "initial", "semantic-validation.json");
    const referencePath = join(repairRoot, "initial", "provider-reference.json");
    const providerPath = join(repairRoot, "initial", "provider-response.json");
    const authorizationPath = join(repairRoot, "repair-authorization.json");
    const manifestPath = join(repairRoot, "repair-authority", "manifest.json");
    const commitPath = join(bookDir, "story", "commits", "chapter-0002", "commit.json");
    const validationContext = JSON.parse(await readFile(validationContextPath, "utf8"));
    const forgedMessages = [{ role: "user", content: "UNRELATED SELF-NOMINATED VALIDATOR REQUEST" }];
    const forgedExecution = {
      ...validationContext.execution,
      messages: forgedMessages,
      inputFingerprint: sha256Utf8(JSON.stringify({
        provider: validationContext.execution.provider,
        model: validationContext.execution.model,
        messages: forgedMessages,
        temperature: validationContext.execution.temperature,
        maxTokens: validationContext.execution.maxTokens,
        stream: validationContext.execution.stream,
      })),
    };
    const { contextSha256: _oldValidationContextSha, ...unsignedValidationContext } = {
      ...validationContext,
      execution: forgedExecution,
    };
    const forgedValidationContext = {
      ...unsignedValidationContext,
      contextSha256: canonicalSha256(unsignedValidationContext),
    };
    const forgedValidationContextBytes = `${canonicalJson(forgedValidationContext)}\n`;
    const defect = JSON.parse(await readFile(defectPath, "utf8"));
    const reference = JSON.parse(await readFile(referencePath, "utf8"));
    const providerArtifact = JSON.parse(await readFile(providerPath, "utf8"));
    const forgedProviderArtifact = { ...providerArtifact, input_fingerprint: forgedExecution.inputFingerprint };
    const forgedProviderBytes = `${JSON.stringify(forgedProviderArtifact, null, 2)}\n`;
    const forgedReference = {
      ...reference,
      inputFingerprint: forgedExecution.inputFingerprint,
      artifactSha256: sha256Utf8(forgedProviderBytes),
    };
    const forgedReferenceBytes = `${canonicalJson(forgedReference)}\n`;
    const forgedDefect = {
      ...defect,
      contextSha256: forgedValidationContext.contextSha256,
      inputFingerprint: forgedExecution.inputFingerprint,
      providerArtifactSha256: forgedReference.artifactSha256,
    };
    const forgedDefectBytes = `${canonicalJson(forgedDefect)}\n`;
    const authorization = JSON.parse(await readFile(authorizationPath, "utf8"));
    const forgedAuthorization = {
      ...authorization,
      initialValidationContextSha256: forgedValidationContext.contextSha256,
      initialValidationArtifactSha256: canonicalSha256(forgedDefect),
      initialDefectArtifactSha256: canonicalSha256(forgedDefect),
    };
    const forgedAuthorizationBytes = `${canonicalJson(forgedAuthorization)}\n`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const forgedManifest = {
      ...manifest,
      files: manifest.files.map((entry: { relativePath: string; sha256: string; bytes: number }) => {
        const replacements: Record<string, string> = {
          "initial/validation-context.json": forgedValidationContextBytes,
          "initial/semantic-validation.json": forgedDefectBytes,
          "initial/provider-reference.json": forgedReferenceBytes,
          "initial/provider-response.json": forgedProviderBytes,
          "repair-authorization.json": forgedAuthorizationBytes,
        };
        const bytes = replacements[entry.relativePath];
        return bytes ? { ...entry, sha256: sha256Utf8(bytes), bytes: Buffer.byteLength(bytes) } : entry;
      }),
    };
    const forgedManifestBytes = `${canonicalJson(forgedManifest)}\n`;
    const commit = JSON.parse(await readFile(commitPath, "utf8"));
    const { commitSha256: _oldCommitSha, ...unsignedCommit } = {
      ...commit,
      repairAuthorityManifestSha256: sha256Utf8(forgedManifestBytes),
    };
    const forgedCommit = { ...unsignedCommit, commitSha256: canonicalSha256(unsignedCommit) };
    await Promise.all([
      writeFile(defectPath, forgedDefectBytes, "utf8"),
      writeFile(validationContextPath, forgedValidationContextBytes, "utf8"),
      writeFile(referencePath, forgedReferenceBytes, "utf8"),
      writeFile(providerPath, forgedProviderBytes, "utf8"),
      writeFile(authorizationPath, forgedAuthorizationBytes, "utf8"),
      writeFile(manifestPath, forgedManifestBytes, "utf8"),
      writeFile(commitPath, `${JSON.stringify(forgedCommit, null, 2)}\n`, "utf8"),
    ]);
    const { commitSha256: _stalePayloadCommitSha, ...reboundCommit } = JSON.parse(await readFile(commitPath, "utf8"));
    reboundCommit.bundlePayloadFiles = await Promise.all(reboundCommit.bundlePayloadFiles.map(async (entry: { relativePath: string }) => {
      const bytes = await readFile(join(repairRoot, entry.relativePath));
      return { relativePath: entry.relativePath, sha256: sha256Utf8(bytes.toString("utf8")), bytes: bytes.length };
    }));
    reboundCommit.bundlePayloadTreeSha256 = canonicalSha256(reboundCommit.bundlePayloadFiles);
    await writeFile(commitPath, JSON.stringify({ ...reboundCommit, commitSha256: canonicalSha256(reboundCommit) }));
    await expect(verifyChapterCommit({ bookDir, chapterNumber: 2 })).rejects.toThrow(/INITIAL semantic repair truth-validator execution messages/i);
  }, 60_000);
});
