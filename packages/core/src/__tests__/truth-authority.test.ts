
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as authority from "../interaction/truth-authority.js";
import { abandonChapterTransactionAttempt, assertChapterAuthorityMutationAllowed, beginChapterTransaction, createChapterGenesis, inspectChapterAuthority, loadCommittedV2PredecessorAuthority, type FirstV2BaselineContext } from "../production/chapter-transaction.js";
import { canonicalSha256, sha256Utf8 } from "../state/canonical-json.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import type { StructuredTruthV1 } from "../models/structured-truth.js";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";
import { executeEditTransaction } from "../interaction/edit-controller.js";
import { createEditTool, createWriteFileTool } from "../agent/agent-tools.js";
import { StateManager } from "../state/manager.js";
import { bootstrapStructuredStateFromMarkdown, rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { loadRuntimeStateSnapshot, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { ArchitectAgent } from "../agents/architect.js";
import { ConsolidatorAgent } from "../agents/consolidator.js";
import { WriterAgent } from "../agents/writer.js";
import { PipelineRunner } from "../pipeline/runner.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-truth-policy-")); roots.push(root);
  const bookDir = join(root, "books", "book");
  await mkdir(join(bookDir, "story", "snapshots", "0"), { recursive: true });
  await mkdir(join(bookDir, "chapters"));
  await writeFile(join(bookDir, "story", "snapshots", "0", "baseline.txt"), "baseline");
  await writeFile(join(bookDir, "chapters", "index.json"), "[]");
  const genesis = await createChapterGenesis({ bookDir, bookId: "book", lastTrustedChapter: 0, trustedSnapshotDir: join(bookDir, "story", "snapshots", "0") });
  const truth: StructuredTruthV1 = {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: "book", throughChapter: 0,
    lineage: { kind: "BASELINE", predecessorCommitSha256: "a".repeat(64), baselineSourceManifestSha256: "b".repeat(64), seedVocabularyCatalogSha256: "c".repeat(64), baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: "d".repeat(64) },
    vocabulary: createVocabularyCatalogV1([]), entities: [], facts: [], relations: [],
    provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
  };
  const firstV2Baseline: FirstV2BaselineContext = await installLegacyBaseline(bookDir, truth);
  return { bookDir, firstV2Baseline };
}

