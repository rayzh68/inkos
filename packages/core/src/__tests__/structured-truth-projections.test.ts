import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NarrativeEntityRecordV1, StructuredTruthV1, TruthRecordSourceV1, VocabularyEntryV1 } from "../models/structured-truth.js";
import { canonicalSha256 } from "../state/canonical-json.js";
import { buildProjectionManifestV1 } from "../state/projection-manifest.js";
import { renderStructuredTruthProjectionsV1 } from "../state/structured-truth-projections.js";
import { createVocabularyCatalogV1 } from "../state/truth-vocabulary.js";
import { deriveBaselineEntityId, deriveFactSlotId, deriveRelationIdentity } from "../state/truth-identities.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const ENTITY_ID = "3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08";
const CUSTOM_ENTRY_ID = "e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6";
const CUSTOM_METADATA_SHA = "89999bf9e2e99c72ecd4b0eb3459db77d1dd5164838a0c84d5b920f843ba1383";
const STATUS_ENTRY_ID = "40ecc07b48810552f9620b3654e3701675f40c8c173905190c2b713534e25650";

function baselineTruth(throughChapter = 0): StructuredTruthV1 {
  return {
    schemaVersion: "1.0",
    kind: "STRUCTURED_TRUTH",
    bookId: "book-1",
    throughChapter,
    lineage: {
      kind: "BASELINE",
      predecessorCommitSha256: A,
      baselineSourceManifestSha256: B,
      seedVocabularyCatalogSha256: C,
      baselineMethod: "DETERMINISTIC",
      baselineConstructionReceiptSha256: D,
    },
    vocabulary: createVocabularyCatalogV1([]),
    entities: [], facts: [], relations: [],
    provenance: {
      schemaVersion: "1.0", producerKind: "BASELINE", producerId: "inkos.truth-baseline.builder.v1",
      producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
    },
  };
}

const source = (operationId: string, evidenceId: string): TruthRecordSourceV1 => ({
  sourceKind: "CHAPTER_DELTA", candidateSha256: A, deltaId: B, operationId, evidenceIds: [evidenceId],
});

function adversarialTruth(): StructuredTruthV1 {
  const customEntry: VocabularyEntryV1 = {
    entryId: CUSTOM_ENTRY_ID,
    scope: "BOOK",
    entryKind: "FACT_KEY",
    bookId: "book-1",
    vocabularySchemaVersion: "1.0",
    canonicalName: "custom.note.blank",
    semanticDefinition: "An exact optional note, including the empty string.",
    semanticMetadataSha256: CUSTOM_METADATA_SHA,
    valueContract: { contractType: "STRING" },
    definitionSource: source("op-0002", "ev-0002"),
  };
  const entity: NarrativeEntityRecordV1 = {
    entityId: ENTITY_ID,
    entityKind: "custom.test.subject",
    identityKey: "subject",
    canonicalName: "A|B`C\n雪",
    aliases: ["A", "B|C", "`D`", "雪"],
    declaredAtChapter: 1,
    declarationSource: { origin: "CHAPTER_DELTA", bookId: "book-1", candidateSha256: A, declarationOperationId: "op-0001" },
  };
  return {
    ...baselineTruth(1),
    lineage: {
      kind: "CHAPTER_DELTA", predecessorCommitSha256: A, predecessorTruthSha256: B,
      predecessorVocabularyCatalogSha256: C, candidateSha256: A, deltaId: B, acceptedDeltaArtifactSha256: D,
    },
    vocabulary: createVocabularyCatalogV1([customEntry]),
    entities: [entity],
    facts: [
      {
        factSlotId: "13b44161d5461acc04aa127c7e6f53b51ee778a1a63fb2f70492d10f792a1e5d",
        subject: { nodeKind: "ENTITY", nodeId: ENTITY_ID }, factKeyEntryId: STATUS_ENTRY_ID,
        assertion: { state: "ABSENT" }, validFromChapter: 1, lastChangedChapter: 1, source: source("op-0004", "ev-0004"),
      },
      {
        factSlotId: "29ecf77e602a6340a265ee098dd549414daa0852484f2d632f9edf41bfb52001",
        subject: { nodeKind: "ENTITY", nodeId: ENTITY_ID }, factKeyEntryId: CUSTOM_ENTRY_ID,
        assertion: { state: "VALUE", value: { valueType: "STRING", value: "" } },
        validFromChapter: 1, lastChangedChapter: 1, source: source("op-0003", "ev-0003"),
      },
    ],
    relations: [],
    provenance: {
      schemaVersion: "1.0", producerKind: "CHAPTER_DELTA", producerId: "inkos.structured-truth.reducer.v1",
      producerVersion: "1.0", canonicalizationId: "inkos.jcs-ijson.v1", truthSchemaVersion: "1.0",
      vocabularySchemaVersion: "1.0", coreVocabularyVersion: "1.0",
    },
  };
}

