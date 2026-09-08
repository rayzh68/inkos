import { canonicalJson, parseJsonRejectingDuplicates } from "../state/canonical-json.js";

interface SettlementContextInput {
  readonly committedAuthority: string;
  readonly predecessorTruthJson: string;
  readonly predecessorTruthSha256: string;
  readonly vocabularyCatalogJson?: string;
  readonly chapterMemo?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedCanonicalJson(text: string): unknown {
  try {
    const value = parseJsonRejectingDuplicates(text);
    canonicalJson(value);
    return value;
  } catch {
    return undefined;
  }
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);
}

/** Model-only projection of the named settlement envelope; durable host authority is untouched. */
export function projectTruthSettlementContext(input: SettlementContextInput): {
  readonly committedAuthority: string;
  readonly vocabularyCatalogJson?: string;
  readonly chapterMemo?: string;
} {
  const authority = parsedCanonicalJson(input.committedAuthority);
  if (!record(authority) || authority.schemaVersion !== "1.0"
    || authority.kind !== "CANONICAL_TRUTH_COMMITTED_AUTHORITY") return input;
  const predecessor = parsedCanonicalJson(input.predecessorTruthJson);
  if (equalCanonical(authority.structuredTruth, predecessor)) {
    authority.structuredTruth = { reference: "Verified predecessor StructuredTruthV1", sha256: input.predecessorTruthSha256 };
  }

  const intent = record(authority.chapterIntent) ? authority.chapterIntent : undefined;
  // Validator has no standalone memo: the shared envelope always retains its complete body.
  const memo = intent && record(intent.memo) ? intent.memo : undefined;
  const memoBody = memo && typeof memo.body === "string" ? memo.body : undefined;
  const memoReference = "[See committedAuthority.chapterIntent.memo.body]";
  // Planner markdown has no persisted memo-span provenance. Keep it, including coincidental memo substrings.
  // Composer's runtime/chapter_memo entry does have a fixed goal/optional-opening/body contract.
  const memoPrefix = memo && typeof memo.goal === "string" && typeof memo.isGoldenOpening === "boolean"
    ? [`goal=${memo.goal}`, ...(memo.isGoldenOpening ? ["golden-opening=true"] : [])].join(" | ") + " | "
    : undefined;
  const contextPackage = intent && record(intent.contextPackage) ? intent.contextPackage : undefined;
  if (contextPackage && Array.isArray(contextPackage.selectedContext)) {
    contextPackage.selectedContext = contextPackage.selectedContext.map((entry: unknown) => {
      if (!record(entry) || typeof entry.excerpt !== "string" || entry.excerpt.length === 0) return entry;
      let excerpt = entry.excerpt;
      if (memoBody && entry.source === "runtime/chapter_memo" && excerpt === memoBody) {
        excerpt = memoReference;
      } else if (memoBody && entry.source === "runtime/chapter_memo" && memoPrefix !== undefined && excerpt === memoPrefix + memoBody) {
        excerpt = memoPrefix + memoReference;
      } else if (equalCanonical(parsedCanonicalJson(excerpt), predecessor)) {
        excerpt = "[See Verified predecessor StructuredTruthV1]";
      } else {
        // References point into complete retained payloads, using JavaScript's exact UTF-16 offsets.
        const retained = [
          ["Verified predecessor StructuredTruthV1", input.predecessorTruthJson],
          ["committedAuthority.storyFrame", authority.storyFrame],
          ["committedAuthority.volumeMap", authority.volumeMap],
        ] as const;
        let uniqueMatch: { target: string; start: number } | undefined;
        let ambiguous = false;
        for (const [target, body] of retained) {
          if (typeof body !== "string") continue;
          const start = body.indexOf(excerpt);
          if (start < 0) continue;
          // Advance one UTF-16 unit, rather than excerpt.length, to also detect overlapping matches.
          if (uniqueMatch || body.indexOf(excerpt, start + 1) >= 0) { ambiguous = true; break; }
          uniqueMatch = { target, start };
        }
        if (uniqueMatch && !ambiguous) {
          excerpt = `[See ${uniqueMatch.target} UTF-16 ${uniqueMatch.start}:${uniqueMatch.start + excerpt.length}]`;
        }
      }
      return { ...entry, excerpt };
    });
  }
  const vocabularyMatches = record(predecessor) && input.vocabularyCatalogJson !== undefined
    && equalCanonical(parsedCanonicalJson(input.vocabularyCatalogJson), predecessor.vocabulary);
  return {
    committedAuthority: canonicalJson(authority),
    ...(input.vocabularyCatalogJson !== undefined ? {
      vocabularyCatalogJson: vocabularyMatches ? "[See Verified predecessor StructuredTruthV1.vocabulary]" : input.vocabularyCatalogJson,
    } : {}),
    ...(input.chapterMemo !== undefined ? {
      chapterMemo: memoBody && input.chapterMemo === memoBody ? memoReference : input.chapterMemo,
    } : {}),
  };
}
