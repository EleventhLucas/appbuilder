import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AddProjectInput,
  AppErrorDto,
  AppBuilderState,
  AppSettings,
  ConversationRecord,
  ConversationSettings,
  Project,
  ProjectConfiguration,
  ProjectConfigurationInspection,
  ProjectPermissionMode,
  RecoveryInfo,
  RunProfile,
} from "../../shared/types";
import { detectRunProfiles } from "./RunProfileDetector";

const BACKUP_COUNT = 5;

const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultMode: "work",
  sidebarCollapsed: false,
  showModeControl: false,
  showPermissionControl: false,
  showMcpStatus: false,
  codexRuntime: {
    preference: "auto",
    customExecutablePath: null,
    managedVersion: null,
  },
};

const EMPTY_STATE: AppBuilderState = {
  version: 3,
  activeProjectId: null,
  settings: DEFAULT_SETTINGS,
  projects: [],
};

interface VersionOneProject {
  id: string;
  name: string;
  path: string;
  archived?: boolean;
  codexThreadId?: string | null;
  selectedRunProfileId?: string | null;
  runProfiles?: RunProfile[];
}

interface VersionOneState {
  version: 1;
  activeProjectId: string | null;
  projects: VersionOneProject[];
}

interface VersionTwoState {
  version: 2;
  activeProjectId: string | null;
  settings: Record<string, unknown>;
  projects: Project[];
}

