import type {
  CodexOverview,
  ConversationItem,
  ConversationSettings,
  InteractiveRequest,
  InteractiveResponse,
  McpServerSummary,
  PendingChatAttachment,
  Project,
  ProjectPermissionMode,
  ThreadTokenUsage,
} from "../../shared/types";
import { cn } from "../lib/utils";
import { AttachmentList } from "./AttachmentList";
import { ConversationHeader } from "./ConversationHeader";
import { MarkdownMessage } from "./MarkdownMessage";
import { MessageComposer } from "./MessageComposer";
import { PlanCard } from "./PlanCard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";

interface ConversationProps {
  project: Project | null;
  items: ConversationItem[];
  working: boolean;
  notice: string | null;
  overview: CodexOverview;
  usage: ThreadTokenUsage | null;
  mcps: McpServerSummary[];
  interactive: InteractiveRequest | null;
  showModeControl: boolean;
  showPermissionControl: boolean;
  showMcpStatus: boolean;
  onChooseAttachments(): Promise<PendingChatAttachment[]>;
  onSend(text: string, attachments: PendingChatAttachment[]): Promise<void> | void;
  onInterrupt(): Promise<void> | void;
  onSettingsChange(settings: ConversationSettings): Promise<void> | void;
  onPermissionModeChange(permissionMode: ProjectPermissionMode): Promise<void> | void;
  onRespondInteractive(requestId: string, response: InteractiveResponse): Promise<void> | void;
  onOpenExternal(url: string): Promise<void> | void;
  onNewConversation(): Promise<void> | void;
  onOpenConversation(threadId: string): Promise<void> | void;
  onRenameConversation(threadId: string, name: string): Promise<void> | void;
  onArchiveConversation(threadId: string): Promise<void> | void;
  onRestoreConversation(threadId: string): Promise<void> | void;
  onDeleteConversation(threadId: string): Promise<void> | void;
  onRefreshStatus(): Promise<void> | void;
  onRefreshMcp(): Promise<void> | void;
  onLogin(): Promise<void> | void;
  onCancelLogin(): Promise<void> | void;
  onRetryRuntime(): Promise<void> | void;
  onChooseRuntime(): Promise<void> | void;
  onUseManagedRuntime(): Promise<void> | void;
}

