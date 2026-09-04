import { describe, expect, it } from "vitest";
import type { BoundTruthNodeRefV1 } from "../models/structured-truth.js";
import {
  deriveBaselineEntityId,
  deriveBaselineRecordId,
  deriveChapterDeltaEntityId,
  deriveCustomVocabularyEntryId,
  deriveFactSlotId,
  deriveRelationIdentity,
  deriveSemanticMetadataSha256,
} from "../state/truth-identities.js";
import {
  BUILT_IN_TRUTH_VOCABULARY_V1,
  createVocabularyCatalogV1,
  validateVocabularyCatalogV1,
} from "../state/truth-vocabulary.js";

const EXPECTED_BUILT_INS = [
  ["lifecycle.half_life_chapters", "bfaaa4641778e2d1dc350e352de50e792f610a7919607958fe5965abc1d08f0b", "02ebde28eac100f6cffe15296fb081b1f7aa4cad6cd8b85c205565f4e4d5f65a"],
  ["ownership.owns", "c7dff6b7ebdc5948a312c5c35fd5883dbe3a70967a4b6930bc238e31ab420ade", "0429eaeae3d217321d7a059e08987ae1ddda3974f755a0f0330d131c43c9602b"],
  ["summary.chapter_number", "2b15dde362f743954fb4fd6f410963282562fcb992aab1263ad93b75b285d97c", "0c4499b465d1e88cf49c2fbbf54bb224a9933ba027420319275d6e6615baa3ee"],
  ["lifecycle.last_advanced_chapter", "546051aaf157b8b26a4813dc2951c49869672084629d1f56da1f16bb03b8e3e4", "0d7d000934e76e7c6298ce1c2d840911e0b005f9f8e5a35824a97c3482123a44"],
  ["summary.title", "9e6f03e0f2f9e586cdddbc89280fb257a3bafbf79782ea8d4526da70f6b32028", "132b09d7f314582356757d91e75e3052811d2c36565c89fe8276dc0b44e9c6c5"],
  ["emotion.state", "c7a242b87dc5a5cf5b77a94c4f5435667c7b3010a847953c324abff8b567ce1d", "14567ebd2ce6b12f0a524e49683ab29970ab3ef56ffe547ad641711a88508acc"],
  ["lifecycle.payoff_timing", "d23c7fcc1e1604d731fa8f344d0448e195507cec9ecc44ee05db35b70fa86ab5", "227630a1b63048570c0bef98d286d836a8c31fc8298c5a0d88c107219a8503e4"],
  ["summary.state_changes", "5cc7a40b2230f6f671dc84e448e6e3d27b02471bd1f63d96823f8eefc357552f", "2ef61a7abd1e61403123337c48a9af12735bfab81cda4d999124b6a3bb74f5a0"],
  ["summary.characters", "ab4ef1ab9a28c1e20138cac073fded6082052769c3b164d63f4892c9d5667925", "32dc7dba4ced63f4edf8ee742c385dc7c919ea4c46d943bc1c7e6e0c41652a51"],
  ["causality.depends-on", "7d566a45b090f5a63ac20430a1d482bbeba4e66c4772bfaa2cc503c58355bcc0", "35fc04c81bbac0612dc88d8ba6a4e7c974a40091d5134bd0c40de63e6caf6d30"],
  ["epistemic.believes", "4e49226350c84afc26a0c27c3507442f292e1736c4932c63c070f622a7e106dd", "38adcd48f574a6c1e7d987a19c2761eabefc4170abc1448c4a3a0d930e758e06"],
  ["participation.in", "ee4b88a8c1c044271866196699682b7c7fcad1e34a493cf1549ca5176a6ed39d", "3ccb4bc0d09a3ae27f45cf0a42b8a82a85f0bc442af6e9c40c399a33245bc7ff"],
  ["state.status", "daf39242bb326d9f0f7b20e298093efecadad332cbcd435536fdc9c89742c3c5", "40ecc07b48810552f9620b3654e3701675f40c8c173905190c2b713534e25650"],
  ["lifecycle.pays_off_in_arc", "e4895f257fc0237e2bf92a0aaaac3dc8dfb8c7f9c592eec2079b203abd005151", "427b7e47ff06d4f4d12646c20e166ee1bf66c2e876f852be843a189d0b4fb386"],
  ["resource.amount", "ee84dbffc35cb10a568a1af861d666f49e14b26b52c828c11ff5c57c573d2618", "42ee76b6f4a5487e2b8084fb13ebc833d28a7b5aa876484a225474155bd5cade"],
  ["relationship.related-to", "db17725f5f0a2740801ac4cf5ee3755bb639f58215bc77de07c595db779747e0", "643d96135503a12e92a359b0e6f6a9cba872bebb26c39bb4724c90bdc079625a"],
  ["lifecycle.core", "cf4df58e468a5bff14211df930c7335e2962e032a7faadcd9e6f2f01c4331b02", "6dbb7d02931009fc80a976c8d312a7f77c60433696942a7092245a41e7d40e55"],
  ["lifecycle.advanced_count", "cac9dfe08084f6b0cff4a69cda6dc3bc27b7d58ef81ad7ae50cba2bbf8afbce1", "6dc692445a9921cac7e30906dc787c3eeafb83bea07f1ac31f93fa97418c88d5"],
  ["lifecycle.type", "e27dd4ec50138eba0836e793d606fff9b9a129d2a44c74af7bfe98d94f276c35", "73356fdfe819a2df17cd1b99cd1f9435fdbe865177c231dcd276631914193db2"],
  ["lifecycle.expected_payoff", "6d67310a2de8820bb51db3a87b32f53990f0d69201f287079bb55485ab73ffb4", "7a454009ff4e43f5d33ff7d4b873045b0838207a93462dae0b5382c2ace28510"],
  ["location.at", "be86d21bf197e1cdd3af16f72a8044f01122c93f6dd799b8248f048d2a530a96", "8217a8559ac0afd81181ab288a8e9c667ef615c4b4baf0b44414a635ca6124cd"],
  ["lifecycle.started_chapter", "a948ea7ff6c79f43bbda5c73b493436d0e18de295643847589726fa6ea13bc67", "954fce904e16c4bdc9d1fba0284716d23d0d83597ef96c78af6818144396e006"],
  ["knowledge.knows", "0bc233922900b578f5d8761a8290f4f1d182475f82d5973d65a6ffa60e742003", "9d82bea4410b6d2db7a274324df729746706b192877c4010dec0fb9cc7c0e42b"],
  ["lifecycle.status", "f4370b59660f2156c1fb92c6a3eb938a61770ad6c6b12a9630cc9aef2c8df032", "a17fe2d23cb74d89aef517d06cbff36dc718f2f89be3a5ceff0b315f7d059b09"],
  ["epistemic.supports", "311764a75fc33ab5d3d5c2887f96d686fa149307f7b868b6040bdd576be4604b", "a2aa60b04f4e931853bafd29c01ecea40f3a1504496fc7ee993b2f3f73214aff"],
  ["possession.holds", "344517757ad39b38c00b620cdcfd9ae869163410b1f1b2fb01cdbebc43565bba", "c1034323555534e840c576517c908fee879f46e9c3a1fe16b448157954bd346b"],
  ["summary.mood", "ad5540b31e2a586ecf18f38df65c64256e4d2ff4e6b0341eb73eff4c86fbf108", "c3cee43dea0d32919c7b642c7f243b29cde209b4a3ada33b9dad9ed9ce0cee16"],
  ["summary.chapter_type", "569338eee00a106a99dbb9aca4949feff2350fee4014be4bcd9ffc8ed91b1dc7", "c4a7cddc3cbcf8e960db7bd4a0f20a94a7a80d841e924e799c20878570696745"],
  ["lifecycle.notes", "8524a7ca57ec15895953362e294c54119d8cb4ff361fcc0cec87c64858d205e3", "c595b7bb494f16e3d3fb0b4e10758e5d75d196b3661e04ca4646e9709322e743"],
  ["identity.name", "d7b3234e1bddd3a924d59d0c8da78e3fa5607556b6010e372179920ccb7e1ec9", "d24da5fc8ecfd50b20e1fdc777d147c569d77246f9b51d1d5109f5cbe20aeea5"],
  ["summary.hook_activity", "cdc5fa16de41360886d4c0952e96917dafedbb88d3835c5e76e30ab2edc1f69e", "f447a100c412d59a1f0fdc38f64df0719affc33ebafc7248e3d4d4b344eb07d2"],
  ["summary.events", "a718ba01702e784d6551323edae68715ef99cb5f09fd5c520e6700b753a79c5d", "fd2b9dec1ebff4b74303809e9d84fe53f5ff247b2404925698d6a3d93e42dac3"],
] as const;

