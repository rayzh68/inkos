import { assertCanonicalRelativePath, canonicalSha256, compareUnsignedUtf8, deepFreeze, sha256Bytes } from "./canonical-json.js";
import type { ProjectionArtifactV1 } from "./structured-truth-projections.js";

export interface ProjectionManifestEntryV1 {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ProjectionManifestV1 {
  readonly schemaVersion: "1.0";
  readonly kind: "PROJECTION_MANIFEST";
  readonly truthSha256: string;
  readonly rendererSetVersion: "1.0";
  readonly rendererId: "inkos.truth-projection-set.v1";
  readonly entries: readonly ProjectionManifestEntryV1[];
  readonly treeSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const PROJECTION_CONTRACT = new Map<string, readonly [string, ProjectionArtifactV1["contentType"]]>([
  ["current_state.md", ["inkos.current-state.markdown.v1", "text/markdown; charset=utf-8"]],
  ["state/current_state.json", ["inkos.current-state.json.v1", "application/json"]],
  ["pending_hooks.md", ["inkos.pending-hooks.markdown.v1", "text/markdown; charset=utf-8"]],
  ["state/hooks.json", ["inkos.hooks.json.v1", "application/json"]],
  ["particle_ledger.md", ["inkos.particle-ledger.markdown.v1", "text/markdown; charset=utf-8"]],
  ["chapter_summaries.md", ["inkos.chapter-summaries.markdown.v1", "text/markdown; charset=utf-8"]],
  ["state/chapter_summaries.json", ["inkos.chapter-summaries.json.v1", "application/json"]],
  ["subplot_board.md", ["inkos.subplot-board.markdown.v1", "text/markdown; charset=utf-8"]],
  ["emotional_arcs.md", ["inkos.emotional-arcs.markdown.v1", "text/markdown; charset=utf-8"]],
  ["character_matrix.md", ["inkos.character-matrix.markdown.v1", "text/markdown; charset=utf-8"]],
]);

export function buildProjectionManifestV1(input: {
  readonly truthSha256: string;
  readonly projections: readonly ProjectionArtifactV1[];
}): ProjectionManifestV1 {
  if (!SHA256.test(input.truthSha256)) throw new Error("truthSha256 must be a lower-case SHA-256");
  if (input.projections.length !== PROJECTION_CONTRACT.size) throw new Error("Projection set must contain exactly the fixed 10 paths");
  const paths = new Set<string>();
  const entries = input.projections.map((projection) => {
    const path = assertCanonicalRelativePath(projection.path);
    if (paths.has(path)) throw new Error(`Duplicate projection path: ${path}`);
    paths.add(path);
    const contract = PROJECTION_CONTRACT.get(path);
    if (!contract) throw new Error(`Extra projection path: ${path}`);
    if (projection.rendererId !== contract[0]) throw new Error(`Projection renderer mismatch for ${path}`);
    if (projection.contentType !== contract[1]) throw new Error(`Projection content type mismatch for ${path}`);
    return { path, sha256: sha256Bytes(projection.bytes), byteLength: projection.bytes.byteLength };
  }).sort((a, b) => compareUnsignedUtf8(a.path, b.path));
  for (const path of PROJECTION_CONTRACT.keys()) if (!paths.has(path)) throw new Error(`Missing fixed projection path: ${path}`);
  const rendererId = "inkos.truth-projection-set.v1" as const;
  const treeSha256 = canonicalSha256({ schemaVersion: "1.0", rendererId, entries });
  return deepFreeze({
    schemaVersion: "1.0",
    kind: "PROJECTION_MANIFEST",
    truthSha256: input.truthSha256,
    rendererSetVersion: "1.0",
    rendererId,
    entries,
    treeSha256,
  });
}
