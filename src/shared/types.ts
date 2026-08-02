export type CollaborationMode = "work" | "plan";
export type ProjectPermissionMode = "ask" | "workspace" | "fullAccess";
export type CodexRuntimePreference = "auto" | "custom" | "managed";

export interface CodexRuntimeSettings {
  preference: CodexRuntimePreference;
  customExecutablePath: string | null;
  managedVersion: string | null;
}

export interface ConversationSettings {
  model: string | null;
  reasoningEffort: string | null;
  mode: CollaborationMode;
}

export interface AppSettings {
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  defaultMode: CollaborationMode;
  sidebarCollapsed: boolean;
  showModeControl: boolean;
  showPermissionControl: boolean;
  showMcpStatus: boolean;
  codexRuntime: CodexRuntimeSettings;
}

export interface ConversationRecord {
  threadId: string;
  name: string | null;
  preview: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  settings: ConversationSettings;
}

export interface AppBuilderState {
  version: 3;
  activeProjectId: string | null;
  settings: AppSettings;
  projects: Project[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  archived: boolean;
  permissionMode: ProjectPermissionMode;
  activeThreadId: string | null;
  draft: ConversationSettings | null;
  conversations: ConversationRecord[];
  selectedRunProfileId: string | null;
  runProfiles: RunProfile[];
}

export interface RunProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  kind?: RunProfileKind;
  url?: string | null;
  entry?: string | null;
}

export type RunProfileKind = "auto" | "web" | "process" | "static";

export interface AddProjectInput {
  name: string;
  path: string;
}

export interface ProjectConfiguration {
  version: 1;
  selectedRunProfileId?: string;
  runProfiles: RunProfile[];
}

export type RunProfileDetector = "node" | "dotnet" | "python" | "rust";

export interface RunProfileSuggestion extends RunProfile {
  detector: RunProfileDetector;
  description: string;
  recommended: boolean;
}

export interface ProjectConfigurationInspection {
  state: "missing" | "valid" | "invalid";
  path: string;
  error: string | null;
  configuration: ProjectConfiguration | null;
  suggestions: RunProfileSuggestion[];
}

export type RuntimeStatusName = "starting" | "ready" | "running" | "stopped" | "failed";
export type RuntimeTargetKind = "web" | "process" | "static" | null;
export type RuntimeFailureCode = "spawn_failed" | "process_exited" | "port_in_use" | "readiness_timeout" | "open_failed" | null;

export interface RuntimeStatus {
  projectId: string;
  status: RuntimeStatusName;
  target: RuntimeTargetKind;
  url: string | null;
  pid: number | null;
  exitCode: number | null;
  failureCode: RuntimeFailureCode;
  error: string | null;
}

export type ChatAttachmentKind = "image" | "file";

export interface ChatAttachment {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  size: number | null;
}

export interface PendingChatAttachment extends ChatAttachment {
  token: string;
}

export interface SendMessageInput {
  text: string;
  attachmentTokens: string[];
}

export interface ConversationMessage {
  type: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
}

export interface PlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface ConversationPlan {
  type: "plan";
  id: string;
  turnId: string;
  text: string;
  explanation: string | null;
  steps: PlanStep[];
}

export type ConversationItem = ConversationMessage | ConversationPlan;

export interface ProjectSelection {
  project: Project;
  items: ConversationItem[];
}

export type ApprovalDecision = "acceptOnce" | "acceptSession" | "decline";

export interface ApprovalRequest {
  id: string;
  projectId: string;
  threadId: string;
  reason: string;
  summary: string;
  canAcceptForSession: boolean;
}

export interface FeatureAvailability {
  supported: boolean;
  reason: string | null;
}

export interface CodexCapabilities {
  models: FeatureAvailability;
  collaborationModes: FeatureAvailability;
  threadSettings: FeatureAvailability;
  conversations: FeatureAvailability;
  conversationNaming: FeatureAvailability;
  conversationArchiving: FeatureAvailability;
  conversationDeletion: FeatureAvailability;
  usage: FeatureAvailability;
  mcp: FeatureAvailability;
  backgroundTerminals: FeatureAvailability;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{ effort: string; description: string }>;
}

export interface CodexCatalogs {
  models: CodexModel[];
  collaborationModes: CollaborationMode[];
}

