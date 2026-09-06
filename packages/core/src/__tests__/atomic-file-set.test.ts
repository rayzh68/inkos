import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import * as atomicFiles from "../utils/atomic-file-set.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

describe("commitAtomicFileSet", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createBookFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-file-set-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "chapters"), { recursive: true }),
      mkdir(join(root, "story"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "chapters", "0001_old.md"), "old chapter", "utf-8"),
      writeFile(join(root, "story", "current_state.md"), "old state", "utf-8"),
      writeFile(join(root, "story", "pending_hooks.md"), "old hooks", "utf-8"),
    ]);
    return root;
  }

  it("publishes identical immutable bytes concurrently without replacing the winner", async () => {
    const root = await createBookFixture();
    const target = join(root, "immutable.json");
    const claims = await Promise.all(Array.from({ length: 8 }, () => atomicFiles.publishImmutableFile(target, '{"value":1}\n')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === false)).toHaveLength(7);
    expect(await readFile(target, "utf8")).toBe('{"value":1}\n');
    expect((await readdir(root)).filter((name) => name.includes(".immutable-"))).toEqual([]);
  });

  it("conflicts the differing immutable publisher and retains exactly one byte identity", async () => {
    const root = await createBookFixture();
    const target = join(root, "immutable.json");
    const results = await Promise.allSettled([
      atomicFiles.publishImmutableFile(target, "first"),
      atomicFiles.publishImmutableFile(target, "second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.message).toContain("IMMUTABLE_CONFLICT");
    expect(["first", "second"]).toContain(await readFile(target, "utf8"));
    await expect(atomicFiles.publishImmutableFile(target, "different")).rejects.toThrow("IMMUTABLE_CONFLICT");
  });

  it("rejects immutable publication through a junction before writing any bytes", async () => {
    const root = await createBookFixture();
    await fs.symlink(join(root, "story"), join(root, "escape"), "junction");
    await expect(atomicFiles.publishImmutableFile(join(root, "escape", "authority.json"), "forbidden"))
      .rejects.toThrow("UNSAFE_PATH_COMPONENT");
    await expect(readFile(join(root, "story", "authority.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every atomic target before changing even the safe first member", async () => {
    const root = await createBookFixture();
    await fs.symlink(join(root, "story"), join(root, "escape"), "junction");
    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_old.md", content: "changed" },
        { relativePath: "escape/current_state.md", content: "escaped" },
      ],
    })).rejects.toThrow("UNSAFE_PATH_COMPONENT");
    expect(await readFile(join(root, "chapters/0001_old.md"), "utf8")).toBe("old chapter");
    expect(await readFile(join(root, "story/current_state.md"), "utf8")).toBe("old state");
    expect((await readdir(root)).filter((name) => name.startsWith(".inkos-file-txn-"))).toEqual([]);
  });

  it.each(["before", "after"])("recovers immutable publication from a crash %s the link", async (phase) => {
    const root = await createBookFixture();
    const target = join(root, "immutable.json");
    const actualLink = fs.link;
    const spy = vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
      if (phase === "after") await actualLink(from, to);
      throw Object.assign(new Error("simulated crash"), { code: "EIO" });
    });
    await expect(atomicFiles.publishImmutableFile(target, "complete")).rejects.toThrow("simulated crash");
    spy.mockRestore();
    if (phase === "before") await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(target, "utf8")).toBe("complete");
    await atomicFiles.publishImmutableFile(target, "complete");
    expect(await readFile(target, "utf8")).toBe("complete");
    expect((await readdir(root)).filter((name) => name.startsWith(".immutable-"))).toEqual([]);
  });

  it("commits the complete file set and removes superseded files", async () => {
    const root = await createBookFixture();

    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
    });

    await expect(readFile(join(root, "chapters", "0001_new.md"), "utf-8")).resolves.toBe("new chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("new hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_new.md"]);
  });

  it("restores every original file when commit fails after the first replacement", async () => {
    const root = await createBookFixture();
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
      renameFile: async (from, to) => {
        if (from.includes(`${sep}staged${sep}`)) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 2) {
            throw new Error("injected commit failure");
          }
        }
        await rename(from, to);
      },
    })).rejects.toThrow("injected commit failure");

    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
  });
});
