const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { CodexSessionManager } = require("../dist/main/codex/CodexSessionManager.js");
const { ProjectStore } = require("../dist/main/projects/ProjectStore.js");

class FakeServer {
  notifications = [];
  requests = [];
  exits = [];
  calls = [];
  responses = [];
  threads = new Map();
  archivedThreads = new Set();
  failTurnStart = false;
  failMethods = new Set();
  nextThread = 1;
  nextTurn = 1;
  account = { type: "chatgpt" };
  startCount = 0;

  onNotification(listener) { this.notifications.push(listener); return () => {}; }
  onRequest(listener) { this.requests.push(listener); return () => {}; }
  onExit(listener) { this.exits.push(listener); return () => {}; }
  async start() { this.startCount += 1; }
  async stop() {}
  isRunning() { return true; }
  notify() {}
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (this.failMethods.has(method)) throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601, data: { method } });
    if (method === "account/read") return { account: this.account, requiresOpenaiAuth: true, unknownFutureField: true };
    if (method === "account/login/start") return { loginId: "login-1", authUrl: "https://auth.openai.com/codex" };
    if (method === "account/login/cancel") return {};
    if (method === "account/logout") { this.account = null; return {}; }
    if (method === "model/list") return {
      data: [
        { id: "second", model: "gpt-second", displayName: "Second", isDefault: false, supportedReasoningEfforts: [] },
        { id: "first", model: "gpt-test", displayName: "Test", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
      ],
    };
    if (method === "collaborationMode/list") return { data: [{ name: "default", mode: "default" }, { name: "plan", mode: "plan" }] };
    if (method === "account/usage/read") return { summary: { lifetimeTokens: 1000 }, dailyUsageBuckets: [] };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 123 }, spendControlReached: false } };
    if (method === "mcpServerStatus/list") return { data: [{ name: "docs", serverInfo: { title: "Docs" }, authStatus: "oAuth", startupStatus: "ready", tools: { search: {} } }] };
    if (method === "thread/start") {
      const thread = { id: `thread-${this.nextThread++}`, turns: [], createdAt: 10, updatedAt: 10 };
      this.threads.set(thread.id, thread);
      return { thread };
    }
    if (method === "thread/resume") {
      if (this.archivedThreads.has(params.threadId)) {
        throw Object.assign(new Error(`session ${params.threadId} is archived. Run \`codex unarchive ${params.threadId}\` to unarchive it first.`), { code: -32600 });
      }
      return { thread: this.threads.get(params.threadId) ?? { id: params.threadId, turns: [] } };
    }
    if (method === "thread/read") return { thread: this.threads.get(params.threadId) ?? { id: params.threadId, turns: [] } };
    if (method === "turn/start") {
      if (this.archivedThreads.has(params.threadId)) {
        throw Object.assign(new Error(`session ${params.threadId} is archived. Run \`codex unarchive ${params.threadId}\` to unarchive it first.`), { code: -32600 });
      }
      if (this.failTurnStart) throw Object.assign(new Error("turn failed"), { code: -32000, data: { retryable: true } });
      return { turn: { id: `turn-${this.nextTurn++}`, status: "inProgress", items: [] } };
    }
    if (method === "thread/archive") { this.archivedThreads.add(params.threadId); return {}; }
    if (method === "thread/unarchive") { this.archivedThreads.delete(params.threadId); return {}; }
    if (method === "thread/delete" || method === "thread/name/set" || method === "thread/settings/update" || method === "turn/interrupt" || method === "thread/backgroundTerminals/clean") return {};
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601, data: { method } });
  }

  emitNotification(method, params) {
    for (const listener of this.notifications) listener({ method, params });
  }

  emitRequest(request) {
    for (const listener of this.requests) listener(request);
  }

  emitExit(message = "crashed") {
    for (const listener of this.exits) listener(message);
  }
}