export interface ThreadTokenUsage {
  totalTokens: number;
  contextTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountUsage {
  lifetimeTokens: number | null;
  todayTokens: number | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  spendControlReached: boolean | null;
}

export interface CodexStatus {
  state: "detecting" | "starting" | "authenticationRequired" | "reconnecting" | "ready" | "unavailable";
  authenticated: boolean | null;
  message: string | null;
}

export type CodexRuntimeSource = "path" | "knownInstall" | "custom" | "managed" | "bundled";

export interface CodexRuntimeCandidateFailure {
  source: CodexRuntimeSource;
  executablePath: string;
  message: string;
}

export interface CodexRuntimeUpdateInfo {
  state: "disabled" | "idle" | "checking" | "available" | "downloading" | "installing" | "failed";
  currentVersion: string | null;
  availableVersion: string | null;
  releaseUrl: string | null;
  message: string | null;
}

export interface CodexRuntimeInfo {
  state: "detecting" | "starting" | "awaitingFallbackConsent" | "ready" | "reconnecting" | "unavailable";
  source: CodexRuntimeSource | null;
  executablePath: string | null;
  version: string | null;
  bundledVersion: string | null;
  candidateFailure: CodexRuntimeCandidateFailure | null;
  update: CodexRuntimeUpdateInfo;
}

export interface CodexAuthFlowState {
  state: "idle" | "starting" | "waiting" | "failed";
  loginId: string | null;
  message: string | null;
}

export interface CodexOverview {
  status: CodexStatus;
  capabilities: CodexCapabilities;
  catalogs: CodexCatalogs;
  accountUsage: AccountUsage | null;
  runtime: CodexRuntimeInfo;
  authFlow: CodexAuthFlowState;
}

export interface AppErrorDto {
  code: string;
  message: string;
  details: string | null;
  retryable: boolean;
}

export interface RecoveryBackup {
  id: string;
  createdAt: number;
  version: number;
}

export interface RecoveryInfo {
  error: AppErrorDto;
  preservedStatePath: string | null;
  backups: RecoveryBackup[];
}

export interface DiagnosticExportResult {
  path: string | null;
  canceled: boolean;
}

export type McpStartupState = "unknown" | "starting" | "ready" | "failed" | "cancelled";

export interface McpServerSummary {
  name: string;
  title: string | null;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "unknown";
  startupState: McpStartupState;
  toolCount: number;
  error: string | null;
}

export interface ToolQuestion {
  id: string;
  header: string;
  question: string;
  secret: boolean;
  allowOther: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export type McpFormFieldType = "string" | "number" | "integer" | "boolean" | "singleSelect" | "multiSelect";

export interface McpFormField {
  id: string;
  label: string;
  description: string;
  type: McpFormFieldType;
  required: boolean;
  secret: boolean;
  options: Array<{ value: string; label: string }> | null;
  defaultValue: string | number | boolean | string[] | null;
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
}

export type InteractiveRequest =
  | {
      id: string;
      projectId: string;
      threadId: string;
      kind: "questions";
      questions: ToolQuestion[];
    }
  | {
      id: string;
      projectId: string;
      threadId: string;
      kind: "mcpForm";
      serverName: string;
      message: string;
      fields: McpFormField[];
    }
  | {
      id: string;
      projectId: string;
      threadId: string;
      kind: "mcpUrl";
      serverName: string;
      message: string;
      url: string;
    };

export interface InteractiveResponse {
  action: "submit" | "decline" | "cancel";
  values: Record<string, unknown>;
}

export type ConversationSwitchDisposition = "keep" | "archive";

export type CodexEvent =
  | { type: "overview"; overview: CodexOverview }
  | { type: "authFlow"; authFlow: CodexAuthFlowState }
  | { type: "working"; projectId: string; threadId: string | null; working: boolean }
  | { type: "delta"; projectId: string; threadId: string; itemId: string; delta: string }
  | { type: "planDelta"; projectId: string; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "planCompleted"; projectId: string; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "planUpdated"; projectId: string; threadId: string; turnId: string; explanation: string | null; plan: PlanStep[] }
  | { type: "tokenUsage"; projectId: string; threadId: string; usage: ThreadTokenUsage }
  | { type: "mcpUpdated"; projectId: string | null; servers: McpServerSummary[] }
  | { type: "interactiveRequest"; request: InteractiveRequest }
  | { type: "interactiveResolved"; requestId: string }
  | { type: "completed"; projectId: string; threadId: string; status: "completed" | "interrupted" | "failed"; error: string | null }
  | { type: "approval"; approval: ApprovalRequest }
  | { type: "projectUpdated"; project: Project }
  | { type: "error"; projectId: string | null; message: string };

export interface AppSnapshot {
  state: AppBuilderState;
  runtimes: RuntimeStatus[];
  codex: CodexOverview;
}

export type BootstrapSnapshot =
  | { phase: "starting"; message: string }
  | { phase: "recovery"; recovery: RecoveryInfo }
  | { phase: "ready"; app: AppSnapshot };

export interface ConversationExportInput {
  projectName: string;
  conversationName: string;
  items: ConversationItem[];
}
