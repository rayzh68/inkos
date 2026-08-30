import { startStudioServer } from "./server.js";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshStudioFrontend, shouldBuildStudioFrontend } from "./studio-frontend-assets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const root = resolve(process.argv[2] ?? process.env.INKOS_PROJECT_ROOT ?? process.cwd());
const port = parseInt(process.env.INKOS_STUDIO_PORT ?? "4567", 10);

// Find studio package root (2 levels up from src/api/)
const studioRoot = resolve(__dirname, "../..");
const distDir = join(studioRoot, "dist");

// Source startup rebuilds only when the client inputs are newer. Packaged
// runtime preserves the existing bundle and the missing-dist fallback.
if (shouldBuildStudioFrontend(studioRoot)) {
  console.log("Building frontend...");
  try {
    refreshStudioFrontend(studioRoot);
  } catch {
    console.error("Failed to build frontend. Run 'cd packages/studio && pnpm build' manually.");
    process.exit(1);
  }
}

startStudioServer(root, port, { staticDir: distDir }).catch((e) => {
  console.error("Failed to start studio:", e);
  process.exit(1);
});
