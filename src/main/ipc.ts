import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { app, clipboard, dialog, shell, type BrowserWindow } from "electron";
import type {
  AddProjectInput,
  AppSettings,
  AppSnapshot,
  ChatAttachmentKind,
  ConversationSettings,
  ConversationSwitchDisposition,
  ConversationExportInput,
  InteractiveResponse,
  PendingChatAttachment,
  ProjectPermissionMode,
  ProjectConfiguration,
  SendMessageInput,
} from "../shared/types";
import { channels } from "../shared/channels";
import type { ProjectStore } from "./projects/ProjectStore";
import type { ProjectRunner } from "./runtime/ProjectRunner";
import type { ApprovalDecision } from "../shared/types";
import type { CodexInputAttachment, CodexSessionManager } from "./codex/CodexSessionManager";
import type { CodexRuntimeManager } from "./codex/CodexRuntimeManager";
import { conversationToMarkdown } from "./conversation/ConversationExporter";
import { handleIpc } from "./ipcResult";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const MAX_ATTACHMENTS = 10;
const ATTACHMENT_SELECTION_TTL_MS = 60 * 60 * 1000;

interface PendingAttachmentSelection extends PendingChatAttachment {
  projectId: string;
  path: string;
  selectedAt: number;
}

function attachmentKind(path: string): ChatAttachmentKind {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) ? "image" : "file";
}

function safeAttachmentName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 160) || "attachment";
}

interface IpcDependencies {
  getWindow(): BrowserWindow | null;
  attachmentsRoot: string;
  codex: CodexSessionManager;
  runner: ProjectRunner;
  store: ProjectStore;
  runtimeManager: CodexRuntimeManager;
}

