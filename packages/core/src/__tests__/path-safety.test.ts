import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { safeChildPath } from "../utils/path-safety.js";
import * as paths from "../utils/path-safety.js";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("path safety", () => {
  const root = resolve("/tmp/inkos/books");

  it("allows paths inside the root", () => {
    expect(safeChildPath(root, "book-a/story/book_rules.md"))
      .toBe(join(root, "book-a/story/book_rules.md"));
  });

  it("blocks parent traversal", () => {
    expect(() => safeChildPath(root, "../books2/secret.md"))
      .toThrow("Path traversal blocked");
  });

  it("blocks sibling-prefix bypasses", () => {
    expect(() => safeChildPath(root, "/tmp/inkos/books2/secret.md"))
      .toThrow("Path traversal blocked");
  });

  it("rejects Windows alias and alternate-stream spellings before a missing suffix is accepted", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-path-alias-"));
    try {
      for (const path of ["story/state/truth.json:stream", "story/state./truth.json", "story/state /truth.json", "story/NUL", "story/../state/truth.json"]) {
        await expect(paths.safeMutationPath(fixture, path)).rejects.toThrow(/UNSAFE_PATH|traversal/i);
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  it("rejects an existing junction component before accessing another book", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inkos-path-policy-"));
    try {
      await mkdir(join(fixture, "book-a"));
      await mkdir(join(fixture, "book-b"));
      await writeFile(join(fixture, "book-b", "truth.json"), "private");
      await symlink(join(fixture, "book-b"), join(fixture, "book-a", "story"), "junction");
      await expect(paths.safeMutationPath(fixture, "book-a", true)).rejects.toThrow("UNSAFE_PATH_COMPONENT");
      await expect(paths.safeMutationPath(join(fixture, "book-a"), "story/truth.json"))
        .rejects.toThrow("UNSAFE_PATH_COMPONENT");
      await expect(paths.safeMutationPath(join(fixture, "book-a", "story"), "truth.json"))
        .rejects.toThrow("UNSAFE_PATH_COMPONENT");
      await expect(paths.safeMutationPath(join(fixture, "book-a"), "new/intent.md"))
        .resolves.toBe(join(fixture, "book-a", "new", "intent.md"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
