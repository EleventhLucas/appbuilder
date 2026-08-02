import { useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import type { AddProjectInput } from "../../shared/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AddProjectDialogProps {
  onClose(): void;
  onChooseDirectory(): Promise<string | null>;
  onSuggestPath(displayName: string): Promise<string>;
  onSubmit(input: AddProjectInput): Promise<void>;
}

export const APP_IDEAS = [
  "Habit Tracker",
  "Daily Journal",
  "Personal Budget",
  "Recipe Box",
  "Workout Log",
  "Reading List",
  "Movie Watchlist",
  "Meal Planner",
  "Pomodoro Timer",
  "Flashcard Study App",
  "Weather Dashboard",
  "Expense Splitter",
  "Plant Care Tracker",
  "Packing Checklist",
  "Password Generator",
  "Unit Converter",
  "Markdown Notes",
  "Bookmark Organizer",
  "Subscription Tracker",
  "Water Intake Tracker",
  "Sleep Log",
  "Mood Tracker",
  "Gratitude Journal",
  "Grocery List",
  "Chore Planner",
  "Event Countdown",
  "Invoice Maker",
  "Contact Book",
  "Quiz Game",
  "Typing Practice",
  "Color Palette Builder",
  "Random Name Picker",
  "Decision Wheel",
  "Link Shortener",
  "File Organizer",
  "Photo Caption Tool",
  "Resume Builder",
  "Portfolio Starter",
  "Kanban Board",
  "Simple Calendar",
  "Meeting Notes",
  "Time Zone Buddy",
  "Goal Tracker",
  "Savings Calculator",
  "Bill Reminder",
  "Pet Care Log",
  "Garden Planner",
  "Travel Wish List",
  "Home Inventory",
  "Study Planner",
] as const;

export function AddProjectDialog({ onClose, onChooseDirectory, onSuggestPath, onSubmit }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const choose = async () => {
    const selected = await onChooseDirectory();
    if (!selected) return;
    setPath(selected);
    if (!name) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project");
  };

  const useRandomIdea = async () => {
    const alternatives = APP_IDEAS.filter((idea) => idea !== name);
    const idea = alternatives[Math.floor(Math.random() * alternatives.length)] ?? APP_IDEAS[0];
    setName(idea);
    setError(null);
    setSuggesting(true);
    try {
      setPath(await onSuggestPath(idea));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit({ path, name });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add Project</DialogTitle>
            <DialogDescription>Open an existing directory or enter a new one for AppBuilder to create.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="project-name">Display name</Label>
              <Button
                aria-label="Surprise me with an app idea"
                disabled={suggesting || saving}
                onClick={() => void useRandomIdea()}
                size="icon-sm"
                title="Surprise me with an app idea"
                type="button"
                variant="ghost"
              >
                <Sparkles />
              </Button>
            </div>
            <Input id="project-name" onChange={(event) => setName(event.target.value)} required value={name} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-path">Project directory</Label>
            <div className="flex gap-2">
              <Input className="min-w-0" id="project-path" onChange={(event) => setPath(event.target.value)} required value={path} />
              <Button onClick={choose} type="button" variant="outline">Browse</Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-1">
            <Button onClick={onClose} type="button" variant="outline">Cancel</Button>
            <Button disabled={saving || suggesting} type="submit">{saving ? "Adding…" : "Add Project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
