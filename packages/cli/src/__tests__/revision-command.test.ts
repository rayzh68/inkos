import { beforeEach, describe, expect, it, vi } from "vitest";

const reviseDraftMock = vi.fn();
const resyncChapterArtifactsMock = vi.fn();
const buildPipelineConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();
const assertChapterAuthorityMutationAllowedMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  DEFAULT_REVISE_MODE: "spot-fix",
  assertChapterAuthorityMutationAllowed: assertChapterAuthorityMutationAllowedMock,
  PipelineRunner: class {
    reviseDraft = reviseDraftMock;
    resyncChapterArtifacts = resyncChapterArtifactsMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
    bookDir(bookId: string) {
      return `/project/books/${bookId}`;
    }
  },
  // Mirrors the real core implementation; unit-tested in
  // packages/core/src/__tests__/revision-gate.test.ts.
  resolveRevisionGate: (
    book: { writing?: { revisionGate?: "strict" | "lenient" | "always" } },
    projectWriting?: { revisionGate?: "strict" | "lenient" | "always" },
  ) => book.writing?.revisionGate ?? projectWriting?.revisionGate ?? "strict",
}));

vi.mock("../utils.js", () => ({
  loadConfig: vi.fn(async () => ({ llm: {} })),
  buildPipelineConfig: buildPipelineConfigMock,
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  getLegacyMigrationHint: vi.fn(async () => undefined),
  resolveContext: vi.fn(),
  log: logMock,
  logError: logErrorMock,
}));

vi.mock("../localization.js", () => ({
  formatWriteNextResultLines: vi.fn(() => ["ok"]),
  resolveCliLanguage: vi.fn(() => "zh"),
}));

describe("revision-related CLI commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviseDraftMock.mockResolvedValue({
      chapterNumber: 3,
      wordCount: 1200,
      fixedIssues: [],
      applied: true,
      status: "ready-for-review",
    });
    resyncChapterArtifactsMock.mockResolvedValue({
      chapterNumber: 3,
      title: "Synced Chapter",
      wordCount: 1200,
      revised: false,
      status: "ready-for-review",
      auditResult: { passed: true, issues: [], summary: "synced" },
    });
    buildPipelineConfigMock.mockReturnValue({});
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    assertChapterAuthorityMutationAllowedMock.mockResolvedValue(undefined);
  });

  it("passes one-off brief into revise command pipeline config", async () => {
    const { reviseCommand } = await import("../commands/revise.js");

    await reviseCommand.parseAsync(["node", "revise", "demo-book", "3", "--mode", "rewrite", "--brief", "把注意力拉回师债主线。"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(expect.anything(), "/project", {
      externalContext: "把注意力拉回师债主线。",
      revisionGate: "strict",
    });
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 3, "rewrite");
  });

  it("exposes write sync and passes brief into pipeline config", async () => {
    const { writeCommand } = await import("../commands/write.js");

    await writeCommand.parseAsync(["node", "write", "sync", "demo-book", "3", "--brief", "以师债线为准同步状态。"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(expect.anything(), "/project", {
      externalContext: "以师债线为准同步状态。",
    });
    expect(resyncChapterArtifactsMock).toHaveBeenCalledWith("demo-book", 3);
  });

  it("blocks write rewrite at the transaction authority guard before filesystem mutation", async () => {
    assertChapterAuthorityMutationAllowedMock.mockRejectedValueOnce(new Error("TRANSACTION_AUTHORITY_MUTATION_FORBIDDEN"));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT_${code}`);
    }) as never);
    const { writeCommand } = await import("../commands/write.js");

    await expect(writeCommand.parseAsync(["node", "write", "rewrite", "demo-book", "4", "--force"], { from: "node" }))
      .rejects.toThrow("EXIT_1");
    expect(assertChapterAuthorityMutationAllowedMock).toHaveBeenCalledWith({
      bookDir: "/project/books/demo-book", chapterNumber: 4,
    });
    expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("TRANSACTION_AUTHORITY_MUTATION_FORBIDDEN"));
    exit.mockRestore();
  });
});
