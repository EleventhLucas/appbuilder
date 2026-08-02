const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const { DiagnosticsLogger } = require("../dist/main/diagnostics/DiagnosticsLogger.js");
const { errorDto } = require("../dist/main/errors/AppBuilderError.js");

const sentinels = {
  prompt: "SENTINEL_PROMPT_DO_NOT_STORE",
  secret: ["sk", "sensitive", "value"].join("-"),
  email: ["person", "private.invalid"].join("@"),
  url: ["https:", "", "private.invalid", "login?token=secret"].join("/"),
  path: ["C:", "Users", "person", "private-project"].join("\\"),
  stack: "Error: private failure\n    at private-file.js:42:1",
  rpc: "{\"prompt\":\"private rpc payload\"}",
};

function contextWithExtraFields() {
  return {
    application: {
      name: "AppBuilder",
      version: "1.2.3",
      electron: "43",
      chrome: "140",
      node: "22",
      platform: "win32",
      architecture: "x64",
      rawStack: sentinels.stack,
    },
    runtime: {
      lifecycleState: "ready",
      connectionState: "connected",
      authenticated: true,
      source: "bundled",
      version: "1.2.3",
      bundledVersion: "1.2.3",
      updateState: "disabled",
      capabilities: { models: true, mcp: false },
      executablePath: sentinels.path,
      serverMessage: sentinels.rpc,
    },
    state: {
      schemaVersion: 3,
      projectCount: 2,
      archivedProjectCount: 1,
      conversationCount: 4,
      recoveryBackupCount: 3,
      prompt: sentinels.prompt,
    },
    arbitrary: sentinels.secret,
  };
}

test("diagnostics delete legacy logs once and export only allowlisted data", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-diagnostics-"));
  const logs = join(root, "logs");
  const bundle = join(root, "support.zip");
  try {
    await writeFile(join(root, "placeholder"), "ready");
    await require("node:fs/promises").mkdir(logs);
    await writeFile(join(logs, "appbuilder-1.log"), Object.values(sentinels).join("\n"), "utf8");

    const logger = new DiagnosticsLogger(logs);
    await logger.initialize();
    assert.equal((await readFile(join(logs, "privacy-format"), "utf8")).trim(), "2");
    await assert.rejects(readFile(join(logs, "appbuilder-1.log"), "utf8"), { code: "ENOENT" });

    logger.error({
      subsystem: "codex",
      operation: "initialize",
      code: "CODEX_START_FAILED",
      retryable: true,
      message: sentinels.prompt,
      details: sentinels.secret,
      stack: sentinels.stack,
    });
    await logger.exportBundle(bundle, contextWithExtraFields());

    const zip = new AdmZip(bundle);
    const combined = zip.getEntries().map((entry) => entry.getData().toString("utf8")).join("\n");
    for (const sentinel of Object.values(sentinels)) assert.doesNotMatch(combined, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(combined, /CODEX_START_FAILED/);
    assert.match(combined, /"projectCount": 2/);
    assert.doesNotMatch(combined, /rawStack|executablePath|serverMessage|arbitrary/);

    await writeFile(join(logs, "appbuilder-2.log"), "safe preserved log\r\n", "utf8");
    await logger.initialize();
    assert.equal(await readFile(join(logs, "appbuilder-2.log"), "utf8"), "safe preserved log\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexpected and RPC renderer errors never expose raw error data", () => {
  const unexpected = errorDto(Object.assign(new Error(sentinels.stack), { secret: sentinels.secret }));
  assert.equal(unexpected.message, "The operation could not be completed.");
  assert.equal(unexpected.details, null);

  class CodexRpcError extends Error {
    constructor() {
      super(sentinels.prompt);
      this.code = -32001;
      this.data = { payload: sentinels.rpc, url: sentinels.url };
    }
  }
  const rpc = errorDto(new CodexRpcError());
  assert.equal(rpc.message, "Codex rejected the operation.");
  assert.equal(rpc.retryable, true);
  const serialized = JSON.stringify(rpc);
  for (const sentinel of Object.values(sentinels)) assert.doesNotMatch(serialized, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("diagnostic logs rotate at the one-megabyte boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-diagnostics-rotation-"));
  const bundle = join(root, "support.zip");
  try {
    const logger = new DiagnosticsLogger(root);
    await logger.initialize();
    await writeFile(join(root, "appbuilder-1.log"), Buffer.alloc(1024 * 1024, "x"));
    logger.info({ subsystem: "runtime", operation: "resolve", code: "RUNTIME_READY", retryable: false });
    await logger.exportBundle(bundle, contextWithExtraFields());

    assert.equal((await readFile(join(root, "appbuilder-2.log"))).length, 1024 * 1024);
    assert.match(await readFile(join(root, "appbuilder-1.log"), "utf8"), /RUNTIME_READY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