export type StoreInitializationResult =
  | { state: "ready"; value: AppBuilderState }
  | { state: "recovery"; recovery: RecoveryInfo };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultConversationSettings(settings: AppSettings): ConversationSettings {
  return {
    model: settings.defaultModel,
    reasoningEffort: settings.defaultReasoningEffort,
    mode: "work",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function validateState(value: unknown): asserts value is AppBuilderState | VersionOneState | VersionTwoState {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
    throw new Error("AppBuilder state has an unsupported version.");
  }
  if (!Array.isArray(value.projects)) throw new Error("AppBuilder state has an invalid projects list.");
  if ((value.version === 2 || value.version === 3) && !isObject(value.settings)) throw new Error("AppBuilder state has invalid settings.");
}

function normalizeConversationSettings(value: unknown, fallback: ConversationSettings): ConversationSettings {
  if (!isObject(value)) return clone(fallback);
  return {
    model: typeof value.model === "string" ? value.model : null,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : null,
    mode: value.mode === "plan" ? "plan" : "work",
  };
}

export class ProjectStore {
  private state: AppBuilderState = clone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();
  private ready = false;
  private recovery: RecoveryInfo | null = null;

  constructor(private readonly statePath: string) {}

  async initialize(): Promise<StoreInitializationResult> {
    this.ready = false;
    this.recovery = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      validateState(parsed);
      this.state = parsed.version === 1 ? this.migrateVersionOne(parsed) : this.normalizeCurrent(parsed);
      let changed = parsed.version !== 3 || JSON.stringify(parsed) !== JSON.stringify(this.state);
      for (const project of this.state.projects) {
        const before = JSON.stringify([project.runProfiles, project.selectedRunProfileId]);
        this.applyConfiguration(project, await this.readConfiguration(project.path));
        changed ||= before !== JSON.stringify([project.runProfiles, project.selectedRunProfileId]);
      }
      if (this.state.activeProjectId && this.state.projects.find((project) => project.id === this.state.activeProjectId)?.archived) {
        this.state.activeProjectId = this.state.projects.find((project) => !project.archived)?.id ?? null;
        changed = true;
      }
      if (changed) await this.writeAtomic(this.state);
      this.ready = true;
      return { state: "ready", value: this.getState() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = clone(EMPTY_STATE);
        this.ready = true;
        return { state: "ready", value: this.getState() };
      }
      this.recovery = await this.buildRecoveryInfo();
      return { state: "recovery", recovery: clone(this.recovery) };
    }
  }

  getState(): AppBuilderState {
    this.ensureReady();
    return clone(this.state);
  }

  getRecoveryInfo(): RecoveryInfo | null {
    return clone(this.recovery);
  }

  async restoreBackup(id: string): Promise<StoreInitializationResult> {
    if (!/^[1-5]$/.test(id)) throw new Error("Recovery backup is invalid.");
    const parsed: unknown = JSON.parse(await readFile(this.backupPath(Number(id)), "utf8"));
    validateState(parsed);
    const restored = parsed.version === 1 ? this.migrateVersionOne(parsed) : this.normalizeCurrent(parsed);
    await this.writeAtomic(restored);
    this.state = restored;
    this.ready = true;
    this.recovery = null;
    return { state: "ready", value: this.getState() };
  }

  async reset(): Promise<StoreInitializationResult> {
    const reset = clone(EMPTY_STATE);
    await this.writeAtomic(reset);
    this.state = reset;
    this.ready = true;
    this.recovery = null;
    return { state: "ready", value: this.getState() };
  }

  getProject(projectId: string): Project {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found.");
    return clone(project);
  }

  async add(input: AddProjectInput): Promise<Project> {
    if (!input || typeof input.name !== "string" || !input.name.trim()) throw new Error("Display name is required.");
    if (typeof input.path !== "string" || !input.path.trim()) throw new Error("Project directory is required.");
    const projectPath = resolve(input.path.trim());
    if (this.state.projects.some((project) => project.path === projectPath)) {
      throw new Error("That project directory has already been added.");
    }
    let info;
    try {
      info = await stat(projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(projectPath, { recursive: true });
      info = await stat(projectPath);
    }
    if (!info.isDirectory()) throw new Error("Project path must be a directory.");

    const project: Project = {
      id: randomUUID(),
      name: input.name.trim(),
      path: projectPath,
      archived: false,
      permissionMode: "workspace",
      activeThreadId: null,
      draft: defaultConversationSettings(this.state.settings),
      conversations: [],
      selectedRunProfileId: null,
      runProfiles: [],
    };
    this.applyConfiguration(project, await this.readConfiguration(projectPath));
    await this.mutate((state) => {
      state.projects.push(project);
      state.activeProjectId = project.id;
    });
    return this.getProject(project.id);
  }

  async select(projectId: string): Promise<Project> {
    const project = this.getProject(projectId);
    if (project.archived) throw new Error("Restore this project before opening it.");
    await this.mutate((state) => {
      state.activeProjectId = projectId;
    });
    return this.getProject(projectId);
  }

  async updateSettings(settings: AppSettings): Promise<AppBuilderState> {
    await this.mutate((state) => {
      state.settings = { ...clone(settings), defaultMode: "work" };
    });
    return this.getState();
  }

  async updatePermissionMode(projectId: string, permissionMode: ProjectPermissionMode): Promise<Project> {
    await this.mutate((state) => {
      this.mutableProject(state, projectId).permissionMode = permissionMode;
    });
    return this.getProject(projectId);
  }

  async beginDraft(projectId: string): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      project.activeThreadId = null;
      project.draft = defaultConversationSettings(state.settings);
    });
    return this.getProject(projectId);
  }

  async updateDraftSettings(projectId: string, settings: ConversationSettings): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      if (!project.draft) throw new Error("No new conversation is active.");
      project.draft = clone(settings);
    });
    return this.getProject(projectId);
  }

  async addConversation(projectId: string, conversation: ConversationRecord): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      const index = project.conversations.findIndex((candidate) => candidate.threadId === conversation.threadId);
      if (index >= 0) project.conversations[index] = clone(conversation);
      else project.conversations.push(clone(conversation));
      project.activeThreadId = conversation.threadId;
      project.draft = null;
    });
    return this.getProject(projectId);
  }

  async bindConversation(projectId: string, threadId: string): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      const conversation = project.conversations.find((candidate) => candidate.threadId === threadId);
      if (!conversation || conversation.archived) throw new Error("Conversation is unavailable.");
      project.activeThreadId = threadId;
      project.draft = null;
    });
    return this.getProject(projectId);
  }

  async clearActiveConversation(projectId: string): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      project.activeThreadId = null;
      project.draft = null;
    });
    return this.getProject(projectId);
  }

  async updateConversation(projectId: string, threadId: string, update: Partial<Omit<ConversationRecord, "threadId">>): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      const conversation = project.conversations.find((candidate) => candidate.threadId === threadId);
      if (!conversation) throw new Error("Conversation not found.");
      Object.assign(conversation, clone(update));
    });
    return this.getProject(projectId);
  }

  async removeConversation(projectId: string, threadId: string): Promise<Project> {
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      project.conversations = project.conversations.filter((candidate) => candidate.threadId !== threadId);
      if (project.activeThreadId === threadId) {
        project.activeThreadId = null;
        project.draft = null;
      }
    });
    return this.getProject(projectId);
  }

  async setArchived(projectId: string, archived: boolean): Promise<AppBuilderState> {
    this.getProject(projectId);
    await this.mutate((state) => {
      const project = this.mutableProject(state, projectId);
      project.archived = archived;
      if (archived && state.activeProjectId === projectId) {
        state.activeProjectId = state.projects.find((candidate) => !candidate.archived && candidate.id !== projectId)?.id ?? null;
      } else if (!archived && state.activeProjectId === null) {
        state.activeProjectId = projectId;
      }
    });
    return this.getState();
  }

  async remove(projectId: string): Promise<AppBuilderState> {
    this.getProject(projectId);
    await this.mutate((state) => {
      state.projects = state.projects.filter((project) => project.id !== projectId);
      if (state.activeProjectId === projectId) {
        state.activeProjectId = state.projects.find((project) => !project.archived)?.id ?? null;
      }
    });
    return this.getState();
  }

  async selectRunProfile(projectId: string, profileId: string): Promise<Project> {
    const project = this.getProject(projectId);
    if (!project.runProfiles.some((profile) => profile.id === profileId)) throw new Error("Run profile not found.");
    await this.mutate((state) => {
      this.mutableProject(state, projectId).selectedRunProfileId = profileId;
    });
    return this.getProject(projectId);
  }

  async refreshConfiguration(projectId: string): Promise<Project> {
    const project = this.getProject(projectId);
    const next = clone(project);
    this.applyConfiguration(next, await this.readConfiguration(project.path));
    if (JSON.stringify([next.runProfiles, next.selectedRunProfileId]) === JSON.stringify([project.runProfiles, project.selectedRunProfileId])) return project;
    await this.mutate((state) => {
      const index = state.projects.findIndex((candidate) => candidate.id === projectId);
      state.projects[index] = next;
    });
    return this.getProject(projectId);
  }

  async inspectConfiguration(projectId: string): Promise<ProjectConfigurationInspection> {
    const project = this.getProject(projectId);
    const path = join(project.path, ".appbuilder", "config.json");
    const suggestions = await detectRunProfiles(project.path);
    try {
      const source = await readFile(path, "utf8");
      const configuration = this.parseConfiguration(source);
      return { state: "valid", path, error: null, configuration, suggestions };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "missing", path, error: null, configuration: null, suggestions };
      }
      return {
        state: "invalid",
        path,
        error: error instanceof Error ? error.message : String(error),
        configuration: null,
        suggestions,
      };
    }
  }

  async saveConfiguration(projectId: string, configuration: ProjectConfiguration): Promise<Project> {
    const project = this.getProject(projectId);
    const normalized = this.parseConfiguration(JSON.stringify(configuration));
    const configurationPath = join(project.path, ".appbuilder", "config.json");
    await mkdir(dirname(configurationPath), { recursive: true });
    const temporaryPath = `${configurationPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\r\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, configurationPath);
    return this.refreshConfiguration(projectId);
  }

  private migrateVersionOne(state: VersionOneState): AppBuilderState {
    const migrated: AppBuilderState = {
      version: 3,
      activeProjectId: typeof state.activeProjectId === "string" ? state.activeProjectId : null,
      settings: clone(DEFAULT_SETTINGS),
      projects: [],
    };
    const defaults = defaultConversationSettings(migrated.settings);
    for (const old of state.projects) {
      const threadId = typeof old.codexThreadId === "string" && old.codexThreadId ? old.codexThreadId : null;
      migrated.projects.push({
        id: old.id,
        name: old.name,
        path: old.path,
        archived: old.archived === true,
        permissionMode: "workspace",
        activeThreadId: threadId,
        draft: threadId ? null : clone(defaults),
        conversations: threadId ? [{
          threadId,
          name: null,
          preview: "",
          archived: false,
          createdAt: 0,
          updatedAt: 0,
          settings: clone(defaults),
        }] : [],
        selectedRunProfileId: typeof old.selectedRunProfileId === "string" ? old.selectedRunProfileId : null,
        runProfiles: Array.isArray(old.runProfiles) ? clone(old.runProfiles) : [],
      });
    }
    return migrated;
  }

  private normalizeCurrent(state: AppBuilderState | VersionTwoState): AppBuilderState {
    const rawSettings = state.settings as unknown as Record<string, unknown>;
    const rawRuntime = isObject(rawSettings.codexRuntime) ? rawSettings.codexRuntime : {};
    const preference = rawRuntime.preference === "custom" || rawRuntime.preference === "managed" ? rawRuntime.preference : "auto";
    const settings: AppSettings = {
      defaultModel: typeof rawSettings.defaultModel === "string" ? rawSettings.defaultModel : null,
      defaultReasoningEffort: typeof rawSettings.defaultReasoningEffort === "string" ? rawSettings.defaultReasoningEffort : null,
      defaultMode: "work",
      sidebarCollapsed: rawSettings.sidebarCollapsed === true,
      showModeControl: rawSettings.showModeControl === true,
      showPermissionControl: rawSettings.showPermissionControl === true,
      showMcpStatus: rawSettings.showMcpStatus === true,
      codexRuntime: {
        preference,
        customExecutablePath: preference === "custom" && typeof rawRuntime.customExecutablePath === "string"
          ? rawRuntime.customExecutablePath
          : null,
        managedVersion: typeof rawRuntime.managedVersion === "string" ? rawRuntime.managedVersion : null,
      },
    };
    const fallback = defaultConversationSettings(settings);
    return {
      version: 3,
      activeProjectId: typeof state.activeProjectId === "string" ? state.activeProjectId : null,
      settings,
      projects: state.projects.map((project) => {
        const conversations = Array.isArray(project.conversations) ? project.conversations
          .filter((conversation) => conversation && typeof conversation.threadId === "string")
          .map((conversation) => ({
            threadId: conversation.threadId,
            name: typeof conversation.name === "string" ? conversation.name : null,
            preview: typeof conversation.preview === "string" ? conversation.preview : "",
            archived: conversation.archived === true,
            createdAt: typeof conversation.createdAt === "number" ? conversation.createdAt : 0,
            updatedAt: typeof conversation.updatedAt === "number" ? conversation.updatedAt : 0,
            settings: normalizeConversationSettings(conversation.settings, fallback),
          })) : [];
        const requestedActive = typeof project.activeThreadId === "string" ? project.activeThreadId : null;
        const activeThreadId = conversations.some((conversation) => conversation.threadId === requestedActive && !conversation.archived)
          ? requestedActive
          : null;
        return {
          ...clone(project),
          archived: project.archived === true,
          permissionMode: project.permissionMode === "ask" || project.permissionMode === "workspace" || project.permissionMode === "fullAccess"
            ? project.permissionMode
            : "workspace",
          activeThreadId,
          draft: activeThreadId ? null : project.draft ? normalizeConversationSettings(project.draft, fallback) : null,
          conversations,
        };
      }),
    };
  }

  private mutableProject(state: AppBuilderState, projectId: string): Project {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found.");
    return project;
  }

  private async mutate(change: (state: AppBuilderState) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const next = clone(this.state);
      change(next);
      await this.writeAtomic(next);
      this.state = next;
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async writeAtomic(state: AppBuilderState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await this.rotateBackups();
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\r\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }

  private ensureReady(): void {
    if (!this.ready) throw new Error("AppBuilder state is awaiting recovery.");
  }

  private backupPath(index: number): string {
    return `${this.statePath}.bak-${index}`;
  }

  private async rotateBackups(): Promise<void> {
    const current = await readFile(this.statePath, "utf8").catch(() => null);
    if (current === null) return;
    try {
      const parsed: unknown = JSON.parse(current);
      validateState(parsed);
    } catch {
      return;
    }
    for (let index = BACKUP_COUNT; index > 1; index -= 1) {
      await copyFile(this.backupPath(index - 1), this.backupPath(index)).catch(() => undefined);
    }
    await copyFile(this.statePath, this.backupPath(1));
  }

  private async buildRecoveryInfo(): Promise<RecoveryInfo> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const preservedStatePath = `${this.statePath}.invalid-${Date.now()}`;
    const preserved = await copyFile(this.statePath, preservedStatePath).then(() => preservedStatePath).catch(() => null);
    const directoryEntries = new Set(await readdir(dirname(this.statePath)).catch(() => []));
    const backups = [];
    for (let index = 1; index <= BACKUP_COUNT; index += 1) {
      const path = this.backupPath(index);
      if (!directoryEntries.has(path.slice(dirname(this.statePath).length + 1))) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        validateState(parsed);
        const info = await stat(path);
        backups.push({ id: String(index), createdAt: info.mtimeMs, version: parsed.version });
      } catch {
        // Invalid recovery files are intentionally omitted.
      }
    }
    const appError: AppErrorDto = {
      code: "STATE_INVALID",
      message: "AppBuilder could not read its saved state.",
      details: "Saved state did not match the supported AppBuilder schema.",
      retryable: true,
    };
    return { error: appError, preservedStatePath: preserved, backups };
  }

  private applyConfiguration(project: Project, configuration: ProjectConfiguration | null): void {
    const configurationPath = join(project.path, ".appbuilder", "config.json");
    const profiles = configuration?.runProfiles ?? (existsSync(configurationPath) ? [] : this.staticSiteProfile(project.path));
    const selected = project.selectedRunProfileId && profiles.some((profile) => profile.id === project.selectedRunProfileId)
      ? project.selectedRunProfileId
      : configuration?.selectedRunProfileId && profiles.some((profile) => profile.id === configuration.selectedRunProfileId)
        ? configuration.selectedRunProfileId
        : profiles[0]?.id ?? null;
    project.runProfiles = clone(profiles);
    project.selectedRunProfileId = selected;
  }

  private staticSiteProfile(projectPath: string): RunProfile[] {
    const entry = join(projectPath, "index.html");
    if (!existsSync(entry)) return [];
    return [{
      id: "static-site",
      name: "Static site",
      command: "",
      args: [],
      kind: "static",
      url: null,
      entry: "index.html",
    }];
  }

  private async readConfiguration(projectPath: string): Promise<ProjectConfiguration | null> {
    try {
      return this.parseConfiguration(await readFile(join(projectPath, ".appbuilder", "config.json"), "utf8"));
    } catch {
      return null;
    }
  }

  private parseConfiguration(source: string): ProjectConfiguration {
    const parsed: unknown = JSON.parse(source);
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.runProfiles)) {
      throw new Error("Configuration must use schema version 1 and contain a runProfiles array.");
    }
    const profiles: RunProfile[] = [];
    const ids = new Set<string>();
    for (const value of parsed.runProfiles) {
      if (!isObject(value)) throw new Error("Every run profile must be an object.");
      if (typeof value.id !== "string" || !value.id.trim() || ids.has(value.id)) throw new Error("Every run profile needs a unique ID.");
      if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`Run profile ${value.id} needs a name.`);
      const kind = value.kind === "web" || value.kind === "process" || value.kind === "static" ? value.kind : "auto";
      if (typeof value.command !== "string" || (!value.command.trim() && kind !== "static")) throw new Error(`Run profile ${value.id} needs an executable command.`);
      if (!Array.isArray(value.args) || !value.args.every((argument) => typeof argument === "string")) {
        throw new Error(`Run profile ${value.id} has invalid arguments.`);
      }
      const url = typeof value.url === "string" ? this.safeLoopbackUrl(value.url) : null;
      if (typeof value.url === "string" && !url) throw new Error(`Run profile ${value.id} must use a localhost URL.`);
      const entry = typeof value.entry === "string" ? this.safeRelativeEntry(value.entry) : null;
      if (typeof value.entry === "string" && !entry) throw new Error(`Run profile ${value.id} has an invalid static entry file.`);
      if (kind === "web" && url === null && !value.command.trim()) throw new Error(`Web profile ${value.id} needs a command or URL.`);
      if (kind === "static" && entry === null) throw new Error(`Static profile ${value.id} needs an entry file.`);
      ids.add(value.id);
      profiles.push({ id: value.id.trim(), name: value.name.trim(), command: value.command.trim(), args: [...value.args], kind, url, entry });
    }
    if (typeof parsed.selectedRunProfileId === "string" && !ids.has(parsed.selectedRunProfileId)) {
      throw new Error("The selected run profile ID does not exist.");
    }
    return {
      version: 1,
      runProfiles: profiles,
      ...(typeof parsed.selectedRunProfileId === "string" ? { selectedRunProfileId: parsed.selectedRunProfileId } : {}),
    };
  }

  private safeLoopbackUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "::1" ? url.toString() : null;
    } catch {
      return null;
    }
  }

  private safeRelativeEntry(value: string): string | null {
    const entry = value.trim();
    if (!entry || entry.startsWith("/") || entry.startsWith("\\") || entry.split(/[\\/]+/).some((part) => part === "..")) return null;
    return entry;
  }
}
