import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MarkdownMessage, safeUrl } from "../src/renderer/components/MarkdownMessage";
import { MessageComposer } from "../src/renderer/components/MessageComposer";
import { AttachmentList } from "../src/renderer/components/AttachmentList";
import { contextRemainingPercent, ConversationHeader, rateLimitRemainingPercent, remainingBatteryState } from "../src/renderer/components/ConversationHeader";
import { ModeToggle } from "../src/renderer/components/ModeToggle";
import { ProjectSidebar } from "../src/renderer/components/ProjectSidebar";
import { APP_IDEAS, AddProjectDialog } from "../src/renderer/components/AddProjectDialog";
import { RUN_CONFIGURATION_PROMPT, RunBar } from "../src/renderer/components/RunBar";
import { DesktopRoot } from "../src/renderer/DesktopRoot";
import { App } from "../src/renderer/App";
import type { AppSnapshot, CodexCapabilities, CodexOverview, Project } from "../src/shared/types";

afterEach(cleanup);

const available = { supported: true as const, reason: null };
const capabilities: CodexCapabilities = {
  models: available,
  collaborationModes: available,
  threadSettings: available,
  conversations: available,
  conversationNaming: available,
  conversationArchiving: available,
  conversationDeletion: available,
  usage: available,
  mcp: available,
  backgroundTerminals: available,
};

describe("MarkdownMessage", () => {
  it("allows only HTTP(S) links", () => {
    expect(safeUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(safeUrl("http://example.com/")).toBe("http://example.com/");
    expect(safeUrl("file:///tmp/secret")).toBe("");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("relative.md")).toBe("");
  });

  it("renders GFM and incomplete Markdown without raw HTML or unsafe anchors", () => {
    const openExternal = vi.fn();
    const { container } = render(<MarkdownMessage onOpenExternal={openExternal} text={'# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[Web](https://example.com) [Local](file:///tmp/a)\n\n<img src=x onerror="alert(1)">\n\n**streaming'} />);
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(container.querySelector("table")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("Local").closest("a")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Web" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
    expect(screen.getByText("**streaming")).toBeInTheDocument();
  });

  it("copies fenced code through the preload boundary", () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "appBuilder", { configurable: true, value: { clipboard: { copy } } });
    render(<MarkdownMessage onOpenExternal={() => undefined} text={'```ts\nconst answer = 42;\n```'} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(copy).toHaveBeenCalledWith("const answer = 42;");
  });
});

