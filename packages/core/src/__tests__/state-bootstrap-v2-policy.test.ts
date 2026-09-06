import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapStructuredStateFromMarkdown, rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { loadRuntimeStateSnapshot, saveRuntimeStateSnapshot } from "../state/runtime-state-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("legacy state construction path boundary", () => {
  it.each(["bootstrap", "rewrite", "runtime-load", "runtime-save"] as const)("rejects a structured-state junction before %s writes any file", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "inkos-bootstrap-boundary-")); roots.push(root);
    const bookDir = join(root, "book");
    const outside = join(root, "outside");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(bookDir, "story/state"), "junction");
    const actions = {
      bootstrap: () => bootstrapStructuredStateFromMarkdown({ bookDir }),
      rewrite: () => rewriteStructuredStateFromMarkdown({ bookDir }),
      "runtime-load": () => loadRuntimeStateSnapshot(bookDir),
      "runtime-save": () => saveRuntimeStateSnapshot(bookDir, {} as never),
    };
    await expect(actions[operation]()).rejects.toThrow("UNSAFE_PATH_COMPONENT");
    expect(await readdir(outside)).toEqual([]);
  });
});
