import { spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { RunProfile, RuntimeFailureCode, RuntimeStatus, RuntimeTargetKind } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";

const OUTPUT_LIMIT = 64 * 1024;
const STOP_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;

interface ManagedProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: string;
  requestedStop: boolean;
  target: RuntimeTargetKind;
  url: string | null;
  closed: Promise<void>;
  readyTimer: NodeJS.Timeout | null;
}

interface ProjectRunnerOptions {
  openUrl(url: string): Promise<void>;
  openFile(path: string): Promise<string>;
}

export class ProjectRunner {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly statuses = new Map<string, RuntimeStatus>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly staticEntries = new Map<string, string>();

  constructor(
    private readonly store: ProjectStore,
    private readonly onStatus: (status: RuntimeStatus) => void,
    private readonly options: ProjectRunnerOptions,
  ) {}

  getStatus(projectId: string): RuntimeStatus {
    return this.statuses.get(projectId) ?? this.status(projectId, "stopped");
  }

  getStatuses(projectIds: string[]): RuntimeStatus[] {
    return projectIds.map((projectId) => this.getStatus(projectId));
  }

  start(projectId: string): Promise<RuntimeStatus> {
    return this.serialize(projectId, () => this.startInternal(projectId));
  }

  restart(projectId: string): Promise<RuntimeStatus> {
    return this.serialize(projectId, async () => {
      await this.stopInternal(projectId);
      return this.startInternal(projectId);
    });
  }

  stop(projectId: string): Promise<RuntimeStatus> {
    return this.serialize(projectId, () => this.stopInternal(projectId));
  }