const EMPTY_OUTPUTS = {
  "current_state.md": "# Current State\n\nRenderer: `inkos.current-state.markdown.v1`\nThrough Chapter: `0`\n\n## Entities\n\n    []\n\n## Facts\n\n    []\n\n## Relations\n\n    []\n\n## Generic / Custom\n\n    []",
  "state/current_state.json": "{\"bookId\":\"book-1\",\"customVocabularyEntries\":[],\"entities\":[],\"facts\":[],\"kind\":\"CURRENT_STATE_PROJECTION\",\"relations\":[],\"rendererId\":\"inkos.current-state.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":0}",
  "pending_hooks.md": "# Pending Hooks\n\nRenderer: `inkos.pending-hooks.markdown.v1`\nThrough Chapter: `0`\n\n## Hooks\n\n    []",
  "state/hooks.json": "{\"bookId\":\"book-1\",\"hooks\":[],\"kind\":\"HOOKS_PROJECTION\",\"rendererId\":\"inkos.hooks.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":0}",
  "particle_ledger.md": "# Particle Ledger\n\nRenderer: `inkos.particle-ledger.markdown.v1`\nThrough Chapter: `0`\n\n## Resources\n\n    []",
  "chapter_summaries.md": "# Chapter Summaries\n\nRenderer: `inkos.chapter-summaries.markdown.v1`\nThrough Chapter: `0`\n\n## Chapters\n\n    []",
  "state/chapter_summaries.json": "{\"bookId\":\"book-1\",\"chapters\":[],\"kind\":\"CHAPTER_SUMMARIES_PROJECTION\",\"rendererId\":\"inkos.chapter-summaries.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":0}",
  "subplot_board.md": "# Subplot Board\n\nRenderer: `inkos.subplot-board.markdown.v1`\nThrough Chapter: `0`\n\n## Subplots\n\n    []",
  "emotional_arcs.md": "# Emotional Arcs\n\nRenderer: `inkos.emotional-arcs.markdown.v1`\nThrough Chapter: `0`\n\n## Arcs\n\n    []",
  "character_matrix.md": "# Character Matrix\n\nRenderer: `inkos.character-matrix.markdown.v1`\nThrough Chapter: `0`\n\n## Characters\n\n    []",
} as const;

