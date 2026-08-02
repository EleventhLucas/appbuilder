const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { ProjectStore } = require("../dist/main/projects/ProjectStore.js");
const { ProjectRunner } = require("../dist/main/runtime/ProjectRunner.js");

test("ProjectRunner prevents duplicates and serializes restart and stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-runner-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  await mkdir(join(projectPath, ".appbuilder"));
  await writeFile(join(projectPath, ".appbuilder", "config.json"), JSON.stringify({
    version: 1,
    runProfiles: [{
      id: "run",
      name: "Run",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }],
  }));
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  const project = await store.add({ name: "Runner", path: projectPath });
  const statuses = [];
  const opened = [];
  const runner = new ProjectRunner(store, (status) => statuses.push(status), { openUrl: async (url) => opened.push(url), openFile: async () => "" });

  try {
    const first = await runner.start(project.id);
    assert.equal(first.status, "running");
    assert.ok(first.pid);

    const duplicate = await runner.start(project.id);
    assert.equal(duplicate.pid, first.pid);

    const restarted = await runner.restart(project.id);
    assert.equal(restarted.status, "running");
    assert.ok(restarted.pid);
    assert.notEqual(restarted.pid, first.pid);

    const stopped = await runner.stop(project.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.pid, null);
    assert.ok(statuses.filter((status) => status.status === "running").length >= 2);
  } finally {
    await runner.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("ProjectRunner opens detected static sites and waits for local web servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-runner-targets-"));
  const staticPath = join(root, "static");
  const webPath = join(root, "web");
  await mkdir(staticPath);
  await mkdir(webPath);
  await writeFile(join(staticPath, "index.html"), "<!doctype html><title>Static</title>");
  await mkdir(join(webPath, ".appbuilder"));
  await writeFile(join(webPath, ".appbuilder", "config.json"), JSON.stringify({
    version: 1,
    runProfiles: [{ id: "web", name: "Web", kind: "web", command: process.execPath, args: ["-e", "const h=require('node:http').createServer((q,s)=>s.end('ok'));h.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+h.address().port))"] }],
  }));
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  const staticProject = await store.add({ name: "Static", path: staticPath });
  const webProject = await store.add({ name: "Web", path: webPath });
  const opened = [];
  const openedFiles = [];
  const runner = new ProjectRunner(store, () => {}, { openUrl: async (url) => opened.push(url), openFile: async (path) => { openedFiles.push(path); return ""; } });
  try {
    const staticStatus = await runner.start(staticProject.id);
    assert.equal(staticStatus.status, "ready");
    assert.equal(staticStatus.target, "static");
    assert.equal(openedFiles.length, 1);
    await runner.start(webProject.id);
    for (let index = 0; index < 80 && runner.getStatus(webProject.id).status !== "ready"; index += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runner.getStatus(webProject.id).status, "ready");
    assert.match(runner.getStatus(webProject.id).url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(opened.length, 1);
  } finally {
    await runner.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
