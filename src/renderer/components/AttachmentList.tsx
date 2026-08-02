import { File, Image, X } from "lucide-react";
import type { ChatAttachment } from "../../shared/types";
import { Button } from "./ui/button";

interface AttachmentListProps {
  attachments: ChatAttachment[];
  onRemove?(id: string): void;
  onRemoveAll?(): void;
}

function formatSize(size: number | null): string | null {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentList({ attachments, onRemove, onRemoveAll }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap gap-2" aria-label="Attachments">
      {attachments.map((attachment) => {
        const size = formatSize(attachment.size);
        return (
          <div className="flex min-w-0 max-w-64 items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5" key={attachment.id}>
            {attachment.kind === "image" ? <Image className="size-3.5 shrink-0 text-primary" /> : <File className="size-3.5 shrink-0 text-primary" />}
            <div className="min-w-0">
              <div className="truncate text-xs font-medium" title={attachment.name}>{attachment.name}</div>
              {size && <div className="text-[10px] text-muted-foreground">{size}</div>}
            </div>
            {onRemove && (
              <Button
                aria-label={`Remove ${attachment.name}`}
                className="-mr-1 text-muted-foreground"
                onClick={() => onRemove(attachment.id)}
                size="icon-xs"
                title={`Remove ${attachment.name}`}
                type="button"
                variant="ghost"
              >
                <X />
              </Button>
            )}
          </div>
        );
      })}
      {onRemoveAll && (
        <Button
          aria-label="Remove all attachments"
          onClick={onRemoveAll}
          size="sm"
          title="Remove all attachments"
          type="button"
          variant="destructive"
        >
          Remove All
        </Button>
      )}
    </div>
  );
}
