import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RpcId = number | string;

interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface ServerMessage {
  method: string;
  params?: unknown;
}

export interface ServerRequest extends ServerMessage {
  id: RpcId;
}

const STDERR_LIMIT = 64 * 1024;

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: ServerMessage) => void>();
  private readonly requestListeners = new Set<(request: ServerRequest) => void>();
  private readonly exitListeners = new Set<(message: string) => void>();
  private stderr = "";
  private stopping = false;

  constructor(private executablePath = "codex") {}

  setExecutablePath(executablePath: string): void {
    if (this.child) throw new Error("Stop Codex App Server before changing its executable.");
    this.executablePath = executablePath;
  }

  getExecutablePath(): string {
    return this.executablePath;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  onNotification(listener: (notification: ServerMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: ServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.stderr = "";
    const child = spawn(this.executablePath, ["app-server"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    child.once("exit", (code, signal) => {
      lines.close();
      if (this.child === child) this.child = null;
      const message = `Codex App Server exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
      if (!this.stopping) for (const listener of this.exitListeners) listener(message);
    });

    try {
      await spawned;
      await this.request("initialize", {
        clientInfo: { name: "appbuilder", title: "AppBuilder", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
          requestAttestation: false,
        },
      });
      this.notify("initialized");
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (this.child === child) child.kill("SIGKILL");
  }

  private write(message: object): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if ("id" in message && !("method" in message) && ("result" in message || "error" in message)) {
      const id = message.id as RpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as RpcErrorShape;
        pending.reject(new CodexRpcError(error.message ?? "Codex request failed.", error.code ?? -32000, error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if ("id" in message) {
      const request = { id: message.id as RpcId, method: message.method, params: message.params };
      if (this.requestListeners.size === 0) this.respondError(request.id, -32601, "Method not supported");
      else for (const listener of this.requestListeners) listener(request);
    } else {
      const notification = { method: message.method, params: message.params };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }
}
