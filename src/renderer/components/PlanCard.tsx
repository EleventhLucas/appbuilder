import { CheckCircle2, ChevronDown, Circle, LoaderCircle } from "lucide-react";
import type { ConversationPlan } from "../../shared/types";
import { MarkdownMessage } from "./MarkdownMessage";

interface PlanCardProps {
  plan: ConversationPlan;
  onOpenExternal(url: string): Promise<void> | void;
}

export function PlanCard({ plan, onOpenExternal }: PlanCardProps) {
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <details className="group rounded-xl border bg-card shadow-sm" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium">
        <ChevronDown className="size-4 -rotate-90 transition-transform group-open:rotate-0" />
        Plan
        {plan.steps.length > 0 && <span className="ml-auto text-xs text-muted-foreground">{completed}/{plan.steps.length} complete</span>}
      </summary>
      <div className="border-t px-4 py-3">
        {plan.explanation && <p className="mb-3 text-sm text-muted-foreground">{plan.explanation}</p>}
        {plan.steps.length > 0 && (
          <ol className="grid gap-2">
            {plan.steps.map((step, index) => (
              <li className="flex items-start gap-2 text-sm" key={`${index}-${step.step}`}>
                {step.status === "completed" ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
                  : step.status === "inProgress" ? <LoaderCircle className="mt-0.5 size-4 animate-spin text-primary" />
                    : <Circle className="mt-0.5 size-4 text-muted-foreground" />}
                <span className={step.status === "completed" ? "text-muted-foreground line-through" : ""}>{step.step}</span>
              </li>
            ))}
          </ol>
        )}
        {plan.text && <div className={plan.steps.length > 0 ? "mt-4 border-t pt-3" : ""}><MarkdownMessage onOpenExternal={onOpenExternal} text={plan.text} /></div>}
      </div>
    </details>
  );
}
