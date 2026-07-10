const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

function getIconPath() {
  if (process.platform === "win32") return path.join(__dirname, "icon.ico");
  if (process.platform === "darwin") return path.join(__dirname, "icon.icns");
  return path.join(__dirname, "icon.png");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 700,
    resizable: true,
    backgroundColor: "#0a0b0f",
    title: "Stream Guardian — OBS Bridge",
    icon: getIconPath(),
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0b0f",
      symbolColor: "#e8e9ed",
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

// Bridge lifecycle — delegated to bridge.cjs
const { startBridge, stopBridge, getBridgeStatus } = require("./bridge.cjs");

ipcMain.handle("bridge:start", async (_event, { bridgeCode, obsUrl, obsPassword }) => {
  try {
    await startBridge({ bridgeCode, obsUrl, obsPassword, onStatusChange });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("bridge:stop", async () => {
  await stopBridge();
  return { success: true };
});

ipcMain.handle("bridge:status", () => {
  return getBridgeStatus();
});

function onStatusChange(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:status-update", status);
  }
}

// In-app updater
const updater = require("./updater.cjs");

ipcMain.handle("updater:version", () => updater.getCurrentVersion());

ipcMain.handle("updater:check", async () => {
  return await updater.checkForUpdate();
});

function emitProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("updater:progress", p);
  }
}

ipcMain.handle("updater:download", async () => {
  try {
    const result = await updater.downloadUpdateInBackground(emitProgress);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("updater:restart", async () => {
  try {
    return { success: true, ...updater.applyStagedUpdate() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("updater:downloadState", () => updater.getDownloadState());

// Back-compat: download + restart in one call.
ipcMain.handle("updater:apply", async () => {
  try {
    const result = await updater.applyUpdate(emitProgress);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Persisted OBS credentials (URL + password). Password is encrypted at rest
// via Electron safeStorage (OS keychain: DPAPI / Keychain / libsecret).
// ---------------------------------------------------------------------------
function credentialsPath() {
  return path.join(app.getPath("userData"), "credentials.json");
}

ipcMain.handle("creds:load", () => {
  try {
    const p = credentialsPath();
    if (!fs.existsSync(p)) return { bridgeCode: "", obsUrl: "", obsPassword: "", passwordSupported: safeStorage.isEncryptionAvailable() };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    let obsPassword = "";
    if (raw.obsPasswordEncB64 && safeStorage.isEncryptionAvailable()) {
      try {
        obsPassword = safeStorage.decryptString(Buffer.from(raw.obsPasswordEncB64, "base64"));
      } catch {
        obsPassword = "";
      }
    }
    return {
      bridgeCode: raw.bridgeCode || "",
      obsUrl: raw.obsUrl || "",
      obsPassword,
      passwordSupported: safeStorage.isEncryptionAvailable(),
    };
  } catch {
    return { bridgeCode: "", obsUrl: "", obsPassword: "", passwordSupported: safeStorage.isEncryptionAvailable() };
  }
});

ipcMain.handle("creds:save", (_event, { bridgeCode, obsUrl, obsPassword }) => {
  try {
    const payload = {
      bridgeCode: typeof bridgeCode === "string" ? bridgeCode : "",
      obsUrl: typeof obsUrl === "string" ? obsUrl : "",
    };
    if (typeof obsPassword === "string" && obsPassword.length > 0 && safeStorage.isEncryptionAvailable()) {
      payload.obsPasswordEncB64 = safeStorage.encryptString(obsPassword).toString("base64");
    }
    fs.writeFileSync(credentialsPath(), JSON.stringify(payload), { mode: 0o600 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("creds:clear", () => {
  try {
    const p = credentialsPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
