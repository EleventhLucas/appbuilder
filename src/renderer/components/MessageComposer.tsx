import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ExternalLink, Paperclip, SendHorizontal, Square } from "lucide-react";
import type {
  CodexCapabilities,
  CodexModel,
  ConversationSettings,
  InteractiveRequest,
  InteractiveResponse,
  McpFormField,
  PendingChatAttachment,
  ProjectPermissionMode,
} from "../../shared/types";
import { AttachmentList } from "./AttachmentList";
import { ModeToggle } from "./ModeToggle";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

interface MessageComposerProps {
  disabled: boolean;
  working: boolean;
  settings: ConversationSettings | null;
  models: CodexModel[];
  capabilities: CodexCapabilities;
  interactive: InteractiveRequest | null;
  permissionMode: ProjectPermissionMode;
  showModeControl: boolean;
  showPermissionControl: boolean;
  onChooseAttachments(): Promise<PendingChatAttachment[]>;
  onSend(text: string, attachments: PendingChatAttachment[]): Promise<void> | void;
  onInterrupt(): Promise<void> | void;
  onSettingsChange(settings: ConversationSettings): Promise<void> | void;
  onPermissionModeChange(permissionMode: ProjectPermissionMode): Promise<void> | void;
  onRespondInteractive(requestId: string, response: InteractiveResponse): Promise<void> | void;
  onOpenExternal(url: string): Promise<void> | void;
}

function normalizedValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== "" && value !== null && value !== undefined;
  }));
}

function fieldValidationError(field: McpFormField, value: unknown): string | null {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return field.required ? `${field.label} is required.` : null;
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return `${field.label} must be a valid ${field.type}.`;
    if (field.minimum !== null && value < field.minimum) return `${field.label} must be at least ${field.minimum}.`;
    if (field.maximum !== null && value > field.maximum) return `${field.label} must be at most ${field.maximum}.`;
  }
  if (field.type === "string" && typeof value === "string") {
    if (field.minLength !== null && value.length < field.minLength) return `${field.label} must contain at least ${field.minLength} characters.`;
    if (field.maxLength !== null && value.length > field.maxLength) return `${field.label} must contain no more than ${field.maxLength} characters.`;
  }
  const allowed = new Set(field.options?.map((option) => option.value) ?? []);
  if (field.type === "singleSelect" && (typeof value !== "string" || !allowed.has(value))) return `${field.label} has an invalid selection.`;
  if (field.type === "multiSelect" && (!Array.isArray(value) || value.some((entry) => !allowed.has(String(entry))))) return `${field.label} has an invalid selection.`;
  return null;
}

