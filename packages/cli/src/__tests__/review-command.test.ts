import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.fn();
const loadIndex = vi.fn();
const saveIndex = vi.fn();
const rollback = vi.fn();
const log = vi.fn();
vi.mock("@actalk/inkos-core", () => ({
  assertLegacyTruthMutationAllowed: guard,
  StateManager: class {
    bookDir(id: string) { return `/project/books/${id}`; }
    loadChapterIndex = loadIndex;
    saveChapterIndex = saveIndex;
    rollbackToChapter = rollback;
  },
}));
vi.mock("../utils.js", () => ({ findProjectRoot: () => "/project", resolveBookId: async (id: string) => id, log, logError: log }));
beforeEach(() => {
  vi.clearAllMocks();
  guard.mockResolvedValue(undefined);
  loadIndex.mockResolvedValue([{ number: 1, status: "ready-for-review" }]);
  saveIndex.mockResolvedValue(undefined);
  rollback.mockResolvedValue([1]);
});
afterEach(() => { vi.restoreAllMocks(); });
describe("review mutation authority", () => {
  it.each(["approve", "approve-all", "reject"])("checks canonical authority before %s reads or writes the index", async (action) => {
    guard.mockRejectedValueOnce(new Error("TRUTH_AUTHORITY_MUTATION_FORBIDDEN"));
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("EXIT_1"); }) as never);
    const { reviewCommand } = await import("../commands/review.js");
    await expect(reviewCommand.parseAsync(["node", "review", action, "book", ...(action === "approve-all" ? [] : ["1"]), "--json"], { from: "node" })).rejects.toThrow("EXIT_1");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TRUTH_AUTHORITY_MUTATION_FORBIDDEN"));
    expect(loadIndex).not.toHaveBeenCalled();
    expect(saveIndex).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });
  it("preserves authorized legacy approval", async () => {
    const { reviewCommand } = await import("../commands/review.js");
    await reviewCommand.parseAsync(["node", "review", "approve", "book", "1", "--json"], { from: "node" });
    expect(saveIndex).toHaveBeenCalledWith("book", [expect.objectContaining({ number: 1, status: "approved" })]);
  });
});
