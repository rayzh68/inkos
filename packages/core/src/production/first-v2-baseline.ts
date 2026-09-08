import type { FirstV2BaselineContext, LegacyChapterCommitV1 } from "./chapter-transaction.js";
import { validateBaselineAuthorityV1, type BaselineSourceManifestV1, type BaselineConstructionReceiptV1, type StructuredTruthV1, type BaselineRecordBindingV1, type NarrativeEntityRecordV1, type FactAssertionRecordV1, type CanonicalFactValueV1 } from "../models/structured-truth.js";
import { CurrentStateStateSchema, HooksStateSchema, ChapterSummariesStateSchema } from "../models/runtime-state.js";
import { canonicalSha256, compareUnsignedUtf8, parseJsonRejectingDuplicates, sha256Bytes, sha256Utf8 } from "../state/canonical-json.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import { deriveBaselineEntityId, deriveFactSlotId } from "../state/truth-identities.js";

/** Pure construction. The caller must first verify the complete committed chain. */
export function buildFirstV2Baseline(input: {
  readonly chapterCommit: LegacyChapterCommitV1;
  readonly sourceFiles: Readonly<Record<string, Uint8Array>>;
  readonly predecessorChapterBody: string;
}): FirstV2BaselineContext {
  const commit = input.chapterCommit;
  const currentBytes = input.sourceFiles["current_state.json"];
  if (!currentBytes) throw new Error("FIRST_V2_LEGACY_SOURCE_UNSUPPORTED");
  const current = CurrentStateStateSchema.parse(parseJsonRejectingDuplicates(Buffer.from(currentBytes).toString("utf8")));
  if (current.chapter !== commit.chapterNumber) throw new Error("FIRST_V2_LEGACY_SOURCE_CHAPTER_MISMATCH");
  if (sha256Utf8(input.predecessorChapterBody) !== commit.finalBodySha256) throw new Error("FIRST_V2_BASELINE_PREDECESSOR_PROSE_MISMATCH");
  const sourceManifest: BaselineSourceManifestV1 = {
    schemaVersion: "1.0", kind: "BASELINE_SOURCE_MANIFEST", bookId: commit.bookId, throughChapter: commit.chapterNumber,
    predecessorCommitSha256: commit.commitSha256, sourceStateTreeSha256: commit.stateTreeSha256,
    entries: commit.stateFiles.map((entry) => ({ path: entry.relativePath, sha256: entry.sha256, byteLength: entry.bytes }))
      .sort((left, right) => compareUnsignedUtf8(left.path, right.path)),
  };
  const vocabulary = createVocabularyCatalogV1([]);
  const manifestSha = canonicalSha256(sourceManifest);
  const bindings: BaselineRecordBindingV1[] = [];
  const entities: NarrativeEntityRecordV1[] = [];
  const facts: FactAssertionRecordV1[] = [];
  const bind = (kind: "ENTITY" | "FACT_SLOT", identity: string, path: string) => {
    const bytes = input.sourceFiles[path]!;
    const baselineRecordId = canonicalSha256({ domain: "inkos.baseline-record.v1", baselineSourceManifestSha256: manifestSha, recordKind: kind, recordIdentity: identity });
    const common = { baselineRecordId, sourceReferences: [{ path, fileSha256: sha256Bytes(bytes), startUtf8: 0, endUtf8: bytes.length, quoteSha256: sha256Bytes(bytes) }] };
    bindings.push(kind === "ENTITY" ? { ...common, recordKind: kind, entityId: identity } : { ...common, recordKind: kind, factSlotId: identity });
    return baselineRecordId;
  };
  const addEntity = (kind: "narrative.hook" | "system.chapter", identityKey: string, name: string, path: string) => {
    const entityId = deriveBaselineEntityId({ bookId: commit.bookId, baselineSourceManifestSha256: manifestSha, entityKind: kind, identityKey });
    if (entities.some((entity) => entity.entityId === entityId)) throw new Error("FIRST_V2_LEGACY_DUPLICATE_ENTITY");
    entities.push({ entityId, entityKind: kind, identityKey, canonicalName: name, aliases: [], declaredAtChapter: 0,
      declarationSource: { origin: "BASELINE", bookId: commit.bookId, baselineSourceManifestSha256: manifestSha,
        baselineConstructionReceiptSha256: "", baselineRecordId: bind("ENTITY", entityId, path) } });
    return entityId;
  };
  const addFact = (entityId: string, key: string, value: unknown, path: string) => {
    const entry = vocabulary.entries.find((item) => item.canonicalName === key && item.entryKind === "FACT_KEY");
    if (!entry || entry.entryKind !== "FACT_KEY") throw new Error("FIRST_V2_SEED_VOCABULARY_MISSING");
    const factSlotId = deriveFactSlotId({ bookId: commit.bookId, subjectEntityId: entityId, factKeyEntryId: entry.entryId });
    const typedValue: CanonicalFactValueV1 = typeof value === "number" ? { valueType: "INTEGER", value: String(value) }
      : typeof value === "boolean" ? { valueType: "BOOLEAN", value } : { valueType: "STRING", value: value as string };
    facts.push({ factSlotId, subject: { nodeKind: "ENTITY", nodeId: entityId }, factKeyEntryId: entry.entryId,
      assertion: { state: "VALUE", value: typedValue }, validFromChapter: commit.chapterNumber, lastChangedChapter: commit.chapterNumber,
      source: { sourceKind: "BASELINE", baselineSourceManifestSha256: manifestSha, baselineConstructionReceiptSha256: "", baselineRecordId: bind("FACT_SLOT", factSlotId, path) } });
  };
  if (input.sourceFiles["hooks.json"]) {
    const raw = parseJsonRejectingDuplicates(Buffer.from(input.sourceFiles["hooks.json"]).toString("utf8")) as { hooks: Record<string, unknown>[] };
    if (!Array.isArray(raw?.hooks)) throw new Error("FIRST_V2_LEGACY_HOOKS_UNSUPPORTED");
    const hooks = HooksStateSchema.parse(raw).hooks;
    const mapping = { type: "lifecycle.type", status: "lifecycle.status", startChapter: "lifecycle.started_chapter", lastAdvancedChapter: "lifecycle.last_advanced_chapter",
      expectedPayoff: "lifecycle.expected_payoff", payoffTiming: "lifecycle.payoff_timing", notes: "lifecycle.notes", paysOffInArc: "lifecycle.pays_off_in_arc",
      coreHook: "lifecycle.core", halfLifeChapters: "lifecycle.half_life_chapters", advancedCount: "lifecycle.advanced_count" } as const;
    for (const [index, hook] of hooks.entries()) {
      if (hook.startChapter > hook.lastAdvancedChapter || hook.lastAdvancedChapter > commit.chapterNumber) throw new Error("FIRST_V2_LEGACY_HOOK_CHAPTER_MISMATCH");
      const entityId = addEntity("narrative.hook", `hook-${sha256Utf8(hook.hookId).slice(0, 48)}`, hook.hookId, "hooks.json");
      for (const [field, key] of Object.entries(mapping)) if (Object.hasOwn(raw.hooks[index], field)) addFact(entityId, key, hook[field as keyof typeof mapping], "hooks.json");
    }
  }
  if (input.sourceFiles["chapter_summaries.json"]) {
    const raw = parseJsonRejectingDuplicates(Buffer.from(input.sourceFiles["chapter_summaries.json"]).toString("utf8")) as { rows: Record<string, unknown>[] };
    if (!Array.isArray(raw?.rows)) throw new Error("FIRST_V2_LEGACY_SUMMARIES_UNSUPPORTED");
    const rows = ChapterSummariesStateSchema.parse(raw).rows;
    const mapping = { chapter: "summary.chapter_number", title: "summary.title", characters: "summary.characters", events: "summary.events", stateChanges: "summary.state_changes",
      hookActivity: "summary.hook_activity", mood: "summary.mood", chapterType: "summary.chapter_type" } as const;
    for (const [index, row] of rows.entries()) {
      if (row.chapter > commit.chapterNumber) throw new Error("FIRST_V2_LEGACY_SUMMARY_CHAPTER_MISMATCH");
      const entityId = addEntity("system.chapter", `chapter-${row.chapter}`, row.title, "chapter_summaries.json");
      for (const [field, key] of Object.entries(mapping)) if (Object.hasOwn(raw.rows[index], field)) addFact(entityId, key, row[field as keyof typeof mapping], "chapter_summaries.json");
    }
  }
  bindings.sort((left, right) => compareUnsignedUtf8(`${left.recordKind}:${left.recordKind === "ENTITY" ? left.entityId : left.recordKind === "FACT_SLOT" ? left.factSlotId : ""}`, `${right.recordKind}:${right.recordKind === "ENTITY" ? right.entityId : right.recordKind === "FACT_SLOT" ? right.factSlotId : ""}`));
  const receipt: BaselineConstructionReceiptV1 = {
    schemaVersion: "1.0", kind: "BASELINE_CONSTRUCTION_RECEIPT", bookId: commit.bookId, throughChapter: commit.chapterNumber,
    predecessorCommitSha256: commit.commitSha256, baselineSourceManifestSha256: canonicalSha256(sourceManifest),
    seedVocabularyCatalogSha256: canonicalSha256(vocabulary),
    method: { kind: "DETERMINISTIC", builderId: "inkos.truth-baseline.builder.v1", builderVersion: "1.0" }, recordBindings: bindings,
  };
  // Legacy free-text subjects/predicates do not prove an entity kind or a V2
  // vocabulary meaning. Their exact bytes remain bound by the complete manifest.
  const truth: StructuredTruthV1 = {
    schemaVersion: "1.0", kind: "STRUCTURED_TRUTH", bookId: commit.bookId, throughChapter: commit.chapterNumber,
    lineage: { kind: "BASELINE", predecessorCommitSha256: commit.commitSha256,
      baselineSourceManifestSha256: canonicalSha256(sourceManifest), seedVocabularyCatalogSha256: receipt.seedVocabularyCatalogSha256,
      baselineMethod: "DETERMINISTIC", baselineConstructionReceiptSha256: canonicalSha256(receipt) },
    vocabulary,
    entities: entities.map((entity) => ({ ...entity, declarationSource: { ...entity.declarationSource, baselineConstructionReceiptSha256: canonicalSha256(receipt) } })).sort((left, right) => compareUnsignedUtf8(left.entityId, right.entityId)),
    facts: facts.map((fact) => ({ ...fact, source: { ...fact.source, baselineConstructionReceiptSha256: canonicalSha256(receipt) } })).sort((left, right) => compareUnsignedUtf8(left.factSlotId, right.factSlotId)),
    relations: [],
    provenance: { schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1", producerVersion: "1.0",
      canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0", vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0" },
  };
  validateBaselineAuthorityV1({ truth, sourceManifest, receipt, sourceFiles: input.sourceFiles, chapterCommit: commit });
  return { previousAuthoritySha256: commit.commitSha256, truth, truthSha256: canonicalSha256(truth),
    vocabularyCatalogSha256: canonicalSha256(vocabulary), predecessorChapterBody: input.predecessorChapterBody,
    predecessorChapterBodySha256: commit.finalBodySha256, sourceManifest, receipt };
}