async function fixture(prefix = "appbuilder-codex-session-", runner = undefined) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  const project = await store.add({ name: "Codex", path: projectPath });
  const server = new FakeServer();
  const events = [];
  const manager = new CodexSessionManager(server, store, (event) => events.push(event), undefined, runner);
  await manager.start();
  return { root, project, store, server, events, manager };
}

test("CodexSessionManager keeps new conversations local until the first successful send", async () => {
  const context = await fixture("appbuilder-lazy-thread-");
  const { root, project, store, server, manager } = context;
  try {
    const opened = await manager.openProject(project.id);
    assert.equal(opened.project.activeThreadId, null);
    assert.deepEqual(opened.items, []);
    assert.equal(server.calls.some((call) => call.method === "thread/start"), false);

    server.failTurnStart = true;
    await assert.rejects(manager.send(project.id, "This should fail"), /turn failed/);
    assert.equal(store.getProject(project.id).activeThreadId, null);
    assert.equal(store.getProject(project.id).conversations.length, 0);
    assert.deepEqual(store.getProject(project.id).draft, { model: null, reasoningEffort: null, mode: "work" });

    server.failTurnStart = false;
    await manager.send(project.id, "Build it");
    const persisted = store.getProject(project.id);
    assert.equal(persisted.activeThreadId, "thread-2");
    assert.equal(persisted.conversations[0].preview, "Build it");
    assert.equal(persisted.draft, null);
    const turnStart = server.calls.findLast((call) => call.method === "turn/start");
    assert.equal(turnStart.params.model, "gpt-test");
    assert.equal(turnStart.params.effort, "medium");
    assert.equal(turnStart.params.approvalPolicy, "never");
    assert.equal(turnStart.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turnStart.params.collaborationMode.settings.developer_instructions, null);
    const threadStart = server.calls.findLast((call) => call.method === "thread/start");
    assert.equal(threadStart.params.dynamicTools[0].name, "appbuilder_runtime_status");
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager restores an active conversation when Codex reports it was archived", async () => {
  const context = await fixture("appbuilder-archived-thread-");
  const { root, project, store, server, manager } = context;
  try {
    const threadId = "thread-archived";
    await store.addConversation(project.id, {
      threadId,
      name: null,
      preview: "Archived conversation",
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, reasoningEffort: null, mode: "work" },
    });
    server.threads.set(threadId, { id: threadId, turns: [] });
    server.archivedThreads.add(threadId);

    await manager.openProject(project.id);
    assert.equal(store.getProject(project.id).conversations[0].archived, false);
    assert.equal(server.calls.filter((call) => call.method === "thread/unarchive" && call.params.threadId === threadId).length, 1);

    server.archivedThreads.add(threadId);
    await manager.send(project.id, "Continue this conversation");
    assert.equal(server.calls.filter((call) => call.method === "thread/unarchive" && call.params.threadId === threadId).length, 2);
    assert.equal(server.calls.findLast((call) => call.method === "turn/start").params.threadId, threadId);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager returns only allowlisted runtime status through its dynamic tool", async () => {
  const runner = { getStatus: () => ({ projectId: "ignored", status: "failed", target: "web", url: "http://127.0.0.1:3000", pid: 999, exitCode: 1, failureCode: "port_in_use", error: "The local app port is already in use." }) };
  const context = await fixture("appbuilder-runtime-tool-", runner);
  const { root, project, store, server, manager } = context;
  try {
    const threadId = "thread-runtime";
    await store.addConversation(project.id, { threadId, name: null, preview: "Runtime", archived: false, createdAt: 1, updatedAt: 1, settings: { model: null, reasoningEffort: null, mode: "work" } });
    server.threads.set(threadId, { id: threadId, turns: [] });
    await manager.openProject(project.id);
    server.emitRequest({ id: "runtime-status", method: "item/tool/call", params: { threadId, tool: "appbuilder_runtime_status", arguments: {} } });
    const response = server.responses.findLast((entry) => entry.id === "runtime-status");
    const payload = JSON.parse(response.result.contentItems[0].text);
    assert.deepEqual(payload, {
      profile: null,
      state: "failed",
      target: "web",
      url: "http://127.0.0.1:3000",
      exitCode: 1,
      failureCode: "port_in_use",
      failure: "The local app port is already in use.",
    });
    assert.equal(JSON.stringify(payload).includes("999"), false);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager applies project permission modes to new threads and turns", async () => {
  const context = await fixture("appbuilder-permissions-");
  const { root, project, store, server, manager } = context;
  try {
    await manager.updateProjectPermissionMode(project.id, "fullAccess");
    assert.equal(store.getProject(project.id).permissionMode, "fullAccess");
    await manager.send(project.id, "Run without prompts");

    const threadStart = server.calls.findLast((call) => call.method === "thread/start");
    assert.equal(threadStart.params.approvalPolicy, "never");
    assert.equal(threadStart.params.sandbox, "danger-full-access");
    const turnStart = server.calls.findLast((call) => call.method === "turn/start");
    assert.equal(turnStart.params.approvalPolicy, "never");
    assert.deepEqual(turnStart.params.sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager can suppress prompts while retaining the workspace sandbox", async () => {
  const context = await fixture("appbuilder-workspace-permissions-");
  const { root, project, server, manager } = context;
  try {
    await manager.updateProjectPermissionMode(project.id, "workspace");
    await manager.send(project.id, "Stay in this project");

    const threadStart = server.calls.findLast((call) => call.method === "thread/start");
    assert.equal(threadStart.params.approvalPolicy, "never");
    assert.equal(threadStart.params.sandbox, "workspace-write");
    const turnStart = server.calls.findLast((call) => call.method === "turn/start");
    assert.equal(turnStart.params.approvalPolicy, "never");
    assert.equal(turnStart.params.sandboxPolicy.type, "workspaceWrite");
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager supports ChatGPT browser login, completion, cancellation, and logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "appbuilder-auth-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const store = new ProjectStore(join(root, "state.json"));
  await store.initialize();
  await store.add({ name: "Auth", path: projectPath });
  const server = new FakeServer();
  server.account = null;
  const events = [];
  const manager = new CodexSessionManager(server, store, (event) => events.push(event));
  try {
    await manager.start();
    assert.equal(manager.getStatus().state, "authenticationRequired");
    const login = await manager.startChatGptLogin();
    assert.deepEqual(login, { loginId: "login-1", authUrl: "https://auth.openai.com/codex" });
    assert.equal(manager.getOverview().authFlow.state, "waiting");

    await manager.cancelChatGptLogin();
    assert.equal(manager.getOverview().authFlow.state, "idle");
    await manager.startChatGptLogin();
    server.account = { type: "chatgpt" };
    server.emitNotification("account/login/completed", { loginId: "login-1", success: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.getStatus().authenticated, true);
    assert.equal(events.some((event) => event.type === "authFlow" && event.authFlow.state === "idle"), true);

    await manager.logout();
    assert.equal(manager.getStatus().state, "authenticationRequired");
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager reconnects after an unexpected app-server exit without resuming a turn", async () => {
  const context = await fixture("appbuilder-reconnect-");
  const { root, server, manager } = context;
  try {
    assert.equal(server.startCount, 1);
    server.emitExit("unexpected exit");
    assert.equal(manager.getStatus().state, "reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(server.startCount, 2);
    assert.equal(manager.getStatus().state, "ready");
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager restores safe transcript items and routes plans, usage, approvals, and interactive requests", async () => {
  const context = await fixture();
  const { root, project, store, server, events, manager } = context;
  try {
    const threadId = "thread-restored";
    await store.addConversation(project.id, {
      threadId,
      name: null,
      preview: "Hello",
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      settings: { model: "gpt-test", reasoningEffort: "high", mode: "plan" },
    });
    server.threads.set(threadId, {
      id: threadId,
      name: "Restored",
      preview: "Hello",
      turns: [{
        id: "old-turn",
        status: "completed",
        items: [
          { id: "user-one", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
          { id: "command-hidden", type: "commandExecution", command: "secret command" },
          { id: "agent-one", type: "agentMessage", text: "**Hi** there" },
          { id: "plan-one", type: "plan", text: "1. Inspect\n2. Build" },
          {
            id: "user-attachments",
            type: "userMessage",
            content: [
              { type: "text", text: "Review these" },
              { type: "localImage", path: "/tmp/11111111-1111-4111-8111-111111111111-screenshot.png" },
              { type: "text", text: `AppBuilder attached file: ${JSON.stringify({ id: "file-one", name: "requirements.pdf", path: "/tmp/requirements.pdf", size: 4096 })}` },
            ],
          },
        ],
      }],
    });

    const restored = await manager.openProject(project.id);
    assert.deepEqual(restored.items, [
      { type: "message", id: "user-one", role: "user", text: "Hello" },
      { type: "message", id: "agent-one", role: "assistant", text: "**Hi** there" },
      { type: "plan", id: "plan-one", turnId: "old-turn", text: "1. Inspect\n2. Build", explanation: null, steps: [] },
      {
        type: "message",
        id: "user-attachments",
        role: "user",
        text: "Review these",
        attachments: [
          { id: "user-attachments-image-1", name: "screenshot.png", kind: "image", size: null },
          { id: "file-one", name: "requirements.pdf", kind: "file", size: 4096 },
        ],
      },
    ]);

    const overview = manager.getOverview();
    assert.deepEqual(overview.catalogs.models.map((model) => model.model), ["gpt-second", "gpt-test"]);
    assert.deepEqual(overview.catalogs.collaborationModes, ["work", "plan"]);
    assert.equal(overview.capabilities.mcp.supported, true);
    assert.equal((await manager.listMcpServers(project.id))[0].toolCount, 1);

    await manager.updateConversationSettings(project.id, { model: "gpt-test", reasoningEffort: "high", mode: "work" });
    const settingsCall = server.calls.findLast((call) => call.method === "thread/settings/update");
    assert.equal(settingsCall.params.effort, "high");
    assert.equal(settingsCall.params.collaborationMode.mode, "default");
    assert.equal(settingsCall.params.collaborationMode.settings.reasoning_effort, "high");

    server.emitNotification("item/plan/delta", { threadId, turnId: "turn-live", itemId: "plan-live", delta: "Inspect" });
    server.emitNotification("turn/plan/updated", { threadId, turnId: "turn-live", explanation: "Updated", plan: [{ step: "Inspect", status: "completed" }, { step: "Build", status: "inProgress" }] });
    server.emitNotification("item/completed", { threadId, turnId: "turn-live", item: { id: "plan-live", type: "plan", text: "1. Inspect\n2. Build" } });
    server.emitNotification("thread/tokenUsage/updated", { threadId, tokenUsage: { total: { totalTokens: 12, inputTokens: 6, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1 }, last: { totalTokens: 3 }, modelContextWindow: 100 } });
    assert.ok(events.some((event) => event.type === "planDelta" && event.delta === "Inspect"));
    assert.ok(events.some((event) => event.type === "planCompleted" && event.text.includes("Build")));
    assert.ok(events.some((event) => event.type === "planUpdated" && event.plan[1].status === "inProgress"));
    assert.equal(manager.getThreadUsage(project.id).totalTokens, 12);
    assert.equal(manager.getThreadUsage(project.id).contextTokens, 3);
    assert.equal(manager.getThreadUsage(project.id).modelContextWindow, 100);

    server.emitRequest({
      id: "approval-one",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: "turn-live", itemId: "command-one", reason: "Needs network access", command: "npm install", availableDecisions: ["accept", "acceptForSession", "decline"] },
    });
    const approval = events.findLast((event) => event.type === "approval").approval;
    assert.equal(approval.summary, "npm install");
    manager.respondToApproval(approval.id, "acceptSession");
    assert.deepEqual(server.responses.at(-1), { id: "approval-one", result: { decision: "acceptForSession" } });

    server.emitRequest({
      id: "questions-one",
      method: "item/tool/requestUserInput",
      params: { threadId, questions: [{ id: "color", header: "Color", question: "Choose", options: [{ label: "Blue", description: "Cool" }], isOther: true }] },
    });
    const questionRequest = events.findLast((event) => event.type === "interactiveRequest").request;
    manager.respondToInteractive(questionRequest.id, { action: "submit", values: { color: "Blue" } });
    assert.deepEqual(server.responses.at(-1), { id: "questions-one", result: { answers: { color: { answers: ["Blue"] } } } });

    server.emitRequest({
      id: "mcp-form",
      method: "mcpServer/elicitation/request",
      params: { threadId, serverName: "forms", mode: "form", message: "Configure", requestedSchema: { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1 }, secret: { type: "string", format: "password" }, tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } } } },
    });
    const formRequest = events.findLast((event) => event.type === "interactiveRequest").request;
    assert.deepEqual(formRequest.fields.map((field) => field.type), ["integer", "string", "multiSelect"]);

    server.emitRequest({ id: "bad-url", method: "mcpServer/elicitation/request", params: { threadId, serverName: "bad", mode: "url", message: "Unsafe", url: "file:///secret" } });
    assert.deepEqual(server.responses.at(-1), { id: "bad-url", result: { action: "decline", content: null, _meta: null } });
    server.emitRequest({ id: "opaque", method: "mcpServer/elicitation/request", params: { threadId, serverName: "bad", mode: "form", requestedSchema: { type: "object", properties: { data: { type: "object" } } } } });
    assert.deepEqual(server.responses.at(-1), { id: "opaque", result: { action: "decline", content: null, _meta: null } });

    server.failMethods.add("thread/name/set");
    await assert.rejects(manager.renameConversation(project.id, threadId, "Unsupported"), /Method not found/);
    assert.equal(manager.getOverview().capabilities.conversationNaming.supported, false);
    assert.match(manager.getOverview().capabilities.conversationNaming.reason, /installed Codex CLI/);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("CodexSessionManager sequences lifecycle interruption and explicit conversation operations", async () => {
  const context = await fixture("appbuilder-conversation-lifecycle-");
  const { root, project, store, server, manager } = context;
  try {
    await manager.send(project.id, "Start work");
    const threadId = store.getProject(project.id).activeThreadId;
    const stopping = manager.interruptForLifecycle(project.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.calls.at(-1).method, "turn/interrupt");
    server.emitNotification("turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted", items: [], error: null } });
    await stopping;
    assert.equal(server.calls.at(-1).method, "thread/backgroundTerminals/clean");

    await manager.renameConversation(project.id, threadId, "Renamed");
    assert.equal(store.getProject(project.id).conversations[0].name, "Renamed");
    await manager.archiveConversation(project.id, threadId);
    assert.equal(store.getProject(project.id).activeThreadId, null);
    assert.equal(store.getProject(project.id).conversations[0].archived, true);
    await manager.restoreConversation(project.id, threadId);
    assert.equal(store.getProject(project.id).activeThreadId, threadId);
    assert.equal(store.getProject(project.id).conversations[0].archived, false);
    await manager.deleteConversation(project.id, threadId);
    assert.equal(store.getProject(project.id).activeThreadId, null);
    assert.deepEqual(store.getProject(project.id).conversations, []);
    assert.deepEqual(server.calls.filter((call) => ["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"].includes(call.method)).map((call) => call.method), ["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"]);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});
