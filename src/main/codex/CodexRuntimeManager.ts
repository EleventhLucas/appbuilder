import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AppSettings,
  CodexRuntimeCandidateFailure,
  CodexRuntimeInfo,
  CodexRuntimeSource,
  CodexRuntimeUpdateInfo,
} from "../../shared/types";
import type { CodexAppServer } from "./CodexAppServer";

const PROBE_TIMEOUT_MS = 5_000;
interface Candidate {
  source: CodexRuntimeSource;
  executablePath: string;
  managed: boolean;
}

interface RuntimeManagerOptions {
  server: CodexAppServer;
  resourcesPath: string;
  userDataPath: string;
  homePath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  getSettings(): AppSettings;
  saveSettings(settings: AppSettings): Promise<void>;
  onChange(info: CodexRuntimeInfo): void;
}

const disabledUpdate = (): CodexRuntimeUpdateInfo => ({
  state: "disabled",
  currentVersion: null,
  availableVersion: null,
  releaseUrl: null,
  message: "Managed Codex updates are disabled until signed release manifests are configured.",
});

export class CodexRuntimeManager {
  private readonly server: CodexAppServer;
  private readonly resourcesPath: string;
  private readonly userDataPath: string;
  private readonly homePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly getSettings: () => AppSettings;
  private readonly saveSettings: (settings: AppSettings) => Promise<void>;
  private readonly onChange: (info: CodexRuntimeInfo) => void;
  private info: CodexRuntimeInfo = {
    state: "detecting",
    source: null,
    executablePath: null,
    version: null,
    bundledVersion: null,
    candidateFailure: null,
    update: disabledUpdate(),
  };

  constructor(options: RuntimeManagerOptions) {
    this.server = options.server;
    this.resourcesPath = options.resourcesPath;
    this.userDataPath = options.userDataPath;
    this.homePath = options.homePath;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.getSettings = options.getSettings;
    this.saveSettings = options.saveSettings;
    this.onChange = options.onChange;
  }

  getInfo(): CodexRuntimeInfo {
    return structuredClone(this.info);
  }

  async resolve(): Promise<CodexRuntimeInfo> {
    this.setInfo({ state: "detecting", candidateFailure: null });
    const settings = this.getSettings().codexRuntime;
    const managed = await this.managedCandidates();
    if (settings.preference === "managed") return this.selectFirstValid(managed);
    if (settings.preference === "custom") {
      if (!settings.customExecutablePath) return this.unavailable("Select a Codex executable.");
      return this.selectFirstValid([{ source: "custom", executablePath: settings.customExecutablePath, managed: false }]);
    }

    const failures: CodexRuntimeCandidateFailure[] = [];
    for (const candidate of await this.externalCandidates()) {
      const result = await this.probe(candidate);
      if (result.ok) return this.select(candidate, result.version);
      if (!result.notFound) failures.push({ source: candidate.source, executablePath: candidate.executablePath, message: result.message });
    }
    if (failures.length > 0 && managed.length > 0) {
      this.setInfo({
        state: "awaitingFallbackConsent",
        source: null,
        executablePath: null,
        version: null,
        candidateFailure: failures[0],
      });
      return this.getInfo();
    }
    return this.selectFirstValid(managed);
  }

  async useManaged(): Promise<CodexRuntimeInfo> {
    const settings = this.getSettings();
    await this.saveSettings({
      ...settings,
      codexRuntime: { ...settings.codexRuntime, preference: "managed", customExecutablePath: null },
    });
    return this.selectFirstValid(await this.managedCandidates());
  }

  async useAutomatic(): Promise<CodexRuntimeInfo> {
    const settings = this.getSettings();
    await this.saveSettings({
      ...settings,
      codexRuntime: { ...settings.codexRuntime, preference: "auto", customExecutablePath: null },
    });
    return this.resolve();
  }

  async useCustom(executablePath: string): Promise<CodexRuntimeInfo> {
    const normalized = resolve(executablePath);
    const result = await this.probe({ source: "custom", executablePath: normalized, managed: false });
    if (!result.ok) return this.unavailable(result.message, { source: "custom", executablePath: normalized, message: result.message });
    const settings = this.getSettings();
    await this.saveSettings({
      ...settings,
      codexRuntime: { ...settings.codexRuntime, preference: "custom", customExecutablePath: normalized },
    });
    return this.select({ source: "custom", executablePath: normalized, managed: false }, result.version);
  }

  recordStartupFailure(error: unknown): CodexRuntimeInfo {
    const message = error instanceof Error ? error.message : String(error);
    const source = this.info.source;
    if (source === "path" || source === "knownInstall") {
      this.setInfo({
        state: "awaitingFallbackConsent",
        candidateFailure: {
          source,
          executablePath: this.info.executablePath ?? "codex",
          message,
        },
      });
    } else {
      this.setInfo({ state: "unavailable", candidateFailure: source && this.info.executablePath ? {
        source,
        executablePath: this.info.executablePath,
        message,
      } : null });
    }
    return this.getInfo();
  }

  markStarting(): void {
    this.setInfo({ state: "starting" });
  }

  markReady(): void {
    this.setInfo({ state: "ready" });
  }

  markReconnecting(): void {
    this.setInfo({ state: "reconnecting" });
  }

