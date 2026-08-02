import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import type { AppSnapshot } from "../shared/types";
import { AppBootstrap } from "./bootstrap/AppBootstrap";
import { CodexAppServer } from "./codex/CodexAppServer";
import { CodexRuntimeManager } from "./codex/CodexRuntimeManager";
import { CodexSessionManager } from "./codex/CodexSessionManager";
import { DiagnosticsLogger } from "./diagnostics/DiagnosticsLogger";
import { registerIpc } from "./ipc";
import { setIpcErrorReporter } from "./ipcResult";
import { ProjectStore } from "./projects/ProjectStore";
import { ProjectRunner } from "./runtime/ProjectRunner";

let mainWindow: BrowserWindow | null = null;
let runner: ProjectRunner | null = null;
let codex: CodexSessionManager | null = null;
let quitting = false;

if (process.platform === "win32") {
  app.setAppUserModelId("com.eleventhlucas.appbuilder");
}
if (process.env.APPBUILDER_E2E === "1" && process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath("userData", process.env.ELECTRON_USER_DATA_DIR);
}
if (process.env.APPBUILDER_E2E === "1" || process.env.APPBUILDER_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
}

function sendToRenderer(channel: string, payload: unknown): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  try {
    window.webContents.send(channel, payload);
  } catch {
    // Renderer navigation or shutdown can dispose a frame between the checks and send.
  }
}

function createWindow(): BrowserWindow {
  const icon = app.isPackaged
    ? join(process.resourcesPath, "icons", "app-icon.png")
    : join(app.getAppPath(), "resources", "icons", "app-icon.png");
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#111014",
    icon,
    ...(process.platform === "win32" || process.platform === "linux"
      ? {
          autoHideMenuBar: true,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#18171c",
            symbolColor: "#f4f4f5",
            height: 32,
          },
        }
      : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
  return window;
}

app.whenReady().then(() => {
  const window = createWindow();
  const userDataPath = app.getPath("userData");
  const store = new ProjectStore(join(userDataPath, "appbuilder-state.json"));
  const logger = new DiagnosticsLogger(join(userDataPath, "logs"));
  void logger.initialize().catch(() => undefined);
  setIpcErrorReporter((channel, error) => logger.error({
    subsystem: "ipc",
    operation: channel,
    code: error.code,
    retryable: error.retryable,
  }));

  let runtimeManager: CodexRuntimeManager;
  const initializeReadyServices = async (): Promise<AppSnapshot> => {
    if (runner && codex) return readySnapshot(store, runner, codex);

    runner = new ProjectRunner(store, (status) => {
      sendToRenderer("runtime:event", status);
    }, {
      openUrl: (url) => shell.openExternal(url),
      openFile: (path) => shell.openPath(path),
    });
    const server = new CodexAppServer();
    codex = new CodexSessionManager(
      server,
      store,
      (event) => sendToRenderer("codex:event", event),
      (error) => {
        logger.error({
          subsystem: "codex",
          operation: "app-server-exit",
          code: "CODEX_APP_SERVER_FAILED",
          retryable: true,
        });
        codex?.setRuntimeInfo(runtimeManager.recordStartupFailure(error));
      },
      runner,
    );
    const resourcesPath = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
    runtimeManager = new CodexRuntimeManager({
      server,
      resourcesPath,
      userDataPath,
      homePath: app.getPath("home"),
      getSettings: () => store.getState().settings,
      saveSettings: async (settings) => { await store.updateSettings(settings); },
      onChange: (runtime) => codex?.setRuntimeInfo(runtime),
    });
    registerIpc({
      getWindow: () => mainWindow,
      attachmentsRoot: join(userDataPath, "attachments"),
      codex,
      runner,
      store,
      runtimeManager,
    });

    const runtime = await runtimeManager.resolve();
    codex.setRuntimeInfo(runtime);
    if (runtime.state === "starting") {
      try {
        runtimeManager.markStarting();
        await codex.start();
        runtimeManager.markReady();
        codex.setRuntimeInfo(runtimeManager.getInfo());
      } catch (error) {
        codex.setRuntimeInfo(runtimeManager.recordStartupFailure(error));
      }
    }
    return readySnapshot(store, runner, codex);
  };

  const bootstrap = new AppBootstrap({
    store,
    logger,
    getWindow: () => mainWindow,
    initializeReadyServices,
    getReadySnapshot: () => {
      if (!runner || !codex) throw new Error("AppBuilder services have not initialized.");
      return readySnapshot(store, runner, codex);
    },
  });

  void window.loadFile(join(__dirname, "../renderer/index.html"));
  void bootstrap.initialize();
});

function readySnapshot(
  store: ProjectStore,
  currentRunner: ProjectRunner,
  currentCodex: CodexSessionManager,
): AppSnapshot {
  const state = store.getState();
  return {
    state,
    runtimes: currentRunner.getStatuses(state.projects.map((project) => project.id)),
    codex: currentCodex.getOverview(),
  };
}

app.on("before-quit", (event) => {
  if (quitting || !runner) return;
  event.preventDefault();
  quitting = true;
  void Promise.all([runner.stopAll(), codex?.stop()]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  app.quit();
});
