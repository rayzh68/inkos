import type {
  FactAssertionRecordV1,
  NarrativeEntityRecordV1,
  RelationAssertionRecordV1,
  StructuredTruthV1,
  VocabularyEntryV1,
} from "../models/structured-truth.js";
import { validateStructuredTruthV1 } from "../models/structured-truth.js";
import { canonicalJson, canonicalJsonBytes, deepFreeze } from "./canonical-json.js";
import { validateVocabularyCatalogV1 } from "./truth-vocabulary.js";

export interface ProjectionArtifactV1 {
  readonly path: string;
  readonly rendererId: string;
  readonly contentType: "text/markdown; charset=utf-8" | "application/json";
  readonly bytes: Uint8Array;
}

export interface ProjectionEntityBundleV1 {
  readonly entity: NarrativeEntityRecordV1;
  readonly facts: readonly FactAssertionRecordV1[];
  readonly outgoingRelations: readonly RelationAssertionRecordV1[];
  readonly incomingRelations: readonly RelationAssertionRecordV1[];
}

const UTF8 = new TextEncoder();
const EMOTION_STATE_ENTRY_ID = "14567ebd2ce6b12f0a524e49683ab29970ab3ef56ffe547ad641711a88508acc";

function markdown(title: string, rendererId: string, throughChapter: number, sections: readonly (readonly [string, unknown])[]): Uint8Array {
  const lines = [`# ${title}`, "", `Renderer: \`${rendererId}\``, `Through Chapter: \`${throughChapter}\``];
  for (const [heading, payload] of sections) lines.push("", `## ${heading}`, "", `    ${canonicalJson(payload)}`);
  return UTF8.encode(lines.join("\n"));
}

function bundle(truth: StructuredTruthV1, entity: NarrativeEntityRecordV1): ProjectionEntityBundleV1 {
  const facts = truth.facts.filter((fact) => fact.subject.nodeId === entity.entityId);
  const localNodes = new Set([`ENTITY:${entity.entityId}`, ...facts.map((fact) => `FACT_SLOT:${fact.factSlotId}`)]);
  return {
    entity,
    facts,
    outgoingRelations: truth.relations.filter((relation) => localNodes.has(`${relation.subject.nodeKind}:${relation.subject.nodeId}`)),
    incomingRelations: truth.relations.filter((relation) => localNodes.has(`${relation.object.nodeKind}:${relation.object.nodeId}`)),
  };
}

function customEntries(truth: StructuredTruthV1): VocabularyEntryV1[] {
  return truth.vocabulary.entries.filter((entry) => entry.scope === "BOOK");
}

function artifact(
  path: string,
  rendererId: string,
  contentType: ProjectionArtifactV1["contentType"],
  bytes: Uint8Array,
): ProjectionArtifactV1 {
  return deepFreeze({ path, rendererId, contentType, bytes });
}

export function renderStructuredTruthProjectionsV1(input: StructuredTruthV1): readonly ProjectionArtifactV1[] {
  const truth = validateStructuredTruthV1(input);
  validateVocabularyCatalogV1(truth.vocabulary);
  const bundles = new Map(truth.entities.map((entity) => [entity.entityId, bundle(truth, entity)]));
  const byKind = (kind: NarrativeEntityRecordV1["entityKind"]): ProjectionEntityBundleV1[] => truth.entities
    .filter((entity) => entity.entityKind === kind)
    .map((entity) => bundles.get(entity.entityId)!);
  const hooks = byKind("narrative.hook");
  const chapters = byKind("system.chapter");
  const resources = byKind("story.resource");
  const subplots = byKind("narrative.subplot");
  const characters = byKind("story.character");
  const emotionalEntityIds = new Set(truth.facts
    .filter((fact) => fact.factKeyEntryId === EMOTION_STATE_ENTRY_ID)
    .map((fact) => fact.subject.nodeId));
  const arcs = truth.entities
    .filter((entity) => !entity.entityKind.startsWith("custom.") && emotionalEntityIds.has(entity.entityId))
    .map((entity) => bundles.get(entity.entityId)!);
  const customVocabularyEntries = customEntries(truth);

  const currentState = {
    schemaVersion: "1.0",
    kind: "CURRENT_STATE_PROJECTION",
    rendererId: "inkos.current-state.json.v1",
    bookId: truth.bookId,
    throughChapter: truth.throughChapter,
    entities: truth.entities,
    facts: truth.facts,
    relations: truth.relations,
    customVocabularyEntries,
  };
  const hooksJson = {
    schemaVersion: "1.0", kind: "HOOKS_PROJECTION", rendererId: "inkos.hooks.json.v1",
    bookId: truth.bookId, throughChapter: truth.throughChapter, hooks,
  };
  const chaptersJson = {
    schemaVersion: "1.0", kind: "CHAPTER_SUMMARIES_PROJECTION", rendererId: "inkos.chapter-summaries.json.v1",
    bookId: truth.bookId, throughChapter: truth.throughChapter, chapters,
  };

  return deepFreeze([
    artifact("current_state.md", "inkos.current-state.markdown.v1", "text/markdown; charset=utf-8", markdown("Current State", "inkos.current-state.markdown.v1", truth.throughChapter, [
      ["Entities", truth.entities], ["Facts", truth.facts], ["Relations", truth.relations], ["Generic / Custom", customVocabularyEntries],
    ])),
    artifact("state/current_state.json", "inkos.current-state.json.v1", "application/json", canonicalJsonBytes(currentState)),
    artifact("pending_hooks.md", "inkos.pending-hooks.markdown.v1", "text/markdown; charset=utf-8", markdown("Pending Hooks", "inkos.pending-hooks.markdown.v1", truth.throughChapter, [["Hooks", hooks]])),
    artifact("state/hooks.json", "inkos.hooks.json.v1", "application/json", canonicalJsonBytes(hooksJson)),
    artifact("particle_ledger.md", "inkos.particle-ledger.markdown.v1", "text/markdown; charset=utf-8", markdown("Particle Ledger", "inkos.particle-ledger.markdown.v1", truth.throughChapter, [["Resources", resources]])),
    artifact("chapter_summaries.md", "inkos.chapter-summaries.markdown.v1", "text/markdown; charset=utf-8", markdown("Chapter Summaries", "inkos.chapter-summaries.markdown.v1", truth.throughChapter, [["Chapters", chapters]])),
    artifact("state/chapter_summaries.json", "inkos.chapter-summaries.json.v1", "application/json", canonicalJsonBytes(chaptersJson)),
    artifact("subplot_board.md", "inkos.subplot-board.markdown.v1", "text/markdown; charset=utf-8", markdown("Subplot Board", "inkos.subplot-board.markdown.v1", truth.throughChapter, [["Subplots", subplots]])),
    artifact("emotional_arcs.md", "inkos.emotional-arcs.markdown.v1", "text/markdown; charset=utf-8", markdown("Emotional Arcs", "inkos.emotional-arcs.markdown.v1", truth.throughChapter, [["Arcs", arcs]])),
    artifact("character_matrix.md", "inkos.character-matrix.markdown.v1", "text/markdown; charset=utf-8", markdown("Character Matrix", "inkos.character-matrix.markdown.v1", truth.throughChapter, [["Characters", characters]])),
  ]);
}