function fieldInput(field: McpFormField, value: unknown, setValue: (value: unknown) => void) {
  if (field.type === "boolean") {
    return <input checked={value === true} className="size-4" onChange={(event) => setValue(event.target.checked)} type="checkbox" />;
  }
  if (field.type === "singleSelect") {
    return (
      <NativeSelect className="w-full" onChange={(event) => setValue(event.target.value)} value={String(value ?? "")}>
        <NativeSelectOption value="">Select…</NativeSelectOption>
        {field.options?.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
      </NativeSelect>
    );
  }
  if (field.type === "multiSelect") {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <select
        className="min-h-24 w-full rounded-lg border bg-background p-2 text-sm"
        multiple
        onChange={(event) => setValue([...event.currentTarget.selectedOptions].map((option) => option.value))}
        value={[...selected]}
      >
        {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <Input
      max={field.maximum ?? undefined}
      maxLength={field.maxLength ?? undefined}
      min={field.minimum ?? undefined}
      minLength={field.minLength ?? undefined}
      onChange={(event) => {
        if (field.type === "number" || field.type === "integer") setValue(event.target.value === "" ? "" : Number(event.target.value));
        else setValue(event.target.value);
      }}
      step={field.type === "integer" ? 1 : undefined}
      type={field.secret ? "password" : field.type === "number" || field.type === "integer" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
    />
  );
}

function InteractiveComposer({
  request,
  onInterrupt,
  onOpenExternal,
  onRespond,
}: {
  request: InteractiveRequest;
  onInterrupt(): Promise<void> | void;
  onOpenExternal(url: string): Promise<void> | void;
  onRespond(response: InteractiveResponse): Promise<void> | void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (request.kind === "mcpForm") {
      setValues(Object.fromEntries(request.fields.filter((field) => field.defaultValue !== null).map((field) => [field.id, field.defaultValue])));
      setIncluded(Object.fromEntries(request.fields.filter((field) => !field.required).map((field) => [field.id, field.defaultValue !== null])));
    } else {
      setValues({});
      setIncluded({});
    }
    setOtherValues({});
    setError(null);
  }, [request]);

  const submit = async () => {
    const submittedValues = Object.fromEntries(Object.entries(values)
      .filter(([id]) => request.kind !== "mcpForm" || request.fields.some((field) => field.id === id && (field.required || included[id])))
      .map(([id, value]) => [id, value === "__other__" ? (otherValues[id] ?? "") : value]));
    if (request.kind === "questions") {
      const missing = request.questions.find((question) => {
        const value = submittedValues[question.id];
        return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      });
      if (missing) {
        setError(`Answer “${missing.header}” to continue.`);
        return;
      }
    }
    if (request.kind === "mcpForm") {
      const validationError = request.fields
        .filter((field) => field.required || included[field.id])
        .map((field) => fieldValidationError(field, submittedValues[field.id]))
        .find((message) => message !== null);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setSending(true);
    try {
      await onRespond({ action: "submit", values: normalizedValues(submittedValues) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative z-10 shrink-0 border-t bg-background px-6 pt-3 pb-4">
      <div className="mx-auto grid max-w-3xl gap-3 rounded-lg border bg-card p-4 shadow-sm">
        {request.kind === "mcpUrl" ? (
          <>
            <div><p className="text-xs font-semibold tracking-wider text-primary uppercase">{request.serverName}</p><p className="mt-1 text-sm">{request.message}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void onOpenExternal(request.url)} type="button" variant="outline"><ExternalLink /> Open secure link</Button>
              <Button disabled={sending} onClick={() => void submit()} type="button">Continue</Button>
              <Button disabled={sending} onClick={() => void onRespond({ action: "decline", values: {} })} type="button" variant="ghost">Decline</Button>
              <Button className="ml-auto" onClick={onInterrupt} type="button" variant="destructive"><Square /> Stop</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <p className="text-xs font-semibold tracking-wider text-primary uppercase">{request.kind === "mcpForm" ? request.serverName : "Codex needs input"}</p>
              {request.kind === "mcpForm" && <p className="mt-1 text-sm">{request.message}</p>}
            </div>
            <div className="grid gap-3">
              {request.kind === "questions" && request.questions.map((question) => (
                <div className="grid gap-1.5" key={question.id}>
                  <Label htmlFor={`question-${question.id}`}>{question.header}</Label>
                  <p className="text-xs text-muted-foreground">{question.question}</p>
                  {question.options ? (
                    <NativeSelect className="w-full" id={`question-${question.id}`} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} value={String(values[question.id] ?? "")}>
                      <NativeSelectOption value="">Select…</NativeSelectOption>
                      {question.options.map((option) => <NativeSelectOption key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ""}</NativeSelectOption>)}
                      {question.allowOther && <NativeSelectOption value="__other__">Other…</NativeSelectOption>}
                    </NativeSelect>
                  ) : (
                    <Input id={`question-${question.id}`} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} type={question.secret ? "password" : "text"} value={String(values[question.id] ?? "")} />
                  )}
                  {values[question.id] === "__other__" && <Input autoFocus onChange={(event) => setOtherValues((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Enter another answer" value={otherValues[question.id] ?? ""} />}
                </div>
              ))}
              {request.kind === "mcpForm" && request.fields.map((field) => (
                <div className="grid gap-1.5" key={field.id}>
                  <div className="flex items-center justify-between gap-3">
                    <Label>{field.label}{field.required ? " *" : ""}</Label>
                    {!field.required && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input checked={Boolean(included[field.id])} onChange={(event) => setIncluded((current) => ({ ...current, [field.id]: event.target.checked }))} type="checkbox" />
                        Include
                      </label>
                    )}
                  </div>
                  {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                  {(field.required || included[field.id]) && fieldInput(field, values[field.id], (value) => setValues((current) => ({ ...current, [field.id]: value })))}
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button disabled={sending} onClick={() => void submit()} type="button">Submit answers</Button>
              {request.kind === "mcpForm" && <Button disabled={sending} onClick={() => void onRespond({ action: "decline", values: {} })} type="button" variant="ghost">Decline</Button>}
              <Button className="ml-auto" onClick={onInterrupt} type="button" variant="destructive"><Square /> Stop</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function MessageComposer({
  disabled,
  working,
  settings,
  models,
  capabilities,
  interactive,
  permissionMode,
  showModeControl,
  showPermissionControl,
  onChooseAttachments,
  onSend,
  onInterrupt,
  onSettingsChange,
  onPermissionModeChange,
  onRespondInteractive,
  onOpenExternal,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const selectedModel = settings?.model ?? models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? null;
  const effortOptions = useMemo(() => models.find((model) => model.model === selectedModel)?.supportedReasoningEfforts ?? [], [models, selectedModel]);

  if (interactive) {
    return <InteractiveComposer onInterrupt={onInterrupt} onOpenExternal={onOpenExternal} onRespond={(response) => onRespondInteractive(interactive.id, response)} request={interactive} />;
  }

  const submit = async () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || disabled || working || sending) return;
    setSending(true);
    try {
      await onSend(value, attachments);
      setText("");
      setAttachments([]);
    } catch {
      // The parent surfaces the error and the draft remains available to retry.
    } finally {
      setSending(false);
    }
  };

  const chooseAttachments = async () => {
    if (disabled || working || sending || attachments.length >= 10) return;
    const selected = await onChooseAttachments();
    setAttachments((current) => {
      const known = new Set(current.map((attachment) => attachment.token));
      return [...current, ...selected.filter((attachment) => !known.has(attachment.token))].slice(0, 10);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const changeSettings = (update: Partial<ConversationSettings>) => {
    if (!settings) return;
    void onSettingsChange({ ...settings, ...update });
  };

  return (
    <div className="relative z-10 shrink-0 border-t bg-background px-6 pt-3 pb-4">
      <div className="mx-auto grid max-w-3xl min-w-0 gap-2">
        <AttachmentList attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} onRemoveAll={() => setAttachments([])} />
        <div className="rounded-lg border bg-card p-2 shadow-sm transition-shadow focus-within:ring-3 focus-within:ring-ring/20">
          <div className="flex min-w-0 items-end gap-2">
            <Button aria-label="Attach photos or files" disabled={disabled || working || sending || attachments.length >= 10} onClick={chooseAttachments} size="icon" title="Attach photos or files" type="button" variant="ghost"><Paperclip /></Button>
            <Textarea
              aria-label="Message Codex"
              className="max-h-36 min-h-8 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1 text-sm leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={disabled || sending}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={disabled ? "Create or select a conversation" : "Ask Codex to work on this project…"}
              rows={1}
              value={text}
            />
            {working ? <Button onClick={onInterrupt} size="sm" type="button" variant="destructive"><Square /> Stop</Button>
              : <Button aria-label="Send message" disabled={disabled || sending || (!text.trim() && attachments.length === 0)} onClick={submit} size="icon" title="Send message" type="button"><SendHorizontal /></Button>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 border-t px-1 pt-2">
            <NativeSelect disabled={working || !settings || !capabilities.models.supported} onChange={(event) => {
              const model = event.target.value || null;
              const supported = models.find((candidate) => candidate.model === model)?.supportedReasoningEfforts.map((item) => item.effort) ?? [];
              changeSettings({ model, reasoningEffort: settings?.reasoningEffort && supported.includes(settings.reasoningEffort) ? settings.reasoningEffort : null });
            }} size="sm" title={capabilities.models.reason ?? "Model"} value={settings?.model ?? ""}>
              <NativeSelectOption value="">Codex default model</NativeSelectOption>
              {models.map((model) => <NativeSelectOption key={model.id} value={model.model}>{model.displayName}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect disabled={working || !settings || !capabilities.models.supported} onChange={(event) => changeSettings({ reasoningEffort: event.target.value || null })} size="sm" title="Reasoning effort" value={settings?.reasoningEffort ?? ""}>
              <NativeSelectOption value="">Default effort</NativeSelectOption>
              {effortOptions.map((effort) => <NativeSelectOption key={effort.effort} value={effort.effort}>{effort.effort}</NativeSelectOption>)}
            </NativeSelect>
            {showModeControl && <ModeToggle
              disabled={working || !settings || !capabilities.collaborationModes.supported}
              mode={settings?.mode ?? "work"}
              onChange={(mode) => changeSettings({ mode })}
              title={capabilities.collaborationModes.reason ?? "Collaboration mode"}
            />}
            {showPermissionControl && <div className="flex items-center gap-1">
              <label className={permissionMode === "fullAccess" ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"} htmlFor="composer-permissions">Perms:</label>
              <NativeSelect
                aria-label="Permissions"
                className={permissionMode === "fullAccess" ? "border-destructive text-destructive" : undefined}
                disabled={working || disabled}
                id="composer-permissions"
                onChange={(event) => void onPermissionModeChange(event.target.value as ProjectPermissionMode)}
                size="sm"
                title={permissionMode === "ask"
                  ? "Ask: Codex requests approval when an action needs it."
                  : permissionMode === "workspace"
                    ? "Auto: Codex works without prompts but remains restricted to the project."
                    : "Full: Codex works without prompts or project sandbox restrictions."}
                value={permissionMode}
              >
                <NativeSelectOption title="Request approval when needed." value="ask">Ask</NativeSelectOption>
                <NativeSelectOption title="No prompts; restricted to the project." value="workspace">Auto</NativeSelectOption>
                <NativeSelectOption title="No prompts or project sandbox restrictions." value="fullAccess">Full</NativeSelectOption>
              </NativeSelect>
            </div>}
          </div>
        </div>
      </div>
    </div>
  );
}