  async open(projectId: string): Promise<RuntimeStatus> {
    return this.serialize(projectId, async () => {
      const current = this.getStatus(projectId);
      if (current.target === "web" && current.url) {
        await this.options.openUrl(current.url);
        return this.getStatus(projectId);
      }
      const entry = this.staticEntries.get(projectId);
      if (current.target === "static" && entry) {
        const error = await this.options.openFile(entry);
        if (!error) return current;
        const failed = this.status(projectId, "failed", "static", null, null, null, "open_failed", "AppBuilder could not open the static site.");
        this.publish(failed);
        return failed;
      }
      throw new Error("This project does not have an app URL to open.");
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((projectId) => this.stop(projectId)));
  }

  private async startInternal(projectId: string): Promise<RuntimeStatus> {
    const existing = this.processes.get(projectId);
    if (existing && existing.child.exitCode === null && existing.child.signalCode === null) return this.getStatus(projectId);

    const project = await this.store.refreshConfiguration(projectId);
    const profile = project.runProfiles.find((candidate) => candidate.id === project.selectedRunProfileId);
    if (!profile) throw new Error("Select a run profile before starting the project.");
    if (profile.kind === "static") return this.openStatic(projectId, project.path, profile);

    const target = this.targetFor(profile);
    if (!profile.command) throw new Error("This run profile needs an executable command.");
    const child = spawn(profile.command, profile.args, {
      cwd: project.path,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveClosed!: () => void;
    const managed: ManagedProcess = {
      child,
      output: "",
      requestedStop: false,
      target,
      url: profile.url ?? null,
      readyTimer: null,
      closed: new Promise<void>((resolveClosedPromise) => { resolveClosed = resolveClosedPromise; }),
    };
    this.processes.set(projectId, managed);
    const capture = (chunk: Buffer) => {
      managed.output = (managed.output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
      if (managed.target === "web" && !managed.url) managed.url = this.outputUrl(managed.output);
      if (managed.target === "web" && managed.url) void this.waitForWebReady(projectId, managed);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      if (this.processes.get(projectId) !== managed) return;
      this.publish(this.status(projectId, "failed", target, null, null, null, "spawn_failed", error.message));
    });
    child.once("close", (code, signal) => {
      resolveClosed();
      if (managed.readyTimer) clearTimeout(managed.readyTimer);
      if (this.processes.get(projectId) !== managed) return;
      this.processes.delete(projectId);
      const prior = this.getStatus(projectId);
      if (prior.status === "failed") return;
      const stoppedCleanly = managed.requestedStop || code === 0;
      const failureCode = stoppedCleanly ? null : this.classifyOutput(managed.output) ?? "process_exited";
      this.publish(this.status(projectId, stoppedCleanly ? "stopped" : "failed", target, null, null, code, failureCode, stoppedCleanly ? null : this.failureMessage(failureCode, signal, code)));
    });
    const initial = this.status(projectId, target === "web" ? "starting" : "running", target, null, child.pid ?? null);
    this.publish(initial);
    if (target === "web" && managed.url) void this.waitForWebReady(projectId, managed);
    else if (target === "web") this.scheduleReadinessTimeout(projectId, managed);
    return initial;
  }

  private async openStatic(projectId: string, projectPath: string, profile: RunProfile): Promise<RuntimeStatus> {
    const entry = profile.entry ?? "";
    const fullPath = resolve(projectPath, entry);
    if (!entry || isAbsolute(entry) || relative(projectPath, fullPath).startsWith("..")) throw new Error("Static site entry must stay inside the project directory.");
    if (!(await stat(fullPath).catch(() => null))?.isFile()) throw new Error("The static site entry file does not exist.");
    this.staticEntries.set(projectId, fullPath);
    const error = await this.options.openFile(fullPath);
    if (error) {
      const failed = this.status(projectId, "failed", "static", null, null, null, "open_failed", "AppBuilder could not open the static site.");
      this.publish(failed);
      return failed;
    }
    const ready = this.status(projectId, "ready", "static");
    this.publish(ready);
    return ready;
  }

  private scheduleReadinessTimeout(projectId: string, managed: ManagedProcess): void {
    if (managed.readyTimer) return;
    managed.readyTimer = setTimeout(() => {
      managed.readyTimer = null;
      if (this.processes.get(projectId) !== managed || managed.url) return;
      void this.failWebStartup(projectId, managed, "readiness_timeout");
    }, READY_TIMEOUT_MS);
  }

  private async waitForWebReady(projectId: string, managed: ManagedProcess): Promise<void> {
    if (!managed.url || this.getStatus(projectId).status === "ready" || this.processes.get(projectId) !== managed) return;
    if (managed.readyTimer) clearTimeout(managed.readyTimer);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const check = async () => {
      if (this.processes.get(projectId) !== managed || !managed.url) return;
      if (await this.isReachable(managed.url)) {
        try {
          await this.options.openUrl(managed.url);
          this.publish(this.status(projectId, "ready", "web", managed.url, managed.child.pid ?? null));
        } catch {
          await this.failWebStartup(projectId, managed, "open_failed");
        }
        return;
      }
      if (Date.now() >= deadline) {
        await this.failWebStartup(projectId, managed, this.classifyOutput(managed.output) ?? "readiness_timeout");
        return;
      }
      managed.readyTimer = setTimeout(() => { managed.readyTimer = null; void check(); }, READY_POLL_MS);
    };
    await check();
  }

  private async failWebStartup(projectId: string, managed: ManagedProcess, code: RuntimeFailureCode): Promise<void> {
    this.publish(this.status(projectId, "failed", "web", null, null, null, code, this.failureMessage(code, null, null)));
    await this.stopManaged(projectId, managed);
  }

  private async stopInternal(projectId: string): Promise<RuntimeStatus> {
    const managed = this.processes.get(projectId);
    if (!managed) {
      const status = this.status(projectId, "stopped");
      this.publish(status);
      return status;
    }
    await this.stopManaged(projectId, managed);
    return this.getStatus(projectId);
  }

  private async stopManaged(projectId: string, managed: ManagedProcess): Promise<void> {
    managed.requestedStop = true;
    if (managed.readyTimer) clearTimeout(managed.readyTimer);
    this.signal(managed.child, "SIGTERM");
    await Promise.race([managed.closed, this.delay(STOP_TIMEOUT_MS)]);
    if (this.processes.get(projectId) === managed) {
      this.signal(managed.child, "SIGKILL");
      await managed.closed;
    }
  }

  private targetFor(profile: RunProfile): RuntimeTargetKind {
    if (profile.kind === "web") return "web";
    if (profile.kind === "process") return "process";
    if (profile.url || /(^|\s)(dev|serve|start)(\s|$)/i.test(profile.args.join(" "))) return "web";
    return /(?:next|vite|react-scripts|astro|nuxt|svelte-kit)/i.test(`${profile.command} ${profile.args.join(" ")}`) ? "web" : "process";
  }

  private outputUrl(output: string): string | null {
    const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i)?.[0] ?? null;
    return match && this.safeLoopbackUrl(match) ? match : null;
  }

  private safeLoopbackUrl(value: string): boolean {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (url.protocol === "http:" || url.protocol === "https:") && (host === "localhost" || host === "127.0.0.1" || host === "::1");
    } catch { return false; }
  }

  private async isReachable(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      await fetch(url, { signal: controller.signal, redirect: "manual" });
      return true;
    } catch { return false; }
    finally { clearTimeout(timeout); }
  }

  private classifyOutput(output: string): RuntimeFailureCode {
    return /EADDRINUSE|address already in use/i.test(output) ? "port_in_use" : null;
  }

  private failureMessage(code: RuntimeFailureCode, signal: string | null, exitCode: number | null): string {
    if (code === "port_in_use") return "The local app port is already in use.";
    if (code === "readiness_timeout") return "The local app did not become ready within 15 seconds.";
    if (code === "open_failed") return "AppBuilder could not open the local app.";
    return `Process exited ${signal ? `with ${signal}` : `with code ${exitCode ?? "unknown"}`}.`;
  }

  private status(projectId: string, status: RuntimeStatus["status"], target: RuntimeTargetKind = null, url: string | null = null, pid: number | null = null, exitCode: number | null = null, failureCode: RuntimeFailureCode = null, error: string | null = null): RuntimeStatus {
    return { projectId, status, target, url, pid, exitCode, failureCode, error };
  }

  private serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(projectId, next);
    void next.finally(() => { if (this.operations.get(projectId) === next) this.operations.delete(projectId); }).catch(() => undefined);
    return next;
  }

  private signal(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
    catch { try { child.kill(signal); } catch { /* Process exited between checks. */ } }
  }

  private publish(status: RuntimeStatus): void {
    this.statuses.set(status.projectId, status);
    this.onStatus(status);
  }

  private delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
}
