import { createServer } from "node:http";
import jpeg from "jpeg-js";

const PORT = Number(process.env.SHADING_MONITOR_PORT || 3002);
const SAMPLE_MS = Number(process.env.SHADING_SAMPLE_MS || 1000);
const EVENT_THRESHOLD = Number(process.env.SHADING_EVENT_THRESHOLD || 8);

const cameras = [
  { id: "cam1", name: "CAM 1", role: "HC5000", host: "10.31.1.1", controller: "AK-UCU500", source: "CCU", iris: 7.5, gainDb: -3 },
  { id: "cam2", name: "CAM 2", role: "HC5000", host: "10.31.1.3", controller: "AK-UCU500", source: "CCU", iris: 5.6, gainDb: 0 },
  { id: "cam3", name: "CAM 3", role: "PTZ", host: null, controller: "CyanView", source: "192.168.206.225" },
  { id: "cam6", name: "CAM 6", role: "AW-UE100", host: "192.168.206.209", controller: "CyanView", source: "192.168.206.252" },
  { id: "cam7", name: "CAM 7", role: "AW-UE160", host: "192.168.206.61", controller: "CyanView", source: "192.168.206.252" },
];

const state = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  cameras: cameras.map((camera) => ({
    ...camera,
    online: false,
    lastSeen: null,
    adjustments: 0,
    adjustmentsPerMinute: 0,
    variance: 0,
    meanMagnitude: 0,
    lastMagnitude: 0,
    lastAdjustmentAt: null,
    metrics: null,
    samples: 0,
    note: camera.host ? "Connecting…" : "CyanView camera mapping not exposed",
    history: [],
  })),
  events: [],
  cyanView: {
    "192.168.206.225": { online: false, cameras: [], fingerprint: null },
    "192.168.206.252": { online: false, cameras: [], fingerprint: null },
    duplicateConfiguration: false,
  },
};

const clients = new Set();
const samplesByCamera = new Map();
const tallyByCyanCamera = new Map();
const tallySuppressedUntil = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(payload);
}

function imageMetrics(raw) {
  const decoded = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
  const { data, width, height } = decoded;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 6000)));
  let r = 0, g = 0, b = 0, luma = 0, contrast = 0, count = 0;
  const luminances = [];
  const blocks = Array.from({ length: 16 }, () => ({ luma: 0, count: 0 }));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const pr = data[offset], pg = data[offset + 1], pb = data[offset + 2];
      const py = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      r += pr; g += pg; b += pb; luma += py; luminances.push(py); count += 1;
      const block = blocks[
        Math.min(3, Math.floor((y / height) * 4)) * 4 +
        Math.min(3, Math.floor((x / width) * 4))
      ];
      block.luma += py;
      block.count += 1;
    }
  }
  r /= count; g /= count; b /= count; luma /= count;
  for (const value of luminances) contrast += (value - luma) ** 2;
  contrast = Math.sqrt(contrast / count);
  luminances.sort((a, b) => a - b);
  return {
    luma, r, g, b, contrast,
    black: luminances[Math.floor(luminances.length * 0.1)],
    white: luminances[Math.floor(luminances.length * 0.9)],
    blocks: blocks.map((block) => block.count ? block.luma / block.count : 0),
  };
}

function magnitude(previous, current) {
  if (!previous) return { value: 0, coherence: 0 };
  const brightness = Math.abs(current.luma - previous.luma) * 0.65;
  const channelDeltas = [
    current.r - previous.r,
    current.g - previous.g,
    current.b - previous.b,
  ];
  const channelMean = channelDeltas.reduce((sum, value) => sum + value, 0) / 3;
  const colour = Math.sqrt(
    channelDeltas.reduce((sum, value) => sum + (value - channelMean) ** 2, 0) / 3,
  ) * 0.7;
  const contrast = Math.abs(current.contrast - previous.contrast) * 0.4;
  const direction = Math.sign(current.luma - previous.luma);
  const blockDeltas = current.blocks
    .map((value, index) => value - previous.blocks[index])
    .filter((delta) => Math.abs(delta) >= 1);
  const coherence = blockDeltas.length
    ? blockDeltas.filter((delta) => Math.sign(delta) === direction).length / blockDeltas.length
    : 0;
  return { value: brightness + colour + contrast, coherence };
}

function updateStats(camera, value, metrics) {
  const now = Date.now();
  const history = samplesByCamera.get(camera.id) || [];
  history.push({ at: now, magnitude: value });
  while (history.length && history[0].at < now - 15 * 60_000) history.shift();
  samplesByCamera.set(camera.id, history);
  const adjustmentSamples = history.filter((item) => item.magnitude >= EVENT_THRESHOLD);
  const values = adjustmentSamples.map((item) => item.magnitude);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length
    ? values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / values.length
    : 0;
  camera.metrics = metrics;
  camera.lastMagnitude = value;
  camera.meanMagnitude = mean;
  camera.variance = variance;
  camera.samples = history.length;
  camera.history = history.slice(-90).map((item) => Number(item.magnitude.toFixed(2)));
  const elapsedMinutes = Math.max(1 / 60, (now - new Date(state.startedAt).getTime()) / 60_000);
  camera.adjustmentsPerMinute = camera.adjustments / elapsedMinutes;
}

function tallyIsSuppressed(camera) {
  return (tallySuppressedUntil.get(camera.id) || 0) > Date.now();
}

