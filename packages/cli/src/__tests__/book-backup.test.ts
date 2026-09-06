import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBookBackup, listBookBackups, restoreBookBackup } from "../book-backup.js";

const logMock = vi.fn();
const logErrorMock = vi.fn();
let projectRoot = "";

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function setupBook(bookId: string): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-book-backup-"));
  const bookDir = join(projectRoot, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: bookId, title: bookId, language: "zh" }), "utf-8");
  await writeFile(join(bookDir, "chapters", "0001_起风.md"), "第一章原文。", "utf-8");
  await writeFile(join(bookDir, "story", "current_state.md"), "原始状态", "utf-8");
  return bookDir;
}

const fixedClock = (iso: string) => () => new Date(iso);

describe("book backup module", () => {
  it("preflights backup source junctions before creating any backup", async () => {
    const bookDir = await setupBook("source-junction");
    const outside = join(projectRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "retained.txt"), "outside");
    await symlink(outside, join(bookDir, "story/redirect"), "junction");
    await expect(createBookBackup(projectRoot, "source-junction")).rejects.toThrow("UNSAFE_PATH_COMPONENT");
    expect(await listBookBackups(projectRoot, "source-junction")).toEqual([]);
  });
  it("rejects a junction in backup contents before replacing the legacy destination", async () => {
    const bookDir = await setupBook("junction-book");
    const backup = await createBookBackup(projectRoot, "junction-book", { now: fixedClock("2026-07-15T08:12:33Z") });
    const otherBook = join(projectRoot, "books/other-book");
    await mkdir(otherBook);
    await writeFile(join(otherBook, "protected.txt"), "private");
    await symlink(otherBook, join(backup.path, "story/escape"), "junction");
    await expect(restoreBookBackup(projectRoot, "junction-book", backup.backupId)).rejects.toThrow("UNSAFE_PATH_COMPONENT");
    expect(await readFile(join(bookDir, "story/current_state.md"), "utf8")).toBe("原始状态");
    expect(await readFile(join(otherBook, "protected.txt"), "utf8")).toBe("private");
    expect(await listBookBackups(projectRoot, "junction-book")).toHaveLength(1);
  });
  it("rejects restore before backup or replacement when active canonical cutover evidence is unprovable", async () => {
    const bookDir = await setupBook("protected-book");
    const backup = await createBookBackup(projectRoot, "protected-book", { now: fixedClock("2026-07-15T08:12:33Z") });
    await mkdir(join(bookDir, "story/runtime/chapter-transactions/chapter-0001"), { recursive: true });
    const transactionPath = join(bookDir, "story/runtime/chapter-transactions/chapter-0001/transaction.json");
    await writeFile(transactionPath, '{"truthMode":"CANONICAL_V2"}');
    await expect(restoreBookBackup(projectRoot, "protected-book", backup.backupId)).rejects.toThrow(/TRUTH_CUTOVER|TRUTH_AUTHORITY/);
    expect(await readFile(transactionPath, "utf8")).toBe('{"truthMode":"CANONICAL_V2"}');
    expect(await listBookBackups(projectRoot, "protected-book")).toHaveLength(1);
  });
  it("snapshots the whole book directory into .inkos/backups/<bookId>/<stamp>/", async () => {
    const bookDir = await setupBook("backbook");

    const result = await createBookBackup(projectRoot, "backbook", { now: fixedClock("2026-07-15T08:12:33Z") });

    expect(result.backupId).toBe("20260715-081233");
    const backupDir = join(projectRoot, ".inkos", "backups", "backbook", "20260715-081233");
    await expect(readFile(join(backupDir, "chapters", "0001_起风.md"), "utf-8")).resolves.toBe("第一章原文。");
    await expect(readFile(join(backupDir, "story", "current_state.md"), "utf-8")).resolves.toBe("原始状态");
    // The original book stays in place.
    await expect(exists(join(bookDir, "book.json"))).resolves.toBe(true);
  });

  it("produces distinct ids for two backups taken at the same clock instant", async () => {
    await setupBook("twinbook");
    const now = fixedClock("2026-07-15T08:12:33Z");

    const first = await createBookBackup(projectRoot, "twinbook", { now });
    const second = await createBookBackup(projectRoot, "twinbook", { now });

    expect(first.backupId).toBe("20260715-081233");
    expect(second.backupId).toBe("20260715-081233-2");
  });

  it("lists backups newest first", async () => {
    await setupBook("listbook");
    await createBookBackup(projectRoot, "listbook", { now: fixedClock("2026-07-14T10:00:00Z") });
    await createBookBackup(projectRoot, "listbook", { now: fixedClock("2026-07-15T10:00:00Z") });

    const backups = await listBookBackups(projectRoot, "listbook");

    expect(backups.map((b) => b.id)).toEqual(["20260715-100000", "20260714-100000"]);
    expect(backups[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an empty list for a book without backups", async () => {
    await setupBook("nobackups");
    await expect(listBookBackups(projectRoot, "nobackups")).resolves.toEqual([]);
  });

  it("restores a backup and auto-backs-up the current state first", async () => {
    const bookDir = await setupBook("restorebook");
    const backup = await createBookBackup(projectRoot, "restorebook", { now: fixedClock("2026-07-15T08:00:00Z") });

    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "改坏了的第一章。", "utf-8");
    await writeFile(join(bookDir, "chapters", "0002_多余.md"), "多写的一章。", "utf-8");

    const result = await restoreBookBackup(projectRoot, "restorebook", backup.backupId, {
      now: fixedClock("2026-07-15T09:00:00Z"),
    });

    expect(result.restoredFrom).toBe("20260715-080000");
    expect(result.preRestoreBackupId).toBe("20260715-090000-pre-restore");

    // Content is back to the backup point, including removal of extra files.
    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8")).resolves.toBe("第一章原文。");
    await expect(exists(join(bookDir, "chapters", "0002_多余.md"))).resolves.toBe(false);

    // The pre-restore auto-backup preserves the botched state.
    const preRestoreDir = join(projectRoot, ".inkos", "backups", "restorebook", "20260715-090000-pre-restore");
    await expect(readFile(join(preRestoreDir, "chapters", "0001_起风.md"), "utf-8")).resolves.toBe("改坏了的第一章。");
    await expect(readFile(join(preRestoreDir, "chapters", "0002_多余.md"), "utf-8")).resolves.toBe("多写的一章。");
  });

  it("rejects backing up a book that does not exist", async () => {
    await setupBook("realbook");
    await expect(createBookBackup(projectRoot, "ghostbook")).rejects.toThrow(/not found/i);
  });

  it("rejects restoring an unknown backup id", async () => {
    await setupBook("orphanbook");
    await expect(restoreBookBackup(projectRoot, "orphanbook", "20990101-000000"))
      .rejects.toThrow(/not found/i);
  });

  it("rejects backup ids containing path separators", async () => {
    await setupBook("evilbook");
    await expect(restoreBookBackup(projectRoot, "evilbook", "../../books/evilbook"))
      .rejects.toThrow(/backup id/i);
  });
});

