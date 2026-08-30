import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { refreshStudioFrontend, shouldBuildStudioFrontend } from "./studio-frontend-assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function studioFixture(input: { readonly sourceMtime: number; readonly distMtime?: number }) {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-assets-"));
  roots.push(root);
  const sourceApiDir = join(root, "src", "api");
  const packagedApiDir = join(root, "dist", "api");
  const sourceFile = join(root, "src", "components", "Panel.tsx");
  const distIndex = join(root, "dist", "index.html");
  await mkdir(join(root, "src", "components"), { recursive: true });
  await mkdir(sourceApiDir, { recursive: true });
  await mkdir(packagedApiDir, { recursive: true });
  await writeFile(sourceFile, "export {};\n", "utf8");
  await utimes(sourceFile, input.sourceMtime, input.sourceMtime);
  if (input.distMtime !== undefined) {
    await writeFile(distIndex, "<!doctype html>\n", "utf8");
    await utimes(distIndex, input.distMtime, input.distMtime);
  }
  return { root, sourceApiDir, packagedApiDir };
}

describe("Studio frontend startup freshness", () => {
  it("restores the compiled server entry after stale client cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-studio-build-"));
    roots.push(root);
    const studioPackage = JSON.parse(await readFile(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    )) as { readonly scripts: { readonly build: string } };
    await mkdir(join(root, "dist", "api"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "dist", "api", "index.js"), "old server\n", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        build: studioPackage.scripts.build,
        "build:client": "node scripts/build-client.mjs",
        "build:server": "node scripts/build-server.mjs",
      },
    }), "utf8");
    await writeFile(join(root, "scripts", "build-client.mjs"), [
      'import { mkdir, rm, writeFile } from "node:fs/promises";',
      'await rm("dist", { recursive: true, force: true });',
      'await mkdir("dist", { recursive: true });',
      'await writeFile("dist/index.html", "fresh client\\n");',
    ].join("\n"), "utf8");
    await writeFile(join(root, "scripts", "build-server.mjs"), [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'await mkdir("dist/api", { recursive: true });',
      'await writeFile("dist/api/index.js", "fresh server\\n");',
    ].join("\n"), "utf8");

    refreshStudioFrontend(root);

    await expect(access(join(root, "dist", "index.html"))).resolves.toBeUndefined();
    await expect(access(join(root, "dist", "api", "index.js"))).resolves.toBeUndefined();
    await expect(readFile(join(root, "dist", "api", "index.js"), "utf8"))
      .resolves.toBe("fresh server\n");
  });

  it("rebuilds a stale dist once when Studio runs from source", async () => {
    const fixture = await studioFixture({ sourceMtime: 200, distMtime: 100 });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(true);
  });

  it("does not rebuild a fresh dist when Studio runs from source", async () => {
    const fixture = await studioFixture({ sourceMtime: 100, distMtime: 200 });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(false);
  });

  it("rebuilds stale dist when a source checkout starts its compiled server", async () => {
    const fixture = await studioFixture({ sourceMtime: 200, distMtime: 100 });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(true);
  });

  it("preserves packaged runtime behavior when dist already exists", async () => {
    const fixture = await studioFixture({ sourceMtime: 200, distMtime: 100 });
    await rm(join(fixture.root, "src"), { recursive: true, force: true });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(false);
  });

  it("preserves the existing missing-dist build fallback", async () => {
    const fixture = await studioFixture({ sourceMtime: 100 });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(true);
    await rm(join(fixture.root, "src"), { recursive: true, force: true });
    expect(shouldBuildStudioFrontend(fixture.root)).toBe(true);
  });
});
