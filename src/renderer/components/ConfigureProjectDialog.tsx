import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { Project, ProjectConfiguration, ProjectConfigurationInspection, RunProfile, RunProfileKind } from "../../shared/types";
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

interface ConfigureProjectDialogProps {
  project: Project;
  onClose(): void;
  onInspect(): Promise<ProjectConfigurationInspection>;
  onOpenEditor(): Promise<void>;
  onSave(configuration: ProjectConfiguration): Promise<void>;
}

const newProfile = (): RunProfile => ({
  id: `run-${crypto.randomUUID().slice(0, 8)}`,
  name: "Run",
  command: "",
  args: [],
  kind: "auto",
  url: null,
  entry: null,
});

export function ConfigureProjectDialog({ project, onClose, onInspect, onOpenEditor, onSave }: ConfigureProjectDialogProps) {
  const [inspection, setInspection] = useState<ProjectConfigurationInspection | null>(null);
  const [profiles, setProfiles] = useState<RunProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void onInspect().then((result) => {
      if (!active) return;
      setInspection(result);
      const initial = result.configuration?.runProfiles ?? [];
      setProfiles(initial);
      setSelectedId(result.configuration?.selectedRunProfileId ?? initial[0]?.id ?? "");
    }).catch((caught) => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { active = false; };
  }, [project.id]);

  const updateProfile = (index: number, update: Partial<RunProfile>) => {
    setProfiles((current) => current.map((profile, profileIndex) => profileIndex === index ? { ...profile, ...update } : profile));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= profiles.length) return;
    setProfiles((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    if (profiles.some((profile) => !profile.id.trim() || !profile.name.trim() || (profile.kind !== "static" && !profile.command.trim()) || (profile.kind === "static" && !profile.entry?.trim()))) {
      setError("Each profile needs an ID, name, and either a command or static entry file.");
      return;
    }
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      setError("Run profile IDs must be unique.");
      return;
    }
    if (inspection?.state === "invalid" && !window.confirm("The current configuration is invalid. Replace it with this reviewed configuration?")) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        version: 1,
        runProfiles: profiles,
        ...(selectedId ? { selectedRunProfileId: selectedId } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const useSuggestions = () => {
    const detected = inspection?.suggestions ?? [];
    setProfiles(detected.map(({ detector: _detector, description: _description, recommended: _recommended, ...profile }) => profile));
    setSelectedId(detected.find((profile) => profile.recommended)?.id ?? detected[0]?.id ?? "");
  };

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Run configurations for {project.name}</DialogTitle>
          <DialogDescription>Detected locally from root project metadata. Commands always execute directly from the project root.</DialogDescription>
        </DialogHeader>
        {!inspection && !error && <p className="text-sm text-muted-foreground">Inspecting Node, .NET, Python, and Rust metadata…</p>}
        {inspection?.state === "invalid" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">The existing configuration is invalid and was not replaced.</p>
            <p className="mt-1 text-xs text-muted-foreground">{inspection.error}</p>
            <Button className="mt-2" onClick={() => void onOpenEditor()} size="sm" variant="outline">Open in editor</Button>
          </div>
        )}
        {inspection && inspection.suggestions.length > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
            <p className="text-sm">{inspection.suggestions.length} launch profile{inspection.suggestions.length === 1 ? "" : "s"} detected.</p>
            <Button onClick={useSuggestions} size="sm" variant="outline">Use detected profiles</Button>
          </div>
        )}
        <div className="grid gap-3">
          {profiles.map((profile, index) => (
            <div className="grid gap-3 rounded-md border p-3" key={profile.id}>
              <div className="flex items-center gap-2">
                <input aria-label={`Default ${profile.name}`} checked={selectedId === profile.id} name="default-profile" onChange={() => setSelectedId(profile.id)} type="radio" />
                <span className="text-xs text-muted-foreground">Default</span>
                <div className="ml-auto flex gap-1">
                  <Button aria-label="Move profile up" disabled={index === 0} onClick={() => move(index, -1)} size="icon-sm" variant="ghost"><ArrowUp /></Button>
                  <Button aria-label="Move profile down" disabled={index === profiles.length - 1} onClick={() => move(index, 1)} size="icon-sm" variant="ghost"><ArrowDown /></Button>
                  <Button aria-label="Remove profile" onClick={() => setProfiles((current) => current.filter((_, profileIndex) => profileIndex !== index))} size="icon-sm" variant="ghost"><Trash2 /></Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1"><Label>Name</Label><Input onChange={(event) => updateProfile(index, { name: event.target.value })} value={profile.name} /></div>
                <div className="grid gap-1"><Label>ID</Label><Input onChange={(event) => updateProfile(index, { id: event.target.value })} value={profile.id} /></div>
              </div>
              <div className="grid gap-1"><Label>Target</Label><select className="h-9 rounded-md border bg-background px-3 text-sm" onChange={(event) => updateProfile(index, { kind: event.target.value as RunProfileKind })} value={profile.kind ?? "auto"}><option value="auto">Auto detect</option><option value="web">Web server</option><option value="process">Standalone process</option><option value="static">Static site</option></select></div>
              {profile.kind === "static" ? (
                <div className="grid gap-1"><Label>Entry file</Label><Input onChange={(event) => updateProfile(index, { entry: event.target.value })} placeholder="index.html" value={profile.entry ?? ""} /></div>
              ) : <>
                <div className="grid gap-1"><Label>Executable command</Label><Input onChange={(event) => updateProfile(index, { command: event.target.value })} value={profile.command} /></div>
                {profile.kind === "web" && <div className="grid gap-1"><Label>Local URL (optional)</Label><Input onChange={(event) => updateProfile(index, { url: event.target.value || null })} placeholder="http://localhost:3000" value={profile.url ?? ""} /></div>}
              </>}
              {profile.kind !== "static" && <div className="grid gap-2">
                <Label>Arguments</Label>
                {profile.args.map((argument, argumentIndex) => (
                  <div className="flex gap-2" key={`${profile.id}-argument-${argumentIndex}`}>
                    <Input
                      aria-label={`Argument ${argumentIndex + 1}`}
                      onChange={(event) => updateProfile(index, { args: profile.args.map((value, valueIndex) => valueIndex === argumentIndex ? event.target.value : value) })}
                      value={argument}
                    />
                    <Button aria-label="Remove argument" onClick={() => updateProfile(index, { args: profile.args.filter((_, valueIndex) => valueIndex !== argumentIndex) })} size="icon" variant="ghost"><Trash2 /></Button>
                  </div>
                ))}
                <Button className="w-fit" onClick={() => updateProfile(index, { args: [...profile.args, ""] })} size="sm" variant="ghost"><Plus /> Add argument</Button>
              </div>}
            </div>
          ))}
          <Button className="w-fit" onClick={() => setProfiles((current) => [...current, newProfile()])} variant="outline"><Plus /> Add profile</Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={saving || !inspection} onClick={() => void save()}>{saving ? "Saving…" : "Save configuration"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
