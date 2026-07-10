// In-app update checker for the Stream Guardian OBS Bridge.
// Pure Node — no extra deps. Pulls a manifest.json from public storage,
// downloads + verifies the latest ZIP/tar.gz, stages it, then swaps on quit.

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { app } = require("electron");

const MANIFEST_URL =
  "https://azdhflrooyftnuzvgvye.supabase.co/storage/v1/object/public/companion-app/manifest.json";

let pkgVersion = "0.0.0";
try {
  pkgVersion = require("./package.json").version || "0.0.0";
} catch {}

function getPlatformKey() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  return `linux-${arch}`;
}

function compareSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: opts.timeout || 15000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(res.headers.location, opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
  });
}

async function fetchManifest() {
  const url = `${MANIFEST_URL}?t=${Date.now()}`;
  const res = await httpGet(url, { timeout: 10000 });
  return new Promise((resolve, reject) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid manifest JSON"));
      }
    });
    res.on("error", reject);
  });
}

async function checkForUpdate() {
  try {
    const manifest = await fetchManifest();
    const platformKey = getPlatformKey();
    const platform = manifest.platforms && manifest.platforms[platformKey];
    const newer = compareSemver(manifest.version, pkgVersion) > 0;
    const required =
      manifest.minSupported && compareSemver(pkgVersion, manifest.minSupported) < 0;
    return {
      ok: true,
      currentVersion: pkgVersion,
      latestVersion: manifest.version,
      releasedAt: manifest.releasedAt || null,
      notes: manifest.notes || "",
      updateAvailable: !!(newer && platform && platform.url),
      required: !!required,
      platform: platform || null,
      platformKey,
    };
  } catch (err) {
    return { ok: false, currentVersion: pkgVersion, error: err.message };
  }
}

function downloadTo(url, destPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpGet(url, { timeout: 30000 });
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve({ received, total })));
      file.on("error", reject);
      res.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("data", (d) => hash.update(d));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", reject);
  });
}

function extractArchive(archivePath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    if (process.platform === "win32") {
      // PowerShell Expand-Archive (ZIP)
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    } else {
      // tar handles both .zip (bsdtar) on macOS and .tar.gz on Linux/macOS
      execFile("tar", ["-xf", archivePath, "-C", outDir], (err) =>
        err ? reject(err) : resolve()
      );
    }
  });
}

