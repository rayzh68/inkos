import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256, compareUnsignedUtf8 } from "../state/canonical-json.js";
import { deriveChapterDeltaEntityId, deriveFactSlotId } from "../state/truth-identities.js";
import { createVocabularyCatalogV1, validateVocabularyCatalogV1 } from "../state/truth-vocabulary.js";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

describe("seeded canonical-truth properties", () => {
  it("keeps canonical bytes and hashes invariant under 256 seeded member permutations", () => {
    const random = seeded(0x1a2b3c4d);
    const entries: Array<[string, unknown]> = [["z", 1], ["a", "雪"], ["nested", { b: 2, a: 1 }], ["empty", ""]];
    const expected = "{\"a\":\"雪\",\"empty\":\"\",\"nested\":{\"a\":1,\"b\":2},\"z\":1}";
    for (let iteration = 0; iteration < 256; iteration += 1) {
      const shuffled = [...entries].sort(() => (random() & 1) === 0 ? -1 : 1);
      const value = Object.fromEntries(shuffled);
      expect(canonicalJson(value), `seed=0x1a2b3c4d iteration=${iteration}`).toBe(expected);
      expect(canonicalSha256(value), `seed=0x1a2b3c4d iteration=${iteration}`).toBe("6b861b23af74b0fffa9ae53d4d3b385070cf9fa3db7ade98ccf17ec1d6ce0a90");
    }
  });

  it("keeps entity and fact identities deterministic and collision-free across a seeded matrix", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 128; index += 1) {
      const entityId = deriveChapterDeltaEntityId({
        bookId: "book-1", candidateSha256: canonicalSha256({ index }),
        declarationOperationId: `op-${String(index + 1).padStart(4, "0")}`,
        entityKind: index % 2 === 0 ? "story.object" : "custom.test.object",
        identityKey: `e${index}`,
      });
      const factSlotId = deriveFactSlotId({
        bookId: "book-1", subjectEntityId: entityId,
        factKeyEntryId: createVocabularyCatalogV1([]).entries[index % 32]!.entryId,
      });
      expect(deriveFactSlotId({
        bookId: "book-1", subjectEntityId: entityId,
        factKeyEntryId: createVocabularyCatalogV1([]).entries[index % 32]!.entryId,
      })).toBe(factSlotId);
      ids.add(entityId);
      ids.add(factSlotId);
    }
    expect(ids.size).toBe(256);
  });

  it("keeps the complete catalog byte-sorted and immutable across repeated construction", () => {
    const first = createVocabularyCatalogV1([]);
    const second = createVocabularyCatalogV1([]);
    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.entryId)).toEqual([...first.entries.map((entry) => entry.entryId)].sort(compareUnsignedUtf8));
    expect(validateVocabularyCatalogV1(first)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
  });
});
