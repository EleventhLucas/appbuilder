import { contextBridge, ipcRenderer } from "electron";
import type { Channels } from "../shared/channels";
import type { AppBuilderApi } from "./api";
import type { AppErrorDto } from "../shared/types";

// Sandboxed Electron preload scripts cannot load relative CommonJS modules.
// Keep this compile-time checked copy inline so the emitted preload is self-contained.
const channels: Channels = {
  bootstrapGet: "bootstrap:get",
  bootstrapRetry: "bootstrap:retry",
  bootstrapRestore: "bootstrap:restore",
  bootstrapReset: "bootstrap:reset",
  bootstrapExportDiagnostics: "bootstrap:export-diagnostics",
  bootstrapEvent: "bootstrap:event",
  appSnapshot: "app:snapshot",
  appSettingsUpdate: "app:settings-update",
  appOpenExternal: "app:open-external",
  appRestart: "app:restart",
  projectAdd: "projects:add",
  projectSelect: "projects:select",
  projectSelectProfile: "projects:select-profile",
  projectSetPermissionMode: "projects:set-permission-mode",
  projectOpenConfiguration: "projects:open-configuration",
  projectRefreshConfiguration: "projects:refresh-configuration",
  projectInspectConfiguration: "projects:inspect-configuration",
  projectSaveConfiguration: "projects:save-configuration",
  projectArchive: "projects:archive",
  projectRestore: "projects:restore",
  projectRemove: "projects:remove",
  projectChooseDirectory: "projects:choose-directory",
  projectSuggestPath: "projects:suggest-path",
  clipboardCopy: "app:clipboard-copy",
  codexChooseAttachments: "codex:choose-attachments",
  codexSend: "codex:send",
  codexInterrupt: "codex:interrupt",
  codexInterruptLifecycle: "codex:interrupt-lifecycle",
  codexApproval: "codex:approval",
  codexInteractive: "codex:interactive",
  codexNewConversation: "codex:conversation-new",
  codexOpenConversation: "codex:conversation-open",
  codexRenameConversation: "codex:conversation-rename",
  codexArchiveConversation: "codex:conversation-archive",
  codexRestoreConversation: "codex:conversation-restore",
  codexDeleteConversation: "codex:conversation-delete",
  codexUpdateConversationSettings: "codex:conversation-settings",
  codexThreadUsage: "codex:thread-usage",
  codexRefreshUsage: "codex:refresh-usage",
  codexListMcp: "codex:list-mcp",
  codexRuntimeRetry: "codex:runtime-retry",
  codexRuntimeAutomatic: "codex:runtime-automatic",
  codexRuntimeManaged: "codex:runtime-managed",
  codexRuntimeCustom: "codex:runtime-custom",
  codexRuntimeChooseExecutable: "codex:runtime-choose-executable",
  codexLogin: "codex:login",
  codexLoginCancel: "codex:login-cancel",
  codexLogout: "codex:logout",
  codexExportConversation: "codex:export-conversation",
  codexEvent: "codex:event",
  runtimeStart: "runtime:start",
  runtimeRestart: "runtime:restart",
  runtimeStop: "runtime:stop",
  runtimeOpen: "runtime:open",
  runtimeEvent: "runtime:event",
};

interface IpcResult<T> {
  ok: boolean;
  value?: T;
  error?: AppErrorDto;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T> | T;
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) return result.value as T;
    const error = result.error ?? {
      code: "IPC_FAILED",
      message: "The operation failed.",
      details: null,
      retryable: false,
    };
    throw Object.assign(new Error(error.message), { name: "AppBuilderClientError", appError: error });
  }
  return result as T;
}

