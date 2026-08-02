const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

test("Codex preparation removes stale opposite-platform resources", async () => {
  const { replaceCodexResources } = await import("../scripts/codex-resource-layout.mjs");
  const root = await mkdtemp(join(tmpdir(), "appbuilder-codex-layout-"));
  const codexRoot = join(root, "resources", "codex");
  const source = join(root, "source");
  try {
    await mkdir(join(codexRoot, "linux-x64", "bin"), { recursive: true });
    await writeFile(join(codexRoot, "linux-x64", "bin", "codex"), "stale", "utf8");
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, "bin", "codex.exe"), "current", "utf8");

    const target = await replaceCodexResources(codexRoot, "win32-x64", source);
    assert.equal(await readFile(join(target, "bin", "codex.exe"), "utf8"), "current");
    await assert.rejects(readFile(join(codexRoot, "linux-x64", "bin", "codex"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
