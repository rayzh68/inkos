import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { safeMutationPath } from "./path-safety.js";

export interface AtomicFileWrite {
  readonly relativePath: string;
  readonly content: string | Uint8Array;
}

/** Publish complete bytes once; true owns publication, false is an identical replay. */
export async function publishImmutableFile(target: string, content: string | Uint8Array): Promise<boolean> {
  const bytes = Buffer.from(content);
  await safeMutationPath(dirname(target), basename(target));
  await mkdir(dirname(target), { recursive: true });
  await safeMutationPath(dirname(target), basename(target));
  const temporary = join(dirname(target), `.immutable-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await safeMutationPath(dirname(target), basename(target));
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await safeMutationPath(dirname(target), basename(target));
      let existing: Buffer;
      try {
        existing = await readFile(target);
      } catch (cause) {
        throw new Error(`IMMUTABLE_CONFLICT: unreadable target ${target}`, { cause });
      }
      if (!existing.equals(bytes)) throw new Error(`IMMUTABLE_CONFLICT: ${target}`);
      return false;
    }
    return true;
  } finally {
    // This path belongs only to this invocation, never to another publisher.
    await rm(temporary, { force: true });
  }
}

export interface AtomicFileSet {
  readonly rootDir: string;
  readonly writes: ReadonlyArray<AtomicFileWrite>;
  readonly deletes?: ReadonlyArray<string>;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

function safeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (
    !relativePath.trim()
    || isAbsolute(relativePath)
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Atomic file path must stay inside rootDir: ${relativePath}`);
  }
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function commitAtomicFileSet(input: AtomicFileSet): Promise<void> {
  const renameFile = input.renameFile ?? rename;
  // Validate original spelling and every existing component before staging or
  // moving any member of the set (normalization must not hide unsafe aliases).
  for (const relativePath of [...input.writes.map((entry) => entry.relativePath), ...(input.deletes ?? [])]) {
    await safeMutationPath(input.rootDir, relativePath);
  }
  const writes = input.writes.map((entry) => ({
    ...entry,
    relativePath: safeRelativePath(entry.relativePath),
  }));
  const deletes = (input.deletes ?? []).map(safeRelativePath);
  const writePaths = new Set(writes.map((entry) => entry.relativePath));
  if (writePaths.size !== writes.length) {
    throw new Error("Atomic file set contains duplicate write paths");
  }
  if (deletes.some((relativePath) => writePaths.has(relativePath))) {
    throw new Error("Atomic file set cannot write and delete the same path");
  }

  await mkdir(input.rootDir, { recursive: true });
  const transactionDir = await mkdtemp(join(input.rootDir, ".inkos-file-txn-"));
  const stagedDir = join(transactionDir, "staged");
  const backupDir = join(transactionDir, "backup");
  const touchedPaths = [...writePaths, ...deletes];
  const backups: Array<{ readonly target: string; readonly backup: string }> = [];
  const committedTargets: string[] = [];

  try {
    for (const entry of writes) {
      const stagedPath = join(stagedDir, entry.relativePath);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, entry.content);
    }

    for (const relativePath of touchedPaths) {
      const target = await safeMutationPath(input.rootDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await safeMutationPath(input.rootDir, relativePath);
      if (!(await exists(target))) continue;

      const backup = join(backupDir, relativePath);
      await mkdir(dirname(backup), { recursive: true });
      await renameFile(target, backup);
      backups.push({ target, backup });
    }

    for (const entry of writes) {
      const target = await safeMutationPath(input.rootDir, entry.relativePath);
      await renameFile(join(stagedDir, entry.relativePath), target);
      committedTargets.push(target);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const target of committedTargets.reverse()) {
      await safeMutationPath(dirname(target), basename(target)).then(() => rm(target, { recursive: true, force: true })).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    for (const entry of backups.reverse()) {
      try {
        await safeMutationPath(dirname(entry.target), basename(entry.target));
        await rm(entry.target, { recursive: true, force: true });
        await mkdir(dirname(entry.target), { recursive: true });
        await renameFile(entry.backup, entry.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Atomic file commit failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
