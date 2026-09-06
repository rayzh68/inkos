import { describe, expect, it } from "vitest";
import { ConsolidatorAgent } from "../agents/consolidator.js";

describe("ConsolidatorAgent", () => {
  it("rejects an archive junction before legacy promotion or model work", async () => {
    const { mkdtemp, mkdir, rm, symlink, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "inkos-consolidator-boundary-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(join(bookDir, "story"), { recursive: true });
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(bookDir, "story/summaries_archive"), "junction");
      const agent = new ConsolidatorAgent({ client: {} as never, model: "test", projectRoot: root });
      await expect(agent.consolidate(bookDir)).rejects.toThrow("UNSAFE_PATH_COMPONENT");
      expect(await readdir(join(root, "outside"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("parses Chinese volume boundaries with full-width parentheses and chapter ranges", () => {
    const agent = new ConsolidatorAgent({
      client: {} as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: "/tmp",
    });

    const outline = [
      "# Volume Outline",
      "",
      "### 第一卷：死而复生的实习期（1-20章）",
      "- 主角重返公司，卷入第一起异常事故",
      "",
      "### 第二卷：时间线上的猎手（21-60章）",
      "- 追查时间裂隙背后的操控者",
      "",
    ].join("\n");

    const boundaries = (agent as unknown as {
      parseVolumeBoundaries: (input: string) => Array<{ name: string; startCh: number; endCh: number }>;
    }).parseVolumeBoundaries(outline);

    expect(boundaries).toEqual([
      { name: "第一卷：死而复生的实习期", startCh: 1, endCh: 20 },
      { name: "第二卷：时间线上的猎手", startCh: 21, endCh: 60 },
    ]);
  });
});
