import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DASHBOARD_URL = "http://127.0.0.1:3000";
let monitorStack = null;
let mainWindow = null;
let ownsMonitorStack = false;
let quitting = false;

const healthCheck = async () => {
  try {
    const response = await fetch("http://127.0.0.1:3001/state", {
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const waitForDashboard = async (attempts = 80) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(DASHBOARD_URL, {
        signal: AbortSignal.timeout(900),
      });
      if (response.ok) return;
    } catch {
      // The local services are still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Switch KPI did not finish starting.");
};

const startMonitorStack = async () => {
  if (await healthCheck()) return;

  const appRoot = app.getAppPath();
  const startScript = resolve(appRoot, "monitor/start.mjs");
  if (!existsSync(startScript)) {
    throw new Error(`The Switch KPI monitor is missing: ${startScript}`);
  }

  const dataDir = resolve(app.getPath("userData"), "data");
  mkdirSync(dataDir, { recursive: true });
  monitorStack = spawn(process.execPath, [startScript], {
    cwd: appRoot,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SWITCH_KPI_DESKTOP: "1",
      SWITCH_KPI_DATA_DIR: dataDir,
    },
  });
  ownsMonitorStack = true;
  monitorStack.once("exit", (code) => {
    if (code && !quitting) {
      dialog.showErrorBox(
        "Switch KPI stopped",
        `The local monitor stopped unexpectedly (code ${code}).`,
      );
    }
  });
};

const stopMonitorStack = () => {
  if (!ownsMonitorStack || !monitorStack || monitorStack.killed) return;
  if (process.platform === "win32") {
    monitorStack.kill("SIGTERM");
  } else {
    try {
      process.kill(-monitorStack.pid, "SIGTERM");
    } catch {
      monitorStack.kill("SIGTERM");
    }
  }
};

const createWindow = async () => {
  const appRoot = app.getAppPath();
  const icon = resolve(appRoot, "build/icon.png");
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#0b0d0f",
    show: false,
    title: "Switch KPI",
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(DASHBOARD_URL)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(DASHBOARD_URL);
};

app.whenReady().then(async () => {
  try {
    await startMonitorStack();
    await waitForDashboard();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Switch KPI could not start",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  stopMonitorStack();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