const EXPECTED_CURRENT_JSON = "{\"bookId\":\"book-1\",\"customVocabularyEntries\":[{\"bookId\":\"book-1\",\"canonicalName\":\"custom.note.blank\",\"definitionSource\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0002\"],\"operationId\":\"op-0002\",\"sourceKind\":\"CHAPTER_DELTA\"},\"entryId\":\"e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6\",\"entryKind\":\"FACT_KEY\",\"scope\":\"BOOK\",\"semanticDefinition\":\"An exact optional note, including the empty string.\",\"semanticMetadataSha256\":\"89999bf9e2e99c72ecd4b0eb3459db77d1dd5164838a0c84d5b920f843ba1383\",\"valueContract\":{\"contractType\":\"STRING\"},\"vocabularySchemaVersion\":\"1.0\"}],\"entities\":[{\"aliases\":[\"A\",\"B|C\",\"`D`\",\"雪\"],\"canonicalName\":\"A|B`C\\n雪\",\"declarationSource\":{\"bookId\":\"book-1\",\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"declarationOperationId\":\"op-0001\",\"origin\":\"CHAPTER_DELTA\"},\"declaredAtChapter\":1,\"entityId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"entityKind\":\"custom.test.subject\",\"identityKey\":\"subject\"}],\"facts\":[{\"assertion\":{\"state\":\"ABSENT\"},\"factKeyEntryId\":\"40ecc07b48810552f9620b3654e3701675f40c8c173905190c2b713534e25650\",\"factSlotId\":\"13b44161d5461acc04aa127c7e6f53b51ee778a1a63fb2f70492d10f792a1e5d\",\"lastChangedChapter\":1,\"source\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0004\"],\"operationId\":\"op-0004\",\"sourceKind\":\"CHAPTER_DELTA\"},\"subject\":{\"nodeId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"nodeKind\":\"ENTITY\"},\"validFromChapter\":1},{\"assertion\":{\"state\":\"VALUE\",\"value\":{\"value\":\"\",\"valueType\":\"STRING\"}},\"factKeyEntryId\":\"e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6\",\"factSlotId\":\"29ecf77e602a6340a265ee098dd549414daa0852484f2d632f9edf41bfb52001\",\"lastChangedChapter\":1,\"source\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0003\"],\"operationId\":\"op-0003\",\"sourceKind\":\"CHAPTER_DELTA\"},\"subject\":{\"nodeId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"nodeKind\":\"ENTITY\"},\"validFromChapter\":1}],\"kind\":\"CURRENT_STATE_PROJECTION\",\"relations\":[],\"rendererId\":\"inkos.current-state.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":1}";

const EXPECTED_CURRENT_MD = [
  "# Current State", "", "Renderer: `inkos.current-state.markdown.v1`", "Through Chapter: `1`", "", "## Entities", "",
  "    [{\"aliases\":[\"A\",\"B|C\",\"`D`\",\"雪\"],\"canonicalName\":\"A|B`C\\n雪\",\"declarationSource\":{\"bookId\":\"book-1\",\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"declarationOperationId\":\"op-0001\",\"origin\":\"CHAPTER_DELTA\"},\"declaredAtChapter\":1,\"entityId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"entityKind\":\"custom.test.subject\",\"identityKey\":\"subject\"}]",
  "", "## Facts", "",
  "    [{\"assertion\":{\"state\":\"ABSENT\"},\"factKeyEntryId\":\"40ecc07b48810552f9620b3654e3701675f40c8c173905190c2b713534e25650\",\"factSlotId\":\"13b44161d5461acc04aa127c7e6f53b51ee778a1a63fb2f70492d10f792a1e5d\",\"lastChangedChapter\":1,\"source\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0004\"],\"operationId\":\"op-0004\",\"sourceKind\":\"CHAPTER_DELTA\"},\"subject\":{\"nodeId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"nodeKind\":\"ENTITY\"},\"validFromChapter\":1},{\"assertion\":{\"state\":\"VALUE\",\"value\":{\"value\":\"\",\"valueType\":\"STRING\"}},\"factKeyEntryId\":\"e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6\",\"factSlotId\":\"29ecf77e602a6340a265ee098dd549414daa0852484f2d632f9edf41bfb52001\",\"lastChangedChapter\":1,\"source\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0003\"],\"operationId\":\"op-0003\",\"sourceKind\":\"CHAPTER_DELTA\"},\"subject\":{\"nodeId\":\"3adf4cf7f1c968f856b90abb04c09c54d4e55d8eaa22d0b762fd6816ed8e0c08\",\"nodeKind\":\"ENTITY\"},\"validFromChapter\":1}]",
  "", "## Relations", "", "    []", "", "## Generic / Custom", "",
  "    [{\"bookId\":\"book-1\",\"canonicalName\":\"custom.note.blank\",\"definitionSource\":{\"candidateSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"deltaId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"evidenceIds\":[\"ev-0002\"],\"operationId\":\"op-0002\",\"sourceKind\":\"CHAPTER_DELTA\"},\"entryId\":\"e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6\",\"entryKind\":\"FACT_KEY\",\"scope\":\"BOOK\",\"semanticDefinition\":\"An exact optional note, including the empty string.\",\"semanticMetadataSha256\":\"89999bf9e2e99c72ecd4b0eb3459db77d1dd5164838a0c84d5b920f843ba1383\",\"valueContract\":{\"contractType\":\"STRING\"},\"vocabularySchemaVersion\":\"1.0\"}]",
].join("\n");

