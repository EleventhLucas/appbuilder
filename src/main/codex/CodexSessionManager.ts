import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type {
  AccountUsage,
  ApprovalDecision,
  ApprovalRequest,
  ChatAttachment,
  CodexCapabilities,
  CodexEvent,
  CodexModel,
  CodexOverview,
  CodexRuntimeInfo,
  CodexStatus,
  CollaborationMode,
  ConversationItem,
  ConversationMessage,
  ConversationRecord,
  ConversationSettings,
  InteractiveRequest,
  InteractiveResponse,
  McpFormField,
  McpServerSummary,
  PlanStep,
  Project,
  ProjectPermissionMode,
  ProjectSelection,
  ThreadTokenUsage,
  ToolQuestion,
} from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ProjectRunner } from "../runtime/ProjectRunner";
import {
  CodexAppServer,
  CodexRpcError,
  type RpcId,
  type ServerMessage,
  type ServerRequest,
} from "./CodexAppServer";

interface AccountResponse {
  account: unknown | null;
  requiresOpenaiAuth: boolean;
}

interface ThreadInput {
  type: string;
  text?: string;
  path?: string;
  url?: string;
}

interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  content?: ThreadInput[];
}

interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string } | null;
  items: ThreadItem[];
}

interface Thread {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  turns: Turn[];
}

interface ThreadResponse {
  thread: Thread;
}

interface PendingApproval {
  publicId: string;
  rpcId: RpcId;
  method: string;
  params: Record<string, unknown>;
}

interface PendingInteractive {
  publicId: string;
  rpcId: RpcId;
  method: "item/tool/requestUserInput" | "mcpServer/elicitation/request";
  params: Record<string, unknown>;
}

interface TurnInputText {
  type: "text";
  text: string;
  text_elements: [];
}

interface TurnInputImage {
  type: "localImage";
  path: string;
  detail: "auto";
}

type TurnInput = TurnInputText | TurnInputImage;

export interface CodexInputAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  size: number | null;
  path: string;
}

const FILE_ATTACHMENT_PREFIX = "AppBuilder attached file: ";

const available = (): { supported: true; reason: null } => ({ supported: true, reason: null });
const checking = (): { supported: false; reason: string } => ({ supported: false, reason: "Checking installed Codex support…" });

function initialCapabilities(): CodexCapabilities {
  return {
    models: checking(),
    collaborationModes: checking(),
    threadSettings: available(),
    conversations: available(),
    conversationNaming: available(),
    conversationArchiving: available(),
    conversationDeletion: available(),
    usage: checking(),
    mcp: checking(),
    backgroundTerminals: available(),
  };
}

export class CodexSessionManager {
  private overview: CodexOverview = {
    status: { state: "detecting", authenticated: null, message: null },
    capabilities: initialCapabilities(),
    catalogs: { models: [], collaborationModes: [] },
    accountUsage: null,
    runtime: {
      state: "detecting",
      source: null,
      executablePath: null,
      version: null,
      bundledVersion: null,
      candidateFailure: null,
      update: {
        state: "disabled",
        currentVersion: null,
        availableVersion: null,
        releaseUrl: null,
        message: "Managed Codex updates are disabled until signed release manifests are configured.",
      },
    },
    authFlow: { state: "idle", loginId: null, message: null },
  };
  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private reconnecting = false;
  private hasConnectedOnce = false;
  private readonly projectByThread = new Map<string, string>();
  private readonly turnByProject = new Map<string, string>();
  private readonly pendingTurnStarts = new Set<string>();
  private readonly completedBeforeStartResponse = new Set<string>();
  private readonly openingByProject = new Map<string, Promise<ProjectSelection>>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly interactives = new Map<string, PendingInteractive>();
  private readonly interruptionWaiters = new Map<string, Array<() => void>>();
  private readonly tokenUsageByThread = new Map<string, ThreadTokenUsage>();
  private readonly mcpByProject = new Map<string, McpServerSummary[]>();
  private globalMcp: McpServerSummary[] = [];
  private runtimeToolEnabled = true;

  constructor(
    private readonly server: CodexAppServer,
    private readonly store: ProjectStore,
    private readonly onEvent: (event: CodexEvent) => void,
    private readonly onStartupFailure?: (error: Error) => void,
    private readonly runner?: ProjectRunner,
  ) {
    server.onNotification((notification) => this.handleNotification(notification));
    server.onRequest((request) => this.handleServerRequest(request));
    server.onExit((message) => {
      for (const [projectId] of this.turnByProject) {
        this.onEvent({ type: "working", projectId, threadId: this.store.getProject(projectId).activeThreadId, working: false });
        this.resolveInterruptionWaiters(projectId);
      }
      this.turnByProject.clear();
      this.clearAllRequests();
      this.startPromise = null;
      if (this.stopping) return;
      if (!this.hasConnectedOnce) {
        this.setStatus({ state: "unavailable", authenticated: null, message });
        return;
      }
      void this.reconnect(message);
    });
  }

  getStatus(): CodexStatus {
    return structuredClone(this.overview.status);
  }

  getOverview(): CodexOverview {
    return structuredClone(this.overview);
  }

  setRuntimeInfo(runtime: CodexRuntimeInfo): void {
    this.overview.runtime = structuredClone(runtime);
    this.emitOverview();
  }

  getThreadUsage(projectId: string): ThreadTokenUsage | null {
    const threadId = this.store.getProject(projectId).activeThreadId;
    return threadId ? structuredClone(this.tokenUsageByThread.get(threadId) ?? null) : null;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.startInternal().catch((error: unknown) => {
      this.startPromise = null;
      const failure = error instanceof Error ? error : new Error(this.errorMessage(error));
      this.onStartupFailure?.(failure);
      throw error;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.reconnecting = false;
    await this.server.stop();
    this.startPromise = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
  }

  async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.ensureServerRunning();
    this.setAuthFlow({ state: "starting", loginId: null, message: null });
    try {
      const response = this.object(await this.server.request<unknown>("account/login/start", { type: "chatgpt" }));
      if (typeof response.loginId !== "string" || typeof response.authUrl !== "string") {
        throw new Error("The installed Codex runtime returned an invalid login response.");
      }
      const url = new URL(response.authUrl);
      if (url.protocol !== "https:") throw new Error("Codex returned an unsafe login URL.");
      this.setAuthFlow({ state: "waiting", loginId: response.loginId, message: null });
      return { loginId: response.loginId, authUrl: url.toString() };
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601 && this.overview.runtime.source && this.overview.runtime.executablePath) {
        this.overview.runtime = {
          ...this.overview.runtime,
          state: "awaitingFallbackConsent",
          candidateFailure: {
            source: this.overview.runtime.source,
            executablePath: this.overview.runtime.executablePath,
            message: "This Codex runtime does not support ChatGPT browser sign-in.",
          },
        };
        this.emitOverview();
      }
      this.setAuthFlow({ state: "failed", loginId: null, message: this.errorMessage(error) });
      throw error;
    }
  }

