import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newestFileMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    newest = Math.max(newest, newestFileMtimeMs(join(path, entry.name)));
  }
  return newest;
}

export function shouldBuildStudioFrontend(studioRoot: string): boolean {
  const distIndex = join(studioRoot, "dist", "index.html");
  if (!existsSync(distIndex)) return true;

  const sourceDir = join(studioRoot, "src");
  if (!existsSync(sourceDir)) return false;

  try {
    const newestInput = Math.max(
      newestFileMtimeMs(sourceDir),
      newestFileMtimeMs(join(studioRoot, "index.html")),
      newestFileMtimeMs(join(studioRoot, "vite.config.ts")),
      newestFileMtimeMs(join(studioRoot, "package.json")),
    );
    return newestInput > statSync(distIndex).mtimeMs;
  } catch {
    return true;
  }
}
