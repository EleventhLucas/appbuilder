import { useEffect, useState } from "react";
import type { BootstrapSnapshot } from "../shared/types";
import { App } from "./App";
import { appIconUrl } from "./appIcon";
import { Button } from "./components/ui/button";

const STARTING: BootstrapSnapshot = { phase: "starting", message: "Starting AppBuilder…" };

export function DesktopRoot() {
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot>(STARTING);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const remove = window.appBuilder.bootstrap.onEvent((next) => active && setSnapshot(next));
    void window.appBuilder.bootstrap.get().then((next) => active && setSnapshot(next)).catch((error) => {
      if (!active) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
      remove();
    };
  }, []);

  const run = async (operation: () => Promise<BootstrapSnapshot>) => {
    setBusy(true);
    setOperationError(null);
    try {
      setSnapshot(await operation());
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (snapshot.phase === "ready") return <App initialSnapshot={snapshot.app} />;
  if (snapshot.phase === "starting") {
    return (
      <main className="grid h-full place-items-center bg-background p-8 text-foreground">
        <div className="text-center" role="status">
          <img alt="" aria-hidden="true" className="mx-auto size-20 drop-shadow-lg" src={appIconUrl} />
          <div className="mx-auto mt-4 size-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          <h1 className="mt-5 text-lg font-semibold">AppBuilder</h1>
          <p className="mt-1 text-sm text-muted-foreground">{snapshot.message}</p>
          {operationError && <p className="mt-3 text-sm text-destructive">{operationError}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="grid h-full place-items-center overflow-auto bg-background p-8 text-foreground">
      <section className="w-full max-w-2xl rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-3">
          <img alt="" aria-hidden="true" className="size-12 shrink-0 drop-shadow-md" src={appIconUrl} />
          <div>
            <p className="text-xs font-semibold tracking-wider text-destructive uppercase">Recovery required</p>
            <h1 className="mt-1 text-xl font-semibold">{snapshot.recovery.error.message}</h1>
          </div>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">The invalid state was preserved and will not be overwritten. Retry, restore a validated backup, or export local diagnostics.</p>
        {snapshot.recovery.error.details && <details className="mt-4 rounded-md bg-muted p-3 text-xs"><summary>Technical detail</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap">{snapshot.recovery.error.details}</pre></details>}
        {snapshot.recovery.backups.length > 0 && (
          <div className="mt-5">
            <h2 className="text-sm font-medium">Validated backups</h2>
            <div className="mt-2 grid gap-2">
              {snapshot.recovery.backups.map((backup) => (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm" key={backup.id}>
                  <span>{new Date(backup.createdAt).toLocaleString()} · schema v{backup.version}</span>
                  <Button disabled={busy} onClick={() => void run(() => window.appBuilder.bootstrap.restore(backup.id))} size="sm" variant="outline">Restore</Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {operationError && <p className="mt-4 text-sm text-destructive">{operationError}</p>}
        <div className="mt-6 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void run(() => window.appBuilder.bootstrap.retry())}>Retry loading</Button>
          <Button disabled={busy} onClick={() => void window.appBuilder.bootstrap.exportDiagnostics()} variant="outline">Export diagnostics</Button>
          <Button
            className="ml-auto"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Reset AppBuilder local state? Projects and AppBuilder-managed conversation associations will be removed from this app. The preserved invalid file will remain on disk.")) {
                void run(() => window.appBuilder.bootstrap.reset());
              }
            }}
            variant="destructive"
          >
            Reset local state
          </Button>
        </div>
      </section>
    </main>
  );
}
