import { describe, expect, it } from "vitest";
import { buildFirstV2Baseline } from "../production/first-v2-baseline.js";
import type { LegacyChapterCommitV1 } from "../production/chapter-transaction.js";
import { canonicalJson, sha256Bytes, sha256Utf8 } from "../state/canonical-json.js";
import { validateBaselineAuthorityV1 } from "../models/structured-truth.js";

function fixture(overrides: Readonly<Record<string, string | undefined>> = {}) {
  const text = {
    "current_state.json": JSON.stringify({ chapter: 5, facts: [{ subject: "protagonist", predicate: "Current Goal", object: "Find her brother", validFromChapter: 5, validUntilChapter: null, sourceChapter: 5 }] }),
    "hooks.json": JSON.stringify({ hooks: [{ hookId: "线索 A", startChapter: 2, type: "mystery", status: "progressing", lastAdvancedChapter: 5, expectedPayoff: "The missing key", payoffTiming: "near-term", notes: "No inference" }] }),
    "chapter_summaries.json": JSON.stringify({ rows: [{ chapter: 5, title: "The key", events: "She found a locked door." }] }),
    "current_state.md": "# Legacy\r\nMeaning preserved exactly.\r\n",
    "unmapped.json": "{\"opaque\":\"preserve without guessing\"}",
    ...overrides,
  };
  const sourceFiles = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, Buffer.from(value!)]));
  const chapterCommit = {
    schemaVersion: 1, kind: "CHAPTER_COMMIT", bookId: "book-a", chapterNumber: 5,
    commitSha256: "a".repeat(64), previousAuthoritySha256: "b".repeat(64), stateTreeSha256: "c".repeat(64),
    finalBodySha256: sha256Utf8("Exact committed prose.\r\n"),
    chapterTitle: "Chapter five", language: "en", transactionId: "legacy-transaction", productionAuthority: "fixture-authority",
    finalLengthCount: 3, lengthSpec: { target: 3, softMin: 3, softMax: 3, hardMin: 3, hardMax: 3, countingMode: "en_words" },
    boundedReviewStatus: "APPROVED", revisionCount: 0, reviewEvidenceSha256: "d".repeat(64), finalCandidateSha256: sha256Utf8("Exact committed prose.\r\n"),
    stateManifestSha256: "d".repeat(64), snapshotManifestSha256: "d".repeat(64), stateValidationSha256: "d".repeat(64),
    snapshotTreeSha256: "d".repeat(64), snapshotFiles: [], usageSha256: "d".repeat(64), providerReferencesSha256: "d".repeat(64), providerReferenceCount: 0,
    createdAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:01:00.000Z",
    stateFiles: Object.entries(sourceFiles).map(([relativePath, bytes]) => ({ relativePath, bytes: bytes.length, sha256: sha256Bytes(bytes) })),
  } satisfies LegacyChapterCommitV1;
  return { chapterCommit, sourceFiles, predecessorChapterBody: "Exact committed prose.\r\n" };
}

describe("deterministic first-V2 baseline", () => {
  it("maps explicitly typed hooks and chapter summaries without inventing free-text subject entities", () => {
    const input = fixture();
    const baseline = buildFirstV2Baseline(input);
    expect(baseline.truth.entities.map((entity) => entity.entityKind).sort()).toEqual(["narrative.hook", "system.chapter"]);
    expect(baseline.truth.entities.every((entity) => entity.declaredAtChapter === 0)).toBe(true);
    const factValues = Object.fromEntries(baseline.truth.facts.map((fact) => [baseline.truth.vocabulary.entries.find((entry) => entry.entryId === fact.factKeyEntryId)!.canonicalName,
      fact.assertion.state === "VALUE" ? fact.assertion.value.value : null]));
    expect(factValues).toMatchObject({ "lifecycle.status": "progressing", "lifecycle.started_chapter": "2", "lifecycle.last_advanced_chapter": "5", "lifecycle.expected_payoff": "The missing key", "summary.chapter_number": "5", "summary.title": "The key", "summary.events": "She found a locked door." });
    expect(baseline.truth.entities.some((entity) => entity.canonicalName === "protagonist")).toBe(false);
    expect(baseline.truth.relations).toEqual([]);
    expect(validateBaselineAuthorityV1({ ...input, ...baseline })).toEqual(baseline.truth);
  });

  it("preserves every committed source byte and produces identical canonical authority on reentry", () => {
    const input = fixture();
    const baseline = buildFirstV2Baseline(input);
    expect(baseline.sourceManifest.entries.map((entry) => entry.path)).toEqual(["chapter_summaries.json", "current_state.json", "current_state.md", "hooks.json", "unmapped.json"]);
    expect(Buffer.from(input.sourceFiles["current_state.md"]!).toString()).toBe("# Legacy\r\nMeaning preserved exactly.\r\n");
    expect(canonicalJson(buildFirstV2Baseline({ ...input, sourceFiles: Object.fromEntries(Object.entries(input.sourceFiles).reverse()) }))).toBe(canonicalJson(baseline));
    expect(baseline.receipt.recordBindings.length).toBe(baseline.truth.entities.length + baseline.truth.facts.length);
  });

  it.each(["tampered source", "missing source", "extra source", "wrong prose"])("rejects %s before returning baseline authority", (attack) => {
    const input = fixture();
    if (attack === "tampered source") input.sourceFiles["current_state.md"] = Buffer.from("changed");
    if (attack === "missing source") Reflect.deleteProperty(input.sourceFiles, "unmapped.json");
    if (attack === "extra source") input.sourceFiles["extra.md"] = Buffer.from("not committed");
    if (attack === "wrong prose") input.predecessorChapterBody = "not the committed chapter";
    expect(() => buildFirstV2Baseline(input)).toThrow();
  });

  it.each([
    { "current_state.json": '{"chapter":6}' },
    { "current_state.json": '{"version":99}' },
    { "current_state.json": '{"chapter":6,"chapter":5}' },
    { "hooks.json": '{"hooks":[{"hookId":"a"}]}' },
    { "hooks.json": '{"hooks":[{"hookId":"a","startChapter":2,"lastAdvancedChapter":6,"type":"mystery","status":"open"}]}' },
    { "hooks.json": '{"hooks":[{"hookId":"a","startChapter":2,"lastAdvancedChapter":5,"type":"mystery","status":"open"},{"hookId":"a","startChapter":2,"lastAdvancedChapter":5,"type":"mystery","status":"resolved"}]}' },
  ])("fails closed for unsupported or ambiguous recognized legacy source: %j", (overrides) => {
    expect(() => buildFirstV2Baseline(fixture(overrides))).toThrow();
  });
});
