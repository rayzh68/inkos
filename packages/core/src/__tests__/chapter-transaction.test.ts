import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../state/manager.js";
import {
  beginChapterTransaction,
  createChapterGenesis,
  finalizeChapterTransaction,
  inspectChapterAuthority,
  reconcileChapterProjections,
  recordChapterTransactionOperation,
  recordChapterTransactionReviewEvidence,
  recordChapterTransactionReviewResult,
  resolveChapterProviderOperation,
  stageChapterCommitCandidate,
  verifyChapterCommit,
  verifyChapterCommitChain,
} from "../production/chapter-transaction.js";

describe("chapter transaction convergence", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function fixture() {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-txn-"));
    roots.push(bookDir);
    await mkdir(join(bookDir, "story", "snapshots", "4", "state"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    for (const chapter of [1, 2, 3, 4]) await writeFile(join(bookDir, "chapters", `${String(chapter).padStart(4, "0")}_Legacy.md`), `legacy ${chapter}`, "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([1, 2, 3, 4].map((number) => ({ number, title: `Legacy ${number}` }))), "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "current_state.md"), "state 4", "utf-8");
    await writeFile(join(bookDir, "story", "snapshots", "4", "state", "manifest.json"), JSON.stringify({ schemaVersion: 2, lastAppliedChapter: 4 }), "utf-8");
    const genesis = await createChapterGenesis({
      bookDir,
      bookId: "book-a",
      lastTrustedChapter: 4,
      trustedSnapshotDir: join(bookDir, "story", "snapshots", "4"),
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    return { bookDir, genesis };
  }

  const body = Array.from({ length: 2200 }, (_, index) => `w${index}`).join(" ");
  const lengthSpec = { target: 2200, softMin: 1980, softMax: 2420, hardMin: 1760, hardMax: 2640, countingMode: "en_words" as const };

  async function stagePassing(bookDir: string, chapterNumber = 5) {
    const transaction = await beginChapterTransaction({
      bookDir, bookId: "book-a", chapterNumber, productionAuthority: "blueprint:v1",
    });
    const logicalOperationId = `provider-step-${transaction.hash(`${transaction.transactionId}:writer`)}`;
    const artifactRelativePath = `story/runtime/bounded-autonomous/provider-responses/${logicalOperationId}.json`;
    const artifactBytes = Buffer.from(JSON.stringify({ logicalOperationId, chapterNumber }));
    await mkdir(join(bookDir, "story", "runtime", "bounded-autonomous", "provider-responses"), { recursive: true });
    await writeFile(join(bookDir, artifactRelativePath), artifactBytes);
    await stageChapterCommitCandidate({
      bookDir,
      transactionId: transaction.transactionId,
      title: `Chapter ${chapterNumber}`,
      body,
      lengthSpec,
      review: {
        status: "APPROVED",
        finalCandidateSha256: transaction.hash(body),
        findings: [],
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
      providerReferences: [{ logicalOperationId, responseArtifactStatus: "COMPLETE", responseSha256: transaction.hash(artifactBytes), artifactRelativePath }],
      completedAt: `2026-08-28T00:00:0${chapterNumber}.000Z`,
    });
    return transaction;
  }

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
      review: { status: "HELD_AFTER_TWO_REVISIONS", finalCandidateSha256: tx.hash(body), findings: [] },
      stateFiles: {}, snapshotFiles: {}, usage: {}, providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
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
      review: { status: "APPROVED", finalCandidateSha256: tx.hash(short), findings: [] },
      stateFiles: {}, snapshotFiles: {}, usage: {}, providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
    })).rejects.toThrow(/hard range/i);
    expect((await inspectChapterAuthority({ bookDir })).nextChapter).toBe(5);
  });

  it("D refuses commit when state settlement or validation evidence is incomplete", async () => {
    const { bookDir } = await fixture();
    const tx = await beginChapterTransaction({ bookDir, bookId: "book-a", chapterNumber: 5, productionAuthority: "blueprint:v1" });
    await expect(stageChapterCommitCandidate({
      bookDir, transactionId: tx.transactionId, title: "state failed", body, lengthSpec,
      review: { status: "APPROVED", finalCandidateSha256: tx.hash(body), findings: [] },
      stateFiles: { "manifest.json": "{}" }, snapshotFiles: {}, usage: {}, providerReferences: [], completedAt: "2026-08-28T00:00:05.000Z",
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
});
