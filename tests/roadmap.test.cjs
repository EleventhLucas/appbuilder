const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { ProjectStore } = require("../dist/main/projects/ProjectStore.js");
const { CodexRuntimeManager } = require("../dist/main/codex/CodexRuntimeManager.js");
const { conversationToMarkdown } = require("../dist/main/conversation/ConversationExporter.js");

test("ProjectStore preserves invalid state and restores one of five validated backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-recovery-"));
  const projectPath = join(root, "project");
  const statePath = join(root, "state.json");
  await mkdir(projectPath);
  try {
    const store = new ProjectStore(statePath);
    await store.initialize();
    const project = await store.add({ name: "Recovery", path: projectPath });
    await store.updatePermissionMode(project.id, "workspace");
    await writeFile(statePath, "{ definitely invalid", "utf8");

    const recovering = new ProjectStore(statePath);
    const result = await recovering.initialize();
    assert.equal(result.state, "recovery");
    assert.equal(await readFile(statePath, "utf8"), "{ definitely invalid");
    assert.ok(result.recovery.preservedStatePath);
    assert.ok(result.recovery.backups.length >= 1);

    const restored = await recovering.restoreBackup(result.recovery.backups[0].id);
    assert.equal(restored.state, "ready");
    assert.equal(restored.value.version, 3);
    assert.equal(restored.value.projects[0].name, "Recovery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run-profile inspection detects root metadata and saves configuration atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-detector-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "package.json"), JSON.stringify({
    scripts: { dev: "vite", test: "vitest" },
  }));
  await writeFile(join(projectPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  try {
    const store = new ProjectStore(join(root, "state.json"));
    await store.initialize();
    const project = await store.add({ name: "Detected", path: projectPath });
    const inspection = await store.inspectConfiguration(project.id);
    assert.equal(inspection.state, "missing");
    assert.equal(inspection.suggestions.find((profile) => profile.id === "node-dev").command, "pnpm");

    const saved = await store.saveConfiguration(project.id, {
      version: 1,
      selectedRunProfileId: "node-dev",
      runProfiles: inspection.suggestions.map(({ detector, description, recommended, ...profile }) => profile),
    });
    assert.equal(saved.selectedRunProfileId, "node-dev");
    const bytes = await readFile(join(projectPath, ".appbuilder", "config.json"), "utf8");
    assert.match(bytes, /\r\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexRuntimeManager validates a custom executable without a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-runtime-"));
  let selected = null;
  let settings = {
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultMode: "work",
    sidebarCollapsed: false,
    showModeControl: false,
    showPermissionControl: false,
    showMcpStatus: false,
    codexRuntime: { preference: "auto", customExecutablePath: null, managedVersion: null },
  };
  try {
    const manager = new CodexRuntimeManager({
      server: {
        setExecutablePath(value) { selected = value; },
      },
      resourcesPath: join(root, "resources"),
      userDataPath: join(root, "user"),
      homePath: root,
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      getSettings: () => settings,
      saveSettings: async (value) => { settings = value; },
      onChange: () => undefined,
    });
    const info = await manager.useCustom(process.execPath);
    assert.equal(info.state, "starting");
    assert.equal(info.source, "custom");
    assert.equal(selected, process.execPath);
    assert.equal(settings.codexRuntime.preference, "custom");
    assert.equal(info.update.state, "disabled");
    assert.match(info.update.message, /signed release manifests/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation Markdown export includes visible content and excludes local locations", () => {
  const markdown = conversationToMarkdown({
    projectName: "Example",
    conversationName: "Build it",
    items: [
      { type: "message", id: "u", role: "user", text: "Please build it", attachments: [{ id: "a", name: "design.png", kind: "image", size: 4 }] },
      { type: "plan", id: "p", turnId: "t", text: "Implementation notes", explanation: "Plan", steps: [{ step: "Ship", status: "inProgress" }] },
      { type: "message", id: "a", role: "assistant", text: "Done" },
    ],
  }, new Date("2026-01-02T03:04:05Z"));
  assert.match(markdown, /^# Build it/);
  assert.match(markdown, /design\.png/);
  assert.match(markdown, /- \[ \] Ship _\(in progress\)_/);
  assert.doesNotMatch(markdown, /attachment location|threadId|tool activity/i);
});