describe("truth vocabulary and deterministic identities", () => {
  it("recomputes the complete immutable 32-entry built-in manifest", () => {
    expect(BUILT_IN_TRUTH_VOCABULARY_V1).toHaveLength(32);
    expect(new Set(BUILT_IN_TRUTH_VOCABULARY_V1.map((entry) => entry.entryId)).size).toBe(32);
    expect(new Set(BUILT_IN_TRUTH_VOCABULARY_V1.map((entry) => entry.semanticMetadataSha256)).size).toBe(32);
    expect(BUILT_IN_TRUTH_VOCABULARY_V1.map((entry) => [
      entry.canonicalName,
      entry.semanticMetadataSha256,
      entry.entryId,
    ])).toEqual(EXPECTED_BUILT_INS);
    expect(BUILT_IN_TRUTH_VOCABULARY_V1.some((entry) => entry.canonicalName === "lifecycle.promoted")).toBe(false);
  });

  it("derives chapter and baseline entity ids from only the frozen identity preimages", () => {
    expect(deriveChapterDeltaEntityId({
      bookId: "book-1",
      candidateSha256: "a".repeat(64),
      declarationOperationId: "op-0001",
      entityKind: "story.character",
      identityKey: "ada",
    })).toBe("13189c90e1bc2a78aacfd6e22525ba9190f00f3407c6e22e21a765b7fe8f7349");
    expect(deriveBaselineEntityId({
      bookId: "book-1",
      baselineSourceManifestSha256: "b".repeat(64),
      entityKind: "story.character",
      identityKey: "ada",
    })).toBe("3d9b79119597e9662d6747fc941eb3e3d26e1cdcfa8ca82e056e94f50ae5069d");
  });

  it("derives custom vocabulary metadata and identity without provenance or display labels", () => {
    const definition = {
      definitionType: "VOCABULARY_FACT_KEY" as const,
      metaKind: "system.vocabulary.fact-key" as const,
      canonicalName: "custom.note.blank",
      semanticDefinition: "An exact optional note, including the empty string.",
      valueContract: { contractType: "STRING" as const },
    };
    expect(deriveSemanticMetadataSha256(definition)).toBe("89999bf9e2e99c72ecd4b0eb3459db77d1dd5164838a0c84d5b920f843ba1383");
    expect(deriveCustomVocabularyEntryId({ bookId: "book-1", definition })).toBe("e823653db76957b411fb37e1e4378d16a08e436028a8e2305e15fd5bfa311ee6");
  });

  it("derives fact slots and typed directed/symmetric relation ids deterministically", () => {
    expect(deriveFactSlotId({ bookId: "book-1", subjectEntityId: "a".repeat(64), factKeyEntryId: "b".repeat(64) }))
      .toBe("417c47f5c455d8638d88de62a387f9a2382e70a091e0268e6f2e957b24aa5cc9");
    const entity: BoundTruthNodeRefV1 = { nodeKind: "ENTITY", nodeId: "f".repeat(64) };
    const fact: BoundTruthNodeRefV1 = { nodeKind: "FACT_SLOT", nodeId: "0".repeat(64) };
    const direct = deriveRelationIdentity({
      bookId: "book-1",
      relationPredicateEntryId: "c".repeat(64),
      directionality: "DIRECTED",
      subject: entity,
      object: fact,
    });
    expect(direct.relationId).toBe("50c5a2fa463bf0dce8fec5b0e9bd80af1a64d3b68bbc56a1e71d736d79b9e6f5");
    const left = deriveRelationIdentity({
      bookId: "book-1",
      relationPredicateEntryId: "d".repeat(64),
      directionality: "SYMMETRIC",
      subject: entity,
      object: fact,
    });
    const right = deriveRelationIdentity({
      bookId: "book-1",
      relationPredicateEntryId: "d".repeat(64),
      directionality: "SYMMETRIC",
      subject: fact,
      object: entity,
    });
    expect(left).toEqual(right);
    expect(left.subject).toEqual(fact);
    expect(left.object).toEqual(entity);
  });

  it("rejects duplicate/colliding custom catalog entries and preserves EntryId order", () => {
    const catalog = createVocabularyCatalogV1([]);
    expect(catalog.entries).toEqual(BUILT_IN_TRUTH_VOCABULARY_V1);
    expect(validateVocabularyCatalogV1(catalog)).toEqual(catalog);
    expect(() => validateVocabularyCatalogV1({ ...catalog, entries: [catalog.entries[0]!, catalog.entries[0]!] }))
      .toThrow(/duplicate|unique/i);
  });

  it("rejects invalid identity preimages before hashing", () => {
    expect(() => deriveChapterDeltaEntityId({ bookId: "", candidateSha256: "x", declarationOperationId: "op-0000", entityKind: "story.character", identityKey: "Ada" })).toThrow(/book|sha|operation|identity/i);
    expect(() => deriveFactSlotId({ bookId: "book-1", subjectEntityId: "x", factKeyEntryId: "b".repeat(64) })).toThrow(/sha|entity/i);
    expect(() => deriveRelationIdentity({ bookId: "book-1", relationPredicateEntryId: "c".repeat(64), directionality: "OTHER" as never, subject: { nodeKind: "ENTITY", nodeId: "a".repeat(64) }, object: { nodeKind: "ENTITY", nodeId: "b".repeat(64) } })).toThrow(/direction/i);
  });

  it("closes every identity preimage including bound nodes, custom definitions, and baseline record identity", () => {
    expect(() => deriveRelationIdentity({
      bookId: "book-1", relationPredicateEntryId: "c".repeat(64), directionality: "DIRECTED",
      subject: { nodeKind: "ENTITY", nodeId: "a".repeat(64), extra: true } as never,
      object: { nodeKind: "ENTITY", nodeId: "b".repeat(64) },
    })).toThrow(/unknown|field|node/i);
    expect(() => deriveChapterDeltaEntityId({
      bookId: "book-1", candidateSha256: "a".repeat(64), declarationOperationId: "op-0001",
      entityKind: "story.character", identityKey: "ada", extra: true,
    } as never)).toThrow(/unknown|field|preimage/i);

    const validFactDefinition = {
      definitionType: "VOCABULARY_FACT_KEY" as const,
      metaKind: "system.vocabulary.fact-key" as const,
      canonicalName: "custom.note.blank",
      semanticDefinition: "An exact note.",
      valueContract: { contractType: "ENUM" as const, allowedValues: ["open", "雪"] },
    };
    expect(() => deriveCustomVocabularyEntryId({
      bookId: "book-1",
      definition: { ...validFactDefinition, semanticDefinition: " \t" },
    })).toThrow(/semantic|NFC|empty|whitespace/i);
    expect(() => deriveCustomVocabularyEntryId({
      bookId: "book-1",
      definition: { ...validFactDefinition, valueContract: { contractType: "ENUM", allowedValues: ["open", " \t"] } },
    } as never)).toThrow(/value|NFC|empty|whitespace/i);
    expect(() => deriveCustomVocabularyEntryId({
      bookId: "book-1",
      definition: { ...validFactDefinition, extra: true },
    } as never)).toThrow(/unknown|field|definition/i);
    expect(() => deriveCustomVocabularyEntryId({
      bookId: "book-1",
      definition: {
        definitionType: "VOCABULARY_RELATION_PREDICATE",
        metaKind: "system.vocabulary.fact-key",
        canonicalName: "custom.relationship.guardian",
        semanticDefinition: "A guardian relation.",
        subjectObjectContract: { allowedSubjectKinds: ["ENTITY"], allowedObjectKinds: ["ENTITY"] },
        directionality: "DIRECTED",
      },
    } as never)).toThrow(/metaKind|definition/i);
    expect(() => deriveBaselineRecordId({
      baselineSourceManifestSha256: "a".repeat(64), recordKind: "ENTITY", recordIdentity: "Ada",
    })).toThrow(/recordIdentity|SHA-256/i);
  });

  it("treats U+000B and U+000C as content under the exact locked nonempty whitespace set", () => {
    expect(deriveCustomVocabularyEntryId({
      bookId: "book-1",
      definition: {
        definitionType: "VOCABULARY_FACT_KEY", metaKind: "system.vocabulary.fact-key",
        canonicalName: "custom.note.vertical-tab", semanticDefinition: "\u000b",
        valueContract: { contractType: "ENUM", allowedValues: ["\u000c"] },
      },
    })).toMatch(/^[0-9a-f]{64}$/);
  });
});