it("replaces the normal composer with queued structured questions", () => {
  render(
    <MessageComposer
      capabilities={capabilities}
      disabled={false}
      interactive={{ id: "request", projectId: "project", threadId: "thread", kind: "questions", questions: [{ id: "choice", header: "Choice", question: "Pick one", secret: false, allowOther: true, options: [{ label: "One", description: "First" }] }] }}
      models={[]}
      onChooseAttachments={async () => []}
      onInterrupt={() => undefined}
      onOpenExternal={() => undefined}
      onRespondInteractive={() => undefined}
      onSend={() => undefined}
      onSettingsChange={() => undefined}
      onPermissionModeChange={() => undefined}
      permissionMode="ask"
      settings={{ model: null, reasoningEffort: null, mode: "work" }}
      showModeControl={false}
      showPermissionControl={false}
      working
    />,
  );
  expect(screen.queryByLabelText("Message Codex")).not.toBeInTheDocument();
  expect(screen.getByText("Pick one")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit answers" })).toBeInTheDocument();
});

it("removes every pending attachment at once", () => {
  const removeAll = vi.fn();
  render(
    <AttachmentList
      attachments={[
        { id: "one", name: "one.png", kind: "image", size: 10 },
        { id: "two", name: "two.txt", kind: "file", size: 20 },
      ]}
      onRemove={() => undefined}
      onRemoveAll={removeAll}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove all attachments" }));
  expect(removeAll).toHaveBeenCalledOnce();
});

it("uses a Work and Plan toggle for collaboration mode", () => {
  const change = vi.fn();
  render(<ModeToggle mode="work" onChange={change} />);
  expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(change).toHaveBeenCalledWith("plan");
});

it("opens a working rename form from conversation history", async () => {
  const onRename = vi.fn().mockResolvedValue(undefined);
  const overview: CodexOverview = {
    status: { state: "ready", authenticated: true, message: null },
    capabilities,
    catalogs: { models: [], collaborationModes: ["work", "plan"] },
    accountUsage: {
      lifetimeTokens: null,
      todayTokens: null,
      primary: { usedPercent: 69, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      spendControlReached: false,
    },
    runtime: {
      state: "ready",
      source: "path",
      executablePath: "codex",
      version: "1.0.0",
      bundledVersion: "1.0.0",
      candidateFailure: null,
      update: { state: "disabled", currentVersion: "1.0.0", availableVersion: null, releaseUrl: null, message: "Managed Codex updates are deferred." },
    },
    authFlow: { state: "idle", loginId: null, message: null },
  };
  const project: Project = {
    id: "project",
    name: "Project",
    path: "C:\\project",
    archived: false,
    permissionMode: "ask",
    activeThreadId: "thread",
    draft: null,
    conversations: [{
      threadId: "thread",
      name: "First name",
      preview: "Preview",
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, reasoningEffort: null, mode: "work" },
    }],
    selectedRunProfileId: null,
    runProfiles: [],
  };
  render(
    <ConversationHeader
      mcps={[]}
      onArchive={() => undefined}
      onDelete={() => undefined}
      onNew={() => undefined}
      onOpen={() => undefined}
      onRefreshMcp={() => undefined}
      onRefreshStatus={() => undefined}
      onRename={onRename}
      onRestore={() => undefined}
      overview={overview}
      project={project}
      showMcpStatus={false}
      usage={{ totalTokens: 1_000_000, contextTokens: 25_000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, modelContextWindow: 100_000 }}
    />,
  );

  const usageBattery = screen.getByLabelText("31% Codex usage remaining");
  expect(usageBattery).toBeInTheDocument();
  expect(screen.queryByText(/25K used of 100K/)).not.toBeInTheDocument();
  fireEvent.click(usageBattery.closest("button")!);
  expect(screen.getByText(/25K used of 100K · 75% remaining/)).toBeInTheDocument();
  expect(screen.getByText("31% remaining")).toBeInTheDocument();
  fireEvent.click(usageBattery.closest("button")!);
  expect(screen.queryByText(/MCP.*Active/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Export active conversation" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /First name/ }));
  fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
  const input = screen.getByRole("textbox", { name: "Conversation name" });
  fireEvent.change(input, { target: { value: "Better name" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));

  await waitFor(() => expect(onRename).toHaveBeenCalledWith("thread", "Better name"));
});

it("offers project-level permission behavior in the composer", async () => {
  const changePermissionMode = vi.fn().mockResolvedValue(undefined);
  render(
    <MessageComposer
      capabilities={capabilities}
      disabled={false}
      interactive={null}
      models={[]}
      onChooseAttachments={async () => []}
      onInterrupt={() => undefined}
      onOpenExternal={() => undefined}
      onPermissionModeChange={changePermissionMode}
      onRespondInteractive={() => undefined}
      onSend={() => undefined}
      onSettingsChange={() => undefined}
      permissionMode="ask"
      settings={{ model: null, reasoningEffort: null, mode: "work" }}
      showModeControl={false}
      showPermissionControl
      working={false}
    />,
  );

  expect(screen.getByText("Perms:")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Work" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Ask" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Auto" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Permissions" }), { target: { value: "workspace" } });
  await waitFor(() => expect(changePermissionMode).toHaveBeenCalledWith("workspace"));
});

it("calculates remaining context and Codex quota battery thresholds", () => {
  const usage = (contextTokens: number) => ({
    totalTokens: 1_000_000,
    contextTokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    modelContextWindow: 100_000,
  });

  expect(contextRemainingPercent(null)).toBeNull();
  expect(contextRemainingPercent({ ...usage(0), modelContextWindow: null })).toBeNull();
  expect(contextRemainingPercent(usage(0))).toBe(100);
  expect(contextRemainingPercent(usage(25_000))).toBe(75);
  expect(contextRemainingPercent(usage(50_000))).toBe(50);
  expect(contextRemainingPercent(usage(75_000))).toBe(25);
  expect(contextRemainingPercent(usage(90_000))).toBe(10);
  expect(contextRemainingPercent(usage(91_000))).toBe(9);
  expect(contextRemainingPercent(usage(100_000))).toBe(0);

  expect(rateLimitRemainingPercent(null)).toBeNull();
  expect(rateLimitRemainingPercent({ usedPercent: Number.NaN, windowDurationMins: null, resetsAt: null })).toBeNull();
  expect(rateLimitRemainingPercent({ usedPercent: -1, windowDurationMins: null, resetsAt: null })).toBe(100);
  expect(rateLimitRemainingPercent({ usedPercent: 0, windowDurationMins: null, resetsAt: null })).toBe(100);
  expect(rateLimitRemainingPercent({ usedPercent: 69, windowDurationMins: null, resetsAt: null })).toBe(31);
  expect(rateLimitRemainingPercent({ usedPercent: 100, windowDurationMins: null, resetsAt: null })).toBe(0);
  expect(rateLimitRemainingPercent({ usedPercent: 101, windowDurationMins: null, resetsAt: null })).toBe(0);

  expect(remainingBatteryState(100)).toEqual({ segments: 4, tone: "green" });
  expect(remainingBatteryState(75)).toEqual({ segments: 3, tone: "green" });
  expect(remainingBatteryState(50)).toEqual({ segments: 2, tone: "green" });
  expect(remainingBatteryState(25)).toEqual({ segments: 1, tone: "green" });
  expect(remainingBatteryState(10)).toEqual({ segments: 1, tone: "yellow" });
  expect(remainingBatteryState(9)).toEqual({ segments: 0, tone: "red" });
});

it("keeps settings scrollable, persists control visibility, and owns conversation export", async () => {
  const overview: CodexOverview = {
    status: { state: "ready", authenticated: true, message: null },
    capabilities,
    catalogs: { models: [], collaborationModes: ["work", "plan"] },
    accountUsage: null,
    runtime: {
      state: "ready",
      source: "path",
      executablePath: "codex",
      version: "1.0.0",
      bundledVersion: "1.0.0",
      candidateFailure: null,
      update: { state: "disabled", currentVersion: "1.0.0", availableVersion: null, releaseUrl: null, message: "Managed Codex updates are deferred." },
    },
    authFlow: { state: "idle", loginId: null, message: null },
  };
  const settings = {
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultMode: "work" as const,
    sidebarCollapsed: false,
    showModeControl: false,
    showPermissionControl: false,
    showMcpStatus: false,
    codexRuntime: { preference: "auto" as const, customExecutablePath: null, managedVersion: null },
  };
  const baseSnapshot: AppSnapshot = {
    state: { version: 3, activeProjectId: null, settings, projects: [] },
    runtimes: [],
    codex: overview,
  };
  const updateSettings = vi.fn(async (nextSettings) => ({ ...baseSnapshot.state, settings: nextSettings }));
  const onEvent = vi.fn(() => () => undefined);
  Object.defineProperty(window, "appBuilder", {
    configurable: true,
    value: {
      codex: { onEvent },
      runtime: { onEvent },
      settings: { update: updateSettings },
    },
  });

  render(<App initialSnapshot={baseSnapshot} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveClass("overflow-hidden");
  expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText("Interface Controls Visibility").closest(".overflow-y-auto")).not.toBeNull();
  expect(screen.queryByText("Model and effort defaults apply to new conversation drafts. New drafts always start in Work mode.")).not.toBeInTheDocument();
  expect(screen.queryByText("Managed Codex updates are deferred.")).not.toBeInTheDocument();
  expect(screen.queryByText("Conversation export")).not.toBeInTheDocument();
  expect(screen.queryByText("Diagnostics")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Managed" })).toHaveAttribute("title", "Managed Codex updates are deferred.");
  expect(screen.getByRole("button", { name: "Export active conversation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export active conversation" })).toHaveAttribute("title", "Open an existing conversation to enable Markdown export.");
  expect(screen.getByRole("button", { name: "Export diagnostics" })).toHaveAttribute("title", "Export a local support bundle when you need to inspect or share allowlisted diagnostic metadata.");
  expect(screen.queryByRole("button", { name: /Check for update/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Install /i })).not.toBeInTheDocument();
  const showMode = screen.getByRole("checkbox", { name: /Work\/Plan Toggle/ });
  expect(showMode).not.toBeChecked();
  fireEvent.click(showMode);
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ showModeControl: true })));

  cleanup();
  const project: Project = {
    id: "project",
    name: "Project",
    path: "C:\\project",
    archived: false,
    permissionMode: "workspace",
    activeThreadId: "thread",
    draft: null,
    conversations: [{
      threadId: "thread",
      name: "Export me",
      preview: "Preview",
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, reasoningEffort: null, mode: "work" },
    }],
    selectedRunProfileId: null,
    runProfiles: [],
  };
  const activeSnapshot: AppSnapshot = {
    ...baseSnapshot,
    state: { ...baseSnapshot.state, activeProjectId: project.id, projects: [project] },
  };
  const exportConversation = vi.fn().mockResolvedValue({ path: "conversation.md", canceled: false });
  Object.defineProperty(window, "appBuilder", {
    configurable: true,
    value: {
      codex: { onEvent, threadUsage: vi.fn().mockResolvedValue(null), exportConversation },
      runtime: { onEvent },
      projects: { select: vi.fn().mockResolvedValue({ project, items: [] }) },
      settings: { update: updateSettings },
    },
  });

  render(<App initialSnapshot={activeSnapshot} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const exportButton = screen.getByRole("button", { name: "Export active conversation" });
  expect(exportButton).toBeEnabled();
  fireEvent.click(exportButton);
  await waitFor(() => expect(exportConversation).toHaveBeenCalledWith(expect.objectContaining({
    projectName: "Project",
    conversationName: "Export me",
  })));
});