describe("inkos book backup / restore commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a backup, lists it, and restores it via the CLI", async () => {
    const bookDir = await setupBook("cliflow");
    const { bookCommand } = await import("../commands/book.js");

    await bookCommand.parseAsync(["node", "book", "backup", "cliflow", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const created = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as { backupId: string };
    expect(created.backupId).toMatch(/^\d{8}-\d{6}/);

    await bookCommand.parseAsync(["node", "book", "backup", "cliflow", "--list", "--json"], { from: "node" });
    const listed = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as {
      backups: ReadonlyArray<{ id: string }>;
    };
    expect(listed.backups.map((b) => b.id)).toContain(created.backupId);

    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "改坏了。", "utf-8");

    await bookCommand.parseAsync(["node", "book", "restore", "cliflow", created.backupId, "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const restored = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as {
      restoredFrom: string;
      preRestoreBackupId: string | null;
    };
    expect(restored.restoredFrom).toBe(created.backupId);
    expect(restored.preRestoreBackupId).not.toBeNull();

    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8")).resolves.toBe("第一章原文。");
  });

  it("fails with exit code 1 when restoring a backup that does not exist", async () => {
    await setupBook("clibroken");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const { bookCommand } = await import("../commands/book.js");
      await bookCommand.parseAsync(["node", "book", "restore", "clibroken", "20990101-000000"], { from: "node" });

      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("not found"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
