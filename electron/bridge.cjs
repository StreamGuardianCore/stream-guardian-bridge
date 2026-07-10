/**
 * OBS ↔ Supabase Realtime bridge logic.
 *
 * Connects to OBS via obs-websocket-js and relays stats to a Supabase
 * Realtime channel. Receives commands from the channel and forwards
 * them to OBS.
 */

const OBSWebSocket = require("obs-websocket-js").default;
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://azdhflrooyftnuzvgvye.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6ZGhmbHJvb3lmdG51enZndnllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDY4NzAsImV4cCI6MjA4ODU4Mjg3MH0.L-_aih8qmgMVFICE_AMG3CQSzWjFKOgTV2e60tQUl_Y";

let obs = null;
let supabase = null;
let channel = null;
let pollTimer = null;
let statusCallback = null;
let lastOutputBytes = 0;
let lastOutputTime = 0;

let currentStatus = {
  bridgeConnected: false,
  obsConnected: false,
  error: null,
  obsUrl: null,
};

function setStatus(partial) {
  currentStatus = { ...currentStatus, ...partial };
  if (statusCallback) statusCallback(currentStatus);
}

function getBridgeStatus() {
  return currentStatus;
}

async function startBridge({ bridgeCode, obsUrl, obsPassword, onStatusChange }) {
  await stopBridge();
  statusCallback = onStatusChange;

  // 1. Connect to OBS
  obs = new OBSWebSocket();
  setStatus({ error: null, obsUrl });

  try {
    await obs.connect(obsUrl, obsPassword || undefined);
    setStatus({ obsConnected: true });
    console.log("[Bridge] Connected to OBS at", obsUrl);
  } catch (err) {
    setStatus({ obsConnected: false, error: `OBS connection failed: ${err.message || err}` });
    throw new Error(`Cannot connect to OBS: ${err.message || err}`);
  }

  obs.on("ConnectionClosed", () => {
    setStatus({ obsConnected: false, error: "OBS connection closed" });
    stopPolling();
    broadcastDisconnected();
  });

  // 2. Connect to Supabase Realtime channel
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const channelName = `obs-bridge-${bridgeCode}`;

  channel = supabase.channel(channelName);

  channel.on("broadcast", { event: "command" }, async ({ payload }) => {
    await handleCommand(payload);
  });

  await channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      setStatus({ bridgeConnected: true });
      console.log("[Bridge] Joined channel:", channelName);
      broadcastConnected();
      startPolling();
    }
  });
}

async function stopBridge() {
  stopPolling();
  if (channel) {
    try { await channel.unsubscribe(); } catch {}
    channel = null;
  }
  if (obs) {
    try { await obs.disconnect(); } catch {}
    obs = null;
  }
  if (supabase) {
    try { supabase.removeAllChannels(); } catch {}
    supabase = null;
  }
  lastOutputBytes = 0;
  lastOutputTime = 0;
  setStatus({ bridgeConnected: false, obsConnected: false, error: null, obsUrl: null });
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => pollAndBroadcast(), 2000);
  // Immediately send first stats
  pollAndBroadcast();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollAndBroadcast() {
  if (!obs || !channel) return;

  try {
    const [statsResp, scenesResp, streamStatus, recordStatus] = await Promise.all([
      obs.call("GetStats"),
      obs.call("GetSceneList"),
      obs.call("GetStreamStatus").catch(() => null),
      obs.call("GetRecordStatus").catch(() => null),
    ]);

    const currentBytes = streamStatus?.outputBytes ?? 0;
    const now = Date.now();
    let kbitsPerSec = 0;
    if (lastOutputTime > 0 && currentBytes > lastOutputBytes) {
      const deltaBytes = currentBytes - lastOutputBytes;
      const deltaSec = (now - lastOutputTime) / 1000;
      if (deltaSec > 0) kbitsPerSec = Math.round((deltaBytes * 8) / (deltaSec * 1000));
    }
    lastOutputBytes = currentBytes;
    lastOutputTime = now;

    const stats = {
      cpuUsage: statsResp.cpuUsage,
      memoryUsage: statsResp.memoryUsage,
      activeFps: statsResp.activeFps,
      renderSkippedFrames: statsResp.renderSkippedFrames,
      renderTotalFrames: statsResp.renderTotalFrames,
      outputSkippedFrames: statsResp.outputSkippedFrames,
      outputTotalFrames: statsResp.outputTotalFrames,
      availableDiskSpace: statsResp.availableDiskSpace,
      kbitsPerSec,
      streaming: streamStatus?.outputActive ?? false,
      recording: recordStatus?.outputActive ?? false,
      currentScene: scenesResp.currentProgramSceneName || "",
      scenes: (scenesResp.scenes || []).map((s) => s.sceneName),
    };

    await channel.send({ type: "broadcast", event: "stats", payload: stats });
  } catch (err) {
    console.warn("[Bridge] Poll error:", err.message);
  }
}

function broadcastConnected() {
  if (channel) channel.send({ type: "broadcast", event: "connected", payload: {} });
}

function broadcastDisconnected() {
  if (channel) channel.send({ type: "broadcast", event: "disconnected", payload: {} });
}

async function handleCommand(payload) {
  if (!obs) return;
  const { action, params, requestId } = payload || {};
  let success = true;
  let error = null;
  let result = null;

  try {
    switch (action) {
      case "startStream":
        await obs.call("StartStream");
        break;
      case "stopStream":
        await obs.call("StopStream");
        break;
      case "switchScene":
        await obs.call("SetCurrentProgramScene", { sceneName: params?.sceneName });
        break;
      case "startRecording":
        await obs.call("StartRecord");
        break;
      case "stopRecording":
        await obs.call("StopRecord");
        break;
      case "startOutput":
        await obs.call("StartOutput", { outputName: params?.outputName });
        break;
      case "stopOutput":
        await obs.call("StopOutput", { outputName: params?.outputName });
        break;
      case "toggleInputMute":
        await obs.call("ToggleInputMute", { inputName: params?.inputName });
        break;
      case "obsCall": {
        // Generic passthrough: { requestType, requestData }
        const requestType = params?.requestType;
        const requestData = params?.requestData;
        if (!requestType) {
          success = false;
          error = "obsCall missing requestType";
          break;
        }
        result = await obs.call(requestType, requestData);
        break;
      }
      default:
        success = false;
        error = `Unknown action: ${action}`;
    }
  } catch (err) {
    success = false;
    error = err.message || String(err);
  }

  if (channel) {
    channel.send({
      type: "broadcast",
      event: "command_result",
      payload: { action, success, error, result, requestId },
    });
  }
}

module.exports = { startBridge, stopBridge, getBridgeStatus };
