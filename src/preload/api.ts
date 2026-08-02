import type {
  AccountUsage,
  AddProjectInput,
  AppBuilderState,
  AppErrorDto,
  AppSettings,
  AppSnapshot,
  ApprovalDecision,
  BootstrapSnapshot,
  CodexEvent,
  ConversationSettings,
  ConversationSwitchDisposition,
  ConversationExportInput,
  DiagnosticExportResult,
  InteractiveResponse,
  McpServerSummary,
  PendingChatAttachment,
  Project,
  ProjectConfiguration,
  ProjectConfigurationInspection,
  ProjectPermissionMode,
  ProjectSelection,
  RuntimeStatus,
  SendMessageInput,
  ThreadTokenUsage,
} from "../shared/types";

export interface AppBuilderApi {
  bootstrap: {
    get(): Promise<BootstrapSnapshot>;
    retry(): Promise<BootstrapSnapshot>;
    restore(backupId: string): Promise<BootstrapSnapshot>;
    reset(): Promise<BootstrapSnapshot>;
    exportDiagnostics(): Promise<DiagnosticExportResult>;
    onEvent(listener: (snapshot: BootstrapSnapshot) => void): () => void;
  };
  snapshot(): Promise<AppSnapshot>;
  app: {
    restart(): Promise<void>;
  };
  settings: {
    update(settings: AppSettings): Promise<AppBuilderState>;
  };
  projects: {
    add(input: AddProjectInput): Promise<ProjectSelection>;
    select(projectId: string): Promise<ProjectSelection>;
    selectRunProfile(projectId: string, profileId: string): Promise<void>;
    setPermissionMode(projectId: string, permissionMode: ProjectPermissionMode): Promise<Project>;
    openConfiguration(projectId: string): Promise<void>;
    refreshConfiguration(projectId: string): Promise<Project>;
    inspectConfiguration(projectId: string): Promise<ProjectConfigurationInspection>;
    saveConfiguration(projectId: string, configuration: ProjectConfiguration): Promise<Project>;
    archive(projectId: string): Promise<AppBuilderState>;
    restore(projectId: string): Promise<AppBuilderState>;
    remove(projectId: string): Promise<AppBuilderState>;
    chooseDirectory(): Promise<string | null>;
    suggestPath(displayName: string): Promise<string>;
  };
  clipboard: {
    copy(text: string): Promise<void>;
  };
  external: {
    open(url: string): Promise<void>;
  };
  codex: {
    chooseAttachments(projectId: string): Promise<PendingChatAttachment[]>;
    send(projectId: string, input: SendMessageInput): Promise<void>;
    interrupt(projectId: string): Promise<void>;
    interruptForLifecycle(projectId: string): Promise<void>;
    respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
    respondToInteractive(requestId: string, response: InteractiveResponse): Promise<void>;
    newConversation(projectId: string, disposition: ConversationSwitchDisposition): Promise<ProjectSelection>;
    openConversation(projectId: string, threadId: string, disposition: ConversationSwitchDisposition): Promise<ProjectSelection>;
    renameConversation(projectId: string, threadId: string, name: string): Promise<Project>;
    archiveConversation(projectId: string, threadId: string): Promise<Project>;
    restoreConversation(projectId: string, threadId: string, disposition: ConversationSwitchDisposition): Promise<ProjectSelection>;
    deleteConversation(projectId: string, threadId: string): Promise<Project>;
    updateConversationSettings(projectId: string, settings: ConversationSettings): Promise<Project>;
    threadUsage(projectId: string): Promise<ThreadTokenUsage | null>;
    refreshUsage(): Promise<AccountUsage | null>;
    listMcp(projectId: string | null): Promise<McpServerSummary[]>;
    retryRuntime(): Promise<void>;
    useAutomaticRuntime(): Promise<void>;
    useManagedRuntime(): Promise<void>;
    useCustomRuntime(path: string): Promise<void>;
    chooseRuntimeExecutable(): Promise<string | null>;
    login(): Promise<void>;
    cancelLogin(): Promise<void>;
    logout(): Promise<void>;
    exportConversation(input: ConversationExportInput): Promise<DiagnosticExportResult>;
    onEvent(listener: (event: CodexEvent) => void): () => void;
  };
  runtime: {
    start(projectId: string): Promise<RuntimeStatus>;
    restart(projectId: string): Promise<RuntimeStatus>;
    stop(projectId: string): Promise<RuntimeStatus>;
    open(projectId: string): Promise<RuntimeStatus>;
    onEvent(listener: (status: RuntimeStatus) => void): () => void;
  };
}

export class AppBuilderClientError extends Error {
  constructor(readonly error: AppErrorDto) {
    super(error.message);
    this.name = "AppBuilderClientError";
  }
}

declare global {
  interface Window {
    appBuilder: AppBuilderApi;
  }
}