  async cancelChatGptLogin(): Promise<void> {
    const loginId = this.overview.authFlow.loginId;
    if (!loginId) return;
    await this.server.request("account/login/cancel", { loginId });
    this.setAuthFlow({ state: "idle", loginId: null, message: null });
  }

  async logout(): Promise<void> {
    await this.ensureServerRunning();
    await this.server.request("account/logout", {});
    this.setAuthFlow({ state: "idle", loginId: null, message: null });
    await this.refreshAccountState();
  }

  openProject(projectId: string): Promise<ProjectSelection> {
    const current = this.openingByProject.get(projectId);
    if (current) return current;
    const opening = this.openProjectInternal(projectId).finally(() => {
      if (this.openingByProject.get(projectId) === opening) this.openingByProject.delete(projectId);
    });
    this.openingByProject.set(projectId, opening);
    return opening;
  }

  async beginConversation(projectId: string, disposition: "keep" | "archive" = "keep"): Promise<ProjectSelection> {
    await this.ensureAvailable();
    const current = this.store.getProject(projectId).activeThreadId;
    if (current && disposition === "archive") await this.archiveConversation(projectId, current);
    if (current) this.clearRequestsForThread(current);
    const project = await this.store.beginDraft(projectId);
    this.onEvent({ type: "projectUpdated", project });
    return { project, items: [] };
  }

  async openConversation(projectId: string, threadId: string, disposition: "keep" | "archive" = "keep"): Promise<ProjectSelection> {
    await this.ensureAvailable();
    const before = this.store.getProject(projectId);
    if (!before.conversations.some((conversation) => conversation.threadId === threadId)) throw new Error("Conversation not found.");
    if (before.activeThreadId && before.activeThreadId !== threadId && disposition === "archive") {
      await this.archiveConversation(projectId, before.activeThreadId);
    }
    if (before.activeThreadId && before.activeThreadId !== threadId) this.clearRequestsForThread(before.activeThreadId);
    const target = this.store.getProject(projectId).conversations.find((conversation) => conversation.threadId === threadId);
    if (target?.archived) await this.unarchiveConversation(projectId, threadId);
    const selection = await this.resumeConversationWithArchiveRecovery(projectId, threadId);
    const project = await this.store.bindConversation(projectId, threadId);
    this.onEvent({ type: "projectUpdated", project });
    return { project, items: selection.items };
  }

  async renameConversation(projectId: string, threadId: string, name: string): Promise<Project> {
    await this.ensureAvailable();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new Error("Conversation name must be between 1 and 120 characters.");
    try {
      await this.server.request("thread/name/set", { threadId, name: trimmed });
    } catch (error) {
      this.disableCapability("conversationNaming", error);
      throw error;
    }
    const project = await this.store.updateConversation(projectId, threadId, { name: trimmed, updatedAt: Date.now() / 1000 });
    this.onEvent({ type: "projectUpdated", project });
    return project;
  }

  async archiveConversation(projectId: string, threadId: string): Promise<Project> {
    await this.ensureAvailable();
    try {
      await this.server.request("thread/archive", { threadId });
    } catch (error) {
      this.disableCapability("conversationArchiving", error);
      throw error;
    }
    let project = await this.store.updateConversation(projectId, threadId, { archived: true });
    if (project.activeThreadId === threadId) project = await this.store.clearActiveConversation(projectId);
    this.onEvent({ type: "projectUpdated", project });
    return project;
  }

  async restoreConversation(projectId: string, threadId: string, disposition: "keep" | "archive" = "keep"): Promise<ProjectSelection> {
    const current = this.store.getProject(projectId).activeThreadId;
    if (current && current !== threadId && disposition === "archive") await this.archiveConversation(projectId, current);
    await this.unarchiveConversation(projectId, threadId);
    return this.openConversation(projectId, threadId, "keep");
  }

  async deleteConversation(projectId: string, threadId: string): Promise<Project> {
    await this.ensureAvailable();
    try {
      await this.server.request("thread/delete", { threadId });
    } catch (error) {
      this.disableCapability("conversationDeletion", error);
      throw error;
    }
    const project = await this.store.removeConversation(projectId, threadId);
    this.projectByThread.delete(threadId);
    this.tokenUsageByThread.delete(threadId);
    this.onEvent({ type: "projectUpdated", project });
    return project;
  }

  async interrupt(projectId: string): Promise<void> {
    await this.ensureAvailable();
    const project = this.store.getProject(projectId);
    const turnId = this.turnByProject.get(projectId);
    if (!project.activeThreadId || !turnId) return;
    await this.server.request("turn/interrupt", { threadId: project.activeThreadId, turnId });
  }

