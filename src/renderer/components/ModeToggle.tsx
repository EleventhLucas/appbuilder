import type { CollaborationMode } from "../../shared/types";
import { cn } from "../lib/utils";

interface ModeToggleProps {
  mode: CollaborationMode;
  disabled?: boolean;
  className?: string;
  title?: string;
  onChange(mode: CollaborationMode): void;
}

export function ModeToggle({ mode, disabled = false, className, title, onChange }: ModeToggleProps) {
  return (
    <div
      aria-label="Work or Plan mode"
      className={cn("inline-flex h-7 w-fit items-center rounded-md border bg-muted/40 p-0.5", className)}
      role="group"
      title={title}
    >
      {(["work", "plan"] as const).map((option) => (
        <button
          aria-pressed={mode === option}
          className={cn(
            "h-6 flex-1 rounded-[4px] px-2 text-xs font-medium transition-colors",
            mode === option ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
          disabled={disabled}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {option === "work" ? "Work" : "Plan"}
        </button>
      ))}
    </div>
  );
}
