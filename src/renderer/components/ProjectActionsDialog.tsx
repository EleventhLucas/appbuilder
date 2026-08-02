import { useState } from "react";
import type { Project } from "../../shared/types";
import { ArchiveRestore, ArchiveX, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ProjectActionsDialogProps {
  project: Project;
  onArchive(): Promise<void>;
  onRestore(): Promise<void>;
  onRemove(): Promise<void>;
  onClose(): void;
}

export function ProjectActionsDialog({ project, onArchive, onRestore, onRemove, onClose }: ProjectActionsDialogProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && !busy && onClose()} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{project.name}</DialogTitle>
          <DialogDescription className="truncate" title={project.path}>{project.path}</DialogDescription>
        </DialogHeader>

        {!confirmingRemove ? (
          <div className="grid gap-2">
            <Button className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal" disabled={busy} onClick={() => void act(project.archived ? onRestore : onArchive)} type="button" variant="outline">
              {project.archived ? <ArchiveRestore className="size-4" /> : <ArchiveX className="size-4" />}
              <span className="grid gap-1">
                <span>{project.archived ? "Restore project" : "Archive project"}</span>
                <span className="text-xs font-normal text-muted-foreground">{project.archived ? "Return it to the active project list." : "Hide it while retaining its settings and Codex thread."}</span>
              </span>
            </Button>
            <Button className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal" disabled={busy} onClick={() => setConfirmingRemove(true)} type="button" variant="destructive">
              <Trash2 className="size-4" />
              <span className="grid gap-1">
                <span>Remove project</span>
                <span className="text-xs font-normal opacity-70">Remove it from AppBuilder without deleting project files.</span>
              </span>
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>Remove <strong className="text-foreground">{project.name}</strong> from AppBuilder?</p>
              <p>Its directory will not be deleted. The project&apos;s AppBuilder record will be removed.</p>
            </div>
            <DialogFooter>
              <Button disabled={busy} onClick={() => setConfirmingRemove(false)} type="button" variant="outline">Cancel</Button>
              <Button disabled={busy} onClick={() => void act(onRemove)} type="button" variant="destructive">
                {busy ? "Removing…" : "Remove project"}
              </Button>
            </DialogFooter>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
