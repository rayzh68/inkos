import { describe, expect, it } from "vitest";
import { BookRulesSchema, parseBookRules, tryParseBookRulesFrontmatter, projectBookRulesForCanonicalAuthority } from "../models/book-rules.js";
import { canonicalJson } from "../state/canonical-json.js";

const required = {
  version: "1.0", prohibitions: [], chapterTypesOverride: [], fatigueWordsOverride: [],
  additionalAuditDimensions: [], enableFullCastTracking: false, allowedDeviations: [],
};
const optional = ["protagonist", "genreLock", "narrativePerson", "numericalSystemOverrides", "eraConstraints", "fanficMode"] as const;

describe("BookRules canonical committed authority", () => {
  it("omits every explicitly undefined top-level optional without mutating runtime rules", () => {
    const rules = BookRulesSchema.parse({ ...required, ...Object.fromEntries(optional.map((key) => [key, undefined])) });
    expect(() => canonicalJson({ bookRules: rules })).toThrow("Unsupported canonical JSON value: undefined");
    const projected = projectBookRulesForCanonicalAuthority(rules);
    expect(projected).toStrictEqual(required);
    expect(() => canonicalJson({ bookRules: projected })).not.toThrow();
    for (const key of optional) expect(Object.hasOwn(rules, key)).toBe(true);
  });

  it.each([
    [{ numericalSystemOverrides: { hardCap: undefined, resourceTypes: [] } }, { numericalSystemOverrides: { resourceTypes: [] } }],
    [{ eraConstraints: { enabled: true, period: undefined, region: undefined } }, { eraConstraints: { enabled: true } }],
    [{ eraConstraints: { enabled: true, period: "", region: undefined } }, { eraConstraints: { enabled: true, period: "" } }],
    [{ eraConstraints: { enabled: true, period: undefined, region: "islands" } }, { eraConstraints: { enabled: true, region: "islands" } }],
  ])("omits nested undefined but preserves defined siblings: %j", (input, expected) => {
    const rules = BookRulesSchema.parse(input);
    expect(() => canonicalJson({ bookRules: rules })).toThrow("Unsupported canonical JSON value: undefined");
    const projected = projectBookRulesForCanonicalAuthority(rules);
    expect(projected).toStrictEqual({ ...required, ...expected });
    expect(() => canonicalJson(projected)).not.toThrow();
  });

  it.each([0, "", 123, "bounded"])("preserves all defined fields including false, empty strings/arrays and hardCap %j", (hardCap) => {
    const input = {
      version: "", protagonist: { name: "Ada\n阿达", personalityLock: ["precise"], behavioralConstraints: [] },
      genreLock: { primary: "", forbidden: ["magic"] }, narrativePerson: "first" as const,
      numericalSystemOverrides: { hardCap, resourceTypes: [] }, eraConstraints: { enabled: false, period: "", region: "North" },
      prohibitions: ["No erased debts"], chapterTypesOverride: ["bridge"], fatigueWordsOverride: ["suddenly"],
      additionalAuditDimensions: [0, ""], enableFullCastTracking: false, fanficMode: "au" as const, allowedDeviations: [],
    };
    const projected = projectBookRulesForCanonicalAuthority(BookRulesSchema.parse(input));
    expect(projected).toStrictEqual(input);
    expect(canonicalJson(projected)).toBe(canonicalJson(input));
  });

  it.each(["canon", "au", "ooc", "cp"])("preserves fanfic mode %s and third person", (fanficMode) => {
    expect(projectBookRulesForCanonicalAuthority(BookRulesSchema.parse({ narrativePerson: "third", fanficMode })))
      .toStrictEqual({ ...required, narrativePerson: "third", fanficMode });
  });

  it("preserves each independently present optional across all 64 top-level combinations", () => {
    const values = {
      protagonist: { name: "", personalityLock: [], behavioralConstraints: [] },
      genreLock: { primary: "history", forbidden: [] }, narrativePerson: "third",
      numericalSystemOverrides: { resourceTypes: [] }, eraConstraints: { enabled: true }, fanficMode: "canon",
    };
    for (let mask = 0; mask < 64; mask += 1) {
      const selected = optional.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const input = { ...required, enableFullCastTracking: true, ...Object.fromEntries(optional.map((key) => [key, selected.includes(key) ? values[key] : undefined])) };
      const expected = { ...required, enableFullCastTracking: true, ...Object.fromEntries(selected.map((key) => [key, values[key]])) };
      const result = projectBookRulesForCanonicalAuthority(BookRulesSchema.parse(input));
      expect(result).toStrictEqual(expected);
      expect(canonicalJson(result)).toBe(canonicalJson(expected));
    }
  });

  it.each([
    ["markdown", "# Book Rules\n## Era Constraints\n- Period: 1920\n"],
    ["frontmatter", "---\nnarrativePerson: unspecified\neraConstraints:\n  enabled: true\n  region: North\n---\nRules body"],
    ["default markdown", "# Book Rules\n"],
    ["frontmatter defaults", "---\nversion: '1.0'\n---\n"],
  ])("canonicalizes %s rules for unrelated book/chapter authorities", (_source, raw) => {
    const parsed = parseBookRules(raw)!;
    expect(parsed).not.toBeNull();
    const projection = projectBookRulesForCanonicalAuthority(parsed.rules);
    for (const [bookId, chapterNumber] of [["island-archive", 11], ["星河", 27]] as const) {
      const authority = { kind: "CANONICAL_TRUTH_COMMITTED_AUTHORITY", bookId, chapterNumber, bookRules: projection };
      expect(JSON.parse(canonicalJson(authority))).toStrictEqual(authority);
    }
    if (_source === "frontmatter") {
      expect(projectBookRulesForCanonicalAuthority(tryParseBookRulesFrontmatter(raw)!.rules)).toStrictEqual(projection);
      expect(projection).not.toHaveProperty("narrativePerson");
    }
  });

  it("keeps canonical JSON strict for unrelated undefined authority", () => {
    expect(() => canonicalJson({ bad: undefined })).toThrow("Unsupported canonical JSON value: undefined");
  });
});
