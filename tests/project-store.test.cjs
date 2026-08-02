const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { ProjectStore } = require("../dist/main/projects/ProjectStore.js");

test("ProjectStore writes version 3 state atomically and restores it", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-store-"));
  const projectPath = join(root, "project-one");
  const statePath = join(root, "state", "appbuilder-state.json");
  await mkdir(projectPath);
  await mkdir(join(projectPath, ".appbuilder"));
  await writeFile(join(projectPath, ".appbuilder", "config.json"), JSON.stringify({
    version: 1,
    runProfiles: [{ id: "run", name: "Run", command: process.execPath, args: ["--version"] }],
  }));

  try {
    const store = new ProjectStore(statePath);
    await store.initialize();
    const project = await store.add({ name: "Project One", path: projectPath });
    assert.equal(project.permissionMode, "workspace");
    await store.updatePermissionMode(project.id, "fullAccess");
    await store.updateSettings({
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultMode: "work",
      sidebarCollapsed: true,
      showModeControl: true,
      showPermissionControl: false,
      showMcpStatus: true,
      codexRuntime: { preference: "auto", customExecutablePath: null, managedVersion: null },
    });
    await store.updateDraftSettings(project.id, { model: "gpt-test", reasoningEffort: "high", mode: "plan" });
    await store.addConversation(project.id, {
      threadId: "thread-persisted",
      name: "Manual name",
      preview: "First message",
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      settings: { model: "gpt-test", reasoningEffort: "high", mode: "plan" },
    });

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.activeProjectId, project.id);
    assert.equal(persisted.projects[0].activeThreadId, "thread-persisted");
    assert.equal(persisted.projects[0].draft, null);
    assert.equal(persisted.projects[0].conversations[0].name, "Manual name");
    assert.equal(persisted.projects[0].runProfiles[0].name, "Run");
    assert.equal(persisted.projects[0].permissionMode, "fullAccess");
    assert.equal(persisted.settings.sidebarCollapsed, true);
    assert.equal(persisted.settings.showModeControl, true);
    assert.equal(persisted.settings.showPermissionControl, false);
    assert.equal(persisted.settings.showMcpStatus, true);
    if (process.platform !== "win32") assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(root, "state"))).filter((name) => name.includes(".tmp-")), []);

    const restored = new ProjectStore(statePath);
    await restored.initialize();
    assert.deepEqual(restored.getState(), persisted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore migrates version 1 thread associations and creates lazy drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-migration-"));
  const statePath = join(root, "state.json");
  const firstPath = join(root, "first");
  const secondPath = join(root, "second");
  await mkdir(firstPath);
  await mkdir(secondPath);
  await writeFile(statePath, JSON.stringify({
    version: 1,
    activeProjectId: "first",
    projects: [
      { id: "first", name: "First", path: firstPath, archived: false, codexThreadId: "thread-old", runProfiles: [] },
      { id: "second", name: "Second", path: secondPath, archived: false, codexThreadId: null, runProfiles: [] },
    ],
  }));

  try {
    const store = new ProjectStore(statePath);
    await store.initialize();
    const state = store.getState();
    assert.equal(state.version, 3);
    assert.deepEqual(state.settings, {
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultMode: "work",
      sidebarCollapsed: false,
      showModeControl: false,
      showPermissionControl: false,
      showMcpStatus: false,
      codexRuntime: { preference: "auto", customExecutablePath: null, managedVersion: null },
    });
    assert.equal(state.projects[0].permissionMode, "workspace");
    assert.equal(state.projects[1].permissionMode, "workspace");
    assert.equal(state.projects[0].activeThreadId, "thread-old");
    assert.deepEqual(state.projects[0].conversations.map((entry) => entry.threadId), ["thread-old"]);
    assert.equal(state.projects[0].draft, null);
    assert.equal(state.projects[1].activeThreadId, null);
    assert.deepEqual(state.projects[1].draft, { model: null, reasoningEffort: null, mode: "work" });
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).version, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore normalizes older version 2 defaults and project permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-v2-normalize-"));
  const projectPath = join(root, "project");
  const statePath = join(root, "state.json");
  await mkdir(projectPath);
  await writeFile(statePath, JSON.stringify({
    version: 2,
    activeProjectId: "project",
    settings: { defaultModel: null, defaultReasoningEffort: null, defaultMode: "plan" },
    projects: [{
      id: "project",
      name: "Project",
      path: projectPath,
      archived: false,
      activeThreadId: null,
      draft: { model: null, reasoningEffort: null, mode: "plan" },
      conversations: [],
      selectedRunProfileId: null,
      runProfiles: [],
    }],
  }));

  try {
    const store = new ProjectStore(statePath);
    await store.initialize();
    const state = store.getState();
    assert.equal(state.settings.defaultMode, "work");
    assert.equal(state.settings.sidebarCollapsed, false);
    assert.equal(state.settings.showModeControl, false);
    assert.equal(state.settings.showPermissionControl, false);
    assert.equal(state.settings.showMcpStatus, false);
    assert.deepEqual(state.settings.codexRuntime, { preference: "auto", customExecutablePath: null, managedVersion: null });
    assert.equal(state.projects[0].permissionMode, "workspace");
    assert.equal(state.projects[0].draft.mode, "plan");
    const newDraft = await store.beginDraft("project");
    assert.equal(newDraft.draft.mode, "work");
    await store.updatePermissionMode("project", "ask");
    const restored = new ProjectStore(statePath);
    await restored.initialize();
    assert.equal(restored.getProject("project").permissionMode, "ask");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore marks projects unconfigured until .appbuilder/config.json appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-config-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();

  try {
    const project = await store.add({ name: "Configurable", path: projectPath });
    assert.deepEqual(project.runProfiles, []);
    assert.equal(project.selectedRunProfileId, null);

    await mkdir(join(projectPath, ".appbuilder"));
    await writeFile(join(projectPath, ".appbuilder", "config.json"), JSON.stringify({
      version: 1,
      selectedRunProfileId: "dev",
      runProfiles: [{ id: "dev", name: "Development", command: "npm", args: ["run", "dev"] }],
    }));
    const configured = await store.refreshConfiguration(project.id);
    assert.equal(configured.selectedRunProfileId, "dev");
    assert.deepEqual(configured.runProfiles[0], {
      id: "dev",
      name: "Development",
      command: "npm",
      args: ["run", "dev"],
      kind: "auto",
      url: null,
      entry: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore detects a root static site without writing a configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-static-site-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await writeFile(join(projectPath, "index.html"), "<!doctype html><title>Static</title>");
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  try {
    const project = await store.add({ name: "Static", path: projectPath });
    assert.deepEqual(project.runProfiles, [{ id: "static-site", name: "Static site", command: "", args: [], kind: "static", url: null, entry: "index.html" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore rejects unsafe web URLs and static entry paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-unsafe-config-"));
  const projectPath = join(root, "project");
  await mkdir(join(projectPath, ".appbuilder"), { recursive: true });
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  try {
    const project = await store.add({ name: "Unsafe", path: projectPath });
    await writeFile(join(projectPath, ".appbuilder", "config.json"), JSON.stringify({ version: 1, runProfiles: [{ id: "bad-url", name: "Bad", kind: "web", command: "node", args: [], url: "https://example.com" }] }));
    assert.equal((await store.inspectConfiguration(project.id)).state, "invalid");
    await writeFile(join(projectPath, ".appbuilder", "config.json"), JSON.stringify({ version: 1, runProfiles: [{ id: "bad-entry", name: "Bad", kind: "static", command: "", args: [], entry: "../secret.html" }] }));
    assert.equal((await store.inspectConfiguration(project.id)).state, "invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore creates a missing project directory when it is added", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-create-project-"));
  const projectPath = join(root, "AppBuilder Projects", "habit-tracker");
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();

  try {
    const project = await store.add({ name: "Habit Tracker", path: projectPath });
    assert.equal(project.path, projectPath);
    assert.equal((await stat(projectPath)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectStore archives, restores, and removes projects without touching Codex threads or directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-lifecycle-"));
  const firstPath = join(root, "first");
  const secondPath = join(root, "second");
  await mkdir(firstPath);
  await mkdir(secondPath);
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();

  try {
    const first = await store.add({ name: "First", path: firstPath });
    const second = await store.add({ name: "Second", path: secondPath });
    await store.addConversation(first.id, {
      threadId: "thread-kept",
      name: null,
      preview: "Keep me",
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, reasoningEffort: null, mode: "work" },
    });

    const archived = await store.setArchived(second.id, true);
    assert.equal(archived.activeProjectId, first.id);
    assert.equal(archived.projects.find((project) => project.id === second.id).archived, true);

    const restored = await store.setArchived(second.id, false);
    assert.equal(restored.activeProjectId, first.id);
    assert.equal(restored.projects.find((project) => project.id === second.id).archived, false);

    const removedFirst = await store.remove(first.id);
    assert.equal(removedFirst.activeProjectId, second.id);
    assert.equal(await stat(firstPath).then((value) => value.isDirectory()), true);
    assert.equal(removedFirst.projects.some((project) => project.id === first.id), false);

    const removedSecond = await store.remove(second.id);
    assert.equal(removedSecond.activeProjectId, null);
    assert.deepEqual(removedSecond.projects, []);
    assert.equal(await stat(secondPath).then((value) => value.isDirectory()), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