export function Conversation({
  project,
  items,
  working,
  notice,
  overview,
  usage,
  mcps,
  interactive,
  showModeControl,
  showPermissionControl,
  showMcpStatus,
  onChooseAttachments,
  onSend,
  onInterrupt,
  onSettingsChange,
  onPermissionModeChange,
  onRespondInteractive,
  onOpenExternal,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  onDeleteConversation,
  onRefreshStatus,
  onRefreshMcp,
  onLogin,
  onCancelLogin,
  onRetryRuntime,
  onChooseRuntime,
  onUseManagedRuntime,
}: ConversationProps) {
  const activeConversation = project?.conversations.find((conversation) => conversation.threadId === project.activeThreadId) ?? null;
  const settings = project?.draft ?? activeConversation?.settings ?? null;
  const conversationKey = project ? `${project.id}:${project.activeThreadId ?? (project.draft ? "draft" : "none")}` : "no-project";
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return items.flatMap((item) => {
      const searchable = item.type === "message"
        ? `${item.text}\n${item.attachments?.map((attachment) => attachment.name).join("\n") ?? ""}`
        : `${item.text}\n${item.explanation ?? ""}\n${item.steps.map((step) => step.step).join("\n")}`;
      const normalized = searchable.toLocaleLowerCase();
      const found: string[] = [];
      let offset = 0;
      while ((offset = normalized.indexOf(query, offset)) >= 0) {
        found.push(item.id);
        offset += Math.max(query.length, 1);
      }
      return found;
    });
  }, [items, search]);
  const matchingIds = useMemo(() => new Set(matches), [matches]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInput.current?.focus(), 0);
      } else if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    setActiveMatch((current) => matches.length === 0 ? 0 : Math.min(current, matches.length - 1));
  }, [matches.length]);

  useEffect(() => {
    const id = matches[activeMatch];
    if (id) document.querySelector(`[data-conversation-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatch, matches]);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {project && (
        <ConversationHeader
          mcps={mcps}
          showMcpStatus={showMcpStatus}
          onArchive={onArchiveConversation}
          onDelete={onDeleteConversation}
          onNew={onNewConversation}
          onOpen={onOpenConversation}
          onRefreshMcp={onRefreshMcp}
          onRefreshStatus={onRefreshStatus}
          onRename={onRenameConversation}
          onRestore={onRestoreConversation}
          overview={overview}
          project={project}
          usage={usage}
        />
      )}

      {notice && (
        <div className="mx-6 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
          <span className="mr-auto">{notice}</span>
          {overview.runtime.state === "awaitingFallbackConsent" && (
            <>
              <button className="font-medium underline" onClick={onRetryRuntime} type="button">Retry</button>
              <button className="font-medium underline" onClick={onChooseRuntime} type="button">Choose executable</button>
              <button className="font-medium underline" onClick={onUseManagedRuntime} type="button">Use managed Codex</button>
            </>
          )}
          {overview.runtime.state === "unavailable" && (
            <>
              <button className="font-medium underline" onClick={onRetryRuntime} type="button">Retry</button>
              <button className="font-medium underline" onClick={onChooseRuntime} type="button">Choose executable</button>
              <button className="font-medium underline" onClick={onUseManagedRuntime} type="button">Use managed Codex</button>
            </>
          )}
          {overview.status.state === "authenticationRequired" && overview.authFlow.state !== "waiting" && (
            <button className="font-medium underline" onClick={onLogin} type="button">Sign in with ChatGPT</button>
          )}
          {overview.authFlow.state === "waiting" && (
            <button className="font-medium underline" onClick={onCancelLogin} type="button">Cancel sign-in</button>
          )}
        </div>
      )}
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-card px-6 py-2">
          <Search className="size-4 text-muted-foreground" />
          <Input
            aria-label="Search active conversation"
            className="h-8 max-w-md"
            onChange={(event) => { setSearch(event.target.value); setActiveMatch(0); }}
            placeholder="Search this conversation"
            ref={searchInput}
            value={search}
          />
          <span className="min-w-20 text-center text-xs text-muted-foreground">{matches.length ? `${activeMatch + 1} of ${matches.length}` : "No results"}</span>
          <Button aria-label="Previous result" disabled={!matches.length} onClick={() => setActiveMatch((current) => (current - 1 + matches.length) % matches.length)} size="icon-sm" variant="ghost"><ChevronUp /></Button>
          <Button aria-label="Next result" disabled={!matches.length} onClick={() => setActiveMatch((current) => (current + 1) % matches.length)} size="icon-sm" variant="ghost"><ChevronDown /></Button>
          <Button aria-label="Close search" onClick={() => { setSearchOpen(false); setSearch(""); }} size="icon-sm" variant="ghost"><X /></Button>
        </div>
      )}

      <section className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <MessageScrollerProvider autoScroll key={conversationKey}>
          <MessageScroller className="h-full min-h-0">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
                {!project && (
                  <MessageScrollerItem className="flex flex-1 items-center justify-center" messageId="no-project">
                    <p className="text-sm text-muted-foreground">No project open.</p>
                  </MessageScrollerItem>
                )}
                {project && !project.draft && !project.activeThreadId && (
                  <MessageScrollerItem className="flex flex-1 items-center justify-center" messageId="no-conversation">
                    <div className="text-center"><h2 className="text-base font-medium">No active conversation</h2><p className="mt-2 text-sm text-muted-foreground">Choose a conversation from history or create a new one.</p></div>
                  </MessageScrollerItem>
                )}
                {project && (project.draft || project.activeThreadId) && items.length === 0 && !working && (
                  <MessageScrollerItem className="flex flex-1 items-center justify-center" messageId="empty-conversation">
                    <div className="text-center"><h2 className="text-base font-medium">What would you like to build?</h2><p className="mt-2 text-sm text-muted-foreground">Codex will work directly in {project.name}.</p></div>
                  </MessageScrollerItem>
                )}
                {items.map((item) => (
                  <MessageScrollerItem
                    className={cn(
                      "rounded-md transition-colors",
                      matchingIds.has(item.id) && "bg-amber-200/30 ring-1 ring-amber-500/40",
                      matches[activeMatch] === item.id && "ring-2 ring-primary",
                    )}
                    data-conversation-item={item.id}
                    key={item.id}
                    messageId={item.id}
                    scrollAnchor={item.type === "message" && item.role === "user"}
                  >
                    {item.type === "plan" ? <PlanCard onOpenExternal={onOpenExternal} plan={item} /> : (
                      <article className={cn("min-w-0 text-sm", item.role === "user" ? "ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-4 py-3 text-secondary-foreground" : "w-full text-foreground")}>
                        {item.role === "assistant" && <div className="mb-1.5 text-[10px] font-semibold tracking-wider text-primary uppercase">Codex</div>}
                        {item.attachments && item.attachments.length > 0 && <div className={cn(item.text && "mb-3")}><AttachmentList attachments={item.attachments} /></div>}
                        {item.text && (item.role === "assistant" ? <MarkdownMessage onOpenExternal={onOpenExternal} text={item.text} /> : <div className="min-w-0 leading-relaxed whitespace-pre-wrap break-words">{item.text}</div>)}
                      </article>
                    )}
                  </MessageScrollerItem>
                ))}
                {working && !interactive && (
                  <MessageScrollerItem messageId={`working-${conversationKey}`}>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground" role="status"><span className="size-1 animate-pulse rounded-full bg-primary" /><span className="size-1 animate-pulse rounded-full bg-primary [animation-delay:150ms]" /><span className="mr-1 size-1 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />Working…</div>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </section>

      <MessageComposer
        capabilities={overview.capabilities}
        disabled={!project || Boolean(notice) || (!project.draft && !project.activeThreadId)}
        interactive={interactive}
        key={conversationKey}
        models={overview.catalogs.models}
        onChooseAttachments={onChooseAttachments}
        onInterrupt={onInterrupt}
        onOpenExternal={onOpenExternal}
        onRespondInteractive={onRespondInteractive}
        onSend={onSend}
        onSettingsChange={onSettingsChange}
        onPermissionModeChange={onPermissionModeChange}
        permissionMode={project?.permissionMode ?? "workspace"}
        showModeControl={showModeControl}
        showPermissionControl={showPermissionControl}
        settings={settings}
        working={working}
      />
    </main>
  );
}
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