it("provides a project sidebar collapse control", () => {
  const collapse = vi.fn();
  render(
    <ProjectSidebar
      activeProjectId={null}
      collapsed={false}
      onAdd={() => undefined}
      onCollapsedChange={collapse}
      onManage={() => undefined}
      onSelect={() => undefined}
      onSettings={() => undefined}
      projects={[]}
      runtimes={{}}
    />,
  );
  expect(screen.getByText("Projects")).toBeInTheDocument();
  expect(screen.queryByText("AppBuilder")).not.toBeInTheDocument();
  expect(document.querySelector("aside img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Collapse project sidebar" }));
  expect(collapse).toHaveBeenCalledWith(true);
});

it("autofills a new project idea and default path without submitting it", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const suggestPath = vi.fn().mockResolvedValue("/Documents/AppBuilder Projects/habit-tracker");
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  render(
    <AddProjectDialog
      onChooseDirectory={async () => null}
      onClose={() => undefined}
      onSubmit={submit}
      onSuggestPath={suggestPath}
    />,
  );

  expect(APP_IDEAS).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: "Surprise me with an app idea" }));
  random.mockRestore();

  await waitFor(() => expect(suggestPath).toHaveBeenCalledWith("Habit Tracker"));
  expect(screen.getByLabelText("Display name")).toHaveValue("Habit Tracker");
  expect(screen.getByLabelText("Project directory")).toHaveValue("/Documents/AppBuilder Projects/habit-tracker");
  expect(submit).not.toHaveBeenCalled();
});

