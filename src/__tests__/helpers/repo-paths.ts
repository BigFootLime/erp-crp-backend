import path from "node:path";

export const repoRoot = path.resolve(__dirname, "../../..");

export function repoPath(...segments: string[]) {
  return path.join(repoRoot, ...segments);
}
