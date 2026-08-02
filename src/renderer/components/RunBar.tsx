import { useState } from "react";
import type { Project, RuntimeStatus } from "../../shared/types";
import { ExternalLink, Info, Play, RotateCw, Sparkles, Square } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

export const RUN_CONFIGURATION_PROMPT = `Set up the AppBuilder run configuration for this project.

Inspect the project files and identify the useful commands that can actually launch the app. Create or repair \`.appbuilder/config.json\` directly; do not just tell me what to copy and paste.

Use this schema:
{
  "version": 1,
  "selectedRunProfileId": "dev",
  "runProfiles": [
    {
      "id": "dev",
      "name": "Development",
      "kind": "web",
      "command": "npm",
      "args": ["run", "dev"],
      "url": "http://localhost:3000"
    }
  ]
}

Commands run directly from the project root without a shell. Use \`kind\` of \`web\`, \`process\`, or \`static\`; static profiles use a project-relative \`entry\` file and no command. Web URLs must be localhost only. Put only the executable in \`command\`, put every argument in \`args\`, do not use shell operators, include only profiles supported by the project, and select the most useful default profile. Validate the JSON after writing it and briefly summarize what you configured.`;

interface RunBarProps {
  project: Project | null;
  runtime: RuntimeStatus | null;
  aiDisabled: boolean;
  onProfileChange(profileId: string): void;
  onStart(): void;
  onRestart(): void;
  onStop(): void;
  onOpen(): void;
  onConfigure(): void;
  onOpenConfiguration(): Promise<void>;
  onSendToAI(prompt: string): Promise<void>;
}

export function RunBar({
  project,
  runtime,
  aiDisabled,
  onProfileChange,
  onStart,
  onRestart,
  onStop,
  onOpen,
  onConfigure,
  onOpenConfiguration,
  onSendToAI,
}: RunBarProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [sendingToAI, setSendingToAI] = useState(false);
  if (!project) return <footer className="border-t bg-card" />;

  const sendToAI = async () => {
    setSendingToAI(true);
    try {
      await onSendToAI(RUN_CONFIGURATION_PROMPT);
    } catch {
      // The parent owns the application-level error message.
    } finally {
      setSendingToAI(false);
    }
  };

  if (project.runProfiles.length === 0) {
    return (
      <>
        <footer className="flex min-w-0 items-center justify-end gap-1 border-t bg-card px-4 text-xs text-muted-foreground">
          <span className="mr-1">No app run config set.</span>
          <Button aria-label="Run configuration information" onClick={() => setInfoOpen(true)} size="icon-sm" title="Run configuration information" type="button" variant="ghost"><Info /></Button>
          <Button disabled={aiDisabled || sendingToAI} onClick={() => void sendToAI()} size="sm" type="button">
            <Sparkles />
            {sendingToAI ? "Sending…" : "Send to AI"}
          </Button>
        </footer>

        {infoOpen && (
          <Dialog onOpenChange={setInfoOpen} open>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Run configuration</DialogTitle>
                <DialogDescription>AppBuilder launches this project using profiles stored in <code>.appbuilder/config.json</code>.</DialogDescription>
              </DialogHeader>
              <p className="text-sm leading-6 text-muted-foreground">
                Send a setup request to Codex so it can inspect the project and write the right commands, or configure the profiles manually.
              </p>
              <Button onClick={() => { setInfoOpen(false); onConfigure(); }} type="button" variant="outline">Configure manually</Button>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  const status = runtime?.status ?? "stopped";
  const running = status === "running" || status === "ready" || status === "starting";
  const ready = status === "ready";
  const staticSite = runtime?.target === "static";
  const statusClass = ready || status === "running" ? "bg-emerald-400" : status === "starting" ? "bg-amber-400" : status === "failed" ? "bg-destructive" : "bg-muted-foreground/60";
  const selectedProfile = project.runProfiles.find((profile) => profile.id === project.selectedRunProfileId) ?? project.runProfiles[0];

  const openConfiguration = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      await onOpenConfiguration();
    } catch (caught) {
      setOpenError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <footer className="flex min-w-0 items-center gap-3 overflow-hidden border-t bg-card px-4">
        <div className="flex shrink-0 gap-2">
          <Button onClick={staticSite && ready ? onOpen : running && !staticSite ? onRestart : onStart} size="sm" type="button" variant="outline">
            {running && !staticSite ? <RotateCw /> : <Play />}
            {staticSite && ready ? "Open app" : running && !staticSite ? "Restart" : "Start"}
          </Button>
          {ready && !staticSite && <Button onClick={onOpen} size="sm" type="button" variant="outline"><ExternalLink /> Open app</Button>}
          <Button disabled={!running || staticSite} onClick={onStop} size="sm" type="button" variant="destructive">
            <Square />
            Stop
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", statusClass)} />
          <span>{status === "failed" ? runtime?.error ?? "Failed" : status === "starting" ? "Starting…" : ready && runtime?.target === "web" ? `Ready at ${runtime.url ?? "localhost"}` : ready ? "Ready" : status === "running" ? "Running" : "Stopped"}</span>
          {status === "failed" && <Button disabled={aiDisabled || sendingToAI} onClick={() => void onSendToAI("Please diagnose and repair this AppBuilder run configuration. Use the appbuilder_runtime_status tool for the selected project's safe runtime status, then update .appbuilder/config.json if needed.")} size="sm" type="button" variant="ghost"><Sparkles /> Ask Codex to fix</Button>}
        </div>
        <div className="flex min-w-0 max-w-60 flex-1 items-center gap-1">
          <NativeSelect
            aria-label="Run profile"
            className="min-w-0 flex-1"
            disabled={false}
            onChange={(event) => onProfileChange(event.target.value)}
            size="sm"
            value={project.selectedRunProfileId ?? selectedProfile.id}
          >
            {project.runProfiles.map((profile) => (
              <NativeSelectOption key={profile.id} value={profile.id}>{profile.name}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button aria-label="Run configuration information" onClick={() => setInfoOpen(true)} size="icon-sm" title="Run configuration information" type="button" variant="ghost"><Info /></Button>
        </div>
      </footer>

      {infoOpen && (
        <Dialog onOpenChange={setInfoOpen} open>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Run configuration</DialogTitle>
              <DialogDescription>AppBuilder reads run profiles from <code>.appbuilder/config.json</code> inside this project.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Profile</span><span>{selectedProfile.name}</span></div>
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Target</span><span>{selectedProfile.kind ?? "auto"}</span></div>
              {selectedProfile.url && <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Local URL</span><code className="min-w-0 break-all">{selectedProfile.url}</code></div>}
              {selectedProfile.entry && <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Entry</span><code className="min-w-0 break-all">{selectedProfile.entry}</code></div>}
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Command</span><code className="min-w-0 break-all">{selectedProfile.command}</code></div>
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Arguments</span><code className="min-w-0 break-all">{selectedProfile.args.length > 0 ? selectedProfile.args.join(" ") : "None"}</code></div>
              <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-2"><span className="text-muted-foreground">Working dir</span><code className="min-w-0 break-all">{project.path}</code></div>
            </div>
            {openError && <p className="text-xs text-destructive">{openError}</p>}
            <Button disabled={opening} onClick={() => void openConfiguration()} type="button" variant="outline"><ExternalLink /> {opening ? "Opening…" : "Open config in default editor"}</Button>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
