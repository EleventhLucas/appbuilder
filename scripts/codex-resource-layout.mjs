import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function replaceCodexResources(codexRoot, platformKey, source) {
  await rm(codexRoot, { recursive: true, force: true });
  const target = join(codexRoot, platformKey);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  return target;
}