export function registerIpc({ getWindow, attachmentsRoot, codex, runner, store, runtimeManager }: IpcDependencies): void {
  const pendingAttachments = new Map<string, PendingAttachmentSelection>();

  const prunePendingAttachments = () => {
    const cutoff = Date.now() - ATTACHMENT_SELECTION_TTL_MS;
    for (const [token, attachment] of pendingAttachments) {
      if (attachment.selectedAt < cutoff) pendingAttachments.delete(token);
    }
  };

  const openProject = async (projectId: string) => {
    try {
      return await codex.openProject(projectId);
    } catch (error) {
      const status = codex.getStatus();
      if (status.state === "ready" && status.authenticated) throw error;
      return { project: store.getProject(projectId), items: [] };
    }
  };

  handleIpc(channels.appSnapshot, (): AppSnapshot => {
    const state = store.getState();
    return {
      state,
      runtimes: runner.getStatuses(state.projects.map((project) => project.id)),
      codex: codex.getOverview(),
    };
  });

  handleIpc(channels.appSettingsUpdate, (_event, settings: AppSettings) => {
    if (!settings || settings.defaultMode !== "work" || typeof settings.sidebarCollapsed !== "boolean") throw new Error("Application settings are invalid.");
    if (typeof settings.showModeControl !== "boolean" || typeof settings.showPermissionControl !== "boolean" || typeof settings.showMcpStatus !== "boolean") {
      throw new Error("Interface visibility settings are invalid.");
    }
    if (settings.defaultModel !== null && typeof settings.defaultModel !== "string") throw new Error("Default model is invalid.");
    if (settings.defaultReasoningEffort !== null && typeof settings.defaultReasoningEffort !== "string") throw new Error("Default reasoning effort is invalid.");
    if (!settings.codexRuntime || !["auto", "custom", "managed"].includes(settings.codexRuntime.preference)) {
      throw new Error("Codex runtime settings are invalid.");
    }
    return store.updateSettings(settings);
  });

  handleIpc(channels.appOpenExternal, async (_event, value: string) => {
    if (typeof value !== "string" || value.length > 4_096) throw new Error("External URL is invalid.");
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) links may be opened.");
    await shell.openExternal(url.toString());
  });

  handleIpc(channels.appRestart, () => {
    app.relaunch();
    app.exit(0);
  });

  handleIpc(channels.projectAdd, async (_event, input: AddProjectInput) => {
    const project = await store.add(input);
    return openProject(project.id);
  });

  handleIpc(channels.projectSelect, async (_event, projectId: string) => {
    await store.select(projectId);
    await store.refreshConfiguration(projectId);
    return openProject(projectId);
  });

  handleIpc(channels.projectSelectProfile, async (_event, projectId: string, profileId: string) => {
    await store.selectRunProfile(projectId, profileId);
  });

  handleIpc(channels.projectSetPermissionMode, (_event, projectId: string, permissionMode: ProjectPermissionMode) => {
    if (permissionMode !== "ask" && permissionMode !== "workspace" && permissionMode !== "fullAccess") {
      throw new Error("Project permission mode is invalid.");
    }
    return codex.updateProjectPermissionMode(projectId, permissionMode);
  });

  handleIpc(channels.projectOpenConfiguration, async (_event, projectId: string) => {
    const project = store.getProject(projectId);
    const configurationPath = join(project.path, ".appbuilder", "config.json");
    const info = await stat(configurationPath).catch(() => null);
    if (!info?.isFile()) throw new Error("Project run configuration does not exist.");
    const openError = await shell.openPath(configurationPath);
    if (openError) throw new Error(openError);
  });

  handleIpc(channels.projectRefreshConfiguration, (_event, projectId: string) => store.refreshConfiguration(projectId));
  handleIpc(channels.projectInspectConfiguration, (_event, projectId: string) => store.inspectConfiguration(projectId));
  handleIpc(channels.projectSaveConfiguration, (_event, projectId: string, configuration: ProjectConfiguration) => store.saveConfiguration(projectId, configuration));
  handleIpc(channels.projectArchive, async (_event, projectId: string) => {
    await Promise.allSettled([codex.interrupt(projectId), runner.stop(projectId)]);
    return store.setArchived(projectId, true);
  });
  handleIpc(channels.projectRestore, (_event, projectId: string) => store.setArchived(projectId, false));
  handleIpc(channels.projectRemove, async (_event, projectId: string) => {
    store.getProject(projectId);
    await Promise.allSettled([
      codex.interrupt(projectId),
      runner.stop(projectId),
      rm(join(attachmentsRoot, projectId), { recursive: true, force: true }),
    ]);
    return store.remove(projectId);
  });
  handleIpc(channels.clipboardCopy, (_event, text: string) => {
    if (typeof text !== "string" || text.length > 20_000) throw new Error("Clipboard text is invalid.");
    clipboard.writeText(text);
  });

  handleIpc(channels.projectChooseDirectory, async () => {
    const owner = getWindow() ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleIpc(channels.projectSuggestPath, (_event, displayName: string) => {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 120) {
      throw new Error("Project display name is invalid.");
    }
    const folderName = displayName
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "new-project";
    return join(app.getPath("documents"), "AppBuilder Projects", folderName);
  });

  handleIpc(channels.codexChooseAttachments, async (_event, projectId: string): Promise<PendingChatAttachment[]> => {
    const project = store.getProject(projectId);
    const owner = getWindow() ?? undefined;
    const options: Electron.OpenDialogOptions = {
      defaultPath: project.path,
      properties: ["openFile", "multiSelections"],
      title: "Attach photos or files",
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];

    prunePendingAttachments();
    const attachments: PendingChatAttachment[] = [];
    for (const path of result.filePaths.slice(0, MAX_ATTACHMENTS)) {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      const id = randomUUID();
      const attachment: PendingAttachmentSelection = {
        id,
        token: id,
        projectId,
        path,
        name: basename(path),
        kind: attachmentKind(path),
        size: metadata.size,
        selectedAt: Date.now(),
      };
      pendingAttachments.set(attachment.token, attachment);
      const { projectId: _projectId, path: _path, selectedAt: _selectedAt, ...publicAttachment } = attachment;
      attachments.push(publicAttachment);
    }
    return attachments;
  });

  handleIpc(channels.runtimeStart, (_event, projectId: string) => runner.start(projectId));
  handleIpc(channels.runtimeRestart, (_event, projectId: string) => runner.restart(projectId));
  handleIpc(channels.runtimeStop, (_event, projectId: string) => runner.stop(projectId));
  handleIpc(channels.runtimeOpen, (_event, projectId: string) => runner.open(projectId));
  handleIpc(channels.codexSend, async (_event, projectId: string, input: SendMessageInput) => {
    if (!input || typeof input.text !== "string" || input.text.length > 200_000 || !Array.isArray(input.attachmentTokens)) {
      throw new Error("Message input is invalid.");
    }
    const tokens = [...new Set(input.attachmentTokens)];
    if (tokens.length > MAX_ATTACHMENTS || tokens.some((token) => typeof token !== "string")) {
      throw new Error(`A message may include at most ${MAX_ATTACHMENTS} attachments.`);
    }
    if (!input.text.trim() && tokens.length === 0) throw new Error("Enter a message or attach a file.");

    prunePendingAttachments();
    const selections = tokens.map((token) => pendingAttachments.get(token));
    if (selections.some((selection) => !selection || selection.projectId !== projectId)) {
      throw new Error("An attachment selection expired. Please attach it again.");
    }

    const turnAttachmentRoot = join(attachmentsRoot, projectId, randomUUID());
    const staged: CodexInputAttachment[] = [];
    let createdAttachmentRoot = false;
    try {
      if (selections.length > 0) {
        await mkdir(turnAttachmentRoot, { recursive: true, mode: 0o700 });
        createdAttachmentRoot = true;
      }
      for (const selection of selections as PendingAttachmentSelection[]) {
        const path = join(turnAttachmentRoot, `${selection.id}-${safeAttachmentName(selection.name)}`);
        await copyFile(selection.path, path);
        staged.push({
          id: selection.id,
          name: selection.name,
          kind: selection.kind,
          size: selection.size,
          path,
        });
      }
      await codex.send(projectId, input.text, staged);
      for (const token of tokens) pendingAttachments.delete(token);
    } catch (error) {
      if (createdAttachmentRoot) await rm(turnAttachmentRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
  handleIpc(channels.codexInterrupt, (_event, projectId: string) => codex.interrupt(projectId));
  handleIpc(channels.codexInterruptLifecycle, (_event, projectId: string) => codex.interruptForLifecycle(projectId));
  handleIpc(channels.codexApproval, (_event, approvalId: string, decision: ApprovalDecision) => {
    codex.respondToApproval(approvalId, decision);
  });
  handleIpc(channels.codexInteractive, (_event, requestId: string, response: InteractiveResponse) => {
    codex.respondToInteractive(requestId, response);
  });
  handleIpc(channels.codexNewConversation, (_event, projectId: string, disposition: ConversationSwitchDisposition) => codex.beginConversation(projectId, disposition));
  handleIpc(channels.codexOpenConversation, (_event, projectId: string, threadId: string, disposition: ConversationSwitchDisposition) => codex.openConversation(projectId, threadId, disposition));
  handleIpc(channels.codexRenameConversation, (_event, projectId: string, threadId: string, name: string) => codex.renameConversation(projectId, threadId, name));
  handleIpc(channels.codexArchiveConversation, (_event, projectId: string, threadId: string) => codex.archiveConversation(projectId, threadId));
  handleIpc(channels.codexRestoreConversation, (_event, projectId: string, threadId: string, disposition: ConversationSwitchDisposition) => codex.restoreConversation(projectId, threadId, disposition));
  handleIpc(channels.codexDeleteConversation, (_event, projectId: string, threadId: string) => codex.deleteConversation(projectId, threadId));
  handleIpc(channels.codexUpdateConversationSettings, (_event, projectId: string, settings: ConversationSettings) => codex.updateConversationSettings(projectId, settings));
  handleIpc(channels.codexThreadUsage, (_event, projectId: string) => codex.getThreadUsage(projectId));
  handleIpc(channels.codexRefreshUsage, () => codex.refreshAccountUsage());
  handleIpc(channels.codexListMcp, (_event, projectId: string | null) => codex.listMcpServers(projectId));

  const startSelectedRuntime = async (selection: () => Promise<ReturnType<CodexRuntimeManager["getInfo"]>>) => {
    await codex.stop();
    const runtime = await selection();
    codex.setRuntimeInfo(runtime);
    if (runtime.state !== "starting") return;
    try {
      runtimeManager.markStarting();
      codex.setRuntimeInfo(runtimeManager.getInfo());
      await codex.start();
      runtimeManager.markReady();
      codex.setRuntimeInfo(runtimeManager.getInfo());
    } catch (error) {
      codex.setRuntimeInfo(runtimeManager.recordStartupFailure(error));
      throw error;
    }
  };

  handleIpc(channels.codexRuntimeRetry, () => startSelectedRuntime(() => runtimeManager.resolve()));
  handleIpc(channels.codexRuntimeAutomatic, () => startSelectedRuntime(() => runtimeManager.useAutomatic()));
  handleIpc(channels.codexRuntimeManaged, () => startSelectedRuntime(() => runtimeManager.useManaged()));
  handleIpc(channels.codexRuntimeCustom, (_event, path: string) => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Select a Codex executable.");
    return startSelectedRuntime(() => runtimeManager.useCustom(path));
  });
  handleIpc(channels.codexRuntimeChooseExecutable, async () => {
    const owner = getWindow() ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { title: "Choose Codex executable", properties: ["openFile"] })
      : await dialog.showOpenDialog({ title: "Choose Codex executable", properties: ["openFile"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleIpc(channels.codexLogin, async () => {
    const { authUrl } = await codex.startChatGptLogin();
    await shell.openExternal(authUrl);
  });
  handleIpc(channels.codexLoginCancel, () => codex.cancelChatGptLogin());
  handleIpc(channels.codexLogout, () => codex.logout());
  handleIpc(channels.codexExportConversation, async (_event, input: ConversationExportInput) => {
    if (!input || typeof input.projectName !== "string" || typeof input.conversationName !== "string" || !Array.isArray(input.items)) {
      throw new Error("Conversation export is invalid.");
    }
    const owner = getWindow() ?? undefined;
    const fileName = `${safeAttachmentName(input.conversationName || "conversation")}.md`;
    const result = owner
      ? await dialog.showSaveDialog(owner, { title: "Export Conversation", defaultPath: fileName, filters: [{ name: "Markdown", extensions: ["md"] }] })
      : await dialog.showSaveDialog({ title: "Export Conversation", defaultPath: fileName, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (result.canceled || !result.filePath) return { path: null, canceled: true };
    await writeFile(result.filePath, conversationToMarkdown(input), "utf8");
    return { path: result.filePath, canceled: false };
  });
}
