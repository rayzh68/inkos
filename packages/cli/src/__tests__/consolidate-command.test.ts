import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const guard = vi.fn();
const consolidate = vi.fn();
const buildConfig = vi.fn();
const log = vi.fn();
vi.mock("@actalk/inkos-core", () => ({
  assertLegacyTruthMutationAllowed: guard,
  StateManager: class { bookDir(id: string) { return `/project/books/${id}`; } },
  ConsolidatorAgent: class { consolidate = consolidate; },
}));
vi.mock("../utils.js", () => ({
  loadConfig: async () => ({}), findProjectRoot: () => "/project", resolveBookId: async (id: string) => id,
  buildPipelineConfig: buildConfig, log, logError: log,
}));
beforeEach(() => { vi.clearAllMocks(); guard.mockResolvedValue(undefined); buildConfig.mockReturnValue({}); consolidate.mockResolvedValue({ archivedVolumes: 0 }); });
afterEach(() => { vi.restoreAllMocks(); });
describe("consolidation command authority", () => {
  it("rejects protected truth before constructing model configuration or invoking Consolidator", async () => {
    guard.mockRejectedValueOnce(new Error("TRUTH_AUTHORITY_MUTATION_FORBIDDEN"));
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("EXIT_1"); }) as never);
    const { consolidateCommand } = await import("../commands/consolidate.js");
    await expect(consolidateCommand.parseAsync(["node", "consolidate", "book", "--json"], { from: "node" })).rejects.toThrow("EXIT_1");
    expect(buildConfig).not.toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TRUTH_AUTHORITY_MUTATION_FORBIDDEN"));
  });
  it("preserves authorized legacy consolidation", async () => {
    const { consolidateCommand } = await import("../commands/consolidate.js");
    await consolidateCommand.parseAsync(["node", "consolidate", "book", "--json"], { from: "node" });
    expect(consolidate).toHaveBeenCalledWith("/project/books/book");
  });
});
