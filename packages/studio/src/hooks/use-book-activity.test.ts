import { describe, expect, it } from "vitest";
import type { SSEMessage } from "./use-sse";
import { collectNewSSEMessages } from "./use-sse";
import * as bookActivityModule from "./use-book-activity";
import {
  applyBookCollectionEvent,
  deriveActiveBookIds,
  deriveBookActivity,
  shouldRefetchBookCollections,
  shouldRefetchBookView,
  shouldRefetchDaemonStatus,
} from "./use-book-activity";

function msg(event: string, data: unknown, timestamp: number): SSEMessage {
  return { event, data, timestamp, seq: timestamp };
}

describe("deriveBookActivity", () => {
  it("keeps a book in writing state after write:start until completion", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("log", { message: "Phase 1" }, 2),
      msg("llm:progress", { totalChars: 1200 }, 3),
    ];

    expect(deriveBookActivity(messages, "alpha")).toMatchObject({
      writing: true,
      drafting: false,
      lastError: null,
    });
  });

  it("clears writing state after completion or error", () => {
    const completed: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("write:complete", { bookId: "alpha", chapterNumber: 2 }, 2),
    ];
    const errored: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("write:error", { bookId: "alpha", error: "locked" }, 2),
    ];

    expect(deriveBookActivity(completed, "alpha")).toMatchObject({
      writing: false,
      lastError: null,
    });
    expect(deriveBookActivity(errored, "alpha")).toMatchObject({
      writing: false,
      lastError: "locked",
    });
  });

  it("tracks drafting independently from writing", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("draft:start", { bookId: "alpha" }, 1),
      msg("write:start", { bookId: "beta" }, 2),
    ];

    expect(deriveBookActivity(messages, "alpha")).toMatchObject({
      writing: false,
      drafting: true,
    });
  });
});

describe("deriveActiveBookIds", () => {
  it("returns only books with in-flight background work", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("draft:start", { bookId: "beta" }, 2),
      msg("write:complete", { bookId: "alpha", chapterNumber: 2 }, 3),
      msg("write:start", { bookId: "gamma" }, 4),
      msg("draft:error", { bookId: "beta", error: "quota" }, 5),
    ];

    expect([...deriveActiveBookIds(messages)].sort()).toEqual(["gamma"]);
  });
});

describe("shouldRefetchBookView", () => {
  it("refreshes the book detail view after terminal background jobs for that book", () => {
    expect(shouldRefetchBookView(msg("write:complete", { bookId: "alpha" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("draft:error", { bookId: "alpha", error: "quota" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("rewrite:complete", { bookId: "alpha", chapterNumber: 3 }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("revise:error", { bookId: "alpha", error: "bad" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("audit:complete", { bookId: "alpha", chapter: 3, passed: true }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("audit:start", { bookId: "alpha", chapter: 3 }, 1), "alpha")).toBe(false);
    expect(shouldRefetchBookView(msg("rewrite:complete", { bookId: "beta" }, 1), "alpha")).toBe(false);
  });

  it("refreshes after an autonomous chapter commit for the matching book only", () => {
    expect(shouldRefetchBookView(msg("autonomous:chapter-complete", { bookId: "alpha", chapterNumber: 5 }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("autonomous:chapter-complete", { bookId: "beta", chapterNumber: 5 }, 1), "alpha")).toBe(false);
  });

  it.each([
    "autonomous:start",
    "autonomous:phase",
    "autonomous:progress",
    "autonomous:complete",
    "autonomous:paused",
    "autonomous:error",
    "llm:progress",
  ])("does not refetch chapter data for %s", (event) => {
    expect(shouldRefetchBookView(msg(event, { bookId: "alpha" }, 1), "alpha")).toBe(false);
  });

  it("finds a chapter completion in the middle of one cursor batch without looping on the same batch", () => {
    const messages = [
      msg("autonomous:phase", { bookId: "alpha" }, 2),
      msg("autonomous:chapter-complete", { bookId: "alpha", chapterNumber: 5 }, 3),
      msg("autonomous:phase", { bookId: "alpha" }, 4),
    ];
    const first = collectNewSSEMessages(messages, 1);
    const refreshes = first.fresh.filter((message) => shouldRefetchBookView(message, "alpha"));
    const repeated = collectNewSSEMessages(messages, first.nextCursor);

    expect(refreshes).toHaveLength(1);
    expect(repeated.fresh).toEqual([]);
  });

  it("does not drop the first chapter completion after an initially empty stream", () => {
    const prime = (bookActivityModule as unknown as {
      readonly primeBookViewSSEMessages?: (messages: ReadonlyArray<SSEMessage>) => ReadonlyArray<SSEMessage>;
    }).primeBookViewSSEMessages;
    const seeded = prime?.([]);

    expect(seeded).toEqual([{ event: "book-view:cursor-seed", data: null, timestamp: 0, seq: 0 }]);
    const initial = collectNewSSEMessages(seeded ?? [], null);
    const firstEvent = msg("autonomous:chapter-complete", { bookId: "alpha", chapterNumber: 5 }, 1);
    const firstFresh = collectNewSSEMessages(prime?.([firstEvent]) ?? [], initial.nextCursor);

    expect(firstFresh.fresh).toEqual([firstEvent]);
    expect(firstFresh.fresh.filter((message) => shouldRefetchBookView(message, "alpha"))).toHaveLength(1);
  });
});

describe("shouldRefetchBookCollections", () => {
  it("refreshes book lists for create/delete and chapter-changing terminal events", () => {
    expect(shouldRefetchBookCollections(msg("book:created", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("book:deleted", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("write:complete", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("draft:error", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("rewrite:complete", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("audit:start", { bookId: "alpha" }, 1))).toBe(false);
    expect(shouldRefetchBookCollections(undefined)).toBe(false);
  });
});

describe("shouldRefetchDaemonStatus", () => {
  it("refreshes daemon status for daemon terminal events", () => {
    expect(shouldRefetchDaemonStatus(msg("daemon:started", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:stopped", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:error", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:chapter", {}, 1))).toBe(false);
  });
});

describe("applyBookCollectionEvent", () => {
  it("upserts a created book from the event payload without requiring a refetch", () => {
    const books = [
      { id: "alpha", title: "Alpha", genre: "urban", status: "active", chaptersWritten: 3 },
    ];

    expect(applyBookCollectionEvent(books, msg("book:created", {
      bookId: "beta",
      book: { id: "beta", title: "Beta", genre: "xuanhuan", status: "outlining", chaptersWritten: 0 },
    }, 1))).toEqual([
      { id: "alpha", title: "Alpha", genre: "urban", status: "active", chaptersWritten: 3 },
      { id: "beta", title: "Beta", genre: "xuanhuan", status: "outlining", chaptersWritten: 0 },
    ]);
  });

  it("returns null when a collection event lacks enough data for incremental update", () => {
    expect(applyBookCollectionEvent([], msg("book:created", { bookId: "beta" }, 1))).toBeNull();
  });
});
