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
  const memoBody = intent && record(intent.memo) && typeof intent.memo.body === "string" ? intent.memo.body : undefined;
  const memoReference = "[See committedAuthority.chapterIntent.memo.body]";
  const replaceMemo = (text: string): string => memoBody ? text.split(memoBody).join(memoReference) : text;
  if (intent && typeof intent.markdown === "string") intent.markdown = replaceMemo(intent.markdown);
  const contextPackage = intent && record(intent.contextPackage) ? intent.contextPackage : undefined;
  if (contextPackage && Array.isArray(contextPackage.selectedContext)) {
    contextPackage.selectedContext = contextPackage.selectedContext.map((entry: unknown) => {
      if (!record(entry) || typeof entry.excerpt !== "string" || entry.excerpt.length === 0) return entry;
      let excerpt = entry.excerpt;
      if (equalCanonical(parsedCanonicalJson(excerpt), predecessor)) {
        excerpt = "[See Verified predecessor StructuredTruthV1]";
      } else {
        // References point into complete retained payloads, using JavaScript's exact UTF-16 offsets.
        const retained = [
          ["Verified predecessor StructuredTruthV1", input.predecessorTruthJson],
          ["committedAuthority.storyFrame", authority.storyFrame],
          ["committedAuthority.volumeMap", authority.volumeMap],
        ] as const;
        const covered = retained.find(([, body]) => typeof body === "string" && body.includes(excerpt));
        if (covered) {
          const start = (covered[1] as string).indexOf(excerpt);
          excerpt = `[See ${covered[0]} UTF-16 ${start}:${start + excerpt.length}]`;
        } else {
          excerpt = replaceMemo(excerpt);
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