async function sampleCamera(camera) {
  if (!camera.host) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`http://${camera.host}/cgi-bin/camera?resolution=640&quality=1`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    const metrics = imageMetrics(raw);
    const previous = camera.metrics;
    const delta = magnitude(previous, metrics);
    const value = delta.value;
    camera.online = true;
    camera.lastSeen = new Date().toISOString();
    camera.note = "Live image analysis";
    updateStats(camera, value, metrics);
    camera.pendingAdjustment = null;
    if (
      previous &&
      value >= EVENT_THRESHOLD &&
      delta.coherence >= 0.78 &&
      !tallyIsSuppressed(camera) &&
      (!camera.lastAdjustmentAt || Date.now() - new Date(camera.lastAdjustmentAt).getTime() > 3000)
    ) {
      const channelDeltas = [
        metrics.r - previous.r,
        metrics.g - previous.g,
        metrics.b - previous.b,
      ];
      const channelMean = channelDeltas.reduce((sum, value) => sum + value, 0) / 3;
      const colourDelta = Math.sqrt(
        channelDeltas.reduce((sum, value) => sum + (value - channelMean) ** 2, 0) / 3,
      );
      const blackDelta = metrics.black - previous.black;
      const whiteDelta = metrics.white - previous.white;
      const parameter =
        colourDelta >= Math.max(4, Math.abs(metrics.luma - previous.luma) * 0.45)
          ? "RGB"
          : Math.abs(blackDelta) >= 3 &&
              Math.abs(blackDelta) > Math.abs(whiteDelta) * 1.45
            ? "Master Black"
            : "Iris / Gain";
      camera.pendingAdjustment = {
        id: `${camera.id}-${Date.now()}`,
        cameraId: camera.id,
        camera: camera.name,
        at: new Date().toISOString(),
        magnitude: Number(value.toFixed(2)),
        coherence: Number(delta.coherence.toFixed(2)),
        parameter,
        lumaDelta: Number((metrics.luma - previous.luma).toFixed(2)),
        colourDelta: Number(colourDelta.toFixed(2)),
        blackDelta: Number(blackDelta.toFixed(2)),
      };
    }
  } catch (error) {
    camera.online = false;
    camera.note = error.name === "AbortError" ? "Image feed timed out" : error.message;
  } finally {
    clearTimeout(timer);
  }
}

function monitorCyanView(host) {
  let retry;
  const connect = () => {
    const ws = new WebSocket(`ws://${host}/ws/dynstatus`);
    ws.onopen = () => { state.cyanView[host].online = true; };
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data));
        const cameras = payload.cameras || [];
        for (const cyanCamera of cameras) {
          const tallySignature = [
            cyanCamera["tally/red"],
            cyanCamera["tally/green"],
            cyanCamera["tally/call"],
          ].join(":");
          const tallyKey = `${host}:${cyanCamera.key}`;
          const previousTally = tallyByCyanCamera.get(tallyKey);
          if (previousTally !== undefined && previousTally !== tallySignature) {
            const monitored = state.cameras.find(
              (camera) => camera.name === cyanCamera.name.split(" - ")[0],
            );
            if (monitored) {
              // Tally is routing metadata, never a shading adjustment. Suppress
              // coincident image deltas while lamps/routes settle.
              tallySuppressedUntil.set(monitored.id, Date.now() + 2500);
            }
          }
          tallyByCyanCamera.set(tallyKey, tallySignature);
        }
        state.cyanView[host].cameras = cameras.map((camera) => ({
          name: camera.name,
          online: camera.control === "online",
          active: payload.monitors?.some((monitor) => monitor.active_camera === camera.key) || false,
        }));
        state.cyanView[host].fingerprint = cameras.map((camera) => `${camera.key}:${camera.name}`).join("|");
        const values = Object.values(state.cyanView);
        state.cyanView.duplicateConfiguration =
          Boolean(values[0]?.fingerprint) && values[0]?.fingerprint === values[1]?.fingerprint;
      } catch {}
    };
    ws.onclose = () => {
      state.cyanView[host].online = false;
      retry = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      state.cyanView[host].online = false;
      // onclose owns the reconnect timer. Calling close() from an error event
      // can recursively dispatch another error in Node's WebSocket runtime.
    };
  };
  connect();
  return () => clearTimeout(retry);
}

for (const host of ["192.168.206.225", "192.168.206.252"]) monitorCyanView(host);

async function poll() {
  while (true) {
    await Promise.all(state.cameras.map(sampleCamera));
    const candidates = state.cameras.filter((camera) => camera.pendingAdjustment);
    // Simultaneous jumps are normally lighting cues, cuts, or other common
    // production changes rather than independent shading operations.
    if (candidates.length === 1) {
      const camera = candidates[0];
      const event = camera.pendingAdjustment;
      camera.adjustments += 1;
      camera.lastAdjustmentAt = event.at;
      state.events.unshift(event);
      state.events = state.events.slice(0, 100);
    }
    for (const camera of state.cameras) delete camera.pendingAdjustment;
    state.updatedAt = new Date().toISOString();
    broadcast();
    await sleep(SAMPLE_MS);
  }
}
poll();

createServer((request, response) => {
  cors(response);
  if (request.url === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    response.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.url === "/state") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(state));
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Shading monitor listening on port ${PORT}`);
});