  private async externalCandidates(): Promise<Candidate[]> {
    const values: Candidate[] = [{ source: "path", executablePath: "codex", managed: false }];
    if (this.platform === "win32" && this.env.LOCALAPPDATA) {
      values.push({
        source: "knownInstall",
        executablePath: join(this.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        managed: false,
      });
      const appBin = join(this.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      for (const entry of await readdir(appBin).catch(() => [])) {
        values.push({ source: "knownInstall", executablePath: join(appBin, entry, "codex.exe"), managed: false });
      }
      if (this.env.APPDATA) {
        const npmRoot = join(this.env.APPDATA, "npm", "node_modules", "@openai");
        values.push(
          { source: "knownInstall", executablePath: join(npmRoot, "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), managed: false },
          { source: "knownInstall", executablePath: join(npmRoot, "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), managed: false },
        );
      }
      if (this.env.USERPROFILE) {
        values.push({
          source: "knownInstall",
          executablePath: join(this.env.USERPROFILE, ".bun", "install", "global", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
          managed: false,
        });
      }
    } else if (this.platform === "linux") {
      values.push(
        { source: "knownInstall", executablePath: join(this.homePath, ".local", "bin", "codex"), managed: false },
        { source: "knownInstall", executablePath: "/usr/local/bin/codex", managed: false },
        { source: "knownInstall", executablePath: "/usr/bin/codex", managed: false },
      );
    }
    return this.unique(values);
  }

  private async managedCandidates(): Promise<Candidate[]> {
    const values: Candidate[] = [];
    const settings = this.getSettings().codexRuntime;
    if (settings.managedVersion) {
      values.push({
        source: "managed",
        executablePath: join(this.userDataPath, "codex", settings.managedVersion, this.platform === "win32" ? "codex.exe" : "codex"),
        managed: true,
      });
    }
    const bundled = this.bundledPath();
    const manifest = await this.bundledManifest();
    this.setInfo({ bundledVersion: manifest?.version ?? null });
    values.push({ source: "bundled", executablePath: bundled, managed: true });
    return this.unique(values);
  }

  private bundledPath(): string {
    return join(this.resourcesPath, "codex", this.platformKey(), "bin", this.platform === "win32" ? "codex.exe" : "codex");
  }

  private async bundledManifest(): Promise<{ version: string } | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.resourcesPath, "codex", "manifest.json"), "utf8")) as Record<string, unknown>;
      return typeof parsed.version === "string" ? { version: parsed.version } : null;
    } catch {
      return null;
    }
  }

  private async selectFirstValid(candidates: Candidate[]): Promise<CodexRuntimeInfo> {
    let lastFailure: CodexRuntimeCandidateFailure | null = null;
    for (const candidate of candidates) {
      const result = await this.probe(candidate);
      if (result.ok) return this.select(candidate, result.version);
      lastFailure = { source: candidate.source, executablePath: candidate.executablePath, message: result.message };
    }
    return this.unavailable(lastFailure?.message ?? "No usable Codex runtime was found.", lastFailure);
  }

  private select(candidate: Candidate, version: string): CodexRuntimeInfo {
    this.server.setExecutablePath(candidate.executablePath);
    this.setInfo({
      state: "starting",
      source: candidate.source,
      executablePath: candidate.executablePath,
      version,
      candidateFailure: null,
      update: { ...this.info.update, currentVersion: version },
    });
    return this.getInfo();
  }

  private unavailable(message: string, candidateFailure: CodexRuntimeCandidateFailure | null = null): CodexRuntimeInfo {
    this.setInfo({
      state: "unavailable",
      source: null,
      executablePath: null,
      version: null,
      candidateFailure: candidateFailure ?? {
        source: "bundled",
        executablePath: this.bundledPath(),
        message,
      },
    });
    return this.getInfo();
  }

  private probe(candidate: Candidate): Promise<{ ok: true; version: string } | { ok: false; message: string; notFound: boolean }> {
    return new Promise((resolveProbe) => {
      let output = "";
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const child = spawn(candidate.executablePath, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: this.env });
      const finish = (result: { ok: true; version: string } | { ok: false; message: string; notFound: boolean }) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolveProbe(result);
      };
      child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4_096); });
      child.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4_096); });
      child.once("error", (error: NodeJS.ErrnoException) => finish({ ok: false, message: error.message, notFound: error.code === "ENOENT" }));
      child.once("close", (code) => {
        const version = output.trim().match(/(?:codex-cli\s+)?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)/i)?.[1] ?? output.trim();
        finish(code === 0 && version ? { ok: true, version } : { ok: false, message: output.trim() || `Codex exited with code ${code ?? "unknown"}.`, notFound: false });
      });
      timeout = setTimeout(() => {
        child.kill();
        finish({ ok: false, message: `Codex validation timed out after ${PROBE_TIMEOUT_MS / 1000} seconds.`, notFound: false });
      }, PROBE_TIMEOUT_MS);
    });
  }

  private platformKey(): "win32-x64" | "linux-x64" {
    if (this.arch !== "x64" || (this.platform !== "win32" && this.platform !== "linux")) {
      throw new Error(`Managed Codex is unsupported on ${this.platform}-${this.arch}.`);
    }
    return `${this.platform}-x64`;
  }

  private unique(candidates: Candidate[]): Candidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.source}:${candidate.executablePath}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private setInfo(update: Partial<CodexRuntimeInfo>): void {
    this.info = { ...this.info, ...update };
    this.onChange(this.getInfo());
  }

}