  async interruptForLifecycle(projectId: string): Promise<void> {
    if (!this.turnByProject.has(projectId)) return;
    let timeout: ReturnType<typeof setTimeout>;
    let resolveWaiter: () => void = () => undefined;
    const completed = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out waiting for the active Codex turn to stop.")), 30_000);
      const waiters = this.interruptionWaiters.get(projectId) ?? [];
      resolveWaiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      waiters.push(resolveWaiter);
      this.interruptionWaiters.set(projectId, waiters);
    });
    try {
      await this.interrupt(projectId);
      await completed;
    } catch (error) {
      clearTimeout(timeout!);
      const waiters = (this.interruptionWaiters.get(projectId) ?? []).filter((waiter) => waiter !== resolveWaiter);
      if (waiters.length > 0) this.interruptionWaiters.set(projectId, waiters);
      else this.interruptionWaiters.delete(projectId);
      throw error;
    }
    const threadId = this.store.getProject(projectId).activeThreadId;
    if (!threadId || !this.overview.capabilities.backgroundTerminals.supported) return;
    try {
      await this.server.request("thread/backgroundTerminals/clean", { threadId });
    } catch (error) {
      this.disableCapability("backgroundTerminals", error);
    }
  }

  async updateConversationSettings(projectId: string, settings: ConversationSettings): Promise<Project> {
    await this.ensureAvailable();
    const project = this.store.getProject(projectId);
    if (project.draft) {
      const updated = await this.store.updateDraftSettings(projectId, settings);
      this.onEvent({ type: "projectUpdated", project: updated });
      return updated;
    }
    if (!project.activeThreadId) throw new Error("No active conversation.");
    if (!this.overview.capabilities.threadSettings.supported) {
      throw new Error(this.overview.capabilities.threadSettings.reason ?? "Thread settings are unavailable.");
    }
    try {
      await this.server.request("thread/settings/update", {
        threadId: project.activeThreadId,
        ...this.turnSettings(settings),
      });
    } catch (error) {
      this.disableCapability("threadSettings", error);
      throw error;
    }
    const updated = await this.store.updateConversation(projectId, project.activeThreadId, { settings });
    this.onEvent({ type: "projectUpdated", project: updated });
    return updated;
  }

  async updateProjectPermissionMode(projectId: string, permissionMode: ProjectPermissionMode): Promise<Project> {
    const updated = await this.store.updatePermissionMode(projectId, permissionMode);
    this.onEvent({ type: "projectUpdated", project: updated });
    return updated;
  }

  async send(projectId: string, text: string, attachments: CodexInputAttachment[] = []): Promise<void> {
    await this.ensureAvailable();
    if (this.turnByProject.has(projectId) || this.pendingTurnStarts.has(projectId)) throw new Error("Codex is already working on this project.");
    const input = this.buildTurnInput(text, attachments);
    let project = this.store.getProject(projectId);
    let threadId = project.activeThreadId;
    let provisionalThread: Thread | null = null;
    const settings = project.draft ?? project.conversations.find((conversation) => conversation.threadId === threadId)?.settings;
    if (!settings) throw new Error("Create or select a conversation before sending a message.");

    if (!threadId) {
      const response = await this.startThread(project.path, settings, project.permissionMode);
      provisionalThread = response.thread;
      threadId = response.thread.id;
      this.projectByThread.set(threadId, projectId);
    } else if (!this.projectByThread.has(threadId)) {
      await this.resumeConversationWithArchiveRecovery(projectId, threadId);
    }

    this.onEvent({ type: "working", projectId, threadId, working: true });
    this.pendingTurnStarts.add(projectId);
    try {
      const params: Record<string, unknown> = {
        threadId,
        clientUserMessageId: randomUUID(),
        input,
        ...this.turnSettings(settings),
        ...this.permissionSettings(project.permissionMode, attachments),
      };
      let response: { turn: Turn };
      try {
        response = await this.server.request<{ turn: Turn }>("turn/start", params);
      } catch (error) {
        if (!this.isArchivedThread(error) || !threadId) throw error;
        await this.resumeConversationWithArchiveRecovery(projectId, threadId);
        response = await this.server.request<{ turn: Turn }>("turn/start", params);
      }
      if (provisionalThread) {
        const now = Date.now() / 1000;
        project = await this.store.addConversation(projectId, this.threadRecord(provisionalThread, settings, text.trim(), now));
        this.onEvent({ type: "projectUpdated", project });
      }
      this.pendingTurnStarts.delete(projectId);
      if (!this.completedBeforeStartResponse.delete(response.turn.id)) this.turnByProject.set(projectId, response.turn.id);
    } catch (error) {
      this.pendingTurnStarts.delete(projectId);
      this.onEvent({ type: "working", projectId, threadId, working: false });
      if (provisionalThread) this.projectByThread.delete(provisionalThread.id);
      throw error;
    }
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("Approval request is no longer active.");
    this.approvals.delete(approvalId);
    if (pending.method === "item/commandExecution/requestApproval" || pending.method === "item/fileChange/requestApproval") {
      this.server.respond(pending.rpcId, { decision: decision === "acceptOnce" ? "accept" : decision === "acceptSession" ? "acceptForSession" : "decline" });
    } else if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
      this.server.respond(pending.rpcId, { decision: decision === "acceptOnce" ? "approved" : decision === "acceptSession" ? "approved_for_session" : "denied" });
    } else if (pending.method === "item/permissions/requestApproval") {
      if (decision === "decline") {
        this.server.respondError(pending.rpcId, -32000, "User declined the permission request.");
        return;
      }
      const requested = this.object(pending.params.permissions);
      const permissions: Record<string, unknown> = {};
      if (requested.network) permissions.network = requested.network;
      if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
      this.server.respond(pending.rpcId, { permissions, scope: decision === "acceptSession" ? "session" : "turn" });
    }
  }

  respondToInteractive(requestId: string, response: InteractiveResponse): void {
    const pending = this.interactives.get(requestId);
    if (!pending) throw new Error("Interactive request is no longer active.");
    this.interactives.delete(requestId);
    if (pending.method === "item/tool/requestUserInput") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const [id, value] of Object.entries(response.values)) {
        if (Array.isArray(value)) answers[id] = { answers: value.map(String) };
        else if (value !== undefined && value !== null && String(value).length > 0) answers[id] = { answers: [String(value)] };
      }
      this.server.respond(pending.rpcId, { answers });
    } else {
      const action = response.action === "submit" ? "accept" : response.action;
      this.server.respond(pending.rpcId, {
        action,
        content: action === "accept" ? response.values : null,
        _meta: null,
      });
    }
    this.onEvent({ type: "interactiveResolved", requestId });
  }

  async refreshAccountUsage(): Promise<AccountUsage | null> {
    await this.ensureAvailable();
    await this.loadUsage();
    return structuredClone(this.overview.accountUsage);
  }

  async listMcpServers(projectId: string | null): Promise<McpServerSummary[]> {
    await this.ensureAvailable();
    if (!this.overview.capabilities.mcp.supported) return [];
    return this.loadMcpServers(projectId);
  }

  private async loadMcpServers(projectId: string | null): Promise<McpServerSummary[]> {
    const threadId = projectId ? this.store.getProject(projectId).activeThreadId : null;
    try {
      const data: unknown[] = [];
      let cursor: string | null = null;
      do {
        const response = this.object(await this.server.request<unknown>("mcpServerStatus/list", {
          detail: "toolsAndAuthOnly",
          cursor,
          ...(threadId ? { threadId } : {}),
        }));
        data.push(...this.array(response.data));
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      } while (cursor);
      const previous = projectId ? (this.mcpByProject.get(projectId) ?? []) : this.globalMcp;
      const servers = data.map((entry) => this.decodeMcpServer(entry, previous));
      if (projectId) this.mcpByProject.set(projectId, servers);
      else this.globalMcp = servers;
      this.overview.capabilities.mcp = available();
      this.emitOverview();
      this.onEvent({ type: "mcpUpdated", projectId, servers: structuredClone(servers) });
      return structuredClone(servers);
    } catch (error) {
      this.disableCapability("mcp", error);
      return [];
    }
  }

  private async openProjectInternal(projectId: string): Promise<ProjectSelection> {
    await this.ensureAvailable();
    const project = this.store.getProject(projectId);
    for (const conversation of project.conversations) this.projectByThread.set(conversation.threadId, projectId);
    if (!project.activeThreadId) return { project, items: [] };
    try {
      const selection = await this.resumeConversationWithArchiveRecovery(projectId, project.activeThreadId);
      return { project: this.store.getProject(projectId), items: selection.items };
    } catch (error) {
      if (!this.isMissingThread(error)) throw error;
      const updated = await this.store.removeConversation(projectId, project.activeThreadId);
      this.onEvent({ type: "projectUpdated", project: updated });
      return { project: updated, items: [] };
    }
  }

  private async resumeConversation(projectId: string, threadId: string): Promise<{ items: ConversationItem[] }> {
    const project = this.store.getProject(projectId);
    this.projectByThread.set(threadId, projectId);
    const resumed = await this.requestThread<ThreadResponse>("thread/resume", {
      threadId,
      cwd: project.path,
      approvalPolicy: project.permissionMode === "ask" ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: project.permissionMode === "fullAccess" ? "danger-full-access" : "workspace-write",
    });
    let thread = resumed.thread;
    try {
      thread = (await this.server.request<ThreadResponse>("thread/read", { threadId, includeTurns: true })).thread;
    } catch (error) {
      const message = this.errorMessage(error);
      if (!message.includes("not materialized yet") && !message.includes("includeTurns is unavailable")) throw error;
    }
    const record = project.conversations.find((conversation) => conversation.threadId === threadId);
    if (record) {
      const updated = await this.store.updateConversation(projectId, threadId, {
        name: typeof thread.name === "string" ? thread.name : record.name,
        preview: typeof thread.preview === "string" ? thread.preview : record.preview,
        createdAt: typeof thread.createdAt === "number" ? thread.createdAt : record.createdAt,
        updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : record.updatedAt,
      });
      this.onEvent({ type: "projectUpdated", project: updated });
    }
    const activeTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
    if (activeTurn) {
      this.turnByProject.set(projectId, activeTurn.id);
      this.onEvent({ type: "working", projectId, threadId, working: true });
    }
    return { items: this.extractItems(thread) };
  }

  private async resumeConversationWithArchiveRecovery(projectId: string, threadId: string): Promise<{ items: ConversationItem[] }> {
    try {
      return await this.resumeConversation(projectId, threadId);
    } catch (error) {
      if (!this.isArchivedThread(error)) throw error;
      await this.unarchiveConversation(projectId, threadId);
      return this.resumeConversation(projectId, threadId);
    }
  }

  private async unarchiveConversation(projectId: string, threadId: string): Promise<Project> {
    await this.ensureAvailable();
    try {
      await this.server.request("thread/unarchive", { threadId });
    } catch (error) {
      this.disableCapability("conversationArchiving", error);
      throw error;
    }
    const project = await this.store.updateConversation(projectId, threadId, { archived: false });
    this.onEvent({ type: "projectUpdated", project });
    return project;
  }

  private async startInternal(): Promise<void> {
    this.setStatus({ state: "starting", authenticated: null, message: null });
    try {
      await this.server.start();
      this.hasConnectedOnce = true;
      await this.refreshAccountState();
    } catch (error) {
      this.setStatus({ state: "unavailable", authenticated: null, message: this.errorMessage(error) });
      throw error;
    }
  }

  private async refreshAccountState(): Promise<void> {
    const account = await this.server.request<AccountResponse>("account/read", { refreshToken: false });
    const authenticated = account.account !== null || account.requiresOpenaiAuth === false;
    this.setStatus({
      state: authenticated ? "ready" : "authenticationRequired",
      authenticated,
      message: authenticated ? null : "Sign in with ChatGPT to use Codex.",
    });
    if (authenticated) {
      await Promise.allSettled([this.loadModels(), this.loadCollaborationModes(), this.loadUsage(), this.loadMcpServers(null)]);
    }
  }

  private async reconnect(exitMessage: string): Promise<void> {
    if (this.reconnecting || this.stopping) return;
    this.reconnecting = true;
    const delays = [1_000, 2_000, 5_000];
    let lastError = exitMessage;
    for (const delay of delays) {
      if (this.stopping) break;
      this.setStatus({ state: "reconnecting", authenticated: null, message: `Codex stopped unexpectedly. Reconnecting in ${delay / 1_000}s…` });
      this.overview.runtime.state = "reconnecting";
      this.emitOverview();
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (this.stopping) break;
      try {
        await this.startInternal();
        this.reconnecting = false;
        this.startPromise = Promise.resolve();
        this.overview.runtime.state = "ready";
        this.emitOverview();
        return;
      } catch (error) {
        lastError = this.errorMessage(error);
      }
    }
    this.reconnecting = false;
    if (!this.stopping) {
      const failure = new Error(lastError);
      this.onStartupFailure?.(failure);
      this.setStatus({ state: "unavailable", authenticated: null, message: lastError });
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const data: unknown[] = [];
      let cursor: string | null = null;
      do {
        const response = this.object(await this.server.request<unknown>("model/list", { includeHidden: false, cursor }));
        data.push(...this.array(response.data));
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      } while (cursor);
      const models: CodexModel[] = data.flatMap((value) => {
        const model = this.object(value);
        if (typeof model.id !== "string" || typeof model.model !== "string") return [];
        return [{
          id: model.id,
          model: model.model,
          displayName: typeof model.displayName === "string" ? model.displayName : model.model,
          description: typeof model.description === "string" ? model.description : "",
          isDefault: model.isDefault === true,
          defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
          supportedReasoningEfforts: this.array(model.supportedReasoningEfforts).flatMap((item) => {
            const effort = this.object(item);
            return typeof effort.reasoningEffort === "string" || typeof effort.effort === "string"
              ? [{ effort: String(effort.reasoningEffort ?? effort.effort), description: typeof effort.description === "string" ? effort.description : "" }]
              : [];
          }),
        }];
      });
      this.overview.catalogs.models = models;
      this.overview.capabilities.models = available();
      this.emitOverview();
    } catch (error) {
      this.disableCapability("models", error);
    }
  }

  private async loadCollaborationModes(): Promise<void> {
    try {
      const response = this.object(await this.server.request<unknown>("collaborationMode/list", {}));
      const modes = new Set<CollaborationMode>();
      for (const entry of this.array(response.data)) {
        const value = this.object(entry);
        if (value.mode === "plan" || String(value.name).toLowerCase() === "plan") modes.add("plan");
        if (value.mode === "default" || String(value.name).toLowerCase() === "default" || String(value.name).toLowerCase() === "work") modes.add("work");
      }
      this.overview.catalogs.collaborationModes = [...modes];
      this.overview.capabilities.collaborationModes = available();
      this.emitOverview();
    } catch (error) {
      this.disableCapability("collaborationModes", error);
    }
  }

  private async loadUsage(): Promise<void> {
    let usageResponse: Record<string, unknown> = {};
    let limitsResponse: Record<string, unknown> = {};
    let success = false;
    try {
      usageResponse = this.object(await this.server.request<unknown>("account/usage/read"));
      success = true;
    } catch {
      // Account token history is unavailable for some auth providers.
    }
    try {
      limitsResponse = this.object(await this.server.request<unknown>("account/rateLimits/read"));
      success = true;
    } catch {
      // Rate limits are unavailable for API-key and some provider configurations.
    }
    if (!success) {
      this.overview.capabilities.usage = { supported: false, reason: "Account usage is unavailable for this Codex configuration." };
      this.overview.accountUsage = null;
      this.emitOverview();
      return;
    }
    const summary = this.object(usageResponse.summary);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const todayBucket = this.array(usageResponse.dailyUsageBuckets).map((item) => this.object(item)).find((item) => item.startDate === today);
    const rateLimits = this.object(limitsResponse.rateLimits);
    this.overview.accountUsage = {
      lifetimeTokens: this.numberOrNull(summary.lifetimeTokens),
      todayTokens: this.numberOrNull(todayBucket?.tokens),
      primary: this.decodeRateLimit(rateLimits.primary),
      secondary: this.decodeRateLimit(rateLimits.secondary),
      spendControlReached: typeof rateLimits.spendControlReached === "boolean" ? rateLimits.spendControlReached : null,
    };
    this.overview.capabilities.usage = available();
    this.emitOverview();
  }

  private async ensureAvailable(): Promise<void> {
    await this.start();
    if (this.overview.status.state !== "ready") throw new Error(this.overview.status.message ?? "Codex is unavailable.");
    if (!this.overview.status.authenticated) throw new Error(this.overview.status.message ?? "Run `codex login` externally.");
  }

  private async ensureServerRunning(): Promise<void> {
    await this.start();
    if (!this.server.isRunning()) throw new Error(this.overview.status.message ?? "Codex is unavailable.");
  }

  private setStatus(status: CodexStatus): void {
    this.overview.status = status;
    this.emitOverview();
  }

  private setAuthFlow(authFlow: CodexOverview["authFlow"]): void {
    this.overview.authFlow = authFlow;
    this.onEvent({ type: "authFlow", authFlow: structuredClone(authFlow) });
    this.emitOverview();
  }

  private emitOverview(): void {
    this.onEvent({ type: "overview", overview: this.getOverview() });
  }

  private disableCapability(capability: keyof CodexCapabilities, error: unknown): void {
    const message = this.errorMessage(error);
    this.overview.capabilities[capability] = { supported: false, reason: `Unsupported by the installed Codex CLI: ${message}` };
    this.emitOverview();
  }

  private handleNotification(notification: ServerMessage): void {
    const params = this.object(notification.params);
    if (notification.method === "account/rateLimits/updated") {
      void this.loadUsage();
      return;
    }
    if (notification.method === "account/login/completed") {
      const success = params.success !== false && typeof params.error !== "string";
      this.setAuthFlow({
        state: success ? "idle" : "failed",
        loginId: null,
        message: success ? null : (typeof params.error === "string" ? params.error : "ChatGPT sign-in failed."),
      });
      if (success) void this.refreshAccountState();
      return;
    }
    if (notification.method === "account/updated") {
      const authenticated = typeof params.authMode === "string";
      this.setStatus({
        state: authenticated ? "ready" : "authenticationRequired",
        authenticated,
        message: authenticated ? null : "Sign in with ChatGPT to use Codex.",
      });
      if (authenticated) void Promise.allSettled([this.loadModels(), this.loadCollaborationModes(), this.loadUsage(), this.loadMcpServers(null)]);
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      this.resolveServerRequest(params.requestId);
      return;
    }
    if (notification.method === "mcpServer/startupStatus/updated") {
      this.updateMcpStartup(params);
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : this.threadIdFromTurnNotification(params);
    const projectId = threadId ? this.findProjectId(threadId) : null;
    if (!projectId || !threadId) return;

    if (notification.method === "turn/started") {
      const turn = this.object(params.turn);
      if (typeof turn.id === "string") this.turnByProject.set(projectId, turn.id);
      this.onEvent({ type: "working", projectId, threadId, working: true });
    } else if (notification.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      this.onEvent({ type: "delta", projectId, threadId, itemId: params.itemId, delta: params.delta });
    } else if (notification.method === "item/plan/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      this.onEvent({
        type: "planDelta",
        projectId,
        threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : "",
        itemId: params.itemId,
        delta: params.delta,
      });
    } else if (notification.method === "item/completed") {
      const item = this.object(params.item);
      if (item.type === "plan" && typeof item.id === "string" && typeof item.text === "string") {
        this.onEvent({
          type: "planCompleted",
          projectId,
          threadId,
          turnId: typeof params.turnId === "string" ? params.turnId : "",
          itemId: item.id,
          text: item.text,
        });
      }
    } else if (notification.method === "turn/plan/updated") {
      this.onEvent({
        type: "planUpdated",
        projectId,
        threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : "",
        explanation: typeof params.explanation === "string" ? params.explanation : null,
        plan: this.decodePlan(params.plan),
      });
    } else if (notification.method === "thread/tokenUsage/updated") {
      const usage = this.decodeTokenUsage(params.tokenUsage);
      this.tokenUsageByThread.set(threadId, usage);
      this.onEvent({ type: "tokenUsage", projectId, threadId, usage });
    } else if (notification.method === "thread/name/updated") {
      void this.updateConversationFromNotification(projectId, threadId, { name: typeof params.name === "string" ? params.name : null });
    } else if (notification.method === "thread/archived") {
      void this.reconcileArchivedNotification(projectId, threadId);
    } else if (notification.method === "thread/unarchived") {
      void this.updateConversationFromNotification(projectId, threadId, { archived: false });
    } else if (notification.method === "thread/deleted") {
      void this.store.removeConversation(projectId, threadId).then((project) => this.onEvent({ type: "projectUpdated", project }));
    } else if (notification.method === "thread/settings/updated") {
      const raw = this.object(params.threadSettings);
      const project = this.store.getProject(projectId);
      const current = project.conversations.find((conversation) => conversation.threadId === threadId);
      if (current) {
        const collaboration = this.object(raw.collaborationMode);
        const mode: CollaborationMode = collaboration.mode === "plan" ? "plan" : "work";
        void this.updateConversationFromNotification(projectId, threadId, {
          settings: {
            model: typeof raw.model === "string" ? raw.model : current.settings.model,
            reasoningEffort: typeof raw.effort === "string" ? raw.effort : current.settings.reasoningEffort,
            mode,
          },
        });
      }
    } else if (notification.method === "turn/completed") {
      this.completeTurn(projectId, threadId, params);
    }
  }

  private completeTurn(projectId: string, threadId: string, params: Record<string, unknown>): void {
    const turn = this.object(params.turn);
    const status = turn.status === "interrupted" || turn.status === "failed" ? turn.status : "completed";
    const error = this.object(turn.error);
    if (typeof turn.id === "string" && this.pendingTurnStarts.has(projectId)) this.completedBeforeStartResponse.add(turn.id);
    this.turnByProject.delete(projectId);
    this.resolveInterruptionWaiters(projectId);
    this.onEvent({ type: "working", projectId, threadId, working: false });
    this.onEvent({ type: "completed", projectId, threadId, status, error: typeof error.message === "string" ? error.message : null });
    this.clearRequestsForThread(threadId);
    void this.updateConversationFromNotification(projectId, threadId, { updatedAt: Date.now() / 1000 });
    void this.refreshProjectConfiguration(projectId).catch((refreshError) => {
      this.onEvent({ type: "error", projectId, message: this.errorMessage(refreshError) });
    });
  }

  private handleServerRequest(request: ServerRequest): void {
    if (request.method === "item/tool/call") {
      this.handleRuntimeTool(request);
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      this.handleToolQuestions(request);
      return;
    }
    if (request.method === "mcpServer/elicitation/request") {
      this.handleMcpElicitation(request);
      return;
    }
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]);
    if (!supported.has(request.method)) {
      this.server.respondError(request.id, -32601, "AppBuilder does not support this request.");
      return;
    }
    const params = this.object(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : typeof params.conversationId === "string" ? params.conversationId : null;
    const projectId = threadId ? this.findProjectId(threadId) : null;
    if (!projectId || !threadId) {
      this.server.respondError(request.id, -32000, "The approval project is not open.");
      return;
    }
    const publicId = randomUUID();
    this.approvals.set(publicId, { publicId, rpcId: request.id, method: request.method, params });
    const approval: ApprovalRequest = {
      id: publicId,
      projectId,
      threadId,
      reason: typeof params.reason === "string" && params.reason.trim() ? params.reason : "Codex needs permission to continue.",
      summary: this.approvalSummary(request.method, params),
      canAcceptForSession: this.canAcceptForSession(request.method, params),
    };
    this.onEvent({ type: "approval", approval });
  }

  private handleRuntimeTool(request: ServerRequest): void {
    const params = this.object(request.params);
    if (params.tool !== "appbuilder_runtime_status") {
      this.server.respondError(request.id, -32601, "AppBuilder does not support this dynamic tool.");
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const projectId = threadId ? this.findProjectId(threadId) : null;
    if (!projectId || !this.runner) {
      this.server.respondError(request.id, -32000, "The runtime status is unavailable for this conversation.");
      return;
    }
    const project = this.store.getProject(projectId);
    const profile = project.runProfiles.find((candidate) => candidate.id === project.selectedRunProfileId) ?? null;
    const status = this.runner.getStatus(projectId);
    const result = {
      profile: profile ? { id: profile.id, name: profile.name, kind: profile.kind ?? "auto" } : null,
      state: status.status,
      target: status.target,
      url: status.url,
      exitCode: status.exitCode,
      failureCode: status.failureCode,
      failure: this.runtimeFailureSummary(status.failureCode),
    };
    this.server.respond(request.id, { contentItems: [{ type: "input_text", text: JSON.stringify(result) }] });
  }

  private runtimeFailureSummary(code: string | null): string | null {
    if (code === "port_in_use") return "The local app port is already in use.";
    if (code === "readiness_timeout") return "The local app did not become ready within 15 seconds.";
    if (code === "open_failed") return "AppBuilder could not open the local app.";
    if (code === "spawn_failed") return "The project process could not be started.";
    if (code === "process_exited") return "The project process exited unexpectedly.";
    return null;
  }

  private handleToolQuestions(request: ServerRequest): void {
    const params = this.object(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const projectId = threadId ? this.findProjectId(threadId) : null;
    if (!threadId || !projectId) {
      this.server.respondError(request.id, -32000, "The request conversation is not available.");
      return;
    }
    const questions: ToolQuestion[] = this.array(params.questions).flatMap((entry) => {
      const value = this.object(entry);
      if (typeof value.id !== "string" || typeof value.question !== "string") return [];
      return [{
        id: value.id,
        header: typeof value.header === "string" ? value.header : "Question",
        question: value.question,
        secret: value.isSecret === true,
        allowOther: value.isOther === true,
        options: Array.isArray(value.options) ? value.options.flatMap((option) => {
          const normalized = this.object(option);
          return typeof normalized.label === "string"
            ? [{ label: normalized.label, description: typeof normalized.description === "string" ? normalized.description : "" }]
            : [];
        }) : null,
      }];
    });
    const publicId = randomUUID();
    this.interactives.set(publicId, { publicId, rpcId: request.id, method: "item/tool/requestUserInput", params });
    const interactive: InteractiveRequest = { id: publicId, projectId, threadId, kind: "questions", questions };
    this.onEvent({ type: "interactiveRequest", request: interactive });
  }

  private handleMcpElicitation(request: ServerRequest): void {
    const params = this.object(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const projectId = threadId ? this.findProjectId(threadId) : null;
    if (!threadId || !projectId) {
      this.server.respond(request.id, { action: "decline", content: null, _meta: null });
      return;
    }
    const publicId = randomUUID();
    const serverName = typeof params.serverName === "string" ? params.serverName : "MCP server";
    const message = typeof params.message === "string" ? params.message : "Additional input is required.";
    let interactive: InteractiveRequest | null = null;
    if (params.mode === "url" && typeof params.url === "string" && this.isSafeHttpUrl(params.url)) {
      interactive = { id: publicId, projectId, threadId, kind: "mcpUrl", serverName, message, url: params.url };
    } else if (params.mode === "form" || params.mode === "openai/form") {
      const fields = this.decodeMcpForm(params.requestedSchema);
      if (fields) interactive = { id: publicId, projectId, threadId, kind: "mcpForm", serverName, message, fields };
    }
    if (!interactive) {
      this.server.respond(request.id, { action: "decline", content: null, _meta: null });
      return;
    }
    this.interactives.set(publicId, { publicId, rpcId: request.id, method: "mcpServer/elicitation/request", params });
    this.onEvent({ type: "interactiveRequest", request: interactive });
  }

  private decodeMcpForm(schemaValue: unknown): McpFormField[] | null {
    const schema = this.object(schemaValue);
    if (schema.type !== "object" || !this.isPlainObject(schema.properties)) return null;
    const required = new Set(this.array(schema.required).filter((value): value is string => typeof value === "string"));
    const fields: McpFormField[] = [];
    for (const [id, rawValue] of Object.entries(schema.properties as Record<string, unknown>)) {
      const value = this.object(rawValue);
      const title = typeof value.title === "string" ? value.title : id;
      const description = typeof value.description === "string" ? value.description : "";
      const base = {
        id,
        label: title,
        description,
        required: required.has(id),
        secret: value.format === "password",
        minimum: this.numberOrNull(value.minimum),
        maximum: this.numberOrNull(value.maximum),
        minLength: this.numberOrNull(value.minLength),
        maxLength: this.numberOrNull(value.maxLength),
      };
      const oneOf = this.array(value.oneOf);
      const enumValues = this.array(value.enum);
      if (value.type === "array") {
        const items = this.object(value.items);
        const options = this.enumOptions(items);
        if (!options) return null;
        fields.push({ ...base, type: "multiSelect", options, defaultValue: Array.isArray(value.default) ? value.default.map(String) : [] });
      } else if (oneOf.length > 0 || enumValues.length > 0) {
        const options = this.enumOptions(value);
        if (!options) return null;
        fields.push({ ...base, type: "singleSelect", options, defaultValue: typeof value.default === "string" ? value.default : null });
      } else if (value.type === "string") {
        fields.push({ ...base, type: "string", options: null, defaultValue: typeof value.default === "string" ? value.default : null });
      } else if (value.type === "number" || value.type === "integer") {
        fields.push({ ...base, type: value.type, options: null, defaultValue: typeof value.default === "number" ? value.default : null });
      } else if (value.type === "boolean") {
        fields.push({ ...base, type: "boolean", options: null, defaultValue: typeof value.default === "boolean" ? value.default : false });
      } else {
        return null;
      }
    }
    return fields;
  }

  private enumOptions(value: Record<string, unknown>): Array<{ value: string; label: string }> | null {
    const oneOf = this.array(value.oneOf);
    if (oneOf.length > 0) {
      const options = oneOf.flatMap((entry) => {
        const option = this.object(entry);
        return typeof option.const === "string" ? [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const }] : [];
      });
      return options.length === oneOf.length ? options : null;
    }
    const direct = this.array(value.enum);
    if (direct.length > 0 && direct.every((entry) => typeof entry === "string")) {
      const names = this.array(value.enumNames);
      return direct.map((entry, index) => ({ value: String(entry), label: typeof names[index] === "string" ? String(names[index]) : String(entry) }));
    }
    const items = this.object(value.items);
    if (Object.keys(items).length > 0) return this.enumOptions(items);
    const anyOf = this.array(value.anyOf);
    if (anyOf.length > 0) return this.enumOptions({ oneOf: anyOf });
    return null;
  }

  private startThread(cwd: string, settings: ConversationSettings, permissionMode: ProjectPermissionMode): Promise<ThreadResponse> {
    const model = this.turnSettings(settings).model;
    return this.requestThread<ThreadResponse>("thread/start", {
      cwd,
      approvalPolicy: permissionMode === "ask" ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: permissionMode === "fullAccess" ? "danger-full-access" : "workspace-write",
      historyMode: "legacy",
      ...(typeof model === "string" ? { model } : {}),
    });
  }

  private requestThread<T>(method: "thread/start" | "thread/resume", params: Record<string, unknown>): Promise<T> {
    const dynamicTools = [{
      name: "appbuilder_runtime_status",
      description: "Read the selected AppBuilder project's safe runtime state. It returns no paths, commands, arguments, or process output.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }];
    const request = () => this.server.request<T>(method, this.runtimeToolEnabled ? { ...params, dynamicTools } : params);
    return request().catch(async (error) => {
      const message = this.errorMessage(error).toLowerCase();
      if (!this.runtimeToolEnabled || !message.includes("dynamic")) throw error;
      this.runtimeToolEnabled = false;
      return this.server.request<T>(method, params);
    });
  }

  private permissionSettings(permissionMode: ProjectPermissionMode, attachments: CodexInputAttachment[] = []): Record<string, unknown> {
    if (permissionMode === "fullAccess") {
      return {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    }
    return {
      approvalPolicy: permissionMode === "ask" ? "on-request" : "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [...new Set(attachments.map((attachment) => dirname(attachment.path)))],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }

  private turnSettings(settings: ConversationSettings): Record<string, unknown> {
    const model = settings.model ?? this.overview.catalogs.models.find((candidate) => candidate.isDefault)?.model
      ?? this.overview.catalogs.models[0]?.model;
    const effort = settings.reasoningEffort
      ?? this.overview.catalogs.models.find((candidate) => candidate.model === model)?.defaultReasoningEffort
      ?? null;
    const result: Record<string, unknown> = {};
    if (model) result.model = model;
    if (effort) result.effort = effort;
    if (this.overview.capabilities.collaborationModes.supported && model) {
      result.collaborationMode = {
        mode: settings.mode === "plan" ? "plan" : "default",
        settings: { model, reasoning_effort: effort, developer_instructions: null },
      };
    }
    return result;
  }

  private buildTurnInput(text: string, attachments: CodexInputAttachment[]): TurnInput[] {
    const input: TurnInput[] = [];
    const messageText = text.trim();
    if (messageText) input.push({ type: "text", text: messageText, text_elements: [] });
    for (const attachment of attachments) {
      if (attachment.kind === "image") input.push({ type: "localImage", path: attachment.path, detail: "auto" });
      else input.push({
        type: "text",
        text: `${FILE_ATTACHMENT_PREFIX}${JSON.stringify({ id: attachment.id, name: attachment.name, path: attachment.path, size: attachment.size })}`,
        text_elements: [],
      });
    }
    if (input.length === 0) throw new Error("Enter a message or attach a file.");
    return input;
  }

  private threadRecord(thread: Thread, settings: ConversationSettings, preview: string, now: number): ConversationRecord {
    return {
      threadId: thread.id,
      name: typeof thread.name === "string" ? thread.name : null,
      preview: typeof thread.preview === "string" && thread.preview ? thread.preview : preview,
      archived: false,
      createdAt: typeof thread.createdAt === "number" ? thread.createdAt : now,
      updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : now,
      settings: structuredClone(settings),
    };
  }

  private extractItems(thread: Thread): ConversationItem[] {
    const items: ConversationItem[] = [];
    const seen = new Set<string>();
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        if (seen.has(item.id)) continue;
        if (item.type === "userMessage") {
          const message = this.userMessage(item);
          if (message) items.push(message);
        } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
          items.push({ type: "message", id: item.id, role: "assistant", text: item.text });
        } else if (item.type === "plan" && typeof item.text === "string") {
          items.push({ type: "plan", id: item.id, turnId: turn.id, text: item.text, explanation: null, steps: [] });
        }
        seen.add(item.id);
      }
    }
    return items;
  }

  private userMessage(item: ThreadItem): ConversationMessage | null {
    const textParts: string[] = [];
    const attachments: ConversationMessage["attachments"] = [];
    for (const [index, part] of (item.content ?? []).entries()) {
      if (part.type === "text" && typeof part.text === "string") {
        const attachment = this.fileAttachmentFromText(part.text);
        if (attachment) attachments.push(attachment);
        else textParts.push(part.text);
      } else if (part.type === "localImage" && typeof part.path === "string") {
        attachments.push({ id: `${item.id}-image-${index}`, name: this.restoredAttachmentName(part.path), kind: "image", size: null });
      } else if (part.type === "image" && typeof part.url === "string") {
        attachments.push({ id: `${item.id}-image-${index}`, name: "Image", kind: "image", size: null });
      }
    }
    const text = textParts.join("\n");
    if (!text && attachments.length === 0) return null;
    return { type: "message", id: item.id, role: "user", text, ...(attachments.length > 0 ? { attachments } : {}) };
  }

  private decodePlan(value: unknown): PlanStep[] {
    return this.array(value).flatMap((entry) => {
      const item = this.object(entry);
      if (typeof item.step !== "string") return [];
      const status = item.status === "inProgress" || item.status === "completed" ? item.status : "pending";
      return [{ step: item.step, status }];
    });
  }

  private decodeTokenUsage(value: unknown): ThreadTokenUsage {
    const usage = this.object(value);
    const total = this.object(usage.total);
    const last = this.object(usage.last);
    return {
      totalTokens: this.numberOrZero(total.totalTokens ?? total.total_tokens),
      contextTokens: this.numberOrZero(last.totalTokens ?? last.total_tokens),
      inputTokens: this.numberOrZero(total.inputTokens ?? total.input_tokens),
      cachedInputTokens: this.numberOrZero(total.cachedInputTokens ?? total.cached_input_tokens),
      outputTokens: this.numberOrZero(total.outputTokens ?? total.output_tokens),
      reasoningOutputTokens: this.numberOrZero(total.reasoningOutputTokens ?? total.reasoning_output_tokens),
      modelContextWindow: this.numberOrNull(usage.modelContextWindow ?? usage.model_context_window),
    };
  }

  private decodeRateLimit(value: unknown): AccountUsage["primary"] {
    const window = this.object(value);
    if (typeof window.usedPercent !== "number") return null;
    return {
      usedPercent: window.usedPercent,
      windowDurationMins: this.numberOrNull(window.windowDurationMins),
      resetsAt: this.numberOrNull(window.resetsAt),
    };
  }

  private decodeMcpServer(value: unknown, previous: McpServerSummary[]): McpServerSummary {
    const server = this.object(value);
    const info = this.object(server.serverInfo);
    const name = typeof server.name === "string" ? server.name : "Unknown MCP";
    const prior = previous.find((candidate) => candidate.name === name);
    const auth = typeof server.authStatus === "string" ? server.authStatus : "unknown";
    const toolCount = Object.keys(this.object(server.tools)).length;
    const inferredReady = auth !== "notLoggedIn" && (toolCount > 0 || Object.keys(info).length > 0);
    return {
      name,
      title: typeof info.title === "string" ? info.title : null,
      authStatus: auth === "unsupported" || auth === "notLoggedIn" || auth === "bearerToken" || auth === "oAuth" ? auth : "unknown",
      startupState: prior?.startupState ?? (inferredReady ? "ready" : "unknown"),
      toolCount,
      error: prior?.error ?? null,
    };
  }

  private updateMcpStartup(params: Record<string, unknown>): void {
    if (typeof params.name !== "string") return;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const projectId = threadId ? this.findProjectId(threadId) : null;
    const current = projectId ? (this.mcpByProject.get(projectId) ?? []) : this.globalMcp;
    const index = current.findIndex((server) => server.name === params.name);
    const status = params.status === "starting" || params.status === "ready" || params.status === "failed" || params.status === "cancelled" ? params.status : "unknown";
    const updated = [...current];
    if (index >= 0) updated[index] = { ...updated[index], startupState: status, error: typeof params.error === "string" ? params.error : null };
    else updated.push({ name: params.name, title: null, authStatus: "unknown", startupState: status, toolCount: 0, error: typeof params.error === "string" ? params.error : null });
    if (projectId) this.mcpByProject.set(projectId, updated);
    else this.globalMcp = updated;
    this.onEvent({ type: "mcpUpdated", projectId, servers: structuredClone(updated) });
  }

  private async updateConversationFromNotification(projectId: string, threadId: string, update: Partial<Omit<ConversationRecord, "threadId">>): Promise<void> {
    try {
      const project = await this.store.updateConversation(projectId, threadId, update);
      this.onEvent({ type: "projectUpdated", project });
    } catch {
      // Notifications for unassociated descendant threads are intentionally ignored.
    }
  }

  private async reconcileArchivedNotification(projectId: string, threadId: string): Promise<void> {
    try {
      let project = await this.store.updateConversation(projectId, threadId, { archived: true });
      if (project.activeThreadId === threadId) project = await this.store.clearActiveConversation(projectId);
      this.clearRequestsForThread(threadId);
      this.onEvent({ type: "projectUpdated", project });
    } catch {
      // Notifications for unassociated descendant threads are intentionally ignored.
    }
  }

  private resolveServerRequest(requestId: unknown): void {
    for (const [publicId, pending] of this.approvals) {
      if (String(pending.rpcId) === String(requestId)) this.approvals.delete(publicId);
    }
    for (const [publicId, pending] of this.interactives) {
      if (String(pending.rpcId) === String(requestId)) {
        this.interactives.delete(publicId);
        this.onEvent({ type: "interactiveResolved", requestId: publicId });
      }
    }
  }

  private clearRequestsForThread(threadId: string): void {
    for (const [publicId, pending] of this.interactives) {
      if (pending.params.threadId === threadId) {
        this.interactives.delete(publicId);
        this.onEvent({ type: "interactiveResolved", requestId: publicId });
      }
    }
  }

  private clearAllRequests(): void {
    this.approvals.clear();
    for (const publicId of this.interactives.keys()) {
      this.onEvent({ type: "interactiveResolved", requestId: publicId });
    }
    this.interactives.clear();
  }

  private resolveInterruptionWaiters(projectId: string): void {
    for (const resolve of this.interruptionWaiters.get(projectId) ?? []) resolve();
    this.interruptionWaiters.delete(projectId);
  }

  private approvalSummary(method: string, params: Record<string, unknown>): string {
    if (method.includes("command") || method === "execCommandApproval") {
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      return typeof command === "string" && command.trim() ? command.slice(0, 500) : "Run a command in the project";
    }
    if (method === "applyPatchApproval") {
      const files = Object.keys(this.object(params.fileChanges));
      return files.length ? `Change ${files.slice(0, 6).join(", ")}${files.length > 6 ? "…" : ""}` : "Change project files";
    }
    if (method === "item/permissions/requestApproval") return `Use additional permissions in ${typeof params.cwd === "string" ? params.cwd : "the project"}`;
    return typeof params.grantRoot === "string" ? `Change files under ${params.grantRoot}` : "Change project files";
  }

  private canAcceptForSession(method: string, params: Record<string, unknown>): boolean {
    if (method !== "item/commandExecution/requestApproval") return true;
    return !Array.isArray(params.availableDecisions) || params.availableDecisions.includes("acceptForSession");
  }

  private findProjectId(threadId: string): string | null {
    const mapped = this.projectByThread.get(threadId);
    if (mapped) return mapped;
    const project = this.store.getState().projects.find((candidate) => candidate.conversations.some((conversation) => conversation.threadId === threadId));
    if (project) this.projectByThread.set(threadId, project.id);
    return project?.id ?? null;
  }

  private threadIdFromTurnNotification(params: Record<string, unknown>): string | null {
    const turn = this.object(params.turn);
    if (typeof turn.threadId === "string") return turn.threadId;
    return null;
  }

  private async refreshProjectConfiguration(projectId: string): Promise<void> {
    const before = this.store.getProject(projectId);
    const project = await this.store.refreshConfiguration(projectId);
    if (JSON.stringify([before.runProfiles, before.selectedRunProfileId]) !== JSON.stringify([project.runProfiles, project.selectedRunProfileId])) {
      this.onEvent({ type: "projectUpdated", project });
    }
  }

  private fileAttachmentFromText(text: string): ChatAttachment | null {
    if (!text.startsWith(FILE_ATTACHMENT_PREFIX)) return null;
    try {
      const value = this.object(JSON.parse(text.slice(FILE_ATTACHMENT_PREFIX.length)));
      if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string") return null;
      return { id: value.id, name: value.name, kind: "file", size: typeof value.size === "number" ? value.size : null };
    } catch {
      return null;
    }
  }

  private restoredAttachmentName(path: string): string {
    return basename(path).replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
  }

  private isSafeHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  private isMissingThread(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("no rollout found") || message.includes("thread not found") || message.includes("session not found");
  }

  private isArchivedThread(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("is archived") && (message.includes("session") || message.includes("thread"));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private object(value: unknown): Record<string, unknown> {
    return this.isPlainObject(value) ? value : {};
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private numberOrZero(value: unknown): number {
    return this.numberOrNull(value) ?? 0;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
  }
}
