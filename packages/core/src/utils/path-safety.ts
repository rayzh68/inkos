import { isAbsolute, relative, resolve, parse, sep, join } from "node:path";
import { lstat, realpath, readdir } from "node:fs/promises";

export function safeChildPath(root: string, requestedPath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, requestedPath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedPath;
  }
  throw new Error(`Path traversal blocked: ${requestedPath}`);
}

/** Validate every existing component, including the trusted root's ancestors. */
export async function safeMutationPath(root: string, requestedPath: string, recursive = false): Promise<string> {
  if (isAbsolute(requestedPath) || requestedPath.split(/[\\/]/u).some((part) => !part || part === "." || part === ".."
    || /[:\u0000-\u001f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`UNSAFE_PATH_COMPONENT: ${requestedPath}`);
  }
  const target = safeChildPath(root, requestedPath);
  const volume = parse(target).root;
  let current = volume;
  const segments = relative(volume, target).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())
        || (index < segments.length - 1 && !info.isDirectory())) {
        throw new Error(`UNSAFE_PATH_COMPONENT: ${current}`);
      }
      // Junctions and other redirections must not silently resolve elsewhere.
      const actual = await realpath(current);
      const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      if (normalized(resolve(actual)) !== normalized(resolve(current))) {
        throw new Error(`UNSAFE_PATH_COMPONENT: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  if (recursive) {
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isDirectory()) {
      for (const name of await readdir(target)) await safeMutationPath(target, name, true);
    }
  }
  return target;
}