it("sends the run-configuration setup prompt to AI", async () => {
  const sendToAI = vi.fn().mockResolvedValue(undefined);
  const configure = vi.fn();
  const project: Project = {
    id: "project",
    name: "Project",
    path: "C:\\project",
    archived: false,
    permissionMode: "workspace",
    activeThreadId: null,
    draft: { model: null, reasoningEffort: null, mode: "work" },
    conversations: [],
    selectedRunProfileId: null,
    runProfiles: [],
  };
  render(
    <RunBar
      aiDisabled={false}
      onConfigure={configure}
      onOpenConfiguration={async () => undefined}
      onProfileChange={() => undefined}
      onRestart={() => undefined}
      onSendToAI={sendToAI}
      onStart={() => undefined}
      onStop={() => undefined}
      project={project}
      runtime={null}
    />,
  );

  expect(screen.getByText("No app run config set.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send to AI" }));
  await waitFor(() => expect(sendToAI).toHaveBeenCalledWith(RUN_CONFIGURATION_PROMPT));

  fireEvent.click(screen.getByRole("button", { name: "Run configuration information" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Configure manually" }));
  expect(configure).toHaveBeenCalledOnce();
});

it("shows selected run configuration details and opens its config file", async () => {
  const openConfiguration = vi.fn().mockResolvedValue(undefined);
  const project: Project = {
    id: "project",
    name: "Project",
    path: "C:\\project",
    archived: false,
    permissionMode: "ask",
    activeThreadId: null,
    draft: { model: null, reasoningEffort: null, mode: "work" },
    conversations: [],
    selectedRunProfileId: "dev",
    runProfiles: [{ id: "dev", name: "Development", command: "npm", args: ["run", "dev"] }],
  };
  render(
    <RunBar
      aiDisabled={false}
      onConfigure={() => undefined}
      onOpenConfiguration={openConfiguration}
      onProfileChange={() => undefined}
      onRestart={() => undefined}
      onSendToAI={async () => undefined}
      onStart={() => undefined}
      onStop={() => undefined}
      project={project}
      runtime={null}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Run configuration information" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Development")).toBeInTheDocument();
  expect(within(dialog).getByText("npm")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Open config in default editor/ }));
  await waitFor(() => expect(openConfiguration).toHaveBeenCalledOnce());
});

it("renders state recovery actions before the desktop app", async () => {
  const retry = vi.fn().mockResolvedValue({
    phase: "recovery",
    recovery: {
      error: { code: "STATE_INVALID", message: "Saved state is invalid.", details: "Unexpected token", retryable: true },
      preservedStatePath: "state.invalid",
      backups: [{ id: "1", createdAt: 1, version: 3 }],
    },
  });
  const snapshot = await retry();
  Object.defineProperty(window, "appBuilder", {
    configurable: true,
    value: {
      bootstrap: {
        get: vi.fn().mockResolvedValue(snapshot),
        retry,
        restore: vi.fn().mockResolvedValue(snapshot),
        reset: vi.fn().mockResolvedValue(snapshot),
        exportDiagnostics: vi.fn().mockResolvedValue({ path: null, canceled: true }),
        onEvent: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
  render(<DesktopRoot />);
  expect(await screen.findByText("Recovery required")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry loading" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export diagnostics" })).toBeInTheDocument();
});
