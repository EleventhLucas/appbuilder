import { useMemo, useState } from "react";
import { Archive, CheckCircle2, ChevronDown, CircleAlert, MessagesSquare, Pencil, Plus, RotateCcw, Search, Server, Trash2 } from "lucide-react";
import type {
  CodexOverview,
  ConversationRecord,
  McpServerSummary,
  Project,
  RateLimitWindow,
  ThreadTokenUsage,
} from "../../shared/types";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

interface ConversationHeaderProps {
  project: Project;
  overview: CodexOverview;
  usage: ThreadTokenUsage | null;
  mcps: McpServerSummary[];
  showMcpStatus: boolean;
  onNew(): Promise<void> | void;
  onOpen(threadId: string): Promise<void> | void;
  onRename(threadId: string, name: string): Promise<void> | void;
  onArchive(threadId: string): Promise<void> | void;
  onRestore(threadId: string): Promise<void> | void;
  onDelete(threadId: string): Promise<void> | void;
  onRefreshStatus(): Promise<void> | void;
  onRefreshMcp(): Promise<void> | void;
}

export function contextRemainingPercent(usage: ThreadTokenUsage | null): number | null {
  const contextWindow = usage?.modelContextWindow;
  if (contextWindow === null || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const used = Math.max(0, usage?.contextTokens ?? 0);
  const remaining = Math.max(0, contextWindow - used);
  return Math.max(0, Math.min(100, Math.round((remaining / contextWindow) * 100)));
}

export function rateLimitRemainingPercent(window: RateLimitWindow | null): number | null {
  const usedPercent = window?.usedPercent;
  if (usedPercent === null || usedPercent === undefined || !Number.isFinite(usedPercent)) return null;
  return Math.round(100 - Math.max(0, Math.min(100, usedPercent)));
}

export function remainingBatteryState(percent: number): { segments: number; tone: "green" | "yellow" | "red" } {
  const segments = percent === 100 ? 4 : percent >= 75 ? 3 : percent >= 50 ? 2 : percent >= 25 ? 1 : percent >= 10 ? 1 : 0;
  return {
    segments,
    tone: percent >= 25 ? "green" : percent >= 10 ? "yellow" : "red",
  };
}

function UsageBattery({ percent }: { percent: number }) {
  const state = remainingBatteryState(percent);
  return (
    <span
      aria-label={`${percent}% Codex usage remaining`}
      className={cn(
        "inline-flex items-center gap-1",
        state.tone === "green" ? "text-emerald-500" : state.tone === "yellow" ? "text-amber-500" : "text-destructive",
      )}
      title={`${percent}% Codex usage remaining`}
    >
      <span aria-hidden="true" className="flex h-3 w-6 gap-px rounded-[3px] border border-current p-px">
        {[0, 1, 2, 3].map((segment) => (
          <span className={cn("h-full min-w-0 flex-1 rounded-[1px]", segment < state.segments ? "bg-current" : "bg-current/15")} key={segment} />
        ))}
      </span>
      <span aria-hidden="true" className="-ml-1 h-1.5 w-0.5 rounded-r-sm bg-current" />
      <span className="tabular-nums">{percent}%</span>
    </span>
  );
}

export function conversationLabel(conversation: ConversationRecord | null): string {
  return conversation?.name?.trim() || conversation?.preview?.trim() || "New conversation";
}

function formatTokens(value: number | null): string {
  if (value === null) return "Unavailable";
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function resetText(timestamp: number | null): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "Reset unavailable";
}

export function ConversationHeader({
  project,
  overview,
  usage,
  mcps,
  showMcpStatus,
  onNew,
  onOpen,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onRefreshStatus,
  onRefreshMcp,
}: ConversationHeaderProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConversationRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const active = project.conversations.find((conversation) => conversation.threadId === project.activeThreadId) ?? null;
  const settings = project.draft ?? active?.settings ?? null;
  const matching = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return [...project.conversations]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((conversation) => !term || conversationLabel(conversation).toLocaleLowerCase().includes(term));
  }, [project.conversations, search]);
  const activeCount = mcps.filter((server) => server.startupState === "ready").length;
  const contextPercent = contextRemainingPercent(usage);
  const primaryRemainingPercent = rateLimitRemainingPercent(overview.accountUsage?.primary ?? null);
  const secondaryRemainingPercent = rateLimitRemainingPercent(overview.accountUsage?.secondary ?? null);
  const primaryBatteryState = primaryRemainingPercent === null ? null : remainingBatteryState(primaryRemainingPercent);

  const run = async (action: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const row = (conversation: ConversationRecord) => (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-lg hover:bg-muted" key={conversation.threadId}>
      <button
        className="min-w-0 px-3 py-2 text-left"
        disabled={busy}
        onClick={() => void run(async () => {
          if (conversation.archived) await onRestore(conversation.threadId);
          else await onOpen(conversation.threadId);
          setPickerOpen(false);
        })}
        type="button"
      >
        <span className="block truncate text-sm">{conversationLabel(conversation)}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {conversation.updatedAt ? new Date(conversation.updatedAt * 1000).toLocaleString() : "No messages yet"}
        </span>
      </button>
      <div className="flex pr-1">
        {!conversation.archived && (
          <Button
            aria-label="Rename conversation"
            disabled={busy || !overview.capabilities.conversationNaming.supported}
            onClick={() => {
              setRenameTarget(conversation);
              setRenameValue(conversation.name ?? conversationLabel(conversation));
              setPickerOpen(false);
            }}
            size="icon-xs"
            title={overview.capabilities.conversationNaming.reason ?? "Rename"}
            type="button"
            variant="ghost"
          >
            <Pencil />
          </Button>
        )}
        {conversation.archived ? (
          <Button aria-label="Restore conversation" disabled={busy || !overview.capabilities.conversationArchiving.supported} onClick={() => void run(() => onRestore(conversation.threadId))} size="icon-xs" title={overview.capabilities.conversationArchiving.reason ?? "Restore and open"} type="button" variant="ghost"><RotateCcw /></Button>
        ) : (
          <Button aria-label="Archive conversation" disabled={busy || !overview.capabilities.conversationArchiving.supported} onClick={() => void run(() => onArchive(conversation.threadId))} size="icon-xs" title={overview.capabilities.conversationArchiving.reason ?? "Archive"} type="button" variant="ghost"><Archive /></Button>
        )}
        <Button
          aria-label="Delete conversation"
          disabled={busy || !overview.capabilities.conversationDeletion.supported}
          onClick={() => {
            if (window.confirm("Permanently delete this conversation and all spawned descendant conversations? This cannot be undone.")) {
              void run(() => onDelete(conversation.threadId));
            }
          }}
          size="icon-xs"
          title={overview.capabilities.conversationDeletion.reason ?? "Delete permanently"}
          type="button"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );

  return (
    <header className="relative z-30 flex min-h-16 shrink-0 items-center gap-4 border-b px-6 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">{project.name}</h1>
        <p className="mt-1 truncate text-xs text-muted-foreground">{project.path}</p>
      </div>

      <div className="relative">
        <Button aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)} type="button" variant="outline">
          <MessagesSquare />
          <span className="max-w-44 truncate">{project.draft ? "New conversation" : active ? conversationLabel(active) : "No active conversation"}</span>
          <ChevronDown />
        </Button>
        {pickerOpen && (
          <div className="absolute top-10 right-0 z-50 w-96 rounded-xl border bg-popover p-2 text-popover-foreground shadow-xl">
            <Button className="mb-2 w-full justify-start" disabled={busy} onClick={() => void run(async () => { await onNew(); setPickerOpen(false); })} type="button" variant="ghost"><Plus /> New conversation</Button>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
              <Input aria-label="Search conversations" className="pl-8" onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" value={search} />
            </div>
            <div className="max-h-80 overflow-y-auto">
              {matching.filter((conversation) => !conversation.archived).map(row)}
              {matching.some((conversation) => conversation.archived) && (
                <div className="mt-2 border-t pt-2">
                  <p className="px-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">Archived</p>
                  {matching.filter((conversation) => conversation.archived).map(row)}
                </div>
              )}
              {matching.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted-foreground">No matching conversations</p>}
            </div>
          </div>
        )}
      </div>

      <div className="relative">
        <Button
          aria-expanded={statusOpen}
          onClick={() => {
            const open = !statusOpen;
            setStatusOpen(open);
            if (open) void onRefreshStatus();
          }}
          type="button"
          variant="outline"
        >
          {overview.status.state === "ready" ? <CheckCircle2 className="text-emerald-500" /> : <CircleAlert className="text-amber-500" />}
          <span>{settings?.model ?? "Codex default"}</span>
          <span className="text-muted-foreground">·</span>
          <span>{settings?.reasoningEffort ?? "default effort"}</span>
          {primaryRemainingPercent !== null && <><span className="text-muted-foreground">·</span><UsageBattery percent={primaryRemainingPercent} /></>}
        </Button>
        {statusOpen && (
          <div className="absolute top-10 right-0 z-50 grid w-80 gap-3 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-xl">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="text-muted-foreground">Connection</span><span>{overview.status.state === "ready" ? "Connected" : overview.status.state}</span>
              <span className="text-muted-foreground">Model</span><span className="truncate">{settings?.model ?? "Codex default"}</span>
              <span className="text-muted-foreground">Effort</span><span>{settings?.reasoningEffort ?? "Codex default"}</span>
              <span className="text-muted-foreground">Context</span><span>{contextPercent === null ? "Unavailable" : `${formatTokens(usage?.contextTokens ?? null)} used of ${formatTokens(usage?.modelContextWindow ?? null)} · ${contextPercent}% remaining`}</span>
              <span className="text-muted-foreground">Today</span><span>{formatTokens(overview.accountUsage?.todayTokens ?? null)}</span>
              <span className="text-muted-foreground">Lifetime</span><span>{formatTokens(overview.accountUsage?.lifetimeTokens ?? null)}</span>
            </div>
            {overview.accountUsage?.primary && primaryRemainingPercent !== null && (
              <div>
                <div className="mb-1 flex justify-between text-xs"><span>Primary limit</span><span>{primaryRemainingPercent}% remaining</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full",
                      primaryBatteryState?.tone === "green" ? "bg-emerald-500" : primaryBatteryState?.tone === "yellow" ? "bg-amber-500" : "bg-destructive",
                    )}
                    style={{ width: `${primaryRemainingPercent}%` }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">{resetText(overview.accountUsage.primary.resetsAt)}</p>
              </div>
            )}
            {overview.accountUsage?.secondary && secondaryRemainingPercent !== null && <p className="text-xs text-muted-foreground">Secondary limit: {secondaryRemainingPercent}% remaining · {resetText(overview.accountUsage.secondary.resetsAt)}</p>}
            {overview.accountUsage?.spendControlReached && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">Account spend control has been reached.</p>}
            {!overview.capabilities.usage.supported && <p className="text-xs text-muted-foreground">{overview.capabilities.usage.reason}</p>}
          </div>
        )}
      </div>

      {showMcpStatus && <Button onClick={() => { setMcpOpen(true); void onRefreshMcp(); }} type="button" variant="outline"><Server /> {activeCount} MCP{activeCount === 1 ? "" : "s"} Active</Button>}

      {mcpOpen && (
        <Dialog onOpenChange={setMcpOpen} open>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Model Context Protocol servers</DialogTitle>
              <DialogDescription>Read-only status for MCP servers available to this conversation.</DialogDescription>
            </DialogHeader>
            <div className="grid max-h-96 gap-2 overflow-y-auto">
              {mcps.map((server) => (
                <div className="rounded-xl border p-3" key={server.name}>
                  <div className="flex items-center justify-between gap-3"><strong className="truncate text-sm">{server.title ?? server.name}</strong><span className="text-xs capitalize text-muted-foreground">{server.startupState}</span></div>
                  <p className="mt-1 text-xs text-muted-foreground">{server.toolCount} tool{server.toolCount === 1 ? "" : "s"} · Auth: {server.authStatus}</p>
                  {server.error && <p className="mt-2 text-xs text-destructive">{server.error}</p>}
                </div>
              ))}
              {mcps.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No configured MCP servers were reported.</p>}
            </div>
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Manage MCP configuration outside AppBuilder in Codex configuration, or ask Codex to help configure it.</p>
          </DialogContent>
        </Dialog>
      )}

      {renameTarget && (
        <Dialog onOpenChange={(open) => !open && setRenameTarget(null)} open>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>Choose a name that will be shown in this project&apos;s conversation history.</DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const name = renameValue.trim();
                if (!name) return;
                void run(async () => {
                  await onRename(renameTarget.threadId, name);
                  setRenameTarget(null);
                });
              }}
            >
              <Input aria-label="Conversation name" autoFocus maxLength={120} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} />
              <DialogFooter className="mt-0">
                <Button disabled={busy || !renameValue.trim()} type="submit">Rename</Button>
                <Button disabled={busy} onClick={() => setRenameTarget(null)} type="button" variant="outline">Cancel</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </header>
  );
}
