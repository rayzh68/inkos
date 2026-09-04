import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testDirectory, "..");
const packageAModules = new Set([
  "models/chapter-delta.ts",
  "models/structured-truth.ts",
  "state/canonical-json.ts",
  "state/truth-identities.ts",
  "state/truth-vocabulary.ts",
  "state/chapter-delta-admission.ts",
  "state/structured-truth-reducer.ts",
  "state/structured-truth-projections.ts",
  "state/projection-manifest.ts",
]);

function TypeScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : TypeScriptFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("Package A dormant boundary", () => {
  it("adds exactly the nine locked production modules without exporting them from the package index", () => {
    for (const modulePath of packageAModules) {
      expect(statSync(join(sourceRoot, modulePath)).isFile(), modulePath).toBe(true);
    }
    const index = readFileSync(join(sourceRoot, "index.ts"), "utf8");
    for (const modulePath of packageAModules) {
      expect(index, modulePath).not.toContain(modulePath.replace(/\.ts$/, ".js"));
    }
  });

  it("proves no pre-Package-B production source consumes the dormant core", () => {
    const importNeedles = [
      "models/chapter-delta", "models/structured-truth", "state/canonical-json", "state/truth-identities",
      "state/truth-vocabulary", "state/chapter-delta-admission", "state/structured-truth-reducer",
      "state/structured-truth-projections", "state/projection-manifest",
    ];
    const consumers = TypeScriptFiles(sourceRoot)
      .filter((path) => !packageAModules.has(relative(sourceRoot, path).replace(/\\/g, "/")))
      .filter((path) => importNeedles.some((needle) => readFileSync(path, "utf8").includes(needle)))
      .map((path) => relative(sourceRoot, path).replace(/\\/g, "/"));
    expect(consumers).toEqual([]);
  });
});