function findStagedAppDir(stagingDir) {
  // Manifest archives produced by CI contain a top-level "StreamGuardian-OBS-Bridge"
  // folder with an "app" subfolder. Locate it defensively.
  const candidates = [
    path.join(stagingDir, "StreamGuardian-OBS-Bridge", "app"),
    path.join(stagingDir, "app"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: look one level deep for a folder containing the exe
  for (const entry of fs.readdirSync(stagingDir)) {
    const full = path.join(stagingDir, entry);
    if (fs.statSync(full).isDirectory()) {
      const innerApp = path.join(full, "app");
      if (fs.existsSync(innerApp)) return innerApp;
    }
  }
  return null;
}

function getInstallRoot() {
  // The packaged app lives at <install>/app/<executable>. We want <install>.
  // app.getAppPath() returns .../app/resources/app (in packaged) — walk up.
  const exeDir = path.dirname(app.getPath("exe"));
  // exeDir is typically <install>/app
  return path.dirname(exeDir);
}

function writeAndRunSwapScript({ installRoot, newAppDir, relaunchCmd }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-bridge-apply-"));
  if (process.platform === "win32") {
    const script = path.join(tmp, "apply-update.cmd");
    const content =
      "@echo off\r\n" +
      "timeout /t 2 /nobreak >nul\r\n" +
      `if exist "${path.join(installRoot, "app.old")}" rmdir /s /q "${path.join(installRoot, "app.old")}"\r\n` +
      `if exist "${path.join(installRoot, "app")}" ren "${path.join(installRoot, "app")}" app.old\r\n` +
      `move "${newAppDir}" "${path.join(installRoot, "app")}"\r\n` +
      `start "" "${relaunchCmd}"\r\n` +
      "exit\r\n";
    fs.writeFileSync(script, content);
    spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore" }).unref();
  } else {
    const script = path.join(tmp, "apply-update.sh");
    const content =
      "#!/bin/sh\n" +
      "sleep 2\n" +
      `rm -rf "${path.join(installRoot, "app.old")}" 2>/dev/null\n` +
      `mv "${path.join(installRoot, "app")}" "${path.join(installRoot, "app.old")}" 2>/dev/null\n` +
      `mv "${newAppDir}" "${path.join(installRoot, "app")}"\n` +
      `"${relaunchCmd}" &\n`;
    fs.writeFileSync(script, content);
    fs.chmodSync(script, 0o755);
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  }
}

async function downloadAndStage(platform, onProgress) {
  if (!platform || !platform.url) throw new Error("No download URL for this platform");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sg-bridge-update-"));
  const ext = platform.url.toLowerCase().endsWith(".tar.gz") ? ".tar.gz" : ".zip";
  const archivePath = path.join(tmpRoot, `bridge-update${ext}`);

  await downloadTo(platform.url, archivePath, onProgress);

  if (platform.sha256) {
    const got = await sha256File(archivePath);
    if (got.toLowerCase() !== String(platform.sha256).toLowerCase()) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      throw new Error("Downloaded file failed integrity check");
    }
  }

  const extractDir = path.join(tmpRoot, "extract");
  await extractArchive(archivePath, extractDir);

  const newAppDir = findStagedAppDir(extractDir);
  if (!newAppDir) throw new Error("Update archive layout was unexpected");
  return { tmpRoot, newAppDir };
}

// Tracks an in-progress or completed background download so the user can
// keep using the Bridge until they choose "Restart to update".
let downloadState = {
  status: "idle", // idle | downloading | ready | error
  version: null,
  receivedBytes: 0,
  totalBytes: 0,
  newAppDir: null,
  tmpRoot: null,
  error: null,
  startedAt: null,
  readyAt: null,
};
let activeDownload = null; // Promise guard

function getDownloadState() {
  return { ...downloadState };
}

async function downloadUpdateInBackground(onProgress) {
  if (downloadState.status === "downloading" && activeDownload) {
    return activeDownload;
  }
  if (downloadState.status === "ready") {
    return { staged: true, version: downloadState.version, alreadyReady: true };
  }

  activeDownload = (async () => {
    const info = await checkForUpdate();
    if (!info.ok) throw new Error(info.error || "Update check failed");
    if (!info.updateAvailable) throw new Error("Already up to date");

    // Clean any previous staged dir before starting a new download.
    if (downloadState.tmpRoot) {
      try { fs.rmSync(downloadState.tmpRoot, { recursive: true, force: true }); } catch {}
    }

    downloadState = {
      status: "downloading",
      version: info.latestVersion,
      receivedBytes: 0,
      totalBytes: 0,
      newAppDir: null,
      tmpRoot: null,
      error: null,
      startedAt: Date.now(),
      readyAt: null,
    };

    try {
      const { tmpRoot, newAppDir } = await downloadAndStage(info.platform, (p) => {
        downloadState.receivedBytes = p.received || 0;
        downloadState.totalBytes = p.total || 0;
        if (onProgress) onProgress({ ...p, version: info.latestVersion, phase: "downloading" });
      });
      downloadState.status = "ready";
      downloadState.tmpRoot = tmpRoot;
      downloadState.newAppDir = newAppDir;
      downloadState.readyAt = Date.now();
      if (onProgress) onProgress({ phase: "ready", version: info.latestVersion });
      return { staged: true, version: info.latestVersion };
    } catch (err) {
      downloadState.status = "error";
      downloadState.error = err.message;
      if (onProgress) onProgress({ phase: "error", error: err.message });
      throw err;
    } finally {
      activeDownload = null;
    }
  })();

  return activeDownload;
}

function applyStagedUpdate() {
  if (downloadState.status !== "ready" || !downloadState.newAppDir) {
    throw new Error("No staged update is ready to apply");
  }
  const installRoot = getInstallRoot();

  let relaunchCmd;
  if (process.platform === "win32") {
    relaunchCmd = path.join(installRoot, "Start Stream Guardian.bat");
    if (!fs.existsSync(relaunchCmd)) {
      relaunchCmd = path.join(installRoot, "app", "StreamGuardian-OBS-Bridge.exe");
    }
  } else if (process.platform === "darwin") {
    relaunchCmd = path.join(installRoot, "app", "StreamGuardian-OBS-Bridge.app", "Contents", "MacOS", "StreamGuardian-OBS-Bridge");
  } else {
    relaunchCmd = path.join(installRoot, "app", "StreamGuardian-OBS-Bridge");
  }

  writeAndRunSwapScript({
    installRoot,
    newAppDir: downloadState.newAppDir,
    relaunchCmd,
  });
  setTimeout(() => app.quit(), 400);
  return { applied: true, version: downloadState.version };
}

// Back-compat: download then immediately apply.
async function applyUpdate(onProgress) {
  await downloadUpdateInBackground(onProgress);
  return applyStagedUpdate();
}

module.exports = {
  checkForUpdate,
  applyUpdate,
  downloadUpdateInBackground,
  applyStagedUpdate,
  getDownloadState,
  getCurrentVersion: () => pkgVersion,
};
