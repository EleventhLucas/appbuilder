import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AddProjectInput,
  AppBuilderState,
  AppSettings,
  AppSnapshot,
  ApprovalRequest,
  CodexEvent,
  CodexOverview,
  ConversationItem,
  ConversationSettings,
  ConversationSwitchDisposition,
  InteractiveRequest,
  InteractiveResponse,
  McpServerSummary,
  PendingChatAttachment,
  Project,
  ProjectSelection,
  RuntimeStatus,
  ThreadTokenUsage,
} from "../shared/types";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { Conversation } from "./components/Conversation";
import { ConfigureProjectDialog } from "./components/ConfigureProjectDialog";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectActionsDialog } from "./components/ProjectActionsDialog";
import { RunBar } from "./components/RunBar";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { cn } from "./lib/utils";

const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultMode: "work",
  sidebarCollapsed: false,
  showModeControl: false,
  showPermissionControl: false,
  showMcpStatus: false,
  codexRuntime: { preference: "auto", customExecutablePath: null, managedVersion: null },
};
const INITIAL_STATE: AppBuilderState = { version: 3, activeProjectId: null, settings: DEFAULT_SETTINGS, projects: [] };
const INITIAL_CODEX: CodexOverview = {
  status: { state: "starting", authenticated: null, message: null },
  capabilities: {
    models: { supported: false, reason: "Checking installed Codex support…" },
    collaborationModes: { supported: false, reason: "Checking installed Codex support…" },
    threadSettings: { supported: true, reason: null },
    conversations: { supported: true, reason: null },
    conversationNaming: { supported: true, reason: null },
    conversationArchiving: { supported: true, reason: null },
    conversationDeletion: { supported: true, reason: null },
    usage: { supported: false, reason: "Checking installed Codex support…" },
    mcp: { supported: false, reason: "Checking installed Codex support…" },
    backgroundTerminals: { supported: true, reason: null },
  },
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
      message: "Managed Codex updates are deferred until AppBuilder supports signed release manifests.",
    },
  },
  authFlow: { state: "idle", loginId: null, message: null },
};

type PendingSwitch = { kind: "new" } | { kind: "open" | "restore"; threadId: string };

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, "");
}

function VisibilityOption({
  checked,
  description,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  id: string;
  label: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60" htmlFor={id} title={description}>
      <input
        checked={checked}
        className="size-4 shrink-0 accent-primary"
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="block text-sm font-medium">{label}</span>
    </label>
  );
}