describe("central canonical truth write authority", () => {
  it("verifies legacy admission history once per observation and rejects later tampering without cached authority", async () => {
    const { bookDir } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test" });
    const baselinePath = join(bookDir, "story/snapshots/0/baseline.txt");
    vi.mocked(readFile).mockClear();
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("LEGACY_V1_ONLY");
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => String(path) === baselinePath)).toHaveLength(1);
    await writeFile(baselinePath, "tampered after the first observation");
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow(/snapshot|hash/i);
  });

  it("rejects an active attempt junction instead of following it as a durable discriminator", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const path = join(bookDir, "story/runtime/chapter-transactions/chapter-0002");
    const outside = join(bookDir, "retained-attempt");
    await rename(path, outside);
    await symlink(outside, path, "junction");
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow("UNSAFE_PATH_COMPONENT");
  });
  it("detects removed canonical mode and baseline by the immutable transaction identity", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0002");
    const record = JSON.parse(await readFile(join(root, "transaction.json"), "utf8"));
    delete record.truthMode;
    delete record.firstV2BaselineSha256;
    await writeFile(join(root, "transaction.json"), JSON.stringify(record));
    await rm(join(root, "first-v2-baseline.json"));
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow("TRANSACTION_IDENTITY_MISMATCH");
  });
  it.each([1, 2])("recovers only exact supplied first-V2 baseline orphan at next attempt %s", async (attemptNumber) => {
    const { bookDir, firstV2Baseline } = await fixture();
    const request = { bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2" as const, firstV2Baseline };
    let initial = await beginChapterTransaction(request);
    if (attemptNumber === 2) {
      await abandonChapterTransactionAttempt({ bookDir, bookId: "book", chapterNumber: 2, transactionId: initial.transactionId, runtimeSnapshot: "{}" });
      initial = await beginChapterTransaction(request);
    }
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0002", ...(attemptNumber === 2 ? ["attempts/attempt-0002"] : []));
    await rm(join(root, "transaction.json"));
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow("FIRST_V2_BASELINE_TRANSACTION_MISSING");
    const { firstV2Baseline: _baseline, ...withoutBytes } = request;
    await expect(beginChapterTransaction(withoutBytes)).rejects.toThrow();
    await expect(beginChapterTransaction({ ...request, firstV2Baseline: { ...firstV2Baseline, predecessorChapterBody: "different", predecessorChapterBodySha256: sha256Utf8("different") } })).rejects.toThrow();
    await expect(beginChapterTransaction(request)).resolves.toMatchObject({ transactionId: initial.transactionId, attemptNumber });
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("FIRST_V2_TRANSACTION_IN_PROGRESS");
  });

  it("refuses orphan recovery when any conflicting attempt evidence accompanies baseline bytes", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    const request = { bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2" as const, firstV2Baseline };
    await beginChapterTransaction(request);
    const root = join(bookDir, "story/runtime/chapter-transactions/chapter-0002");
    await rm(join(root, "transaction.json"));
    await writeFile(join(root, "terminal-outcome.json"), "{}");
    await expect(beginChapterTransaction(request)).rejects.toThrow();
    await expect(readFile(join(root, "transaction.json"))).rejects.toThrow();
  });
  it.each(["edit", "write"] as const)("guards generic agent %s chapter prose against the durable active transaction", async (kind) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "chapters/0002_Title.md"), "before");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const tool = kind === "edit" ? createEditTool(resolve(bookDir, "../..")) : createWriteFileTool(resolve(bookDir, "../.."));
    expect(JSON.stringify(await tool.execute("test", { path: "book/chapters/0002_Title.md", content: "after", old_string: "before", new_string: "after" } as never))).toContain("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(await readFile(join(bookDir, "chapters/0002_Title.md"), "utf8")).toBe("before");
  });
  it("restarts the matching first V2 attempt and predecessor from durable evidence without transient config", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    const request = { bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2" as const };
    const initial = await beginChapterTransaction({ ...request, firstV2Baseline });
    await expect(beginChapterTransaction(request)).resolves.toMatchObject({ transactionId: initial.transactionId });
    await expect(loadCommittedV2PredecessorAuthority({ bookDir, chapterNumber: 2 })).resolves.toMatchObject({ truth: firstV2Baseline.truth });
    const runner = new PipelineRunner({ client: {} as never, model: "test", projectRoot: resolve(bookDir, "../..") });
    expect(await (runner as unknown as { usesCanonicalTruthV2(path: string): Promise<boolean> }).usesCanonicalTruthV2(bookDir)).toBe(true);
    await writeFile(join(bookDir, "story/runtime/chapter-transactions/chapter-0002/first-v2-baseline.json"), "{}");
    await expect(beginChapterTransaction(request)).rejects.toThrow("FIRST_V2_BASELINE");
  });
  it.each(["repairChapterState", "resyncChapterArtifacts", "resyncChapterStateAndAudit"] as const)("rejects Runner %s at durable State-B admission without a transient baseline flag", async (method) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const runner = new PipelineRunner({ client: {} as never, model: "test", projectRoot: resolve(bookDir, "../..") });
    await expect(runner[method]("book", 1)).rejects.toThrow("V2_CANONICAL_TRUTH_MANUAL_REPAIR_REQUIRED");
  });
  it("protects an uncommitted chapter edit/delete from bypassing State B through the public chapter guard", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    await expect(assertChapterAuthorityMutationAllowed({ bookDir, chapterNumber: 2 })).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
  });
  it.each(["writeDraft", "planChapter", "composeChapter", "auditDraft", "reviseDraft", "reviewExistingChapterBounded", "importChapters"] as const)("blocks Runner %s in durable State B without a transient V2 config flag", async (method) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const runner = new PipelineRunner({ client: {} as never, model: "test", projectRoot: resolve(bookDir, "../..") });
    const invoke = method === "importChapters" ? () => runner.importChapters({ bookId: "book", chapters: [] } as never)
      : () => (runner[method] as (book: string, chapter?: number) => Promise<unknown>).call(runner, "book", method === "reviewExistingChapterBounded" ? 1 : undefined);
    await expect(invoke()).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    await expect(readFile(join(bookDir, "story/current_state.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps Architect F foundation revision functional without replacing the commit-bound character matrix", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "story/character_matrix.md"), "canonical projection");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const architect = new ArchitectAgent({ client: {} as never, model: "test", projectRoot: resolve(bookDir, "../..") });
    await architect.writeFoundationFiles(bookDir, { storyFrame: "updated F foundation", volumeMap: "volume", storyBible: "bible", volumeOutline: "outline", bookRules: "rules", pendingHooks: "hooks", roles: [] } as never, false, "en", "revise");
    expect(await readFile(join(bookDir, "story/character_matrix.md"), "utf8")).toBe("canonical projection");
    expect(await readFile(join(bookDir, "story/outline/story_frame.md"), "utf8")).toBe("updated F foundation");
  });
  it.each(["consolidator", "writer"] as const)("blocks direct legacy %s publication in State B", async (role) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "story/current_state.md"), "before");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const config = { client: {} as never, model: "test", projectRoot: resolve(bookDir, "../..") };
    const action = role === "consolidator" ? () => new ConsolidatorAgent(config).consolidate(bookDir)
      : () => new WriterAgent(config).saveChapter(bookDir, { chapterNumber: 2, title: "Title", content: "body", updatedState: "forged", updatedHooks: "hooks" } as never, false);
    await expect(action()).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(await readFile(join(bookDir, "story/current_state.md"), "utf8")).toBe("before");
    await expect(readFile(join(bookDir, "chapters/0002_Title.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["index", "snapshot", "restore", "rollback", "bootstrap", "rewrite-bootstrap", "runtime-load", "runtime-save"] as const)("blocks legacy %s in State B before derived authority mutation", async (operation) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "story/current_state.md"), "before");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const manager = new StateManager(resolve(bookDir, "../.."));
    const operations = {
      index: () => manager.saveChapterIndex("book", []), snapshot: () => manager.snapshotState("book", 1),
      restore: () => manager.restoreState("book", 0), rollback: () => manager.rollbackToChapter("book", 0),
      bootstrap: () => bootstrapStructuredStateFromMarkdown({ bookDir }),
      "rewrite-bootstrap": () => rewriteStructuredStateFromMarkdown({ bookDir }),
      "runtime-load": () => loadRuntimeStateSnapshot(bookDir), "runtime-save": () => saveRuntimeStateSnapshot(bookDir, {} as never),
    };
    await expect(operations[operation]()).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(await readFile(join(bookDir, "story/current_state.md"), "utf8")).toBe("before");
    expect(await readFile(join(bookDir, "chapters/index.json"), "utf8")).toBe("[]");
    await expect(readFile(join(bookDir, "story/state/manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["edit", "write"] as const)("blocks generic agent %s protected files in State B and permits F", async (kind) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "story/current_state.md"), "before");
    await writeFile(join(bookDir, "story/author_intent.md"), "before");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const tool = kind === "edit" ? createEditTool(resolve(bookDir, "../..")) : createWriteFileTool(resolve(bookDir, "../.."));
    const run = (path: string) => tool.execute("test", { path: `book/${path}`, content: "after", old_string: "before", new_string: "after" } as never);
    expect(JSON.stringify(await run("story/current_state.md"))).toContain("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(await readFile(join(bookDir, "story/current_state.md"), "utf8")).toBe("before");
    expect(JSON.stringify(await run("story/author_intent.md"))).toContain("successfully");
    expect(await readFile(join(bookDir, "story/author_intent.md"), "utf8")).toBe("after");
  });
  it.each(["truth-file-edit", "entity-rename"] as const)("blocks %s in State B before any truth or foundation replacement", async (kind) => {
    const { bookDir, firstV2Baseline } = await fixture();
    await writeFile(join(bookDir, "story/current_state.md"), "Ada remains.");
    await writeFile(join(bookDir, "story/story_bible.md"), "Ada foundation.");
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    await expect(executeEditTransaction({ bookDir: () => bookDir, loadChapterIndex: async () => [], saveChapterIndex: async () => {} },
      kind === "truth-file-edit" ? { kind, bookId: "book", fileName: "current_state.md", instruction: "forged" }
      : { kind, bookId: "book", entityType: "character", oldValue: "Ada", newValue: "Eve" })).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(await readFile(join(bookDir, "story/current_state.md"), "utf8")).toBe("Ada remains.");
    expect(await readFile(join(bookDir, "story/story_bible.md"), "utf8")).toBe("Ada foundation.");
  });
  it("blocks interaction legacy truth writes in durable State B before control writes, while F remains editable", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    let controlWrites = 0;
    const tools = createInteractionToolsFromDeps({} as never, {
      bookDir: () => bookDir, acquireBookLock: async () => async () => {},
      ensureControlDocuments: async () => { controlWrites++; },
    } as never);
    await expect(tools.writeTruthFile("book", "current_state.md", "forbidden")).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    expect(controlWrites).toBe(0);
    await expect(readFile(join(bookDir, "story/current_state.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await tools.writeTruthFile("book", "outline/story_frame.md", "valid planning");
    expect(await readFile(join(bookDir, "story/outline/story_frame.md"), "utf8")).toBe("valid planning");
  });
  it("converges concurrent identical abandonment and recovers after terminal selection before the descriptive marker", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const request = { bookDir, bookId: "book", chapterNumber: 2, transactionId: transaction.transactionId, runtimeSnapshot: "{}" };
    const results = await Promise.all(Array.from({ length: 4 }, () => abandonChapterTransactionAttempt(request)));
    expect(results.every((result) => result.runtimeSnapshotSha256 === results[0]!.runtimeSnapshotSha256)).toBe(true);
    const marker = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0002", "abandonment.json");
    await rm(marker);
    await expect(abandonChapterTransactionAttempt(request)).resolves.toMatchObject({ transactionId: transaction.transactionId, runtimeSnapshotSha256: results[0]!.runtimeSnapshotSha256 });
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("LEGACY_V1_ONLY");
  });
  it("replays the same abandonment and returns first V2 to legacy without advancing N+1", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const request = { bookDir, bookId: "book", chapterNumber: 2, transactionId: transaction.transactionId, runtimeSnapshot: "{}" };
    const first = await abandonChapterTransactionAttempt(request);
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("LEGACY_V1_ONLY");
    await expect(abandonChapterTransactionAttempt(request)).resolves.toEqual(first);
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(2);
    const fresh = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test" });
    expect(fresh.transactionId).not.toBe(transaction.transactionId);
    expect(fresh.attemptNumber).toBe(2);
    await expect(abandonChapterTransactionAttempt({ ...request, runtimeSnapshot: '{"different":true}' })).rejects.toThrow();
  });
  it("fails closed when the durable transaction discriminator is corrupt or removed", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    const path = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0002", "transaction.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    delete record.truthMode;
    await writeFile(path, JSON.stringify(record));
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow();
    await writeFile(path, "{");
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow();
  });
  it("permits legitimate legacy B/E and F but always rejects direct A/C/D", async () => {
    const { bookDir } = await fixture();
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("LEGACY_V1_ONLY");
    for (const relativePath of ["story/current_state.md", "story/state/current_state.json", "story/snapshots/0/current_state.md", "story/outline/story_frame.md", "story/author_intent.md"])
      await expect(authority.assertTruthMutationAllowed({ bookDir, relativePath })).resolves.toBeUndefined();
    for (const relativePath of ["story/state/truth.json", "story/runtime/chapter-transactions/chapter-0002/transaction.json", "story/commits/chapter-0002/commit.json"])
      await expect(authority.assertTruthMutationAllowed({ bookDir, relativePath })).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
  });

  it("durably protects first V2 B/E while retaining F and rejects restart baseline corruption", async () => {
    const { bookDir, firstV2Baseline } = await fixture();
    const transaction = await beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test", truthMode: "CANONICAL_V2", firstV2Baseline });
    expect(transaction.truthMode).toBe("CANONICAL_V2");
    expect(transaction.firstV2BaselineSha256).toBe(canonicalSha256(firstV2Baseline));
    expect(await authority.resolveTruthCutoverState(bookDir)).toBe("FIRST_V2_TRANSACTION_IN_PROGRESS");
    for (const relativePath of ["story/current_state.md", "story/state/current_state.json", "chapters/index.json", "story/snapshots/0/current_state.md"])
      await expect(authority.assertTruthMutationAllowed({ bookDir, relativePath })).rejects.toThrow("TRUTH_AUTHORITY_MUTATION_FORBIDDEN");
    await expect(authority.assertTruthMutationAllowed({ bookDir, relativePath: "story/outline/story_frame.md" })).resolves.toBeUndefined();
    await expect(beginChapterTransaction({ bookDir, bookId: "book", chapterNumber: 2, productionAuthority: "test" })).rejects.toThrow("authority mismatch");
    const baselinePath = join(bookDir, "story", "runtime", "chapter-transactions", "chapter-0002", "first-v2-baseline.json");
    expect(JSON.parse(await readFile(baselinePath, "utf8"))).toEqual(firstV2Baseline);
    await writeFile(baselinePath, "{}");
    await expect(authority.resolveTruthCutoverState(bookDir)).rejects.toThrow(/BASELINE|baseline/);
  });
});
