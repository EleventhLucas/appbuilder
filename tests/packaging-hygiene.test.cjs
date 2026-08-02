const assert = require("node:assert/strict");
const { access, readFile } = require("node:fs/promises");
const test = require("node:test");

test("packaging excludes source maps and managed-update signing placeholders", async () => {
  const builder = await readFile("electron-builder.yml", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.match(builder, /"!dist\/\*\*\/\*\.map"/);
  assert.doesNotMatch(builder, /resources\/updates/);
  assert.equal(packageJson.dependencies.tar, undefined);

  for (const path of [
    "resources/updates/codex-public-key.pem",
    "scripts/provision-update-key.mjs",
    "scripts/sign-codex-manifest.mjs",
  ]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});
