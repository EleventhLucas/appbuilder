import type { ApprovalDecision, ApprovalRequest, Project } from "../../shared/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ApprovalDialogProps {
  approval: ApprovalRequest;
  project: Project | undefined;
  onRespond(decision: ApprovalDecision): void;
}

export function ApprovalDialog({ approval, project, onRespond }: ApprovalDialogProps) {
  return (
    <Dialog open>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Permission required</DialogTitle>
          <DialogDescription>Codex approval · {project?.name ?? "Project"}</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-foreground/80">{approval.reason}</p>
        <div className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground break-words">{approval.summary}</div>
        <DialogFooter className="flex-row flex-wrap">
          <Button onClick={() => onRespond("decline")} type="button" variant="destructive">Decline</Button>
          {approval.canAcceptForSession && (
            <Button onClick={() => onRespond("acceptSession")} type="button" variant="outline">Accept for Session</Button>
          )}
          <Button onClick={() => onRespond("acceptOnce")} type="button">Accept Once</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