const api: AppBuilderApi = {
  bootstrap: {
    get: () => invoke(channels.bootstrapGet),
    retry: () => invoke(channels.bootstrapRetry),
    restore: (backupId) => invoke(channels.bootstrapRestore, backupId),
    reset: () => invoke(channels.bootstrapReset),
    exportDiagnostics: () => invoke(channels.bootstrapExportDiagnostics),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(channels.bootstrapEvent, handler);
      return () => ipcRenderer.removeListener(channels.bootstrapEvent, handler);
    },
  },
  snapshot: () => invoke(channels.appSnapshot),
  app: {
    restart: () => invoke(channels.appRestart),
  },
  settings: {
    update: (settings) => invoke(channels.appSettingsUpdate, settings),
  },
  projects: {
    add: (input) => invoke(channels.projectAdd, input),
    select: (projectId) => invoke(channels.projectSelect, projectId),
    selectRunProfile: (projectId, profileId) => invoke(channels.projectSelectProfile, projectId, profileId),
    setPermissionMode: (projectId, permissionMode) => invoke(channels.projectSetPermissionMode, projectId, permissionMode),
    openConfiguration: (projectId) => invoke(channels.projectOpenConfiguration, projectId),
    refreshConfiguration: (projectId) => invoke(channels.projectRefreshConfiguration, projectId),
    inspectConfiguration: (projectId) => invoke(channels.projectInspectConfiguration, projectId),
    saveConfiguration: (projectId, configuration) => invoke(channels.projectSaveConfiguration, projectId, configuration),
    archive: (projectId) => invoke(channels.projectArchive, projectId),
    restore: (projectId) => invoke(channels.projectRestore, projectId),
    remove: (projectId) => invoke(channels.projectRemove, projectId),
    chooseDirectory: () => invoke(channels.projectChooseDirectory),
    suggestPath: (displayName) => invoke(channels.projectSuggestPath, displayName),
  },
  clipboard: {
    copy: (text) => invoke(channels.clipboardCopy, text),
  },
  external: {
    open: (url) => invoke(channels.appOpenExternal, url),
  },
  codex: {
    chooseAttachments: (projectId) => invoke(channels.codexChooseAttachments, projectId),
    send: (projectId, input) => invoke(channels.codexSend, projectId, input),
    interrupt: (projectId) => invoke(channels.codexInterrupt, projectId),
    interruptForLifecycle: (projectId) => invoke(channels.codexInterruptLifecycle, projectId),
    respondToApproval: (approvalId, decision) => invoke(channels.codexApproval, approvalId, decision),
    respondToInteractive: (requestId, response) => invoke(channels.codexInteractive, requestId, response),
    newConversation: (projectId, disposition) => invoke(channels.codexNewConversation, projectId, disposition),
    openConversation: (projectId, threadId, disposition) => invoke(channels.codexOpenConversation, projectId, threadId, disposition),
    renameConversation: (projectId, threadId, name) => invoke(channels.codexRenameConversation, projectId, threadId, name),
    archiveConversation: (projectId, threadId) => invoke(channels.codexArchiveConversation, projectId, threadId),
    restoreConversation: (projectId, threadId, disposition) => invoke(channels.codexRestoreConversation, projectId, threadId, disposition),
    deleteConversation: (projectId, threadId) => invoke(channels.codexDeleteConversation, projectId, threadId),
    updateConversationSettings: (projectId, settings) => invoke(channels.codexUpdateConversationSettings, projectId, settings),
    threadUsage: (projectId) => invoke(channels.codexThreadUsage, projectId),
    refreshUsage: () => invoke(channels.codexRefreshUsage),
    listMcp: (projectId) => invoke(channels.codexListMcp, projectId),
    retryRuntime: () => invoke(channels.codexRuntimeRetry),
    useAutomaticRuntime: () => invoke(channels.codexRuntimeAutomatic),
    useManagedRuntime: () => invoke(channels.codexRuntimeManaged),
    useCustomRuntime: (path) => invoke(channels.codexRuntimeCustom, path),
    chooseRuntimeExecutable: () => invoke(channels.codexRuntimeChooseExecutable),
    login: () => invoke(channels.codexLogin),
    cancelLogin: () => invoke(channels.codexLoginCancel),
    logout: () => invoke(channels.codexLogout),
    exportConversation: (input) => invoke(channels.codexExportConversation, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(channels.codexEvent, handler);
      return () => ipcRenderer.removeListener(channels.codexEvent, handler);
    },
  },
  runtime: {
    start: (projectId) => invoke(channels.runtimeStart, projectId),
    restart: (projectId) => invoke(channels.runtimeRestart, projectId),
    stop: (projectId) => invoke(channels.runtimeStop, projectId),
    open: (projectId) => invoke(channels.runtimeOpen, projectId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on(channels.runtimeEvent, handler);
      return () => ipcRenderer.removeListener(channels.runtimeEvent, handler);
    },
  },
};

contextBridge.exposeInMainWorld("appBuilder", api);
