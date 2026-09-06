import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { safeMutationPath } from "../utils/path-safety.js";

export type TruthCutoverState = "LEGACY_V1_ONLY" | "FIRST_V2_TRANSACTION_IN_PROGRESS" | "VERIFIED_V2_COMMIT_EXISTS";
export type TruthPathClass = "A" | "B" | "C" | "D" | "E" | "F";
const V2_PROJECTIONS = new Set([
  "current_state.md", "pending_hooks.md", "particle_ledger.md", "chapter_summaries.md",
  "subplot_board.md", "emotional_arcs.md", "character_matrix.md", "projection-manifest.json",
]);

export function classifyTruthMutationPath(relativePath: string): TruthPathClass {
  const path = relativePath.replace(/\\/gu, "/").toLowerCase();
  if (path.startsWith("/") || /^[a-z]:/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Path traversal blocked");
  if (path === "story/state/truth.json") return "A";
  if (path === "story/commits" || path.startsWith("story/commits/")) return "D";
  if (path === "story/runtime" || path.startsWith("story/runtime/")) return "C";
  if (path === "story/state" || path.startsWith("story/state/") || (path.startsWith("story/") && V2_PROJECTIONS.has(path.slice(6)))) return "B";
  if (path === "chapters/index.json" || path === "story/snapshots" || path.startsWith("story/snapshots/")) return "E";
  return "F";
}

export async function resolveTruthCutoverState(bookDir: string): Promise<TruthCutoverState> {
  await safeMutationPath(bookDir, "story/commits");
  await safeMutationPath(bookDir, "story/runtime/chapter-transactions");
  const genesis = join(bookDir, "story", "commits", "genesis.json");
  try { await lstat(genesis); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const directory of [join(bookDir, "story", "commits"), join(bookDir, "story", "runtime", "chapter-transactions")]) {
      const entries = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      });
      if (entries.length) throw new Error("TRUTH_CUTOVER_EVIDENCE_DEFECT: missing genesis");
    }
    return "LEGACY_V1_ONLY";
  }
  const { loadCanonicalTruthAuthorityObservation } = await import("../production/chapter-transaction.js");
  const { chain, activeTransaction } = await loadCanonicalTruthAuthorityObservation(bookDir);
  if (chain.commits.some((commit) => commit.kind === "TRUTH_CHAPTER_COMMIT")) return "VERIFIED_V2_COMMIT_EXISTS";
  return activeTransaction ? "FIRST_V2_TRANSACTION_IN_PROGRESS" : "LEGACY_V1_ONLY";
}

export async function assertTruthMutationAllowed(input: { readonly bookDir: string; readonly relativePath: string }): Promise<void> {
  await safeMutationPath(input.bookDir, input.relativePath);
  const pathClass = classifyTruthMutationPath(input.relativePath);
  if (["A", "C", "D"].includes(pathClass)) throw new Error(`TRUTH_AUTHORITY_MUTATION_FORBIDDEN: ${pathClass}`);
  if (pathClass === "F") {
    const chapter = /^chapters\/(\d+)(?:_|\.)[^/]*\.md$/iu.exec(input.relativePath.replace(/\\/gu, "/"));
    if (chapter) {
      const { assertChapterAuthorityMutationAllowed } = await import("../production/chapter-transaction.js");
      await assertChapterAuthorityMutationAllowed({ bookDir: input.bookDir, chapterNumber: Number(chapter[1]) });
    }
    return;
  }
  if (await resolveTruthCutoverState(input.bookDir) !== "LEGACY_V1_ONLY") throw new Error(`TRUTH_AUTHORITY_MUTATION_FORBIDDEN: ${pathClass}`);
}

export async function assertLegacyTruthMutationAllowed(bookDir: string): Promise<void> {
  if (await resolveTruthCutoverState(bookDir) !== "LEGACY_V1_ONLY") throw new Error("TRUTH_AUTHORITY_MUTATION_FORBIDDEN: legacy operation");
}

export type TruthAuthority =
  | "direction"
  | "foundation"
  | "rules"
  | "runtime-truth"
  | "memory";

const NORMALIZED_TRUTH_FILES = new Set([
  "author_intent.md",
  "current_focus.md",
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "current_state.md",
  "pending_hooks.md",
  "chapter_summaries.md",
]);

export function normalizeTruthFileName(fileName: string): string {
  const trimmed = fileName.trim().toLowerCase();
  const normalized = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  if (!NORMALIZED_TRUTH_FILES.has(normalized)) {
    return normalized;
  }
  return normalized;
}

export function classifyTruthAuthority(fileName: string): TruthAuthority {
  switch (normalizeTruthFileName(fileName)) {
    case "author_intent.md":
    case "current_focus.md":
      return "direction";
    case "story_bible.md":
    case "volume_outline.md":
      return "foundation";
    case "book_rules.md":
      return "rules";
    case "current_state.md":
    case "pending_hooks.md":
      return "runtime-truth";
    case "chapter_summaries.md":
    default:
      return "memory";
  }
}
