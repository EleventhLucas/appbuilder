import { app, dialog, type BrowserWindow } from "electron";
import { join } from "node:path";
import type { AppSnapshot, BootstrapSnapshot, DiagnosticExportResult } from "../../shared/types";
import { channels } from "../../shared/channels";
import type { DiagnosticBundleContext, DiagnosticsLogger } from "../diagnostics/DiagnosticsLogger";
import { errorDto } from "../errors/AppBuilderError";
import { handleIpc } from "../ipcResult";
import type { ProjectStore, StoreInitializationResult } from "../projects/ProjectStore";

interface AppBootstrapOptions {
  store: ProjectStore;
  logger: DiagnosticsLogger;
  getWindow(): BrowserWindow | null;
  initializeReadyServices(): Promise<AppSnapshot>;
  getReadySnapshot(): AppSnapshot;
}

export class AppBootstrap {
  private snapshot: BootstrapSnapshot = { phase: "starting", message: "Starting AppBuilder…" };
  private readyServicesInitialized = false;
  private operation: Promise<BootstrapSnapshot> | null = null;

  constructor(private readonly options: AppBootstrapOptions) {
    handleIpc(channels.bootstrapGet, () => this.getSnapshot());
    handleIpc(channels.bootstrapRetry, () => this.initialize());
    handleIpc(channels.bootstrapRestore, (_event, backupId: string) => this.restore(backupId));
    handleIpc(channels.bootstrapReset, () => this.reset());
    handleIpc(channels.bootstrapExportDiagnostics, () => this.exportDiagnostics());
  }

  getSnapshot(): BootstrapSnapshot {
    if (this.snapshot.phase === "ready" && this.readyServicesInitialized) {
      return { phase: "ready", app: this.options.getReadySnapshot() };
    }
    return structuredClone(this.snapshot);
  }

  initialize(): Promise<BootstrapSnapshot> {
    if (this.operation) return this.operation;
    this.setSnapshot({ phase: "starting", message: "Loading local AppBuilder data…" });
    this.operation = this.finishInitialization(this.options.store.initialize()).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async restore(backupId: string): Promise<BootstrapSnapshot> {
    this.setSnapshot({ phase: "starting", message: "Restoring a validated backup…" });
    return this.finishInitialization(this.options.store.restoreBackup(backupId));
  }

  private async reset(): Promise<BootstrapSnapshot> {
    this.setSnapshot({ phase: "starting", message: "Creating clean local AppBuilder data…" });
    return this.finishInitialization(this.options.store.reset());
  }

  private async finishInitialization(resultPromise: Promise<StoreInitializationResult>): Promise<BootstrapSnapshot> {
    try {
      const result = await resultPromise;
      if (result.state === "recovery") {
        this.options.logger.error({
          subsystem: "storage",
          operation: "load-state",
          code: result.recovery.error.code,
          retryable: result.recovery.error.retryable,
        });
        this.setSnapshot({ phase: "recovery", recovery: result.recovery });
        return this.getSnapshot();
      }
      const appSnapshot = this.readyServicesInitialized
        ? this.options.getReadySnapshot()
        : await this.options.initializeReadyServices();
      this.readyServicesInitialized = true;
      this.setSnapshot({ phase: "ready", app: appSnapshot });
    } catch (error) {
      const appError = errorDto(error, "BOOTSTRAP_FAILED");
      appError.retryable = true;
      this.options.logger.error({
        subsystem: "bootstrap",
        operation: "initialize",
        code: appError.code,
        retryable: appError.retryable,
      });
      this.setSnapshot({
        phase: "recovery",
        recovery: {
          error: appError,
          preservedStatePath: null,
          backups: this.options.store.getRecoveryInfo()?.backups ?? [],
        },
      });
    }
    return this.getSnapshot();
  }

  private async exportDiagnostics(): Promise<DiagnosticExportResult> {
    const owner = this.options.getWindow() ?? undefined;
    const defaultPath = join(app.getPath("downloads"), `AppBuilder-Diagnostics-${new Date().toISOString().slice(0, 10)}.zip`);
    const result = owner
      ? await dialog.showSaveDialog(owner, { title: "Export AppBuilder Diagnostics", defaultPath, filters: [{ name: "ZIP archive", extensions: ["zip"] }] })
      : await dialog.showSaveDialog({ title: "Export AppBuilder Diagnostics", defaultPath, filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
    if (result.canceled || !result.filePath) return { path: null, canceled: true };
    await this.options.logger.exportBundle(result.filePath, this.diagnosticContext());
    return { path: result.filePath, canceled: false };
  }

  private diagnosticContext(): DiagnosticBundleContext {
    const ready = this.snapshot.phase === "ready" ? this.snapshot.app : null;
    return {
      application: {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      },
      runtime: {
        lifecycleState: ready?.codex.runtime.state ?? this.snapshot.phase,
        connectionState: ready?.codex.status.state ?? this.snapshot.phase,
        authenticated: ready?.codex.status.authenticated ?? null,
        source: ready?.codex.runtime.source ?? null,
        version: ready?.codex.runtime.version ?? null,
        bundledVersion: ready?.codex.runtime.bundledVersion ?? null,
        updateState: ready?.codex.runtime.update.state ?? "disabled",
        capabilities: ready
          ? Object.fromEntries(Object.entries(ready.codex.capabilities).map(([name, capability]) => [name, capability.supported]))
          : {},
      },
      state: this.stateSummary(),
    };
  }

  private stateSummary(): DiagnosticBundleContext["state"] {
    if (this.snapshot.phase !== "ready") {
      return {
        schemaVersion: null,
        projectCount: 0,
        archivedProjectCount: 0,
        conversationCount: 0,
        recoveryBackupCount: this.snapshot.phase === "recovery" ? this.snapshot.recovery.backups.length : 0,
      };
    }
    return {
      schemaVersion: this.snapshot.app.state.version,
      projectCount: this.snapshot.app.state.projects.length,
      archivedProjectCount: this.snapshot.app.state.projects.filter((project) => project.archived).length,
      conversationCount: this.snapshot.app.state.projects.reduce((count, project) => count + project.conversations.length, 0),
      recoveryBackupCount: 0,
    };
  }

  private setSnapshot(snapshot: BootstrapSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(channels.bootstrapEvent, this.getSnapshot());
      } catch {
        // The renderer can be disposed between the lifecycle checks and send.
      }
    }
  }
}