describe("deterministic structured-truth projections", () => {
  it("renders all ten locked empty projections as exact no-BOM/no-final-newline bytes", () => {
    const artifacts = renderStructuredTruthProjectionsV1(baselineTruth());
    expect(artifacts.map((item) => item.path)).toEqual(Object.keys(EMPTY_OUTPUTS));
    for (const artifact of artifacts) {
      const text = new TextDecoder().decode(artifact.bytes);
      expect(text, artifact.path).toBe(EMPTY_OUTPUTS[artifact.path as keyof typeof EMPTY_OUTPUTS]);
      expect(text.endsWith("\n"), artifact.path).toBe(false);
      expect([...artifact.bytes].slice(0, 3), artifact.path).not.toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it("snapshots all ten adversarial literal bytes and SHA-256 values", () => {
    const artifacts = renderStructuredTruthProjectionsV1(adversarialTruth());
    const expected = {
      "current_state.md": { bytes: EXPECTED_CURRENT_MD, sha256: "19d50302d2ff6ff141f2e9fcdae23bfc9e265230b1fa9f752b2cc00a63f96839" },
      "state/current_state.json": { bytes: EXPECTED_CURRENT_JSON, sha256: "afca035c24f5a64eeac0253692a7a62f09fd7dc4400cbcef2a5c3e2c0f817f89" },
      "pending_hooks.md": { bytes: "# Pending Hooks\n\nRenderer: `inkos.pending-hooks.markdown.v1`\nThrough Chapter: `1`\n\n## Hooks\n\n    []", sha256: "9c8128b96a3e4803e19a53db377ea4e343e409859e3b16088762d09d02a332e3" },
      "state/hooks.json": { bytes: "{\"bookId\":\"book-1\",\"hooks\":[],\"kind\":\"HOOKS_PROJECTION\",\"rendererId\":\"inkos.hooks.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":1}", sha256: "2e6c86233a91702242e9d8f9161e4c0492f24824a44d7ab616ca06a12c3f0ab7" },
      "particle_ledger.md": { bytes: "# Particle Ledger\n\nRenderer: `inkos.particle-ledger.markdown.v1`\nThrough Chapter: `1`\n\n## Resources\n\n    []", sha256: "7aef1801f31d1ac1958154312de32b7e1c250aa2030088d823805fc2130988ee" },
      "chapter_summaries.md": { bytes: "# Chapter Summaries\n\nRenderer: `inkos.chapter-summaries.markdown.v1`\nThrough Chapter: `1`\n\n## Chapters\n\n    []", sha256: "0a8b914d9295cf50883bf2dd7dd0e370ef36596577be41230040bec4a408b5b0" },
      "state/chapter_summaries.json": { bytes: "{\"bookId\":\"book-1\",\"chapters\":[],\"kind\":\"CHAPTER_SUMMARIES_PROJECTION\",\"rendererId\":\"inkos.chapter-summaries.json.v1\",\"schemaVersion\":\"1.0\",\"throughChapter\":1}", sha256: "f618045f01447b8d5aa18d3a63236c1833e8b9d264911de5bdbdbbb7292642d3" },
      "subplot_board.md": { bytes: "# Subplot Board\n\nRenderer: `inkos.subplot-board.markdown.v1`\nThrough Chapter: `1`\n\n## Subplots\n\n    []", sha256: "fe495d3e0434afe2a8720212f7cb022689c2a2f68008b2f2b3d5aa0e785ed009" },
      "emotional_arcs.md": { bytes: "# Emotional Arcs\n\nRenderer: `inkos.emotional-arcs.markdown.v1`\nThrough Chapter: `1`\n\n## Arcs\n\n    []", sha256: "de402570be1f4ac06d30ca3d22f6a38ef1eb2d49beb86b4f276f73586ae7c8c5" },
      "character_matrix.md": { bytes: "# Character Matrix\n\nRenderer: `inkos.character-matrix.markdown.v1`\nThrough Chapter: `1`\n\n## Characters\n\n    []", sha256: "b67a54a373efd031bd43250dbc8f464aa8e1e711eb3515be8a11f311470c5b24" },
    };
    expect(Object.fromEntries(artifacts.map((artifact) => {
      const bytes = new TextDecoder().decode(artifact.bytes);
      return [artifact.path, { bytes, sha256: createHash("sha256").update(artifact.bytes).digest("hex") }];
    }))).toEqual(expected);
  });

  it("routes built-ins additively, terminates custom routing, and keeps bundle closure nonrecursive", () => {
    const makeEntity = (id: string, entityKind: NarrativeEntityRecordV1["entityKind"]): NarrativeEntityRecordV1 => ({
      entityId: deriveBaselineEntityId({ bookId: "book-1", baselineSourceManifestSha256: B, entityKind, identityKey: `e${id}` }), entityKind, identityKey: `e${id}`, canonicalName: `Entity ${id}`, aliases: [],
      declaredAtChapter: 0,
      declarationSource: { origin: "BASELINE", bookId: "book-1", baselineSourceManifestSha256: B, baselineConstructionReceiptSha256: D, baselineRecordId: id.repeat(64) },
    });
    const entities = [
      makeEntity("1", "system.chapter"), makeEntity("2", "story.character"), makeEntity("3", "story.place"),
      makeEntity("4", "story.resource"), makeEntity("5", "narrative.hook"), makeEntity("6", "narrative.subplot"),
      makeEntity("7", "custom.people.character"),
    ];
    const emotionFact = {
      factSlotId: deriveFactSlotId({ bookId: "book-1", subjectEntityId: entities[2]!.entityId, factKeyEntryId: "14567ebd2ce6b12f0a524e49683ab29970ab3ef56ffe547ad641711a88508acc" }), subject: { nodeKind: "ENTITY" as const, nodeId: entities[2]!.entityId },
      factKeyEntryId: "14567ebd2ce6b12f0a524e49683ab29970ab3ef56ffe547ad641711a88508acc",
      assertion: { state: "VALUE" as const, value: { valueType: "STRING" as const, value: "calm" } },
      validFromChapter: 0, lastChangedChapter: 0,
      source: { sourceKind: "BASELINE" as const, baselineSourceManifestSha256: B, baselineConstructionReceiptSha256: D, baselineRecordId: "8".repeat(64) },
    };
    const knows = baselineTruth().vocabulary.entries.find((entry) => entry.canonicalName === "knowledge.knows")!;
    if (knows.entryKind !== "RELATION_PREDICATE") throw new Error("bad knowledge.knows fixture");
    const relationIdentity = deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: knows.entryId, directionality: knows.directionality,
      subject: { nodeKind: "ENTITY", nodeId: entities[1]!.entityId },
      object: { nodeKind: "FACT_SLOT", nodeId: emotionFact.factSlotId },
    });
    const truth: StructuredTruthV1 = {
      ...baselineTruth(),
      entities: [...entities].sort((a, b) => a.entityId.localeCompare(b.entityId)),
      facts: [emotionFact],
      relations: [{
        relationId: relationIdentity.relationId, predicateEntryId: knows.entryId, directionality: knows.directionality,
        subject: relationIdentity.subject, object: relationIdentity.object, assertion: { state: "PRESENT" },
        validFromChapter: 0, lastChangedChapter: 0,
        source: { sourceKind: "BASELINE", baselineSourceManifestSha256: B, baselineConstructionReceiptSha256: D, baselineRecordId: "9".repeat(64) },
      }],
    };
    const byPath = new Map(renderStructuredTruthProjectionsV1(truth).map((item) => [item.path, new TextDecoder().decode(item.bytes)]));
    expect(byPath.get("state/chapter_summaries.json")).toContain(`\"entityId\":\"${entities[0]!.entityId}\"`);
    expect(byPath.get("character_matrix.md")).toContain(`\"entityId\":\"${entities[1]!.entityId}\"`);
    expect(byPath.get("emotional_arcs.md")).toContain(`\"entityId\":\"${entities[2]!.entityId}\"`);
    expect(byPath.get("character_matrix.md")).toContain(`\"relationId\":\"${relationIdentity.relationId}\"`);
    expect(byPath.get("emotional_arcs.md")).toContain(`\"relationId\":\"${relationIdentity.relationId}\"`);
    expect(byPath.get("character_matrix.md")).not.toContain(`\"canonicalName\":\"Entity 3\"`);
    expect(byPath.get("emotional_arcs.md")).not.toContain(`\"canonicalName\":\"Entity 2\"`);
    expect(byPath.get("particle_ledger.md")).toContain(`\"entityId\":\"${entities[3]!.entityId}\"`);
    expect(byPath.get("pending_hooks.md")).toContain(`\"entityId\":\"${entities[4]!.entityId}\"`);
    expect(byPath.get("subplot_board.md")).toContain(`\"entityId\":\"${entities[5]!.entityId}\"`);
    for (const path of ["character_matrix.md", "emotional_arcs.md", "particle_ledger.md", "pending_hooks.md", "subplot_board.md", "chapter_summaries.md"]) {
      expect(byPath.get(path)).not.toContain(`\"entityId\":\"${entities[6]!.entityId}\"`);
    }
    expect(byPath.get("current_state.md")).toContain(`\"entityId\":\"${entities[6]!.entityId}\"`);
  });

  it("builds a deterministic path-sorted projection manifest and frozen content-tree checksum", () => {
    const truth = adversarialTruth();
    const projections = renderStructuredTruthProjectionsV1(truth);
    const manifest = buildProjectionManifestV1({ truthSha256: canonicalSha256(truth), projections });
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "chapter_summaries.md", "character_matrix.md", "current_state.md", "emotional_arcs.md", "particle_ledger.md",
      "pending_hooks.md", "state/chapter_summaries.json", "state/current_state.json", "state/hooks.json", "subplot_board.md",
    ]);
    expect(manifest.entries).toHaveLength(10);
    expect(manifest.treeSha256).toBe("d970f24c6d82fc0223f3df682e3156d51c3c97a77b00d92f3e5607fb0966ff25");
    expect(buildProjectionManifestV1({ truthSha256: canonicalSha256(truth), projections })).toEqual(manifest);
  });

  it("rejects incomplete, extra, or renderer/content-type mismatched projection sets", () => {
    const projections = renderStructuredTruthProjectionsV1(baselineTruth());
    expect(() => buildProjectionManifestV1({ truthSha256: canonicalSha256(baselineTruth()), projections: projections.slice(1) })).toThrow(/fixed|missing|10/i);
    expect(() => buildProjectionManifestV1({ truthSha256: canonicalSha256(baselineTruth()), projections: [...projections, projections[0]!] })).toThrow(/duplicate|10/i);
    expect(() => buildProjectionManifestV1({ truthSha256: canonicalSha256(baselineTruth()), projections: projections.map((item, index) => index === 0 ? { ...item, rendererId: "wrong" } : item) })).toThrow(/renderer/i);
    expect(() => buildProjectionManifestV1({ truthSha256: canonicalSha256(baselineTruth()), projections: projections.map((item, index) => index === 0 ? { ...item, contentType: "application/json" as const } : item) })).toThrow(/content/i);
  });
});