export function App({ initialSnapshot }: { initialSnapshot?: AppSnapshot }) {
  const [state, setState] = useState<AppBuilderState>(initialSnapshot?.state ?? INITIAL_STATE);
  const [items, setItems] = useState<Record<string, ConversationItem[]>>({});
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeStatus>>(
    Object.fromEntries((initialSnapshot?.runtimes ?? []).map((runtime) => [runtime.projectId, runtime])),
  );
  const [codex, setCodex] = useState<CodexOverview>(initialSnapshot?.codex ?? INITIAL_CODEX);
  const [usage, setUsage] = useState<Record<string, ThreadTokenUsage | null>>({});
  const usageRequestId = useRef(0);
  const [mcps, setMcps] = useState<Record<string, McpServerSummary[]>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [interactives, setInteractives] = useState<InteractiveRequest[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [configureProjectId, setConfigureProjectId] = useState<string | null>(null);
  const [manageProjectId, setManageProjectId] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeProject = useMemo(() => state.projects.find((project) => project.id === state.activeProjectId) ?? null, [state]);
  const activeInteractive = activeProject?.activeThreadId
    ? interactives.find((request) => request.projectId === activeProject.id && request.threadId === activeProject.activeThreadId) ?? null
    : null;

  useEffect(() => {
    let active = true;
    const load = initialSnapshot ? Promise.resolve(initialSnapshot) : window.appBuilder.snapshot();
    void load.then((snapshot) => {
      if (!active) return;
      setState(snapshot.state);
      setCodex(snapshot.codex);
      setRuntimes(Object.fromEntries(snapshot.runtimes.map((runtime) => [runtime.projectId, runtime])));
      if (snapshot.state.activeProjectId) void selectProject(snapshot.state.activeProjectId, false);
    }).catch((caught) => active && setError(errorText(caught)));

    const removeCodex = window.appBuilder.codex.onEvent(handleCodexEvent);
    const removeRuntime = window.appBuilder.runtime.onEvent((runtime) => setRuntimes((current) => ({ ...current, [runtime.projectId]: runtime })));
    return () => {
      active = false;
      removeCodex();
      removeRuntime();
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(null), 7_000);
    return () => window.clearTimeout(timeout);
  }, [error]);

  const handleCodexEvent = (event: CodexEvent) => {
    if (event.type === "overview") {
      setCodex(event.overview);
    } else if (event.type === "working") {
      setWorking((current) => ({ ...current, [event.projectId]: event.working }));
    } else if (event.type === "delta") {
      setItems((current) => {
        const projectItems = [...(current[event.projectId] ?? [])];
        const index = projectItems.findIndex((item) => item.type === "message" && item.id === event.itemId);
        if (index >= 0) {
          const message = projectItems[index];
          if (message.type === "message") projectItems[index] = { ...message, text: message.text + event.delta };
        } else {
          projectItems.push({ type: "message", id: event.itemId, role: "assistant", text: event.delta });
        }
        return { ...current, [event.projectId]: projectItems };
      });
    } else if (event.type === "planDelta") {
      setItems((current) => {
        const projectItems = [...(current[event.projectId] ?? [])];
        const index = projectItems.findIndex((item) => item.type === "plan" && (item.id === event.itemId || item.turnId === event.turnId));
        if (index >= 0) {
          const plan = projectItems[index];
          if (plan.type === "plan") projectItems[index] = { ...plan, text: plan.text + event.delta };
        } else {
          projectItems.push({ type: "plan", id: event.itemId, turnId: event.turnId, text: event.delta, explanation: null, steps: [] });
        }
        return { ...current, [event.projectId]: projectItems };
      });
    } else if (event.type === "planCompleted") {
      setItems((current) => {
        const projectItems = [...(current[event.projectId] ?? [])];
        const index = projectItems.findIndex((item) => item.type === "plan" && (item.id === event.itemId || item.turnId === event.turnId));
        if (index >= 0) {
          const plan = projectItems[index];
          if (plan.type === "plan") projectItems[index] = { ...plan, id: event.itemId, text: event.text };
        } else {
          projectItems.push({ type: "plan", id: event.itemId, turnId: event.turnId, text: event.text, explanation: null, steps: [] });
        }
        return { ...current, [event.projectId]: projectItems };
      });
    } else if (event.type === "planUpdated") {
      setItems((current) => {
        const projectItems = [...(current[event.projectId] ?? [])];
        const index = projectItems.findIndex((item) => item.type === "plan" && item.turnId === event.turnId);
        if (index >= 0) {
          const plan = projectItems[index];
          if (plan.type === "plan") projectItems[index] = { ...plan, explanation: event.explanation, steps: event.plan };
        } else {
          projectItems.push({ type: "plan", id: `plan-${event.turnId}`, turnId: event.turnId, text: "", explanation: event.explanation, steps: event.plan });
        }
        return { ...current, [event.projectId]: projectItems };
      });
    } else if (event.type === "tokenUsage") {
      setUsage((current) => ({ ...current, [event.projectId]: event.usage }));
    } else if (event.type === "mcpUpdated") {
      setMcps((current) => ({ ...current, [event.projectId ?? "global"]: event.servers }));
    } else if (event.type === "interactiveRequest") {
      setInteractives((current) => [...current.filter((request) => request.id !== event.request.id), event.request]);
    } else if (event.type === "interactiveResolved") {
      setInteractives((current) => current.filter((request) => request.id !== event.requestId));
    } else if (event.type === "completed") {
      setWorking((current) => ({ ...current, [event.projectId]: false }));
      if (event.status === "failed" && event.error) setError(event.error);
    } else if (event.type === "approval") {
      setApprovals((current) => [...current.filter((approval) => approval.id !== event.approval.id), event.approval]);
    } else if (event.type === "projectUpdated") {
      updateProject(event.project, false);
      if (event.project.runProfiles.length > 0) setConfigureProjectId((current) => current === event.project.id ? null : current);
    } else if (event.type === "error") {
      setError(event.message);
    }
  };

  const updateProject = (project: Project, activate = true) => {
    setState((current) => ({
      ...current,
      activeProjectId: activate ? project.id : current.activeProjectId,
      projects: current.projects.some((candidate) => candidate.id === project.id)
        ? current.projects.map((candidate) => candidate.id === project.id ? project : candidate)
        : [...current.projects, project],
    }));
  };

  const loadThreadUsage = async (projectId: string, clearFirst = false) => {
    const requestId = ++usageRequestId.current;
    if (clearFirst) setUsage((current) => ({ ...current, [projectId]: null }));
    const value = await window.appBuilder.codex.threadUsage(projectId);
    if (requestId === usageRequestId.current) {
      setUsage((current) => ({ ...current, [projectId]: value }));
    }
  };

  const applySelection = (selection: ProjectSelection) => {
    updateProject(selection.project);
    setItems((current) => ({ ...current, [selection.project.id]: selection.items }));
    void loadThreadUsage(selection.project.id, true);
  };

  const selectProject = async (projectId: string, updateImmediately = true) => {
    setError(null);
    if (updateImmediately) setState((current) => ({ ...current, activeProjectId: projectId }));
    try {
      applySelection(await window.appBuilder.projects.select(projectId));
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const addProject = async (input: AddProjectInput) => {
    const selection = await window.appBuilder.projects.add(input);
    applySelection(selection);
    setRuntimes((current) => ({ ...current, [selection.project.id]: { projectId: selection.project.id, status: "stopped", target: null, url: null, pid: null, exitCode: null, failureCode: null, error: null } }));
    setShowAdd(false);
  };

  const sendToProject = async (projectId: string, text: string, attachments: PendingChatAttachment[]) => {
    const messageAttachments = attachments.map(({ token: _token, ...attachment }) => attachment);
    const message: ConversationItem = { type: "message", id: `local-${crypto.randomUUID()}`, role: "user", text, ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}) };
    setItems((current) => ({ ...current, [projectId]: [...(current[projectId] ?? []), message] }));
    setWorking((current) => ({ ...current, [projectId]: true }));
    setError(null);
    try {
      await window.appBuilder.codex.send(projectId, { text, attachmentTokens: attachments.map((attachment) => attachment.token) });
    } catch (caught) {
      setItems((current) => ({ ...current, [projectId]: (current[projectId] ?? []).filter((item) => item.id !== message.id) }));
      setWorking((current) => ({ ...current, [projectId]: false }));
      setError(errorText(caught));
      throw caught;
    }
  };

  const send = async (text: string, attachments: PendingChatAttachment[]) => {
    if (activeProject) await sendToProject(activeProject.id, text, attachments);
  };

  const sendRunConfigurationPrompt = async (prompt: string) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    if (!activeProject.draft && !activeProject.activeThreadId) {
      try {
        applySelection(await window.appBuilder.codex.newConversation(projectId, "keep"));
      } catch (caught) {
        setError(errorText(caught));
        throw caught;
      }
    }
    await sendToProject(projectId, prompt, []);
  };

  const executeSwitch = async (action: PendingSwitch, disposition: ConversationSwitchDisposition) => {
    if (!activeProject) return;
    setError(null);
    if (working[activeProject.id]) await window.appBuilder.codex.interruptForLifecycle(activeProject.id);
    const selection = action.kind === "new"
      ? await window.appBuilder.codex.newConversation(activeProject.id, disposition)
      : action.kind === "restore"
        ? await window.appBuilder.codex.restoreConversation(activeProject.id, action.threadId, disposition)
        : await window.appBuilder.codex.openConversation(activeProject.id, action.threadId, disposition);
    applySelection(selection);
    setPendingSwitch(null);
  };

  const requestSwitch = (action: PendingSwitch) => {
    if (!activeProject) return;
    const targetId = action.kind === "new" ? null : action.threadId;
    if (action.kind === "open" && targetId === activeProject.activeThreadId) return;
    if (working[activeProject.id] || activeProject.activeThreadId) setPendingSwitch(action);
    else void executeSwitch(action, "keep").catch((caught) => setError(errorText(caught)));
  };

  const prepareDestructiveLifecycle = async () => {
    if (!activeProject || !working[activeProject.id]) return;
    if (!window.confirm("Codex is working. Interrupt the active turn and continue?")) throw new Error("Action canceled.");
    await window.appBuilder.codex.interruptForLifecycle(activeProject.id);
  };

  const respondToApproval = async (decision: "acceptOnce" | "acceptSession" | "decline") => {
    const approval = approvals[0];
    if (!approval) return;
    try {
      await window.appBuilder.codex.respondToApproval(approval.id, decision);
      setApprovals((current) => current.slice(1));
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const runAction = async (action: "start" | "restart" | "stop") => {
    if (!activeProject) return;
    try {
      const status = await window.appBuilder.runtime[action](activeProject.id);
      setRuntimes((current) => ({ ...current, [activeProject.id]: status }));
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const chooseRuntime = async () => {
    try {
      const path = await window.appBuilder.codex.chooseRuntimeExecutable();
      if (path) await window.appBuilder.codex.useCustomRuntime(path);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F5") return;
      event.preventDefault();
      if (!activeProject) return;
      if (event.shiftKey) {
        void runAction("stop");
        return;
      }
      void runAction(runtimes[activeProject.id]?.status === "running" ? "restart" : "start");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProject?.id, runtimes]);

  const applyProjectLifecycle = (nextState: AppBuilderState, affectedProjectId: string, removed = false) => {
    const previousActiveProjectId = state.activeProjectId;
    setState(nextState);
    setManageProjectId(null);
    setConfigureProjectId((current) => current === affectedProjectId ? null : current);
    if (removed) {
      setItems((current) => { const next = { ...current }; delete next[affectedProjectId]; return next; });
      setWorking((current) => { const next = { ...current }; delete next[affectedProjectId]; return next; });
      setRuntimes((current) => { const next = { ...current }; delete next[affectedProjectId]; return next; });
    }
    if (nextState.activeProjectId && nextState.activeProjectId !== previousActiveProjectId) void selectProject(nextState.activeProjectId, false);
  };

  const saveAppSettings = async (settings: AppSettings) => {
    try {
      const next = await window.appBuilder.settings.update(settings);
      setState(next);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const exportActiveConversation = async () => {
    if (!activeProject?.activeThreadId) return;
    const activeConversation = activeProject.conversations.find((conversation) => conversation.threadId === activeProject.activeThreadId);
    try {
      await window.appBuilder.codex.exportConversation({
        projectName: activeProject.name,
        conversationName: activeConversation?.name?.trim() || activeConversation?.preview?.trim() || "New conversation",
        items: items[activeProject.id] ?? [],
      });
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const notice = (
    codex.runtime.state === "awaitingFallbackConsent"
      ? `An external Codex installation was found but could not start: ${codex.runtime.candidateFailure?.message ?? "validation failed"}. Choose whether to retry it or use managed Codex.`
      : codex.status.state === "detecting" ? "Looking for a Codex runtime…"
        : codex.status.state === "starting" ? "Starting Codex…"
          : codex.status.state === "reconnecting" ? (codex.status.message ?? "Reconnecting to Codex…")
            : codex.status.state === "authenticationRequired"
              ? (codex.authFlow.state === "waiting" ? "Waiting for ChatGPT sign-in in your browser…" : codex.authFlow.message ?? "Sign in with ChatGPT to continue.")
              : codex.status.state === "unavailable" || codex.runtime.state === "unavailable"
                ? (codex.status.message ?? codex.runtime.candidateFailure?.message ?? "Codex is unavailable.")
                : null
  );

  const defaultSelectedModel = state.settings.defaultModel ?? codex.catalogs.models.find((model) => model.isDefault)?.model ?? codex.catalogs.models[0]?.model ?? null;
  const defaultEfforts = codex.catalogs.models.find((model) => model.model === defaultSelectedModel)?.supportedReasoningEfforts ?? [];

  return (
    <div className={cn("grid h-full w-full overflow-hidden bg-background transition-[grid-template-columns] duration-150", state.settings.sidebarCollapsed ? "grid-cols-[52px_minmax(0,1fr)]" : "grid-cols-[220px_minmax(0,1fr)] max-[880px]:grid-cols-[184px_minmax(0,1fr)]")}>
      <ProjectSidebar activeProjectId={state.activeProjectId} collapsed={state.settings.sidebarCollapsed} onAdd={() => setShowAdd(true)} onCollapsedChange={(sidebarCollapsed) => void saveAppSettings({ ...state.settings, sidebarCollapsed })} onManage={setManageProjectId} onSelect={(projectId) => void selectProject(projectId)} onSettings={() => setShowSettings(true)} projects={state.projects} runtimes={runtimes} />
      <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_54px] overflow-hidden">
        <Conversation
          interactive={activeInteractive}
          items={activeProject ? (items[activeProject.id] ?? []) : []}
          mcps={activeProject ? (mcps[activeProject.id] ?? mcps.global ?? []) : (mcps.global ?? [])}
          notice={activeProject ? notice : null}
          showMcpStatus={state.settings.showMcpStatus}
          showModeControl={state.settings.showModeControl}
          showPermissionControl={state.settings.showPermissionControl}
          onArchiveConversation={async (threadId) => {
            if (!activeProject) return;
            try {
              if (activeProject.activeThreadId === threadId) await prepareDestructiveLifecycle();
              const project = await window.appBuilder.codex.archiveConversation(activeProject.id, threadId);
              updateProject(project, false);
              if (project.activeThreadId === null) setItems((current) => ({ ...current, [project.id]: [] }));
            } catch (caught) { if (errorText(caught) !== "Action canceled.") setError(errorText(caught)); }
          }}
          onChooseAttachments={async () => {
            if (!activeProject) return [];
            setError(null);
            try { return await window.appBuilder.codex.chooseAttachments(activeProject.id); }
            catch (caught) { setError(errorText(caught)); return []; }
          }}
          onDeleteConversation={async (threadId) => {
            if (!activeProject) return;
            try {
              if (activeProject.activeThreadId === threadId) await prepareDestructiveLifecycle();
              const project = await window.appBuilder.codex.deleteConversation(activeProject.id, threadId);
              updateProject(project, false);
              if (project.activeThreadId === null) setItems((current) => ({ ...current, [project.id]: [] }));
            } catch (caught) { if (errorText(caught) !== "Action canceled.") setError(errorText(caught)); }
          }}
          onInterrupt={() => activeProject ? window.appBuilder.codex.interrupt(activeProject.id) : undefined}
          onLogin={async () => {
            try { await window.appBuilder.codex.login(); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onCancelLogin={async () => {
            try { await window.appBuilder.codex.cancelLogin(); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onRetryRuntime={async () => {
            try { await window.appBuilder.codex.retryRuntime(); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onChooseRuntime={chooseRuntime}
          onUseManagedRuntime={async () => {
            try { await window.appBuilder.codex.useManagedRuntime(); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onNewConversation={() => requestSwitch({ kind: "new" })}
          onOpenConversation={(threadId) => requestSwitch({ kind: "open", threadId })}
          onOpenExternal={async (url) => { try { await window.appBuilder.external.open(url); } catch (caught) { setError(errorText(caught)); } }}
          onPermissionModeChange={async (permissionMode) => {
            if (!activeProject) return;
            try { updateProject(await window.appBuilder.projects.setPermissionMode(activeProject.id, permissionMode), false); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onRefreshMcp={async () => {
            if (!activeProject) return;
            const servers = await window.appBuilder.codex.listMcp(activeProject.id);
            setMcps((current) => ({ ...current, [activeProject.id]: servers }));
          }}
          onRefreshStatus={async () => {
            if (!activeProject) return;
            await window.appBuilder.codex.refreshUsage();
            await loadThreadUsage(activeProject.id);
          }}
          onRenameConversation={async (threadId, name) => { if (activeProject) updateProject(await window.appBuilder.codex.renameConversation(activeProject.id, threadId, name), false); }}
          onRespondInteractive={async (requestId: string, response: InteractiveResponse) => {
            try { await window.appBuilder.codex.respondToInteractive(requestId, response); setInteractives((current) => current.filter((request) => request.id !== requestId)); }
            catch (caught) { setError(errorText(caught)); }
          }}
          onRestoreConversation={(threadId) => requestSwitch({ kind: "restore", threadId })}
          onSend={send}
          onSettingsChange={async (settings: ConversationSettings) => {
            if (!activeProject) return;
            try { updateProject(await window.appBuilder.codex.updateConversationSettings(activeProject.id, settings), false); }
            catch (caught) { setError(errorText(caught)); }
          }}
          overview={codex}
          project={activeProject}
          usage={activeProject ? (usage[activeProject.id] ?? null) : null}
          working={activeProject ? Boolean(working[activeProject.id]) : false}
        />
        <RunBar
          aiDisabled={!activeProject
            || Boolean(working[activeProject.id])
            || Boolean(activeInteractive)
            || Boolean(notice)}
          onConfigure={() => activeProject && setConfigureProjectId(activeProject.id)}
          onOpenConfiguration={async () => { if (activeProject) await window.appBuilder.projects.openConfiguration(activeProject.id); }}
          onProfileChange={async (profileId) => { if (!activeProject) return; await window.appBuilder.projects.selectRunProfile(activeProject.id, profileId); updateProject({ ...activeProject, selectedRunProfileId: profileId }); }}
          onRestart={() => void runAction("restart")}
          onOpen={() => { if (activeProject) void window.appBuilder.runtime.open(activeProject.id).catch((caught) => setError(errorText(caught))); }}
          onSendToAI={sendRunConfigurationPrompt}
          onStart={() => void runAction("start")}
          onStop={() => void runAction("stop")}
          project={activeProject}
          runtime={activeProject ? (runtimes[activeProject.id] ?? null) : null}
        />
      </div>

      {error && (
        <div className="fixed right-4 bottom-16 z-50 flex max-w-md items-start gap-3 rounded-md border border-destructive/30 bg-card px-4 py-3 text-sm shadow-lg" role="alert">
          <span className="text-destructive">{error}</span>
          <button aria-label="Dismiss" className="text-muted-foreground" onClick={() => setError(null)} type="button">×</button>
        </div>
      )}

      {showAdd && (
        <AddProjectDialog
          onChooseDirectory={() => window.appBuilder.projects.chooseDirectory()}
          onClose={() => setShowAdd(false)}
          onSubmit={addProject}
          onSuggestPath={(displayName) => window.appBuilder.projects.suggestPath(displayName)}
        />
      )}
      {showSettings && (
        <Dialog onOpenChange={(open) => !open && setShowSettings(false)} open>
          <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-md">
            <DialogHeader><DialogTitle title="Model and effort defaults apply to new conversation drafts. New drafts always start in Work mode.">Settings</DialogTitle></DialogHeader>
            <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
              <div className="grid gap-1.5" title="Model and effort defaults apply to new conversation drafts. New drafts always start in Work mode."><Label>Default model</Label><NativeSelect className="w-full" disabled={!codex.capabilities.models.supported} onChange={(event) => void saveAppSettings({ ...state.settings, defaultModel: event.target.value || null, defaultReasoningEffort: null })} value={state.settings.defaultModel ?? ""}><NativeSelectOption value="">Use Codex default</NativeSelectOption>{codex.catalogs.models.map((model) => <NativeSelectOption key={model.id} value={model.model}>{model.displayName}</NativeSelectOption>)}</NativeSelect></div>
              <div className="grid gap-1.5" title="Model and effort defaults apply to new conversation drafts. New drafts always start in Work mode."><Label>Default reasoning effort</Label><NativeSelect className="w-full" disabled={!codex.capabilities.models.supported} onChange={(event) => void saveAppSettings({ ...state.settings, defaultReasoningEffort: event.target.value || null })} value={state.settings.defaultReasoningEffort ?? ""}><NativeSelectOption value="">Use Codex default</NativeSelectOption>{defaultEfforts.map((effort) => <NativeSelectOption key={effort.effort} value={effort.effort}>{effort.effort}</NativeSelectOption>)}</NativeSelect></div>
              <div className="grid gap-1 rounded-md border p-3" title="Choose which advanced controls stay visible while working.">
                <p className="mb-1 text-sm font-medium">Interface Controls Visibility</p>
                <VisibilityOption checked={state.settings.showModeControl} description="Show the Work/Plan collaboration toggle in the message composer." id="settings-show-mode" label="Work/Plan Toggle" onChange={(showModeControl) => void saveAppSettings({ ...state.settings, showModeControl })} />
                <VisibilityOption checked={state.settings.showPermissionControl} description="Show the Ask, Auto, and Full permission selector in the message composer." id="settings-show-permissions" label="Permissions Mode" onChange={(showPermissionControl) => void saveAppSettings({ ...state.settings, showPermissionControl })} />
                <VisibilityOption checked={state.settings.showMcpStatus} description="Show the active MCP server button in the conversation header." id="settings-show-mcp" label="MCP Status" onChange={(showMcpStatus) => void saveAppSettings({ ...state.settings, showMcpStatus })} />
              </div>
              <div className="grid gap-2 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Codex runtime</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {codex.runtime.source ?? "No source selected"}{codex.runtime.version ? ` · ${codex.runtime.version}` : ""} · {codex.runtime.state}
                  </p>
                  {codex.runtime.executablePath && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={codex.runtime.executablePath}>{codex.runtime.executablePath}</p>}
                  {codex.runtime.bundledVersion && <p className="mt-1 text-xs text-muted-foreground">Bundled version: {codex.runtime.bundledVersion}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void window.appBuilder.codex.useAutomaticRuntime().catch((caught) => setError(errorText(caught)))} size="sm" variant="outline">Automatic</Button>
                  <Button onClick={() => void chooseRuntime()} size="sm" variant="outline">Choose executable</Button>
                  <Button onClick={() => void window.appBuilder.codex.useManagedRuntime().catch((caught) => setError(errorText(caught)))} size="sm" title={codex.runtime.update.message ?? "Use the managed Codex runtime."} variant="outline">Managed</Button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <p className="text-muted-foreground">Codex account: <span className="text-foreground">{codex.status.authenticated ? "Connected" : codex.status.authenticated === false ? "Login required" : "Checking…"}</span></p>
                {codex.status.authenticated
                  ? <Button onClick={() => void window.appBuilder.codex.logout().catch((caught) => setError(errorText(caught)))} size="sm" variant="ghost">Sign out</Button>
                  : <Button onClick={() => void window.appBuilder.codex.login().catch((caught) => setError(errorText(caught)))} size="sm">Sign in with ChatGPT</Button>}
              </div>
              <div className="flex flex-wrap gap-2 rounded-md border p-3">
                <Button disabled={!activeProject?.activeThreadId} onClick={() => void exportActiveConversation()} size="sm" title={activeProject?.activeThreadId ? "Save the open conversation as Markdown." : "Open an existing conversation to enable Markdown export."} variant="outline">Export active conversation</Button>
                <Button onClick={() => void window.appBuilder.bootstrap.exportDiagnostics()} size="sm" title="Export a local support bundle when you need to inspect or share allowlisted diagnostic metadata." variant="outline">Export diagnostics</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {pendingSwitch && activeProject && (
        <Dialog onOpenChange={(open) => !open && setPendingSwitch(null)} open>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Change conversation?</DialogTitle><DialogDescription>{working[activeProject.id] ? "Codex is working. The active turn and its background terminals will be stopped first. " : ""}{activeProject.activeThreadId ? "Choose what to do with the current conversation." : "Continue to the selected conversation."}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button onClick={() => setPendingSwitch(null)} type="button" variant="ghost">Cancel</Button>
              {activeProject.activeThreadId ? <><Button onClick={() => void executeSwitch(pendingSwitch, "keep").catch((caught) => setError(errorText(caught)))} type="button" variant="outline">Keep current</Button><Button onClick={() => void executeSwitch(pendingSwitch, "archive").catch((caught) => setError(errorText(caught)))} type="button">Archive current</Button></>
                : <Button onClick={() => void executeSwitch(pendingSwitch, "keep").catch((caught) => setError(errorText(caught)))} type="button">Continue</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {manageProjectId && (() => {
        const project = state.projects.find((candidate) => candidate.id === manageProjectId);
        return project ? <ProjectActionsDialog onArchive={async () => applyProjectLifecycle(await window.appBuilder.projects.archive(project.id), project.id)} onClose={() => setManageProjectId(null)} onRemove={async () => applyProjectLifecycle(await window.appBuilder.projects.remove(project.id), project.id, true)} onRestore={async () => applyProjectLifecycle(await window.appBuilder.projects.restore(project.id), project.id)} project={project} /> : null;
      })()}
      {approvals[0] && <ApprovalDialog approval={approvals[0]} onRespond={(decision) => void respondToApproval(decision)} project={state.projects.find((project) => project.id === approvals[0].projectId)} />}
      {configureProjectId && (() => {
        const project = state.projects.find((candidate) => candidate.id === configureProjectId);
        return project ? (
          <ConfigureProjectDialog
            onClose={() => setConfigureProjectId(null)}
            onInspect={() => window.appBuilder.projects.inspectConfiguration(project.id)}
            onOpenEditor={() => window.appBuilder.projects.openConfiguration(project.id)}
            onSave={async (configuration) => updateProject(await window.appBuilder.projects.saveConfiguration(project.id, configuration), false)}
            project={project}
          />
        ) : null;
      })()}
    </div>
  );
}
