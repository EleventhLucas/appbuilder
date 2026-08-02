const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const test = require("node:test");

test("sandboxed preload output is self-contained", async () => {
  const preload = await readFile("dist/preload/preload.js", "utf8");
  assert.doesNotMatch(preload, /require\(["']\.\.\//);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("appBuilder"/);
});
