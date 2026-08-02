import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";

const LOG_COUNT = 5;
const LOG_LIMIT = 1024 * 1024;
const PRIVACY_FORMAT = "2";
const PRIVACY_MARKER = "privacy-format";

export type DiagnosticSubsystem = "bootstrap" | "codex" | "ipc" | "runtime" | "storage" | "updates";

export interface DiagnosticEvent {
  subsystem: DiagnosticSubsystem;
  operation: string;
  code: string;
  retryable: boolean;
}

interface StoredDiagnosticEvent extends DiagnosticEvent {
  timestamp: string;
  level: "info" | "error";
}

export interface DiagnosticBundleContext {
  application: {
    name: string;
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    architecture: string;
  };
  runtime: {
    lifecycleState: string;
    connectionState: string;
    authenticated: boolean | null;
    source: string | null;
    version: string | null;
    bundledVersion: string | null;
    updateState: string;
    capabilities: Record<string, boolean>;
  };
  state: {
    schemaVersion: number | null;
    projectCount: number;
    archivedProjectCount: number;
    conversationCount: number;
    recoveryBackupCount: number;
  };
}

export class DiagnosticsLogger {
  private readonly recentEvents: StoredDiagnosticEvent[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.initializeOnce();
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const marker = await readFile(this.markerPath(), "utf8").catch(() => null);
    if (marker?.trim() === PRIVACY_FORMAT) return;
    await Promise.all(Array.from({ length: LOG_COUNT }, (_, index) => rm(this.logPath(index + 1), { force: true })));
    await writeFile(this.markerPath(), `${PRIVACY_FORMAT}\r\n`, { encoding: "utf8", mode: 0o600 });
  }

  info(event: DiagnosticEvent): void {
    this.write("info", event);
  }

  error(event: DiagnosticEvent): void {
    this.write("error", event);
  }

  async exportBundle(targetPath: string, context: DiagnosticBundleContext): Promise<void> {
    await this.initialize();
    await this.writeQueue;
    const zip = new AdmZip();
    for (let index = 1; index <= LOG_COUNT; index += 1) {
      const content = await readFile(this.logPath(index)).catch(() => null);
      if (content) zip.addFile(`logs/appbuilder-${index}.log`, content);
    }
    const report = {
      generatedAt: new Date().toISOString(),
      application: {
        name: context.application.name,
        version: context.application.version,
        electron: context.application.electron,
        chrome: context.application.chrome,
        node: context.application.node,
        platform: context.application.platform,
        architecture: context.application.architecture,
      },
      runtime: {
        lifecycleState: context.runtime.lifecycleState,
        connectionState: context.runtime.connectionState,
        authenticated: context.runtime.authenticated,
        source: context.runtime.source,
        version: context.runtime.version,
        bundledVersion: context.runtime.bundledVersion,
        updateState: context.runtime.updateState,
        capabilities: Object.fromEntries(Object.entries(context.runtime.capabilities).map(([name, supported]) => [name, supported === true])),
      },
      state: {
        schemaVersion: context.state.schemaVersion,
        projectCount: context.state.projectCount,
        archivedProjectCount: context.state.archivedProjectCount,
        conversationCount: context.state.conversationCount,
        recoveryBackupCount: context.state.recoveryBackupCount,
      },
      recentEvents: this.recentEvents.map((event) => ({ ...event })),
      privacy: "Only allowlisted operational metadata is included. No prompts, transcripts, attachments, secrets, environment variables, command output, raw errors, URLs, executable paths, or project paths are included.",
    };
    zip.addFile("diagnostics.json", Buffer.from(`${JSON.stringify(report, null, 2)}\r\n`, "utf8"));
    await mkdir(dirname(targetPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      zip.writeZip(targetPath, (error) => error ? reject(error) : resolve());
    });
  }

  private write(level: StoredDiagnosticEvent["level"], event: DiagnosticEvent): void {
    const stored: StoredDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      level,
      subsystem: event.subsystem,
      operation: event.operation,
      code: event.code,
      retryable: event.retryable === true,
    };
    this.recentEvents.push(stored);
    if (this.recentEvents.length > 50) this.recentEvents.shift();
    const entry = `${JSON.stringify(stored)}\r\n`;
    const operation = this.writeQueue.then(async () => {
      await this.initialize();
      await this.rotateIfNeeded(Buffer.byteLength(entry));
      await appendFile(this.logPath(1), entry, { encoding: "utf8", mode: 0o600 });
    });
    this.writeQueue = operation.catch(() => undefined);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const currentSize = (await stat(this.logPath(1)).catch(() => null))?.size ?? 0;
    if (currentSize + incomingBytes <= LOG_LIMIT) return;
    for (let index = LOG_COUNT; index > 1; index -= 1) {
      await rm(this.logPath(index), { force: true }).catch(() => undefined);
      await rename(this.logPath(index - 1), this.logPath(index)).catch(() => undefined);
    }
  }

  private markerPath(): string {
    return join(this.root, PRIVACY_MARKER);
  }

  private logPath(index: number): string {
    return join(this.root, `appbuilder-${index}.log`);
  }
}
