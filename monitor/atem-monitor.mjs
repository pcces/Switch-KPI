import { Atem, Enums } from "atem-connection";
import PDFDocument from "pdfkit";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.MONITOR_PORT || 3001);
const DATA_DIR = resolve(process.env.SWITCH_KPI_DATA_DIR || "data");
const SHOWS_DIR = resolve(DATA_DIR, "shows");
const STORE_PATH = resolve(DATA_DIR, "current-show.json");
const RECOVERY_PATH = resolve(DATA_DIR, "recovery-state.json");
const SETTINGS_PATH = resolve(DATA_DIR, "settings.json");
const MAX_EVENT_HISTORY = 100_000;
const PCC_COGS_PATH = [
  resolve("public/pcc-cogs.png"),
  resolve("dist/standalone/dist/client/pcc-cogs.png"),
  resolve("dist/client/pcc-cogs.png"),
].find((path) => existsSync(path));
const PCC_COGS_BUFFER = PCC_COGS_PATH
  ? readFileSync(PCC_COGS_PATH)
  : null;
const PCC_COGS_DATA_URI = PCC_COGS_BUFFER
  ? `data:image/png;base64,${PCC_COGS_BUFFER.toString("base64")}`
  : "";
const REPORT_BRAND_TITLE = "SWITCH KPI by PCC - C-GEN SHOW REPORT.";
const AWARD_GUIDE = [
  ["⊤", "T Bar", "Awarded for every 10 ME1 mixes.", "gold"],
  [
    "D",
    "Diversity",
    "Five unique non-Black sources inside one 45-second round.",
    "cyan",
  ],
  [
    "½",
    "Half-Mix",
    "Hold a mix at 40–60% for at least two seconds.",
    "gold",
  ],
  [
    "Ⅱ",
    "Dual ME",
    "Cut on ME1 and ME2 within five seconds.",
    "purple",
  ],
  [
    "⚡",
    "Bum Cut",
    "An operator alert when another Program take lands within half a second.",
    "red",
  ],
  [
    "67",
    "6/7",
    "Cut or mix directly between sources numbered 6 and 7.",
    "cyan",
  ],
  ["N", "NIDA", "Use a wipe transition on either ME.", "red"],
  [
    "ℙ",
    "Prime Time",
    "Use three prime-numbered Program sources in a row.",
    "purple",
  ],
  [
    "φ",
    "Fibonacci",
    "Use 3, 4 or 5 distinct Fibonacci sources for Bronze, Silver or Gold.",
    "green",
  ],
  ["π", "Pi Time", "Use sources 3 → 1 → 4 → 1 → 5 in order.", "purple"],
  [
    "P↑",
    "Prime Ladder",
    "Use sources 2 → 3 → 5 → 7 in ascending prime order.",
    "cyan",
  ],
  [
    "G",
    "Golden Run",
    "Use sources 1 → 2 → 3 → 5 → 8 in Fibonacci order.",
    "gold",
  ],
  [
    "T",
    "Transition Tango",
    "Alternate CUT and MIX four times in either direction.",
    "purple",
  ],
  [
    "RF",
    "Rapid Fire",
    "Complete five Program takes on one ME inside five seconds.",
    "red",
  ],
  [
    "⌂",
    "Homecoming",
    "Leave a source, visit five different sources, then return home.",
    "cyan",
  ],
  [
    "♪",
    "N*Sync",
    "Make three consecutive shot lengths within 20% of each other.",
    "green",
  ],
];

mkdirSync(SHOWS_DIR, { recursive: true });

const savedSettings = (() => {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
})();
const INITIAL_ADDRESS =
  process.env.ATEM_ADDRESS || savedSettings.atemAddress || "192.168.206.99";
const atem = new Atem();
const clients = new Set();
const freshSequenceAwards = () => ({
  piTime: 0,
  primeLadder: 0,
  goldenRun: 0,
  transitionTango: 0,
  rapidFire: 0,
  homecoming: 0,
  nSync: 0,
});

const freshShow = () => ({
  id: null,
  name: "No show started",
  status: "idle",
  startedAt: null,
  pausedAt: null,
  stoppedAt: null,
});

const state = {
  connected: false,
  address: INITIAL_ADDRESS,
  updatedAt: new Date().toISOString(),
  show: freshShow(),
  program: null,
  preview: null,
  sources: new Map(),
  events: [],
  transitions: { cut: 0, mix: 0, other: 0 },
  previewChangesSinceTake: 0,
  wrongBusAlerts: 0,
  me2: {
    available: false,
    program: null,
    preview: null,
    sources: new Map(),
    events: [],
    transitions: { cut: 0, mix: 0, other: 0 },
  },
  special: {
    halfMixAwards: 0,
    halfMixDurations: [],
    dualMeAwards: 0,
    bumCuts: 0,
    bumCutEvents: [],
    sixSevenBonuses: 0,
    sixSevenEvents: [],
    nidaAwards: 0,
    nidaEvents: [],
    primeAwards: 0,
    primeEvents: [],
    fibonacciAwards: 0,
    fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
    fibonacciEvents: [],
    sequenceAwards: freshSequenceAwards(),
    sequenceEvents: [],
  },
  error: null,
};

let currentProgramId = null;
let programSince = Date.now();
let activeTransition = null;
let transitionStartedAt = null;
let lastTransitionEndedAt = 0;
let me2CurrentProgramId = null;
let me2ProgramSince = Date.now();
let me2ActiveTransition = null;
let me2TransitionStartedAt = null;
let me2LastTransitionEndedAt = 0;
const halfMixHold = {
  me1: { startedAt: null, awarded: false },
  me2: { startedAt: null, awarded: false },
};
const lastCutAt = { me1: 0, me2: 0 };
let lastDualMeAwardAt = 0;
const primeRun = { me1: [], me2: [] };
const fibonacciRun = { me1: [], me2: [] };
const fibonacciAwardedLevels = { me1: new Set(), me2: new Set() };
const freshSequenceRuntime = () => ({
  sourceIds: [],
  sourceNumbers: [],
  transitionTypes: [],
  takeTimes: [],
  shotDurations: [],
  previousTakeAt: null,
  cooldowns: {},
});
const sequenceRuntime = {
  me1: freshSequenceRuntime(),
  me2: freshSequenceRuntime(),
};

const safeName = (value) =>
  String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 80);

const inputName = (inputId, atemState = atem.state) => {
  const input = atemState?.inputs?.[inputId];
  return input?.longName || input?.shortName || `Input ${inputId}`;
};

const ensureSource = (inputId, atemState = atem.state) => {
  if (!state.sources.has(inputId)) {
    state.sources.set(inputId, {
      id: inputId,
      name: inputName(inputId, atemState),
      milliseconds: 0,
      uses: 0,
    });
  }
  const source = state.sources.get(inputId);
  source.name = inputName(inputId, atemState);
  return source;
};

const ensureMe2Source = (inputId, atemState = atem.state) => {
  if (!state.me2.sources.has(inputId)) {
    state.me2.sources.set(inputId, {
      id: inputId,
      name: inputName(inputId, atemState),
      milliseconds: 0,
      uses: 0,
    });
  }
  const source = state.me2.sources.get(inputId);
  source.name = inputName(inputId, atemState);
  return source;
};

const isRunning = () => state.show.status === "running";

const materializeAirtime = () => {
  const now = Date.now();
  if (isRunning() && currentProgramId !== null) {
    ensureSource(currentProgramId).milliseconds += Math.max(0, now - programSince);
  }
  if (isRunning() && me2CurrentProgramId !== null) {
    ensureMe2Source(me2CurrentProgramId).milliseconds += Math.max(
      0,
      now - me2ProgramSince,
    );
  }
  programSince = now;
  me2ProgramSince = now;
};

const serializableState = ({ live = true } = {}) => {
  const now = Date.now();
  return {
    version: 1,
    connected: state.connected,
    address: state.address,
    updatedAt: new Date().toISOString(),
    show: state.show,
    program: state.program,
    preview: state.preview,
    sources: [...state.sources.values()].map((source) => ({
      ...source,
      milliseconds:
        source.milliseconds +
        (isRunning() && source.id === currentProgramId
          ? Math.max(0, now - programSince)
          : 0),
      live: live && source.id === currentProgramId,
    })),
    events: state.events,
    transitions: state.transitions,
    previewChangesSinceTake: state.previewChangesSinceTake,
    wrongBusAlerts: state.wrongBusAlerts,
    me2: {
      available: state.me2.available,
      program: state.me2.program,
      preview: state.me2.preview,
      sources: [...state.me2.sources.values()].map((source) => ({
        ...source,
        milliseconds:
          source.milliseconds +
          (isRunning() && source.id === me2CurrentProgramId
            ? Math.max(0, now - me2ProgramSince)
            : 0),
        live: live && source.id === me2CurrentProgramId,
      })),
      events: state.me2.events,
      transitions: state.me2.transitions,
    },
    special: state.special,
    error: state.error,
  };
};

const atomicWrite = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
};

const persistSettings = () => {
  atomicWrite(SETTINGS_PATH, { atemAddress: state.address });
};

const persist = () => {
  materializeAirtime();
  atomicWrite(STORE_PATH, serializableState());
};

const archiveCurrentShow = () => {
  if (!state.show.id) return;
  atomicWrite(resolve(SHOWS_DIR, `${state.show.id}.json`), serializableState({ live: false }));
};

const loadStoredState = () => {
  const sourcePath = existsSync(STORE_PATH)
    ? STORE_PATH
    : existsSync(RECOVERY_PATH)
      ? RECOVERY_PATH
      : null;
  if (!sourcePath) return;

  try {
    const stored = JSON.parse(readFileSync(sourcePath, "utf8"));
    const recoveredShow = stored.show || {
      id: `recovered-${Date.now()}`,
      name: "Recovered live show",
      status: "running",
      startedAt: stored.startedAt || new Date().toISOString(),
      pausedAt: null,
      stoppedAt: null,
    };
    state.show = recoveredShow;
    state.program = stored.program || null;
    state.preview = stored.preview || null;
    state.sources = new Map(
      (stored.sources || []).map(({ live: _live, ...source }) => [source.id, source]),
    );
    state.events = stored.events || [];
    state.transitions = stored.transitions || { cut: 0, mix: 0, other: 0 };
    state.previewChangesSinceTake = stored.previewChangesSinceTake || 0;
    state.wrongBusAlerts = stored.wrongBusAlerts || 0;
    if (stored.me2) {
      state.me2.available = stored.me2.available || false;
      state.me2.program = stored.me2.program || null;
      state.me2.preview = stored.me2.preview || null;
      state.me2.sources = new Map(
        (stored.me2.sources || []).map(({ live: _live, ...source }) => [
          source.id,
          source,
        ]),
      );
      state.me2.events = stored.me2.events || [];
      state.me2.transitions =
        stored.me2.transitions || { cut: 0, mix: 0, other: 0 };
      me2CurrentProgramId = stored.me2.program?.id ?? null;
      me2ProgramSince = Date.now();
    }
    state.special = {
      halfMixAwards: 0,
      halfMixDurations: [],
      dualMeAwards: 0,
      bumCuts: 0,
      bumCutEvents: [],
      sixSevenBonuses: 0,
      sixSevenEvents: [],
      nidaAwards: 0,
      nidaEvents: [],
      primeAwards: 0,
      primeEvents: [],
      fibonacciAwards: 0,
      fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
      fibonacciEvents: [],
      sequenceAwards: freshSequenceAwards(),
      sequenceEvents: [],
      ...(stored.special || {}),
    };
    state.special.fibonacciTiers = {
      bronze: 0,
      silver: 0,
      gold: 0,
      ...(stored.special?.fibonacciTiers || {}),
    };
    state.special.sequenceAwards = {
      ...freshSequenceAwards(),
      ...(stored.special?.sequenceAwards || {}),
    };
    state.special.sequenceEvents = stored.special?.sequenceEvents || [];
    currentProgramId = stored.program?.id ?? null;
    programSince = Date.now();
    atomicWrite(STORE_PATH, serializableState());
  } catch (error) {
    state.error = `Saved show data could not be loaded: ${error.message}`;
  }
};

loadStoredState();

const broadcast = () => {
  state.updatedAt = new Date().toISOString();
  const payload = `data: ${JSON.stringify(serializableState())}\n\n`;
  for (const client of clients) client.write(payload);
};

const transitionLabel = (style) => {
  if (style === Enums.TransitionStyle.MIX) return "MIX";
  if (style == null) return "CUT";
  return "OTHER";
};

const registerCut = (me, at) => {
  const other = me === "me1" ? "me2" : "me1";
  const previousSameMeCut = lastCutAt[me];
  lastCutAt[me] = at;

  if (previousSameMeCut && at - previousSameMeCut < 500) {
    state.special.bumCuts += 1;
    state.special.bumCutEvents.unshift({
      id: `bum-${me}-${at}`,
      at: new Date(at).toISOString(),
      me: me.toUpperCase(),
      intervalMs: at - previousSameMeCut,
    });
    state.special.bumCutEvents = state.special.bumCutEvents.slice(0, 100);
  }

  if (
    lastCutAt[other] > lastDualMeAwardAt &&
    at - lastCutAt[other] <= 5000
  ) {
    state.special.dualMeAwards += 1;
    lastDualMeAwardAt = at;
  }
};

const displayedSourceNumber = (inputId, name) => {
  const match = String(name || "")
    .trim()
    .match(/(?:^|\s)(6|7)$/);
  if (match) return Number(match[1]);
  return inputId === 6 || inputId === 7 ? inputId : null;
};

const isSixSevenChange = (fromId, toId, fromName, toName) => {
  const fromNumber = displayedSourceNumber(fromId, fromName);
  const toNumber = displayedSourceNumber(toId, toName);
  return (
    (fromNumber === 6 && toNumber === 7) ||
    (fromNumber === 7 && toNumber === 6)
  );
};

const registerSixSeven = (
  me,
  fromId,
  toId,
  fromName,
  toName,
  type,
  at,
) => {
  if (!isSixSevenChange(fromId, toId, fromName, toName)) return;
  state.special.sixSevenBonuses += 1;
  state.special.sixSevenEvents.unshift({
    id: `67-${me}-${at}`,
    at: new Date(at).toISOString(),
    me: me.toUpperCase(),
    fromId,
    toId,
    fromName,
    toName,
    type,
  });
  state.special.sixSevenEvents = state.special.sixSevenEvents.slice(0, 100);
};

const reconcileSixSevenHistory = () => {
  const knownIds = new Set(
    state.special.sixSevenEvents.map((event) => event.id),
  );
  let recovered = 0;
  for (const [me, events] of [
    ["me1", state.events],
    ["me2", state.me2.events],
  ]) {
    for (const event of events) {
      const at = new Date(event.at).getTime();
      const id = `67-${me}-${at}`;
      if (
        knownIds.has(id) ||
        !isSixSevenChange(
          event.fromId,
          event.toId,
          event.from,
          event.to,
        )
      ) {
        continue;
      }
      state.special.sixSevenEvents.push({
        id,
        at: event.at,
        me: me.toUpperCase(),
        fromId: event.fromId ?? null,
        toId: event.toId ?? null,
        fromName: event.from,
        toName: event.to,
        type: event.type,
        recovered: true,
      });
      knownIds.add(id);
      recovered += 1;
    }
  }
  if (recovered > 0) {
    state.special.sixSevenBonuses += recovered;
    state.special.sixSevenEvents.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    state.special.sixSevenEvents =
      state.special.sixSevenEvents.slice(0, 100);
  }
};

reconcileSixSevenHistory();

const registerNida = (me, style, fromId, toId, at) => {
  if (style !== Enums.TransitionStyle.WIPE) return;
  state.special.nidaAwards += 1;
  state.special.nidaEvents.unshift({
    id: `nida-${me}-${at}`,
    at: new Date(at).toISOString(),
    me: me.toUpperCase(),
    fromId,
    toId,
  });
  state.special.nidaEvents = state.special.nidaEvents.slice(0, 100);
};

const isPrimeInput = (value) => {
  if (!Number.isInteger(value) || value < 2) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) {
    if (value % divisor === 0) return false;
  }
  return true;
};

const displayedPrimeNumber = (inputId, name) => {
  const match = String(name || "").match(/\b(\d+)\b/);
  return match ? Number(match[1]) : inputId;
};

const primeSourceNumber = (inputId, name) => {
  const number = displayedPrimeNumber(inputId, name);
  return isPrimeInput(number) ? number : null;
};

const storedMe1Prime = primeSourceNumber(
  currentProgramId,
  state.program?.name,
);
if (isRunning() && storedMe1Prime !== null) {
  primeRun.me1 = [storedMe1Prime];
}
const storedMe2Prime = primeSourceNumber(
  me2CurrentProgramId,
  state.me2.program?.name,
);
if (isRunning() && storedMe2Prime !== null) {
  primeRun.me2 = [storedMe2Prime];
}

const registerPrimeInput = (me, inputId, name, at) => {
  const primeNumber = primeSourceNumber(inputId, name);
  if (primeNumber === null) {
    primeRun[me] = [];
    return;
  }

  primeRun[me].push(primeNumber);
  if (primeRun[me].length < 3) return;

  const sequence = [...primeRun[me]];
  state.special.primeAwards += 1;
  state.special.primeEvents.unshift({
    id: `prime-${me}-${at}`,
    at: new Date(at).toISOString(),
    me: me.toUpperCase(),
    sequence,
  });
  state.special.primeEvents = state.special.primeEvents.slice(0, 100);
  primeRun[me] = [];
};

const isFibonacciNumber = (value) => {
  if (!Number.isInteger(value) || value < 1) return false;
  if (value === 1 || value === 2) return true;
  let previous = 1;
  let current = 2;
  while (current < value) {
    [previous, current] = [current, previous + current];
  }
  return current === value;
};

const fibonacciSourceNumber = (inputId, name) => {
  const number = displayedPrimeNumber(inputId, name);
  return isFibonacciNumber(number) ? number : null;
};

const storedMe1Fibonacci = fibonacciSourceNumber(
  currentProgramId,
  state.program?.name,
);
if (isRunning() && storedMe1Fibonacci !== null) {
  fibonacciRun.me1 = [storedMe1Fibonacci];
}
const storedMe2Fibonacci = fibonacciSourceNumber(
  me2CurrentProgramId,
  state.me2.program?.name,
);
if (isRunning() && storedMe2Fibonacci !== null) {
  fibonacciRun.me2 = [storedMe2Fibonacci];
}

const registerFibonacciInput = (me, inputId, name, at) => {
  const fibonacciNumber = fibonacciSourceNumber(inputId, name);
  if (fibonacciNumber === null) {
    fibonacciRun[me] = [];
    fibonacciAwardedLevels[me].clear();
    return;
  }

  fibonacciRun[me].push(fibonacciNumber);
  fibonacciRun[me] = fibonacciRun[me].slice(-12);
  const uniqueSources = new Set(fibonacciRun[me]).size;
  const level =
    uniqueSources >= 5 ? 3 : uniqueSources >= 4 ? 2 : uniqueSources >= 3 ? 1 : 0;
  if (level === 0 || fibonacciAwardedLevels[me].has(level)) return;

  const tier = level === 3 ? "gold" : level === 2 ? "silver" : "bronze";
  fibonacciAwardedLevels[me].add(level);
  state.special.fibonacciAwards += 1;
  state.special.fibonacciTiers ??= { bronze: 0, silver: 0, gold: 0 };
  state.special.fibonacciTiers[tier] += 1;
  state.special.fibonacciEvents.unshift({
    id: `fibonacci-${me}-${level}-${at}`,
    at: new Date(at).toISOString(),
    me: me.toUpperCase(),
    level,
    tier,
    uniqueSources,
    sequence: [...fibonacciRun[me]],
  });
  state.special.fibonacciEvents =
    state.special.fibonacciEvents.slice(0, 100);
};

const sequenceLabels = {
  piTime: "PI TIME",
  primeLadder: "PRIME LADDER",
  goldenRun: "GOLDEN RUN",
  transitionTango: "TRANSITION TANGO",
  rapidFire: "RAPID FIRE",
  homecoming: "HOMECOMING",
  nSync: "N*SYNC",
};

const registerDirectorSequence = (me, event) => {
  const runtime = sequenceRuntime[me];
  const at = new Date(event.at).getTime();
  const sourceNumber = displayedPrimeNumber(event.toId, event.to);
  const award = (key, detail, sequence, cooldownMs = 0) => {
    if (cooldownMs && at - (runtime.cooldowns[key] || 0) < cooldownMs) return;
    runtime.cooldowns[key] = at;
    state.special.sequenceAwards ??= freshSequenceAwards();
    state.special.sequenceEvents ??= [];
    state.special.sequenceAwards[key] += 1;
    state.special.sequenceEvents.unshift({
      id: `sequence-${key}-${me}-${at}`,
      at: event.at,
      me: me.toUpperCase(),
      key,
      label: sequenceLabels[key],
      detail,
      sequence,
    });
    state.special.sequenceEvents = state.special.sequenceEvents.slice(0, 200);
  };
  const tailMatches = (values, pattern) =>
    values.length >= pattern.length &&
    pattern.every(
      (value, index) => values[values.length - pattern.length + index] === value,
    );

  if (runtime.previousTakeAt !== null) {
    runtime.shotDurations.push(Math.max(0, at - runtime.previousTakeAt));
    runtime.shotDurations = runtime.shotDurations.slice(-8);
  }
  runtime.previousTakeAt = at;
  runtime.sourceIds.push(event.toId);
  runtime.sourceIds = runtime.sourceIds.slice(-12);
  runtime.sourceNumbers.push(sourceNumber);
  runtime.sourceNumbers = runtime.sourceNumbers.slice(-12);
  runtime.transitionTypes.push(event.type);
  runtime.transitionTypes = runtime.transitionTypes.slice(-8);
  runtime.takeTimes.push(at);
  runtime.takeTimes = runtime.takeTimes.slice(-8);

  if (tailMatches(runtime.sourceNumbers, [3, 1, 4, 1, 5])) {
    award("piTime", "3 → 1 → 4 → 1 → 5", [3, 1, 4, 1, 5]);
  }
  if (tailMatches(runtime.sourceNumbers, [2, 3, 5, 7])) {
    award("primeLadder", "2 → 3 → 5 → 7", [2, 3, 5, 7]);
  }
  if (tailMatches(runtime.sourceNumbers, [1, 2, 3, 5, 8])) {
    award("goldenRun", "1 → 2 → 3 → 5 → 8", [1, 2, 3, 5, 8]);
  }
  if (
    tailMatches(runtime.transitionTypes, ["CUT", "MIX", "CUT", "MIX"]) ||
    tailMatches(runtime.transitionTypes, ["MIX", "CUT", "MIX", "CUT"])
  ) {
    award(
      "transitionTango",
      "CUT and MIX alternating four times",
      runtime.transitionTypes.slice(-4),
      5_000,
    );
  }
  const rapidTimes = runtime.takeTimes.slice(-5);
  if (
    rapidTimes.length === 5 &&
    rapidTimes[rapidTimes.length - 1] - rapidTimes[0] <= 5_000
  ) {
    award(
      "rapidFire",
      "Five takes inside five seconds",
      runtime.sourceNumbers.slice(-5),
      10_000,
    );
  }
  const homecomingIds = runtime.sourceIds.slice(-7);
  if (
    homecomingIds.length === 7 &&
    homecomingIds[0] === homecomingIds[6] &&
    !homecomingIds.slice(1, 6).includes(homecomingIds[0]) &&
    new Set(homecomingIds.slice(1, 6)).size === 5
  ) {
    award(
      "homecoming",
      "Returned home after five different sources",
      runtime.sourceNumbers.slice(-7),
    );
  }
  const rhythm = runtime.shotDurations.slice(-3);
  if (
    rhythm.length === 3 &&
    rhythm.every((duration) => duration >= 1_000 && duration <= 120_000) &&
    Math.max(...rhythm) <= Math.min(...rhythm) * 1.2
  ) {
    award(
      "nSync",
      "Three shot lengths within 20%",
      rhythm.map((duration) => Math.round(duration)),
      20_000,
    );
  }
};

const finalizeHalfMix = (me, at = Date.now()) => {
  const hold = halfMixHold[me];
  if (hold.startedAt === null) return;
  const durationMs = Math.max(0, at - hold.startedAt);
  if (durationMs >= 2000) {
    if (!hold.awarded) state.special.halfMixAwards += 1;
    state.special.halfMixDurations.push({
      id: `half-${me}-${hold.startedAt}`,
      at: new Date(hold.startedAt).toISOString(),
      me: me.toUpperCase(),
      durationMs,
    });
    state.special.halfMixDurations.sort(
      (a, b) => b.durationMs - a.durationMs,
    );
    state.special.halfMixDurations = state.special.halfMixDurations.slice(0, 50);
    persist();
    broadcast();
  }
  hold.startedAt = null;
  hold.awarded = false;
};

const updateHalfMix = (me, mixEffect) => {
  const hold = halfMixHold[me];
  const isHalfMix =
    isRunning() &&
    mixEffect.transitionPosition.inTransition &&
    mixEffect.transitionProperties.style === Enums.TransitionStyle.MIX &&
    mixEffect.transitionPosition.handlePosition >= 4000 &&
    mixEffect.transitionPosition.handlePosition <= 6000;

  if (isHalfMix && hold.startedAt === null) {
    hold.startedAt = Date.now();
    hold.awarded = false;
    const startedAt = hold.startedAt;
    setTimeout(() => {
      if (hold.startedAt === startedAt && !hold.awarded && isRunning()) {
        hold.awarded = true;
        state.special.halfMixAwards += 1;
        persist();
        broadcast();
      }
    }, 2000);
  } else if (!isHalfMix && hold.startedAt !== null) {
    finalizeHalfMix(me);
  }
};

const handleProgramChange = (nextId, atemState) => {
  if (currentProgramId === null) {
    currentProgramId = nextId;
    programSince = Date.now();
    const source = ensureSource(nextId, atemState);
    if (isRunning()) {
      source.uses += 1;
      registerPrimeInput("me1", nextId, source.name, Date.now());
      registerFibonacciInput("me1", nextId, source.name, Date.now());
    }
    state.program = { id: nextId, name: source.name };
    persist();
    broadcast();
    return;
  }
  if (nextId === currentProgramId) return;

  const now = Date.now();
  state.previewChangesSinceTake = 0;
  const previous = ensureSource(currentProgramId, atemState);
  if (isRunning()) previous.milliseconds += Math.max(0, now - programSince);
  const next = ensureSource(nextId, atemState);

  if (isRunning()) {
    next.uses += 1;
    const transitionWasActive =
      activeTransition !== null || now - lastTransitionEndedAt < 750;
    const type = transitionWasActive ? transitionLabel(activeTransition) : "CUT";
    const durationMs =
      transitionStartedAt === null
        ? undefined
        : Math.max(0, now - transitionStartedAt);

    if (type === "MIX") state.transitions.mix += 1;
    else if (type === "CUT") {
      state.transitions.cut += 1;
      registerCut("me1", now);
    }
    else state.transitions.other += 1;
    registerSixSeven(
      "me1",
      currentProgramId,
      nextId,
      previous.name,
      next.name,
      type,
      now,
    );
    registerNida("me1", activeTransition, currentProgramId, nextId, now);
    registerPrimeInput("me1", nextId, next.name, now);
    registerFibonacciInput("me1", nextId, next.name, now);

    const eventRecord = {
      id: `${now}-${nextId}`,
      at: new Date(now).toISOString(),
      from: previous.name,
      to: next.name,
      fromId: currentProgramId,
      toId: nextId,
      type,
      durationMs,
    };
    state.events.unshift(eventRecord);
    state.events = state.events.slice(0, MAX_EVENT_HISTORY);
    registerDirectorSequence("me1", eventRecord);
  }

  currentProgramId = nextId;
  programSince = now;
  state.program = { id: nextId, name: next.name };
  persist();
  broadcast();
};

const handleMe2ProgramChange = (nextId, atemState) => {
  state.me2.available = true;
  if (me2CurrentProgramId === null) {
    me2CurrentProgramId = nextId;
    me2ProgramSince = Date.now();
    const source = ensureMe2Source(nextId, atemState);
    if (isRunning()) {
      source.uses += 1;
      registerPrimeInput("me2", nextId, source.name, Date.now());
      registerFibonacciInput("me2", nextId, source.name, Date.now());
    }
    state.me2.program = { id: nextId, name: source.name };
    persist();
    broadcast();
    return;
  }
  if (nextId === me2CurrentProgramId) return;

  const now = Date.now();
  const previous = ensureMe2Source(me2CurrentProgramId, atemState);
  if (isRunning()) {
    previous.milliseconds += Math.max(0, now - me2ProgramSince);
  }
  const next = ensureMe2Source(nextId, atemState);

  if (isRunning()) {
    next.uses += 1;
    const transitionWasActive =
      me2ActiveTransition !== null || now - me2LastTransitionEndedAt < 750;
    const type = transitionWasActive
      ? transitionLabel(me2ActiveTransition)
      : "CUT";
    const durationMs =
      me2TransitionStartedAt === null
        ? undefined
        : Math.max(0, now - me2TransitionStartedAt);

    if (type === "MIX") state.me2.transitions.mix += 1;
    else if (type === "CUT") {
      state.me2.transitions.cut += 1;
      registerCut("me2", now);
    }
    else state.me2.transitions.other += 1;
    registerSixSeven(
      "me2",
      me2CurrentProgramId,
      nextId,
      previous.name,
      next.name,
      type,
      now,
    );
    registerNida(
      "me2",
      me2ActiveTransition,
      me2CurrentProgramId,
      nextId,
      now,
    );
    registerPrimeInput("me2", nextId, next.name, now);
    registerFibonacciInput("me2", nextId, next.name, now);

    const eventRecord = {
      id: `me2-${now}-${nextId}`,
      at: new Date(now).toISOString(),
      from: previous.name,
      to: next.name,
      fromId: me2CurrentProgramId,
      toId: nextId,
      type,
      durationMs,
    };
    state.me2.events.unshift(eventRecord);
    state.me2.events = state.me2.events.slice(0, MAX_EVENT_HISTORY);
    registerDirectorSequence("me2", eventRecord);
  }

  me2CurrentProgramId = nextId;
  me2ProgramSince = now;
  state.me2.program = { id: nextId, name: next.name };
  persist();
  broadcast();
};

const startShow = (requestedName) => {
  if (state.show.status === "paused") {
    state.show.status = "running";
    state.show.pausedAt = null;
    programSince = Date.now();
    if (currentProgramId !== null) ensureSource(currentProgramId).uses += 1;
    me2ProgramSince = Date.now();
    if (me2CurrentProgramId !== null) ensureMe2Source(me2CurrentProgramId).uses += 1;
    persist();
    broadcast();
    return;
  }

  if (state.show.status === "running") return;
  const now = new Date();
  state.show = {
    id: now.toISOString().replace(/[:.]/g, "-"),
    name:
      safeName(requestedName) ||
      `Show ${new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(now)}`,
    status: "running",
    startedAt: now.toISOString(),
    pausedAt: null,
    stoppedAt: null,
  };
  state.sources = new Map();
  state.events = [];
  state.transitions = { cut: 0, mix: 0, other: 0 };
  state.me2.sources = new Map();
  state.me2.events = [];
  state.me2.transitions = { cut: 0, mix: 0, other: 0 };
  state.special = {
    halfMixAwards: 0,
    halfMixDurations: [],
    dualMeAwards: 0,
    bumCuts: 0,
    bumCutEvents: [],
    sixSevenBonuses: 0,
    sixSevenEvents: [],
    nidaAwards: 0,
    nidaEvents: [],
    primeAwards: 0,
    primeEvents: [],
    fibonacciAwards: 0,
    fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
    fibonacciEvents: [],
    sequenceAwards: freshSequenceAwards(),
    sequenceEvents: [],
  };
  halfMixHold.me1 = { startedAt: null, awarded: false };
  halfMixHold.me2 = { startedAt: null, awarded: false };
  lastCutAt.me1 = 0;
  lastCutAt.me2 = 0;
  lastDualMeAwardAt = 0;
  primeRun.me1 = [];
  primeRun.me2 = [];
  fibonacciRun.me1 = [];
  fibonacciRun.me2 = [];
  fibonacciAwardedLevels.me1.clear();
  fibonacciAwardedLevels.me2.clear();
  sequenceRuntime.me1 = freshSequenceRuntime();
  sequenceRuntime.me2 = freshSequenceRuntime();
  programSince = Date.now();
  me2ProgramSince = Date.now();
  if (currentProgramId !== null) {
    const source = ensureSource(currentProgramId);
    source.uses = 1;
    state.program = { id: currentProgramId, name: source.name };
    const primeNumber = primeSourceNumber(currentProgramId, source.name);
    if (primeNumber !== null) primeRun.me1 = [primeNumber];
    const fibonacciNumber = fibonacciSourceNumber(currentProgramId, source.name);
    if (fibonacciNumber !== null) fibonacciRun.me1 = [fibonacciNumber];
  }
  if (me2CurrentProgramId !== null) {
    const source = ensureMe2Source(me2CurrentProgramId);
    source.uses = 1;
    state.me2.program = { id: me2CurrentProgramId, name: source.name };
    const primeNumber = primeSourceNumber(me2CurrentProgramId, source.name);
    if (primeNumber !== null) {
      primeRun.me2 = [primeNumber];
    }
    const fibonacciNumber = fibonacciSourceNumber(
      me2CurrentProgramId,
      source.name,
    );
    if (fibonacciNumber !== null) {
      fibonacciRun.me2 = [fibonacciNumber];
    }
  }
  persist();
  broadcast();
};

const pauseShow = () => {
  if (!isRunning()) return;
  finalizeHalfMix("me1");
  finalizeHalfMix("me2");
  materializeAirtime();
  state.show.status = "paused";
  state.show.pausedAt = new Date().toISOString();
  persist();
  broadcast();
};

const stopShow = () => {
  if (!["running", "paused"].includes(state.show.status)) return;
  if (isRunning()) {
    finalizeHalfMix("me1");
    finalizeHalfMix("me2");
  }
  materializeAirtime();
  state.show.status = "stopped";
  state.show.pausedAt = null;
  state.show.stoppedAt = new Date().toISOString();
  persist();
  archiveCurrentShow();
  broadcast();
};

atem.on("connected", () => {
  state.connected = true;
  state.error = null;
  const me1 = atem.state?.video?.mixEffects?.[0];
  if (me1) {
    handleProgramChange(me1.programInput, atem.state);
    state.preview = {
      id: me1.previewInput,
      name: inputName(me1.previewInput, atem.state),
    };
  }
  const me2 = atem.state?.video?.mixEffects?.[1];
  state.me2.available = Boolean(me2);
  if (me2) {
    handleMe2ProgramChange(me2.programInput, atem.state);
    state.me2.preview = {
      id: me2.previewInput,
      name: inputName(me2.previewInput, atem.state),
    };
  }
  persist();
  broadcast();
});

atem.on("disconnected", () => {
  state.connected = false;
  state.error = `Connection to the ATEM at ${state.address} was lost. Retrying automatically.`;
  persist();
  broadcast();
});

atem.on("error", (error) => {
  state.error = error?.message || String(error);
  broadcast();
});

atem.on("stateChanged", (atemState, paths) => {
  const changed = Array.isArray(paths) ? paths : [paths];
  const me1 = atemState.video?.mixEffects?.[0];
  if (!me1) return;
  const me2 = atemState.video?.mixEffects?.[1];

  if (changed.some((path) => path?.includes("video.mixEffects.0.transitionPosition"))) {
    updateHalfMix("me1", me1);
    if (me1.transitionPosition.inTransition) {
      if (activeTransition === null) {
        transitionStartedAt = Date.now();
        activeTransition = me1.transitionProperties.style;
      }
    } else if (activeTransition !== null) {
      lastTransitionEndedAt = Date.now();
      setTimeout(() => {
        if (Date.now() - lastTransitionEndedAt >= 700) {
          activeTransition = null;
          transitionStartedAt = null;
        }
      }, 750);
    }
  }

  if (changed.some((path) => path?.includes("video.mixEffects.0.programInput"))) {
    handleProgramChange(me1.programInput, atemState);
  }

  if (changed.some((path) => path?.includes("video.mixEffects.0.previewInput"))) {
    const previewChanged = state.preview?.id !== me1.previewInput;
    state.preview = {
      id: me1.previewInput,
      name: inputName(me1.previewInput, atemState),
    };
    if (isRunning() && previewChanged) {
      state.previewChangesSinceTake += 1;
      if (state.previewChangesSinceTake === 4) state.wrongBusAlerts += 1;
      persist();
    }
    broadcast();
  }

  if (changed.some((path) => path?.startsWith("inputs."))) {
    for (const source of state.sources.values()) {
      source.name = inputName(source.id, atemState);
    }
    if (state.program) state.program.name = inputName(state.program.id, atemState);
    if (state.preview) state.preview.name = inputName(state.preview.id, atemState);
    for (const source of state.me2.sources.values()) {
      source.name = inputName(source.id, atemState);
    }
    if (state.me2.program) {
      state.me2.program.name = inputName(state.me2.program.id, atemState);
    }
    if (state.me2.preview) {
      state.me2.preview.name = inputName(state.me2.preview.id, atemState);
    }
    persist();
    broadcast();
  }

  if (me2) {
    state.me2.available = true;
    if (
      changed.some((path) =>
        path?.includes("video.mixEffects.1.transitionPosition"),
      )
    ) {
      updateHalfMix("me2", me2);
      if (me2.transitionPosition.inTransition) {
        if (me2ActiveTransition === null) {
          me2TransitionStartedAt = Date.now();
          me2ActiveTransition = me2.transitionProperties.style;
        }
      } else if (me2ActiveTransition !== null) {
        me2LastTransitionEndedAt = Date.now();
        setTimeout(() => {
          if (Date.now() - me2LastTransitionEndedAt >= 700) {
            me2ActiveTransition = null;
            me2TransitionStartedAt = null;
          }
        }, 750);
      }
    }

    if (
      changed.some((path) =>
        path?.includes("video.mixEffects.1.programInput"),
      )
    ) {
      handleMe2ProgramChange(me2.programInput, atemState);
    }

    if (
      changed.some((path) =>
        path?.includes("video.mixEffects.1.previewInput"),
      )
    ) {
      state.me2.preview = {
        id: me2.previewInput,
        name: inputName(me2.previewInput, atemState),
      };
      broadcast();
    }
  }
});

const readBody = (request) =>
  new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });

const validAtemAddress = (value) => {
  const parts = String(value || "").trim().split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^\d{1,3}$/.test(part) &&
        Number(part) >= 0 &&
        Number(part) <= 255,
    )
  );
};

const reconnectAtem = async (address) => {
  materializeAirtime();
  state.address = address;
  state.connected = false;
  state.error = null;
  persistSettings();
  persist();
  broadcast();
  try {
    await atem.disconnect();
  } catch {
    // The ATEM may already be disconnected; reconnecting is still safe.
  }
  void atem.connect(state.address).catch((error) => {
    state.connected = false;
    state.error = `Could not connect to the ATEM at ${state.address}: ${error.message}`;
    persist();
    broadcast();
  });
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatDuration = (milliseconds) => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
};

const reportData = (showId) => {
  if (!showId || showId === state.show.id) return serializableState({ live: false });
  const normalizedId = String(showId);
  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedId)) return null;
  const path = resolve(SHOWS_DIR, `${normalizedId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Could not read saved report ${normalizedId}:`, error.message);
    return null;
  }
};

const diversityRoundStats = (report) => {
  const startedAt = report.show?.startedAt
    ? new Date(report.show.startedAt).getTime()
    : Date.now();
  const endedAt = report.show?.stoppedAt
    ? new Date(report.show.stoppedAt).getTime()
    : report.updatedAt
      ? new Date(report.updatedAt).getTime()
      : Date.now();
  const roundLength = 45 * 1000;
  const currentRound = Math.max(0, Math.floor((endedAt - startedAt) / roundLength));
  const rounds = new Map();
  const add = (round, sourceName) => {
    const name = String(sourceName || "").trim();
    if (!name || name.toLowerCase() === "black") return;
    if (!rounds.has(round)) rounds.set(round, new Set());
    rounds.get(round).add(name);
  };
  let lastSource = null;
  let lastRound = 0;
  for (const event of [...report.events].reverse()) {
    const round = Math.max(
      0,
      Math.floor((new Date(event.at).getTime() - startedAt) / roundLength),
    );
    if (lastSource && round > lastRound) {
      for (let index = lastRound + 1; index <= round; index += 1) add(index, lastSource);
    }
    add(round, event.from);
    add(round, event.to);
    lastSource = event.to;
    lastRound = round;
  }
  if (lastSource && currentRound > lastRound) {
    for (let index = lastRound + 1; index <= currentRound; index += 1) {
      add(index, lastSource);
    }
  }
  if (report.program) add(currentRound, report.program.name);
  const points = (count) =>
    count * 100 +
    (count >= 5 ? 250 : 0) +
    (count >= 8 ? 500 : 0) +
    (count >= 10 ? 750 : 0) +
    (count >= 12 ? 1000 : 0);
  const counts = [...rounds.values()].map((sources) => sources.size);
  return {
    totalPoints: counts.reduce((sum, count) => sum + points(count), 0),
    bestCount: Math.max(0, ...counts),
    awards: counts.filter((count) => count >= 5).length,
    rounds: counts.length,
  };
};

const reportHtml = (report, { theme = "dark", showId = "" } = {}) => {
  report.sources = Array.isArray(report.sources) ? report.sources : [];
  report.events = Array.isArray(report.events) ? report.events : [];
  report.transitions = {
    cut: 0,
    mix: 0,
    other: 0,
    ...(report.transitions || {}),
  };
  const darkTheme = theme !== "light";
  const resolvedShowId = String(showId || report.show?.id || "");
  const encodedShowId = encodeURIComponent(resolvedShowId);
  const reportQuery = encodedShowId ? `show=${encodedShowId}&` : "";
  const darkHref = `/report?${reportQuery}theme=dark`;
  const lightHref = `/report?${reportQuery}theme=light`;
  const pdfHref = `/report.pdf${encodedShowId ? `?show=${encodedShowId}` : ""}`;
  const csvHref = `/report.csv${encodedShowId ? `?show=${encodedShowId}` : ""}`;
  const blackSource = report.sources.find(
    (source) =>
      source.id === 0 || source.name.trim().toLowerCase() === "black",
  );
  const activeSources = report.sources.filter(
    (source) =>
      source.id !== 0 && source.name.trim().toLowerCase() !== "black",
  );
  const diversity = diversityRoundStats(report);
  const sortedSources = [...activeSources].sort(
    (a, b) => b.milliseconds - a.milliseconds,
  );
  const totalAirtime = Math.max(
    1,
    activeSources.reduce((sum, source) => sum + source.milliseconds, 0),
  );
  const blackTime = blackSource?.milliseconds || 0;
  const totalProgramTime = Math.max(1, totalAirtime + blackTime);
  const totalTakes =
    report.transitions.cut +
    report.transitions.mix +
    report.transitions.other;
  const startedAt = report.show?.startedAt
    ? new Date(report.show.startedAt).getTime()
    : Date.now();
  const endedAt = report.show?.stoppedAt
    ? new Date(report.show.stoppedAt).getTime()
    : report.updatedAt
      ? new Date(report.updatedAt).getTime()
      : Date.now();
  const showDuration = Math.max(1, endedAt - startedAt);
  const takeRate = totalTakes / Math.max(1 / 60, showDuration / 60_000);
  const cutRate =
    report.transitions.cut / Math.max(1 / 60, showDuration / 60_000);
  const activeUses = activeSources.reduce((sum, source) => sum + source.uses, 0);
  const averageShot = totalAirtime / Math.max(1, activeUses);
  const cutPercent = totalTakes
    ? (report.transitions.cut / totalTakes) * 100
    : 0;
  const mixPercent = totalTakes
    ? (report.transitions.mix / totalTakes) * 100
    : 0;
  const longestStreak = (type) => {
    let best = 0;
    let run = 0;
    for (const event of [...report.events].reverse()) {
      run = event.type === type ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  };
  const sourceRows = sortedSources
    .map(
      (source) => `<tr>
        <td>${escapeHtml(source.name)}</td>
        <td>${((source.milliseconds / totalAirtime) * 100).toFixed(1)}%</td>
        <td>${formatDuration(source.milliseconds)}</td>
        <td>${source.uses}</td>
      </tr>`,
    )
    .join("");
  const sourceBars = sortedSources
    .slice(0, 12)
    .map((source, index) => {
      const percentage = (source.milliseconds / totalAirtime) * 100;
      return `<div class="source-bar-row">
        <span>${index + 1}. ${escapeHtml(source.name)}</span>
        <div><i style="width:${Math.max(1, percentage).toFixed(1)}%"></i></div>
        <b>${percentage.toFixed(1)}%</b>
      </div>`;
    })
    .join("");
  const bucketCount = Math.max(
    1,
    Math.min(60, Math.ceil(showDuration / 60_000)),
  );
  const bucketSize = showDuration / bucketCount;
  const bucketDurationLabel = formatDuration(bucketSize).replace(/^0h 0?/, "");
  const untimedTakeCount = Math.max(0, totalTakes - report.events.length);
  const activity = Array.from({ length: bucketCount }, () => 0);
  for (const event of report.events) {
    const index = Math.min(
      bucketCount - 1,
      Math.max(
        0,
        Math.floor((new Date(event.at).getTime() - startedAt) / bucketSize),
      ),
    );
    activity[index] += 1;
  }
  const peakActivity = Math.max(1, ...activity);
  const activityBars = activity
    .map(
      (count, index) =>
        `<i style="height:${Math.max(2, (count / peakActivity) * 100).toFixed(1)}%" title="Period ${index + 1}: ${count} takes"><span>${count}</span></i>`,
    )
    .join("");
  const activityAxisLabels = [0, 0.25, 0.5, 0.75, 1]
    .map((position) => {
      const time = new Date(startedAt + showDuration * position);
      return `<span>${time.toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
      })}</span>`;
    })
    .join("");
  const me2 = {
    available: false,
    sources: [],
    events: [],
    transitions: { cut: 0, mix: 0, other: 0 },
    ...(report.me2 || {}),
    transitions: {
      cut: 0,
      mix: 0,
      other: 0,
      ...(report.me2?.transitions || {}),
    },
  };
  const me2Sources = [...me2.sources]
    .filter(
      (source) =>
        source.id !== 0 && source.name.trim().toLowerCase() !== "black",
    )
    .sort((a, b) => b.milliseconds - a.milliseconds);
  const me2TotalAirtime = Math.max(
    1,
    me2Sources.reduce((sum, source) => sum + source.milliseconds, 0),
  );
  const me2Takes =
    me2.transitions.cut + me2.transitions.mix + me2.transitions.other;
  const reportStartedAt = report.show?.startedAt
    ? new Date(report.show.startedAt).getTime()
    : Date.now();
  const reportEndedAt = report.show?.stoppedAt
    ? new Date(report.show.stoppedAt).getTime()
    : report.updatedAt
      ? new Date(report.updatedAt).getTime()
      : Date.now();
  const reportMinutes = Math.max(
    1 / 60,
    (reportEndedAt - reportStartedAt) / 60_000,
  );
  const reportTakes =
    report.transitions.cut +
    report.transitions.mix +
    report.transitions.other;
  const me2SourceBars = me2Sources
    .slice(0, 10)
    .map((source, index) => {
      const percentage = (source.milliseconds / me2TotalAirtime) * 100;
      return `<div class="source-bar-row">
        <span>${index + 1}. ${escapeHtml(source.name)}</span>
        <div><i style="width:${Math.max(1, percentage).toFixed(1)}%"></i></div>
        <b>${percentage.toFixed(1)}%</b>
      </div>`;
    })
    .join("");
  const me2Section = me2.available
    ? `<section class="report-grid">
      <article class="panel"><div class="panel-head"><h2>ME2 Performance</h2><span>Second Mix Effects</span></div><div class="facts">
        <div class="fact"><span>ME2 Takes</span><b>${me2Takes}</b></div>
        <div class="fact"><span>ME2 Cuts</span><b>${me2.transitions.cut}</b></div>
        <div class="fact"><span>ME2 Mixes</span><b>${me2.transitions.mix}</b></div>
        <div class="fact"><span>ME2 Sources</span><b>${me2Sources.length}</b></div>
        <div class="fact"><span>Second Deck Awards</span><b>${Math.floor(me2Takes / 10)}</b></div>
        <div class="fact"><span>ME2 Mix Awards</span><b>${Math.floor(me2.transitions.mix / 5)}</b></div>
      </div></article>
      <article class="panel"><div class="panel-head"><h2>ME2 Source Share</h2><span>Black Excluded</span></div><div class="source-bars">${me2SourceBars || "<small>No ME2 source airtime recorded.</small>"}</div></article>
    </section>`
    : "";
  const special = report.special || {
    halfMixAwards: 0,
    halfMixDurations: [],
    dualMeAwards: 0,
    bumCuts: 0,
    bumCutEvents: [],
    sixSevenBonuses: 0,
    sixSevenEvents: [],
    nidaAwards: 0,
    nidaEvents: [],
    primeAwards: 0,
    primeEvents: [],
    fibonacciAwards: 0,
    fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
    fibonacciEvents: [],
    sequenceAwards: freshSequenceAwards(),
    sequenceEvents: [],
  };
  special.fibonacciTiers = {
    bronze: 0,
    silver: 0,
    gold: 0,
    ...(special.fibonacciTiers || {}),
  };
  special.sequenceAwards = {
    ...freshSequenceAwards(),
    ...(special.sequenceAwards || {}),
  };
  special.sequenceEvents ||= [];
  const halfMixRows = special.halfMixDurations
    .slice(0, 10)
    .map(
      (hold, index) => `<tr>
        <td>${index + 1}</td>
        <td>${hold.me}</td>
        <td>${(hold.durationMs / 1000).toFixed(2)}s</td>
        <td>${new Date(hold.at).toLocaleTimeString("en-AU")}</td>
      </tr>`,
    )
    .join("");
  const specialSection = `<section class="report-grid">
    <article class="panel"><div class="panel-head"><h2>Precision Awards</h2><span>ME1 + ME2</span></div><div class="awards">
      <div class="award"><b>${special.halfMixAwards}</b><span>Long Half-Mix</span></div>
      <div class="award purple"><b>${special.dualMeAwards}</b><span>Dual ME</span></div>
      <div class="award red"><b>${special.bumCuts}</b><span>Bum Cuts</span></div>
      <div class="award"><b>${special.sixSevenBonuses || 0}</b><span>6/7 Awards</span></div>
      <div class="award purple"><b>${special.nidaAwards || 0}</b><span>NIDA Wipes</span></div>
      <div class="award"><b>${special.primeAwards || 0}</b><span>Prime Time</span></div>
      <div class="award purple"><b>${special.fibonacciAwards || 0}</b><span>Fibonacci · B${special.fibonacciTiers.bronze} S${special.fibonacciTiers.silver} G${special.fibonacciTiers.gold}</span></div>
    </div></article>
    <article class="panel"><div class="panel-head"><h2>Top Half-Mix Holds</h2><span>40–60% Position</span></div>
      ${halfMixRows ? `<table><thead><tr><th>Rank</th><th>ME</th><th>Duration</th><th>Time</th></tr></thead><tbody>${halfMixRows}</tbody></table>` : "<small>No qualifying half-mix holds recorded.</small>"}
    </article>
  </section>`;
  const awardGallery = [
    ["⊤", "T Bar", Math.floor(report.transitions.mix / 10), "gold"],
    ["D", "Diversity", diversity.awards, "cyan"],
    ["½", "Half-Mix", special.halfMixAwards, "gold"],
    ["Ⅱ", "Dual ME", special.dualMeAwards, "purple"],
    ["67", "6/7", special.sixSevenBonuses || 0, "cyan"],
    ["N", "NIDA", special.nidaAwards || 0, "red"],
    ["ℙ", "Prime Time", special.primeAwards || 0, "purple"],
    ["φ", "Fibonacci", special.fibonacciAwards || 0, "green"],
    ["π", "Pi Time", special.sequenceAwards.piTime, "purple"],
    ["P↑", "Prime Ladder", special.sequenceAwards.primeLadder, "purple"],
    ["G", "Golden Run", special.sequenceAwards.goldenRun, "gold"],
    ["T", "Transition Tango", special.sequenceAwards.transitionTango, "cyan"],
    ["RF", "Rapid Fire", special.sequenceAwards.rapidFire, "red"],
    ["⌂", "Homecoming", special.sequenceAwards.homecoming, "green"],
    ["♪", "N*Sync", special.sequenceAwards.nSync, "cyan"],
    ["⚡", "Bum Cut", special.bumCuts || 0, "red"],
  ]
    .map(
      ([symbol, label, count, color]) => `<div class="award-gallery-tile ${color}">
        <i>${symbol}</i><b>${count}</b><span>${label}</span>
      </div>`,
    )
    .join("");
  const awardGuide = AWARD_GUIDE.map(
    ([symbol, label, description, color]) => `<div class="award-guide-item ${color}">
      <i>${symbol}</i>
      <div><b>${label}</b><span>${description}</span></div>
    </div>`,
  ).join("");
  const maxSourceUses = Math.max(1, ...activeSources.map((source) => source.uses));
  const sourceUseBars = [...activeSources]
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 12)
    .map(
      (source, index) => `<div class="use-bar">
        <span>${index + 1}. ${escapeHtml(source.name)}</span>
        <div><i style="width:${Math.max(2, (source.uses / maxSourceUses) * 100).toFixed(1)}%"></i></div>
        <b>${source.uses}</b>
      </div>`,
    )
    .join("");
  const chronologicalEvents = [...report.events].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const shotDurations = chronologicalEvents
    .map((event, index) => {
      const previousAt =
        index === 0
          ? startedAt
          : new Date(chronologicalEvents[index - 1].at).getTime();
      return Math.max(0, new Date(event.at).getTime() - previousAt);
    })
    .filter((duration) => Number.isFinite(duration));
  const shotBands = [
    { label: "< 1 sec", count: shotDurations.filter((value) => value < 1_000).length },
    { label: "1–3 sec", count: shotDurations.filter((value) => value >= 1_000 && value < 3_000).length },
    { label: "3–5 sec", count: shotDurations.filter((value) => value >= 3_000 && value < 5_000).length },
    { label: "5–10 sec", count: shotDurations.filter((value) => value >= 5_000 && value < 10_000).length },
    { label: "10–30 sec", count: shotDurations.filter((value) => value >= 10_000 && value < 30_000).length },
    { label: "30+ sec", count: shotDurations.filter((value) => value >= 30_000).length },
  ];
  const peakShotBand = Math.max(1, ...shotBands.map((band) => band.count));
  const shotBandBars = shotBands
    .map(
      (band) => `<div class="shot-band">
        <span>${band.label}</span>
        <div><i style="width:${Math.max(1, (band.count / peakShotBand) * 100).toFixed(1)}%"></i></div>
        <b>${band.count}</b>
      </div>`,
    )
    .join("");
  let cumulativeTakes = 0;
  const cumulativePoints = activity
    .map((count, index) => {
      cumulativeTakes += count;
      const x =
        activity.length === 1 ? 0 : (index / (activity.length - 1)) * 100;
      const y = 38 - (cumulativeTakes / Math.max(1, totalTakes)) * 34;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const maxSourceAirtime = Math.max(
    0,
    ...activeSources.map((source) => source.milliseconds),
  );
  const tBarAwards = Math.floor(report.transitions.mix / 10);
  const bingoLevels = [
    [
      ["10 CUTS", report.transitions.cut >= 10],
      ["5 MIXES", report.transitions.mix >= 5],
      ["5 IN 45 SEC", diversity.bestCount >= 5],
      ["50 CUTS", report.transitions.cut >= 50],
      ["T BAR!", tBarAwards >= 1],
      ["8 IN 45 SEC", diversity.bestCount >= 8],
      ["100 TAKES", totalTakes >= 100],
      ["20 MIXES", report.transitions.mix >= 20],
      ["5 MIN AIR", maxSourceAirtime >= 300_000],
    ],
    [
      ["750 CUTS", report.transitions.cut >= 750],
      ["300 MIXES", report.transitions.mix >= 300],
      ["10 IN 45 SEC", diversity.bestCount >= 10],
      ["900 CUTS", report.transitions.cut >= 900],
      ["35 T BARS", tBarAwards >= 35],
      [`12 IN 45 SEC · BEST ${diversity.bestCount}`, diversity.bestCount >= 12],
      ["1,250 TAKES", totalTakes >= 1_250],
      ["400 MIXES", report.transitions.mix >= 400],
      ["45 MIN AIR", maxSourceAirtime >= 2_700_000],
    ],
    [
      ["1,000 CUTS", report.transitions.cut >= 1_000],
      ["500 MIXES", report.transitions.mix >= 500],
      ["20 DIVERSITY", diversity.awards >= 20],
      ["1,250 CUTS", report.transitions.cut >= 1_250],
      ["60 T BARS", tBarAwards >= 60],
      [`12 IN 45 SEC · BEST ${diversity.bestCount}`, diversity.bestCount >= 12],
      ["2,000 TAKES", totalTakes >= 2_000],
      ["700 MIXES", report.transitions.mix >= 700],
      ["60 MIN AIR", maxSourceAirtime >= 3_600_000],
    ],
    [
      ["1,500 CUTS", report.transitions.cut >= 1_500],
      ["800 MIXES", report.transitions.mix >= 800],
      ["40 DIVERSITY", diversity.awards >= 40],
      ["2,000 CUTS", report.transitions.cut >= 2_000],
      ["100 T BARS", tBarAwards >= 100],
      [`12 IN 45 SEC · BEST ${diversity.bestCount}`, diversity.bestCount >= 12],
      ["3,000 TAKES", totalTakes >= 3_000],
      ["1,200 MIXES", report.transitions.mix >= 1_200],
      ["90 MIN AIR", maxSourceAirtime >= 5_400_000],
    ],
    [
      ["2,500 CUTS", report.transitions.cut >= 2_500],
      ["1,500 MIXES", report.transitions.mix >= 1_500],
      ["75 DIVERSITY", diversity.awards >= 75],
      ["3,000 CUTS", report.transitions.cut >= 3_000],
      ["200 T BARS", tBarAwards >= 200],
      [`12 IN 45 SEC · BEST ${diversity.bestCount}`, diversity.bestCount >= 12],
      ["5,000 TAKES", totalTakes >= 5_000],
      ["2,500 MIXES", report.transitions.mix >= 2_500],
      ["120 MIN AIR", maxSourceAirtime >= 7_200_000],
    ],
  ];
  const firstIncompleteBingoLevel = bingoLevels.findIndex(
    (board) => !board.every(([, done]) => done),
  );
  const bingoLevelIndex =
    firstIncompleteBingoLevel === -1
      ? bingoLevels.length - 1
      : firstIncompleteBingoLevel;
  const reportBingoLevel = bingoLevelIndex + 1;
  const bingoTiles = bingoLevels[bingoLevelIndex]
    .map(
      ([label, done]) =>
        `<div class="${done ? "done" : ""}"><b>${done ? "✓" : "·"}</b><span>${label}</span></div>`,
    )
    .join("");
  const mePeakTakes = Math.max(1, totalTakes, me2Takes);
  const meComparison = [
    ["ME1", totalTakes, report.transitions.cut, report.transitions.mix],
    ["ME2", me2Takes, me2.transitions.cut, me2.transitions.mix],
  ]
    .map(
      ([label, takes, cuts, mixes]) => `<div class="me-compare-row">
        <strong>${label}</strong>
        <div><i style="width:${Math.max(1, (takes / mePeakTakes) * 100).toFixed(1)}%"></i></div>
        <b>${takes} takes</b>
        <small>${cuts} cuts · ${mixes} mixes</small>
      </div>`,
    )
    .join("");
  const graphicsSection = `
    <section class="report-grid">
      <article class="panel"><div class="panel-head"><h2>Bingo Level ${reportBingoLevel}</h2><span>Director KPI ladder</span></div>
        <div class="report-bingo">${bingoTiles}</div>
      </article>
      <article class="panel"><div class="panel-head"><h2>Cumulative Take Curve</h2><span>${totalTakes} Total</span></div>
        <div class="curve-chart"><svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Cumulative takes over show time"><path d="M0 38 H100" class="axis"/><path d="M0 4 V38" class="axis"/><polyline points="${cumulativePoints}" /></svg></div>
        <div class="activity-labels"><span>Show start</span><span>Steeper = faster cutting</span><span>Snapshot</span></div>
      </article>
    </section>
    <section class="report-grid">
      <article class="panel"><div class="panel-head"><h2>Shot-Length Distribution</h2><span>${shotDurations.length} Measured Shots</span></div><div class="shot-bands">${shotBandBars}</div></article>
      <article class="panel"><div class="panel-head"><h2>Source Selection Frequency</h2><span>Program Selections</span></div><div class="use-bars">${sourceUseBars || "<small>No source selections recorded.</small>"}</div></article>
    </section>
    <section class="panel"><div class="panel-head"><h2>ME Workload Comparison</h2><span>Relative Number of Takes</span></div><div class="me-compare">${meComparison}</div></section>
    <section class="panel"><div class="panel-head"><h2>Award Scoreboard</h2><span>Show Achievements</span></div><div class="award-gallery">${awardGallery}</div>
      <div class="award-guide"><h3>What Each Award Represents</h3><div class="award-guide-grid">${awardGuide}</div></div>
    </section>`;
  const awardsByEventTime = new Map();
  const addEventAward = (at, symbol, label) => {
    const key = new Date(at).getTime();
    if (!Number.isFinite(key)) return;
    if (!awardsByEventTime.has(key)) awardsByEventTime.set(key, []);
    const awards = awardsByEventTime.get(key);
    if (!awards.some((award) => award.symbol === symbol)) {
      awards.push({ symbol, label });
    }
  };
  for (const event of special.sixSevenEvents || []) {
    if (event.me === "ME1") addEventAward(event.at, "67", "6/7");
  }
  for (const event of special.nidaEvents || []) {
    if (event.me === "ME1") addEventAward(event.at, "N", "NIDA Award");
  }
  for (const event of special.primeEvents || []) {
    if (event.me === "ME1") addEventAward(event.at, "ℙ", "Prime Time");
  }
  for (const event of special.fibonacciEvents || []) {
    if (event.me === "ME1") {
      addEventAward(
        event.at,
        "φ",
        `Fibonacci ${event.tier || "Bronze"}`,
      );
    }
  }
  const sequenceAwardSymbols = {
    piTime: "π",
    primeLadder: "P↑",
    goldenRun: "G",
    transitionTango: "T",
    rapidFire: "RF",
    homecoming: "⌂",
    nSync: "♪",
  };
  for (const event of special.sequenceEvents || []) {
    if (event.me === "ME1") {
      addEventAward(
        event.at,
        sequenceAwardSymbols[event.key] || "★",
        event.label || event.key,
      );
    }
  }
  for (const event of special.bumCutEvents || []) {
    if (event.me === "ME1") addEventAward(event.at, "⚡", "Bum Cut");
  }
  let mixSequence = 0;
  const diversitySourcesByRound = new Map();
  for (const event of chronologicalEvents) {
    const eventAt = new Date(event.at).getTime();
    if (event.type === "MIX") {
      mixSequence += 1;
      if (mixSequence % 10 === 0) {
        addEventAward(event.at, "⊤", "T Bar Award");
      }
    }
    const round = Math.max(
      0,
      Math.floor((eventAt - startedAt) / (45 * 1000)),
    );
    if (!diversitySourcesByRound.has(round)) {
      diversitySourcesByRound.set(round, new Set());
    }
    const roundSources = diversitySourcesByRound.get(round);
    const before = roundSources.size;
    for (const name of [event.from, event.to]) {
      const normalized = String(name || "").trim();
      if (normalized && normalized.toLowerCase() !== "black") {
        roundSources.add(normalized);
      }
    }
    if (before < 5 && roundSources.size >= 5) {
      addEventAward(event.at, "D", "Diversity Award");
    }
  }
  for (const hold of special.halfMixDurations || []) {
    if (hold.me !== "ME1" || chronologicalEvents.length === 0) continue;
    const holdAt = new Date(hold.at).getTime();
    const closest = chronologicalEvents.reduce((best, event) => {
      const distance = Math.abs(new Date(event.at).getTime() - holdAt);
      return distance < best.distance ? { event, distance } : best;
    }, { event: null, distance: Infinity });
    if (closest.event && closest.distance <= 30_000) {
      addEventAward(closest.event.at, "½", "Long Half-Mix");
    }
  }
  const gapByEventId = new Map();
  chronologicalEvents.forEach((event, index) => {
    const previousAt =
      index === 0
        ? startedAt
        : new Date(chronologicalEvents[index - 1].at).getTime();
    gapByEventId.set(
      event.id,
      Math.max(0, new Date(event.at).getTime() - previousAt),
    );
  });
  const formatGap = (milliseconds) => {
    if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
    if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  };
  const eventRows = [...chronologicalEvents]
    .reverse()
    .map((event) => {
      const eventAwards =
        awardsByEventTime.get(new Date(event.at).getTime()) || [];
      const awardBadges = eventAwards
        .map(
          (award) =>
            `<span class="event-award" title="${escapeHtml(award.label)}">${award.symbol}</span>`,
        )
        .join("");
      return `<tr>
        <td>${new Date(event.at).toLocaleTimeString("en-AU")}</td>
        <td>${formatGap(gapByEventId.get(event.id) || 0)}</td>
        <td>${escapeHtml(event.from)}</td>
        <td>${escapeHtml(event.to)}</td>
        <td>${event.type}</td>
        <td><div class="event-awards">${awardBadges || '<span class="no-award">—</span>'}</div></td>
      </tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${REPORT_BRAND_TITLE} — ${escapeHtml(report.show.name)}</title>
  <style>
  :root{--ink:#111418;--muted:#66717b;--line:#d9dfe3;--red:#ed4548;--cyan:#19a8bd;--purple:#7657d7;--gold:#c88710}*{box-sizing:border-box}body{font:13px Arial,sans-serif;color:var(--ink);margin:36px auto;max-width:1100px;padding:0 24px}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:5px solid var(--ink);padding-bottom:20px}h1{margin:4px 0 0;font-size:34px;letter-spacing:-1.5px}h2{margin:0 0 16px;font-size:18px}h3{margin:0;font-size:13px}small{color:var(--muted)}.kicker{font-size:9px;font-weight:bold;letter-spacing:2px;color:var(--cyan)}.midway-banner{display:flex;justify-content:space-between;gap:20px;margin-top:16px;padding:12px 15px;background:linear-gradient(90deg,var(--purple),#4d32a5);color:white;font-size:10px;font-weight:bold;letter-spacing:.08em}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0}.card{border:1px solid var(--line);padding:15px;min-height:82px}.card b{display:block;margin-top:6px;font-size:23px}.card span{color:var(--muted);text-transform:uppercase;font-size:8px;font-weight:bold;letter-spacing:.8px}.card small{display:block;margin-top:4px;font-size:8px}.report-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px;margin:14px 0}.panel{border:1px solid var(--line);padding:18px;break-inside:avoid}.panel-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:14px}.panel-head span{font-size:9px;color:var(--muted);text-transform:uppercase}.transition-chart{display:grid;grid-template-columns:140px 1fr;gap:24px;align-items:center}.donut{display:grid;place-items:center;width:132px;height:132px;border-radius:50%;background:conic-gradient(var(--red) 0 ${cutPercent.toFixed(1)}%,var(--cyan) 0 ${(cutPercent + mixPercent).toFixed(1)}%,#d7dde1 0)}.donut div{display:grid;place-items:center;width:82px;height:82px;border-radius:50%;background:white}.donut b{font-size:25px}.donut small{font-size:8px;text-transform:uppercase}.legend{display:grid;gap:10px}.legend div{display:grid;grid-template-columns:8px 1fr auto;gap:8px;align-items:center}.legend i{height:22px;background:var(--red)}.legend .mix{background:var(--cyan)}.legend .other{background:#aeb7bd}.legend span{font-size:10px}.legend b{font-size:15px}.source-bars{display:grid;gap:8px}.source-bar-row{display:grid;grid-template-columns:115px 1fr 42px;gap:8px;align-items:center}.source-bar-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.source-bar-row>div{height:8px;background:#edf0f2}.source-bar-row i{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),#62cad7)}.source-bar-row:first-child i{background:linear-gradient(90deg,var(--red),#f28688)}.source-bar-row b{text-align:right;font-size:9px}.activity-chart{display:flex;align-items:end;gap:2px;height:140px;padding-top:18px;border-bottom:1px solid var(--ink);background:repeating-linear-gradient(to top,#eef1f3 0 1px,transparent 1px 35px)}.activity-chart>i{position:relative;flex:1;min-width:2px;background:linear-gradient(var(--purple),#a18bea)}.activity-chart>i span{display:none;position:absolute;top:-13px;left:50%;font-size:7px;transform:translateX(-50%)}.activity-chart>i:hover span{display:block}.activity-labels{display:flex;justify-content:space-between;margin-top:6px;color:var(--muted);font-size:8px}.report-bingo{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.report-bingo>div{display:grid;place-items:center;min-height:54px;padding:7px;border:1px solid var(--line);color:#9ba4aa;text-align:center}.report-bingo>div.done{border-color:rgba(118,87,215,.45);background:rgba(118,87,215,.08);color:var(--purple)}.report-bingo b{font-size:15px}.report-bingo span{font-size:7px;font-weight:bold;letter-spacing:.04em}.curve-chart{height:154px;background:repeating-linear-gradient(to top,#eef1f3 0 1px,transparent 1px 38px)}.curve-chart svg{width:100%;height:100%;overflow:visible}.curve-chart polyline{fill:none;stroke:var(--purple);stroke-width:1.5;vector-effect:non-scaling-stroke}.curve-chart .axis{fill:none;stroke:#aeb7bd;stroke-width:.6;vector-effect:non-scaling-stroke}.shot-bands,.use-bars{display:grid;gap:9px}.shot-band,.use-bar{display:grid;grid-template-columns:78px 1fr 34px;gap:8px;align-items:center}.shot-band span,.use-bar span{overflow:hidden;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.shot-band>div,.use-bar>div{height:10px;background:#edf0f2}.shot-band i,.use-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--red),#f28b8d)}.use-bar i{background:linear-gradient(90deg,var(--cyan),#68ceda)}.shot-band b,.use-bar b{text-align:right;font-size:9px}.me-compare{display:grid;gap:12px}.me-compare-row{display:grid;grid-template-columns:44px 1fr 70px 120px;gap:10px;align-items:center}.me-compare-row>div{height:20px;background:#edf0f2}.me-compare-row i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),#a28bea)}.me-compare-row:nth-child(2) i{background:linear-gradient(90deg,var(--cyan),#69d0dc)}.me-compare-row b{font-size:10px}.me-compare-row small{font-size:8px}.award-gallery{display:grid;grid-template-columns:repeat(9,1fr);gap:7px}.award-gallery-tile{display:grid;place-items:center;gap:3px;min-height:92px;padding:9px;border:1px solid var(--line);background:linear-gradient(145deg,#fff,#f6f7f8);text-align:center}.award-gallery-tile i{display:grid;place-items:center;width:31px;height:31px;border:1px solid currentColor;border-radius:50%;color:var(--gold);font-family:Georgia,serif;font-size:14px;font-style:normal}.award-gallery-tile b{font-size:22px}.award-gallery-tile span{color:var(--muted);font-size:7px;text-transform:uppercase}.award-gallery-tile.purple i{color:var(--purple)}.award-gallery-tile.cyan i{color:var(--cyan)}.award-gallery-tile.red i{color:var(--red)}.award-gallery-tile.green i{color:#25875e}.event-awards{display:flex;gap:3px;min-width:62px}.event-award{display:grid;place-items:center;min-width:22px;height:22px;padding:0 4px;border:1px solid rgba(118,87,215,.45);border-radius:50%;background:rgba(118,87,215,.07);color:var(--purple);font-family:Georgia,serif;font-size:8px;font-weight:bold}.no-award{color:#aeb7bd}.award-key{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);background:#f7f8f9}.award-key span{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:8px}.award-key i{display:grid;place-items:center;min-width:20px;height:20px;padding:0 3px;border:1px solid rgba(118,87,215,.45);border-radius:50%;color:var(--purple);font-family:Georgia,serif;font-size:8px;font-style:normal;font-weight:bold}.facts{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}.fact{display:grid;gap:4px;padding:14px;background:white}.fact span{font-size:8px;color:var(--muted);text-transform:uppercase}.fact b{font-size:17px}.awards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.award{padding:14px;border:1px solid var(--line);text-align:center}.award b{display:block;color:var(--gold);font-size:26px}.award.purple b{color:var(--purple)}.award.red b{color:var(--red)}.award span{font-size:8px;text-transform:uppercase;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:10px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}th{font-size:8px;text-transform:uppercase;color:var(--muted);letter-spacing:.6px}.section{margin-top:26px}.actions{position:fixed;z-index:10;right:24px;top:24px;padding:10px 14px;border:0;background:var(--ink);color:white;cursor:pointer}.page-break{break-before:page}@page{size:A4;margin:15mm}@media(max-width:760px){.summary{grid-template-columns:repeat(2,1fr)}.report-grid{grid-template-columns:1fr}.transition-chart{grid-template-columns:120px 1fr}.me-compare-row{grid-template-columns:40px 1fr 65px}.me-compare-row small{display:none}.award-gallery{grid-template-columns:repeat(3,1fr)}}@media print{.actions{display:none}body{margin:0;max-width:none;padding:0}.summary{grid-template-columns:repeat(4,1fr)}.section{break-inside:avoid}.award-gallery{grid-template-columns:repeat(5,1fr)}}
  .report-actions{position:fixed;z-index:20;right:24px;top:24px;display:flex;gap:6px;padding:6px;border:1px solid var(--line);background:rgba(255,255,255,.96);box-shadow:0 10px 30px rgba(17,20,24,.15)}.report-actions button,.report-actions a{display:inline-grid;place-items:center;min-height:34px;padding:0 12px;border:1px solid var(--ink);background:var(--ink);color:white;font:700 9px Arial,sans-serif;letter-spacing:.05em;text-decoration:none;text-transform:uppercase;cursor:pointer}.report-actions a.secondary{background:white;color:var(--ink)}body.report-mono{--ink:#000;--muted:#303030;--line:#000;--red:#000;--cyan:#000;--purple:#000;--gold:#000;background:#fff;color:#000}body.report-mono .midway-banner{border:2px solid #000;background:#fff;color:#000}body.report-mono .donut{background:conic-gradient(#000 0 ${cutPercent.toFixed(1)}%,#666 0 ${(cutPercent + mixPercent).toFixed(1)}%,#ddd 0)}body.report-mono .source-bar-row i,body.report-mono .source-bar-row:first-child i,body.report-mono .activity-chart>i,body.report-mono .shot-band i,body.report-mono .use-bar i,body.report-mono .me-compare-row i,body.report-mono .me-compare-row:nth-child(2) i{background:#000}body.report-mono .report-bingo>div.done{border:2px solid #000;background:#eee;color:#000}body.report-mono .curve-chart polyline{stroke:#000}body.report-mono .award-gallery-tile{background:#fff}body.report-mono .award-gallery-tile i,body.report-mono .award-gallery-tile.purple i,body.report-mono .award-gallery-tile.cyan i,body.report-mono .award-gallery-tile.red i,body.report-mono .award-gallery-tile.green i,body.report-mono .event-award,body.report-mono .award-key i,body.report-mono .award b,body.report-mono .award.purple b,body.report-mono .award.red b{border-color:#000;color:#000}body.report-mono .activity-chart,body.report-mono .curve-chart{background:repeating-linear-gradient(to top,#ddd 0 1px,transparent 1px 35px)}@media(max-width:760px){.report-actions{position:static;justify-content:flex-end;margin-bottom:18px;flex-wrap:wrap}}@media print{.report-actions{display:none!important}body.report-mono{-webkit-print-color-adjust:economy;print-color-adjust:economy}}
  body{font-size:15px}h1{font-size:40px}h2{font-size:21px}h3{font-size:16px}.kicker{font-size:11px}.midway-banner{font-size:12px}.card span,.card small,.panel-head span,.activity-labels,.report-bingo span,.award-gallery-tile span,.award-key span,.fact span,.award span,th{font-size:10px}.card b{font-size:27px}.source-bar-row>span,.source-bar-row b,.shot-band span,.use-bar span,.shot-band b,.use-bar b,.me-compare-row b,.me-compare-row small{font-size:11px}.legend span{font-size:12px}.legend b{font-size:17px}.fact b{font-size:20px}table{font-size:12px}.event-award,.award-key i{font-size:10px}.report-actions button,.report-actions a{font-size:11px}
  body{position:relative;max-width:1380px;padding:0 34px;font-size:17px;line-height:1.45}h1{font-size:clamp(46px,5vw,70px);line-height:.92;letter-spacing:-.055em}h2{font-size:28px;letter-spacing:-.03em}h3{font-size:20px}.kicker{font-size:13px}.report-title{display:flex;align-items:center;gap:22px;min-width:0}.report-title>div{min-width:0}.report-cogs{position:relative;display:grid;place-items:center;width:88px;height:88px;color:var(--cyan);font-size:68px;line-height:1;filter:drop-shadow(0 0 16px currentColor)}.report-cogs i{position:absolute;right:-7px;top:-8px;color:var(--purple);font-size:39px;font-style:normal}.report-status{display:grid;gap:6px;justify-items:end}.report-status>b{padding:7px 12px;border:1px solid var(--cyan);color:var(--cyan);font-size:15px;letter-spacing:.12em}.report-status small{font-size:13px}.summary{gap:14px;margin:28px 0}.card{min-height:118px;padding:21px}.card b{font-size:36px}.card span,.card small,.panel-head span,.activity-labels,.report-bingo span,.award-gallery-tile span,.award-key span,.fact span,.award span,th{font-size:12px}.report-grid{gap:18px;margin:18px 0}.panel{padding:26px}.panel-head{margin-bottom:20px}.transition-chart{grid-template-columns:190px 1fr;gap:30px}.donut{width:180px;height:180px;filter:drop-shadow(0 0 20px rgba(25,168,189,.24))}.donut div{width:112px;height:112px}.donut b{font-size:36px}.donut small{font-size:11px}.legend{gap:15px}.legend div{grid-template-columns:11px 1fr auto;gap:12px}.legend i{height:30px}.legend span{font-size:15px}.legend b{font-size:21px}.source-bars{gap:13px}.source-bar-row{grid-template-columns:160px 1fr 58px;gap:12px}.source-bar-row>span,.source-bar-row b{font-size:14px}.source-bar-row>div{height:14px}.activity-chart{height:230px;gap:4px;padding-top:28px}.activity-chart>i{min-width:4px;border-radius:5px 5px 0 0}.activity-chart>i span{font-size:10px}.activity-labels{margin-top:10px}.report-bingo{gap:9px}.report-bingo>div{min-height:84px;padding:12px}.report-bingo b{font-size:24px}.curve-chart{height:230px}.curve-chart polyline{stroke-width:3}.shot-bands,.use-bars{gap:13px}.shot-band,.use-bar{grid-template-columns:110px 1fr 48px;gap:12px}.shot-band span,.use-bar span,.shot-band b,.use-bar b{font-size:13px}.shot-band>div,.use-bar>div{height:16px}.me-compare{gap:17px}.me-compare-row{grid-template-columns:58px 1fr 92px 150px;gap:14px}.me-compare-row>div{height:27px}.me-compare-row b{font-size:14px}.me-compare-row small{font-size:12px}.award-gallery{grid-template-columns:repeat(5,1fr);gap:13px}.award-gallery-tile{min-height:148px;padding:16px}.award-gallery-tile i{width:58px;height:58px;border-width:2px;font-size:25px;box-shadow:0 0 22px color-mix(in srgb,currentColor 28%,transparent)}.award-gallery-tile b{font-size:34px}.award-gallery-tile span{font-size:11px}.event-awards{gap:7px;min-width:95px}.event-award{min-width:34px;height:34px;padding:0 7px;border-width:2px;font-size:13px}.award-key{gap:10px 18px;margin-bottom:18px;padding:16px}.award-key span{gap:8px;font-size:12px}.award-key i{min-width:32px;height:32px;padding:0 6px;border-width:2px;font-size:13px}.fact{min-height:94px;padding:20px}.fact span{font-size:11px}.fact b{font-size:27px}.fact small{font-size:12px}.awards{gap:13px}.award{padding:21px}.award b{font-size:40px}.award span{font-size:11px}table{font-size:14px}th,td{padding:12px 10px}th{font-size:11px}.section{margin-top:36px}.report-actions button,.report-actions a{min-height:42px;padding:0 16px;font-size:12px}
  body.report-dark{--ink:#f5f8fb;--muted:#9aa8b5;--line:#29333d;--red:#ff4968;--cyan:#31e6ff;--purple:#a879ff;--gold:#ffc857;min-height:100vh;background:radial-gradient(circle at 78% -5%,rgba(168,121,255,.2),transparent 31rem),radial-gradient(circle at -10% 28%,rgba(49,230,255,.13),transparent 32rem),linear-gradient(150deg,#07090d,#0c1118 54%,#080b10);color:var(--ink);color-scheme:dark}body.report-dark::before,body.report-dark::after{content:"";position:fixed;z-index:-1;width:360px;height:360px;border-radius:50%;filter:blur(100px);opacity:.18;pointer-events:none}body.report-dark::before{left:-100px;top:36%;background:var(--cyan)}body.report-dark::after{right:-120px;bottom:8%;background:var(--purple)}body.report-dark header{position:relative;border-bottom:0;padding:28px 30px;background:linear-gradient(115deg,rgba(20,28,38,.96),rgba(11,15,22,.9));box-shadow:inset 0 0 0 1px var(--line),0 24px 70px rgba(0,0,0,.35);overflow:hidden}body.report-dark header::after{content:"";position:absolute;right:0;bottom:0;left:0;height:4px;background:linear-gradient(90deg,var(--red),var(--gold),var(--cyan),var(--purple),var(--red));background-size:220% 100%;animation:report-spectrum 8s linear infinite}body.report-dark .card,body.report-dark .panel{position:relative;border:1px solid var(--line);background:linear-gradient(145deg,rgba(22,29,38,.94),rgba(11,15,21,.96));box-shadow:0 15px 45px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.035);overflow:hidden}body.report-dark .card::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:linear-gradient(var(--cyan),var(--purple));box-shadow:0 0 18px var(--cyan)}body.report-dark .card:nth-child(3n+2)::before{background:linear-gradient(var(--gold),var(--red));box-shadow:0 0 18px var(--gold)}body.report-dark .card b{background:linear-gradient(100deg,#fff,var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}body.report-dark .panel-head{border-bottom:1px solid var(--line);padding-bottom:14px}body.report-dark .panel-head span{color:var(--cyan)}body.report-dark .donut div{background:#0d131b;box-shadow:inset 0 0 28px rgba(0,0,0,.55)}body.report-dark .source-bar-row>div,body.report-dark .shot-band>div,body.report-dark .use-bar>div,body.report-dark .me-compare-row>div{background:#18222c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.025)}body.report-dark .source-bar-row i,body.report-dark .use-bar i{background:linear-gradient(90deg,#00a7c2,var(--cyan));box-shadow:0 0 16px rgba(49,230,255,.32)}body.report-dark .source-bar-row:first-child i,body.report-dark .shot-band i{background:linear-gradient(90deg,#ff3358,var(--red),var(--gold));box-shadow:0 0 16px rgba(255,73,104,.32)}body.report-dark .activity-chart,body.report-dark .curve-chart{border-color:var(--line);background:repeating-linear-gradient(to top,rgba(255,255,255,.055) 0 1px,transparent 1px 46px),linear-gradient(180deg,rgba(168,121,255,.055),transparent)}body.report-dark .activity-chart>i{background:linear-gradient(var(--cyan),var(--purple));box-shadow:0 0 12px rgba(168,121,255,.32)}body.report-dark .curve-chart polyline{stroke:var(--cyan);filter:drop-shadow(0 0 5px rgba(49,230,255,.65))}body.report-dark .curve-chart .axis{stroke:#536170}body.report-dark .report-bingo>div{border-color:#303b47;background:#0c1118;color:#667482}body.report-dark .report-bingo>div.done{border-color:var(--purple);background:radial-gradient(circle at 50% 0,rgba(168,121,255,.25),rgba(168,121,255,.08));color:#d2baff;box-shadow:inset 0 0 24px rgba(168,121,255,.12),0 0 14px rgba(168,121,255,.12)}body.report-dark .award-gallery-tile{border-color:#313d48;background:radial-gradient(circle at 50% 0,rgba(255,200,87,.11),transparent 48%),linear-gradient(145deg,#151d26,#0b1016);box-shadow:0 12px 32px rgba(0,0,0,.25)}body.report-dark .award-gallery-tile.purple{background:radial-gradient(circle at 50% 0,rgba(168,121,255,.16),transparent 50%),linear-gradient(145deg,#171b29,#0b1016)}body.report-dark .award-gallery-tile.cyan{background:radial-gradient(circle at 50% 0,rgba(49,230,255,.14),transparent 50%),linear-gradient(145deg,#101f27,#0b1016)}body.report-dark .award-gallery-tile.red{background:radial-gradient(circle at 50% 0,rgba(255,73,104,.16),transparent 50%),linear-gradient(145deg,#25151c,#0b1016)}body.report-dark .award-gallery-tile.green{background:radial-gradient(circle at 50% 0,rgba(75,232,158,.15),transparent 50%),linear-gradient(145deg,#10231c,#0b1016)}body.report-dark .award-gallery-tile.green i{color:#4be89e}body.report-dark .facts{background:var(--line)}body.report-dark .fact{background:#0e141c}body.report-dark .award{border-color:#303b47;background:linear-gradient(145deg,#141b24,#0b1016)}body.report-dark .award-key{background:#0c1219}body.report-dark .event-award{border-color:rgba(168,121,255,.62);background:rgba(168,121,255,.14);color:#d2baff;box-shadow:0 0 10px rgba(168,121,255,.12)}body.report-dark table{background:rgba(9,13,18,.7)}body.report-dark tbody tr:nth-child(odd){background:rgba(255,255,255,.025)}body.report-dark tbody tr:hover{background:rgba(49,230,255,.065)}body.report-dark .report-actions{border-color:#34414d;background:rgba(8,12,17,.9);box-shadow:0 14px 45px rgba(0,0,0,.5);backdrop-filter:blur(16px)}body.report-dark .report-actions button{border-color:var(--cyan);background:linear-gradient(120deg,#123a46,#172232);color:#fff}body.report-dark .report-actions a.secondary{border-color:#465461;background:#111821;color:#dce6ed}body.report-dark .midway-banner{background:linear-gradient(90deg,var(--purple),#4b2db5,var(--cyan));box-shadow:0 12px 34px rgba(77,45,181,.3)}@keyframes report-spectrum{to{background-position:220% 0}}@media(prefers-reduced-motion:reduce){body.report-dark header::after{animation:none}}@media(max-width:900px){body{padding:0 18px}.award-gallery{grid-template-columns:repeat(3,1fr)}.summary{grid-template-columns:repeat(2,1fr)}.report-cogs{width:60px;height:60px;font-size:49px}.report-cogs i{font-size:28px}h1{font-size:42px}}@media print{body{font-size:12px!important}body.report-dark{-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#07090d!important;color:#f5f8fb!important}body.report-dark::before,body.report-dark::after{display:none}.card{min-height:88px}.award-gallery{grid-template-columns:repeat(5,1fr)}.award-gallery-tile{min-height:105px}.report-cogs{width:58px;height:58px;font-size:46px}.report-cogs i{font-size:25px}h1{font-size:38px}h2{font-size:20px}.panel{padding:16px}}
  body.report-dark .report-actions a.primary{border-color:var(--cyan);background:linear-gradient(120deg,#123a46,#172232);color:#fff}
  .report-title img.report-cogs{display:block;object-fit:contain;filter:drop-shadow(0 0 16px rgba(49,230,255,.32))}
  .card span,.fact span,.award span,.award-gallery-tile span{text-transform:none}
  .donut div{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}.donut b,.donut small{line-height:1;margin:0}
  .activity-axis{gap:0}.activity-axis span{flex:1;text-align:center}.activity-axis span:first-child{text-align:left}.activity-axis span:last-child{text-align:right}.activity-axis-title{margin-top:5px;color:var(--muted);font-size:11px;font-weight:bold;letter-spacing:.08em;text-align:center;text-transform:uppercase}
  .chart-explainer{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 18px;margin-top:16px;padding:16px 18px;border:1px solid var(--line);background:rgba(255,255,255,.025)}.chart-explainer>div{display:grid;gap:5px;padding-right:16px;border-right:1px solid var(--line)}.chart-explainer>div:last-of-type{padding-right:0;border-right:0}.chart-explainer b{color:var(--cyan);font-size:13px}.chart-explainer span{color:var(--muted);font-size:13px;line-height:1.45}.chart-explainer small{grid-column:1/-1;color:var(--gold);font-size:12px}@media(max-width:900px){.chart-explainer{grid-template-columns:1fr}.chart-explainer>div{padding:0 0 12px;border-right:0;border-bottom:1px solid var(--line)}}
  .award-guide{margin-top:28px;padding-top:24px;border-top:1px solid var(--line)}.award-guide h3{margin-bottom:18px;font-size:22px}.award-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px}.award-guide-item{display:grid;grid-template-columns:44px 1fr;gap:12px;align-items:start;padding:14px;border:1px solid var(--line);background:rgba(255,255,255,.025)}.award-guide-item>i{display:grid;place-items:center;width:40px;height:40px;border:2px solid currentColor;border-radius:50%;color:var(--gold);font-family:Georgia,serif;font-size:15px;font-style:normal;font-weight:bold}.award-guide-item.purple>i{color:var(--purple)}.award-guide-item.cyan>i{color:var(--cyan)}.award-guide-item.red>i{color:var(--red)}.award-guide-item.green>i{color:#4be89e}.award-guide-item div{display:grid;gap:4px}.award-guide-item b{font-size:15px}.award-guide-item span{color:var(--muted);font-size:13px;line-height:1.4}@media(max-width:760px){.award-guide-grid{grid-template-columns:1fr}}
  </style></head><body class="${darkTheme ? "report-dark" : "report-light"}">
  <nav class="report-actions" aria-label="Report actions">
    <a class="primary" href="${pdfHref}">Download PDF</a>
    <a class="secondary" href="${darkTheme ? lightHref : darkHref}">${darkTheme ? "Light edition" : "Dark edition"}</a>
    <a class="secondary" href="${csvHref}">Download CSV</a>
  </nav>
  <header><div class="report-title">${PCC_COGS_DATA_URI ? `<img class="report-cogs" src="${PCC_COGS_DATA_URI}" alt="PCC cogs">` : ""}<div><span class="kicker">${REPORT_BRAND_TITLE}</span><h1>${escapeHtml(report.show.name)}</h1></div></div><div class="report-status"><b>${report.show.status.toUpperCase()}</b><small>${new Date(report.show.startedAt).toLocaleString("en-AU")}</small></div></header>
  ${report.show.status === "paused" ? `<div class="midway-banner"><span>MIDWAY SNAPSHOT · SHOW PAUSED</span><span>Generated ${new Date(report.updatedAt).toLocaleString("en-AU")}</span></div>` : ""}
  <section class="summary">
    <div class="card"><span>Show Duration</span><b>${formatDuration(showDuration)}</b></div>
    <div class="card"><span>Total Takes</span><b>${totalTakes}</b><small>${takeRate.toFixed(1)} per minute</small></div>
    <div class="card"><span>Cuts Per Minute</span><b>${cutRate.toFixed(1)}</b><small>${report.transitions.cut} total cuts</small></div>
    <div class="card"><span>Transitions Per Minute</span><b>${takeRate.toFixed(1)}</b><small>All cuts, mixes and others</small></div>
    <div class="card"><span>Active Sources</span><b>${activeSources.length}</b></div>
    <div class="card"><span>Average Shot</span><b>${formatDuration(averageShot)}</b></div>
    <div class="card"><span>Black / Holding</span><b>${formatDuration(blackTime)}</b><small>${((blackTime / totalProgramTime) * 100).toFixed(1)}% of program time</small></div>
    <div class="card"><span>Wrong-Bus Alerts</span><b>${report.wrongBusAlerts || 0}</b></div>
  </section>

  <section class="report-grid">
    <article class="panel"><div class="panel-head"><h2>Source Share</h2><span>Black Excluded</span></div><div class="source-bars">${sourceBars}</div></article>
    <article class="panel"><div class="panel-head"><h2>Transition Mix</h2><span>${totalTakes} Takes</span></div><div class="transition-chart"><div class="donut"><div><b>${totalTakes}</b><small>takes</small></div></div><div class="legend"><div><i></i><span>Cuts</span><b>${report.transitions.cut} · ${cutPercent.toFixed(0)}%</b></div><div><i class="mix"></i><span>Mixes</span><b>${report.transitions.mix} · ${mixPercent.toFixed(0)}%</b></div><div><i class="other"></i><span>Other</span><b>${report.transitions.other}</b></div></div></div></article>
  </section>

  <section class="panel"><div class="panel-head"><h2>Take Activity Over Time</h2><span>Peak ${peakActivity} Takes Per Period</span></div><div class="activity-chart">${activityBars}</div><div class="activity-labels activity-axis">${activityAxisLabels}</div><div class="activity-axis-title">Time of Show · ${bucketCount} Equal Periods</div>
    <div class="chart-explainer">
      <div><b>How to Read It</b><span>Left to right follows the show. Each bar is one ${bucketDurationLabel} slice; its height is the number of ME1 Program changes—cuts, mixes and other transitions.</span></div>
      <div><b>What the Pattern Means</b><span>Tall clusters show fast, high-energy switching. Short or flat sections show longer shots, holding or pauses. Cyan and purple only separate neighbouring periods.</span></div>
      <div><b>How It Helps</b><span>Match peaks and lulls to the rundown. Use them to find sections that felt rushed, slow or inconsistent, then adjust shot choices, cue timing or rehearsal.</span></div>
      ${untimedTakeCount ? `<small>Data coverage: ${report.events.length.toLocaleString()} retained timestamped takes are charted. ${untimedTakeCount.toLocaleString()} earlier takes remain in the totals but no longer have timestamps for placement.</small>` : ""}
    </div>
  </section>
  ${graphicsSection}

  <section class="report-grid">
    <article class="panel"><div class="panel-head"><h2>Performance Statistics</h2><span>ME1</span></div><div class="facts">
      <div class="fact"><span>Top Source</span><b>${escapeHtml(sortedSources[0]?.name || "—")}</b><small>${sortedSources[0] ? formatDuration(sortedSources[0].milliseconds) : "No airtime"}</small></div>
      <div class="fact"><span>Most Selected</span><b>${escapeHtml([...activeSources].sort((a,b)=>b.uses-a.uses)[0]?.name || "—")}</b><small>${Math.max(0, ...activeSources.map((source) => source.uses))} uses</small></div>
      <div class="fact"><span>Longest Cut Streak</span><b>${longestStreak("CUT")}</b></div>
      <div class="fact"><span>Longest Mix Streak</span><b>${longestStreak("MIX")}</b></div>
      <div class="fact"><span>Active Airtime</span><b>${formatDuration(totalAirtime)}</b></div>
      <div class="fact"><span>Dennis Alerts</span><b>${report.wrongBusAlerts || 0}</b></div>
    </div></article>
    <article class="panel"><div class="panel-head"><h2>Arcade Awards</h2><span>Show Achievements</span></div><div class="awards">
      <div class="award"><b>${Math.floor(report.transitions.mix / 10)}</b><span>T BAR Awards</span></div>
      <div class="award purple"><b>${diversity.awards}</b><span>Diversity Awards</span></div>
      <div class="award red"><b>${diversity.bestCount}</b><span>Best 45-sec diversity</span></div>
    </div><div class="facts" style="margin-top:10px"><div class="fact"><span>Diversity XP</span><b>${diversity.totalPoints.toLocaleString()}</b></div><div class="fact"><span>Rounds Scored</span><b>${diversity.rounds}</b></div></div></article>
  </section>
  ${me2Section}
  ${specialSection}

  <section class="section"><h2>Active Source Detail</h2><table><thead><tr><th>Source</th><th>Share</th><th>Program Time</th><th>Uses</th></tr></thead><tbody>${sourceRows}</tbody></table></section>
  <section class="section page-break"><h2>Complete Take Log</h2>
    <div class="award-key"><span><i>⊤</i>T Bar</span><span><i>D</i>Diversity</span><span><i>½</i>Half-Mix</span><span><i>67</i>6/7</span><span><i>N</i>NIDA</span><span><i>ℙ</i>Prime</span><span><i>φ</i>Fibonacci B/S/G</span><span><i>π</i>Pi Time</span><span><i>P↑</i>Prime Ladder</span><span><i>G</i>Golden Run</span><span><i>T</i>Transition Tango</span><span><i>RF</i>Rapid Fire</span><span><i>⌂</i>Homecoming</span><span><i>♪</i>N*Sync</span><span><i>⚡</i>Bum Cut</span></div>
    <table><thead><tr><th>Time</th><th>Gap</th><th>From</th><th>To</th><th>Type</th><th>Awards</th></tr></thead><tbody>${eventRows}</tbody></table>
  </section>
  </body></html>`;
};

const writeReportPdf = (report, response) => {
  const colors = {
    background: "#070A0F",
    panel: "#111821",
    panelAlt: "#0C1219",
    line: "#2B3743",
    text: "#F5F8FB",
    muted: "#99A8B6",
    cyan: "#31E6FF",
    purple: "#A879FF",
    red: "#FF4968",
    gold: "#FFC857",
    green: "#4BE89E",
  };
  const sources = (report.sources || []).filter(
    (source) =>
      source.id !== 0 && source.name.trim().toLowerCase() !== "black",
  );
  const blackSource = (report.sources || []).find(
    (source) =>
      source.id === 0 || source.name.trim().toLowerCase() === "black",
  );
  const sortedSources = [...sources].sort(
    (a, b) => b.milliseconds - a.milliseconds,
  );
  const totalAirtime = Math.max(
    1,
    sources.reduce((sum, source) => sum + source.milliseconds, 0),
  );
  const transitions = {
    cut: 0,
    mix: 0,
    other: 0,
    ...(report.transitions || {}),
  };
  const totalTakes = transitions.cut + transitions.mix + transitions.other;
  const startedAt = report.show?.startedAt
    ? new Date(report.show.startedAt).getTime()
    : Date.now();
  const endedAt = report.show?.stoppedAt
    ? new Date(report.show.stoppedAt).getTime()
    : report.updatedAt
      ? new Date(report.updatedAt).getTime()
      : Date.now();
  const showDuration = Math.max(1, endedAt - startedAt);
  const showMinutes = Math.max(1 / 60, showDuration / 60_000);
  const activeUses = sources.reduce((sum, source) => sum + source.uses, 0);
  const averageShot = totalAirtime / Math.max(1, activeUses);
  const diversity = diversityRoundStats(report);
  const special = {
    halfMixAwards: 0,
    halfMixDurations: [],
    dualMeAwards: 0,
    bumCuts: 0,
    bumCutEvents: [],
    sixSevenBonuses: 0,
    sixSevenEvents: [],
    nidaAwards: 0,
    nidaEvents: [],
    primeAwards: 0,
    primeEvents: [],
    fibonacciAwards: 0,
    fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
    fibonacciEvents: [],
    sequenceAwards: freshSequenceAwards(),
    sequenceEvents: [],
    ...(report.special || {}),
  };
  special.sequenceAwards = {
    ...freshSequenceAwards(),
    ...(special.sequenceAwards || {}),
  };
  const me2 = report.me2 || {
    sources: [],
    transitions: { cut: 0, mix: 0, other: 0 },
  };
  const me2Takes =
    (me2.transitions?.cut || 0) +
    (me2.transitions?.mix || 0) +
    (me2.transitions?.other || 0);

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    bufferPages: true,
    info: {
      Title: `${REPORT_BRAND_TITLE} - ${report.show.name}`,
      Author: "PCC Switch KPI",
      Subject: "ATEM show performance and transition analytics",
    },
  });
  doc.pipe(response);
  const width = doc.page.width;
  const height = doc.page.height;

  const paintBackground = () => {
    doc.save();
    doc.rect(0, 0, width, height).fill(colors.background);
    doc.rect(0, 0, width, 4).fill(colors.cyan);
    doc.rect(width * 0.34, 0, width * 0.33, 4).fill(colors.purple);
    doc.rect(width * 0.67, 0, width * 0.33, 4).fill(colors.red);
    doc.restore();
  };
  doc.on("pageAdded", paintBackground);
  paintBackground();

  const panel = (x, y, panelWidth, panelHeight, accent = colors.cyan) => {
    doc.save();
    doc.roundedRect(x, y, panelWidth, panelHeight, 7).fillAndStroke(
      colors.panel,
      colors.line,
    );
    doc.rect(x, y, 4, panelHeight).fill(accent);
    doc.restore();
  };
  const drawAwardIcon = (label, centerX, centerY, radius, color) => {
    const scale = radius / 15;
    const line = 1.7 * scale;
    const point = (x, y) => [centerX + x * scale, centerY + y * scale];
    const strokePath = (points, close = false) => {
      doc.moveTo(...point(...points[0]));
      points.slice(1).forEach(([x, y]) => doc.lineTo(...point(x, y)));
      if (close) doc.closePath();
      doc.stroke();
    };
    const strokeCurve = (start, control1, control2, end) => {
      doc
        .moveTo(...point(...start))
        .bezierCurveTo(
          ...point(...control1),
          ...point(...control2),
          ...point(...end),
        )
        .stroke();
    };
    doc.save();
    doc
      .lineWidth(line)
      .lineCap("round")
      .lineJoin("round")
      .strokeColor(color)
      .fillColor(color);
    doc.circle(centerX, centerY, radius).stroke();
    if (label === "T Bar") {
      strokePath([[-7, -7], [7, -7]]);
      strokePath([[0, -7], [0, 8]]);
      doc.roundedRect(centerX - 4 * scale, centerY - 1.5 * scale, 8 * scale, 4 * scale, 1.5 * scale).fill();
    } else if (label === "Diversity") {
      [[0, -7], [-7, -1], [7, -1], [-4, 7], [4, 7]].forEach(([x, y]) =>
        doc.circle(...point(x, y), 2.1 * scale).fill(),
      );
    } else if (label === "Half-Mix") {
      doc
        .save()
        .fillOpacity(0.2)
        .polygon(point(-8, -8), point(8, -8), point(-8, 8))
        .fill(color)
        .restore();
      doc.roundedRect(...point(-8, -8), 16 * scale, 16 * scale, 1.5 * scale).stroke();
      strokePath([[-8, 8], [8, -8]]);
      strokePath([[-7, 3], [-3, 7]]);
      strokePath([[-7, -2], [2, 7]]);
    } else if (label === "Dual ME") {
      doc.roundedRect(...point(-9, -8), 14 * scale, 9 * scale, 1.5 * scale).stroke();
      doc.roundedRect(...point(-5, 0), 14 * scale, 9 * scale, 1.5 * scale).stroke();
    } else if (label === "Bum Cut") {
      strokeCurve([-8, -5], [-4, -8], [4, -8], [8, -5]);
      strokeCurve([-8, -5], [-10, 1], [-6, 9], [-1, 8]);
      strokeCurve([8, -5], [10, 1], [6, 9], [1, 8]);
      strokeCurve([0, -3], [-1, 0], [-1, 4], [0, 7]);
    } else if (label === "6/7") {
      doc
        .font("Helvetica-Bold")
        .fontSize(7.5 * scale)
        .fillColor(color)
        .text("6/7", centerX - 10 * scale, centerY - 4.8 * scale, {
          width: 20 * scale,
          align: "center",
        });
    } else if (label === "NIDA") {
      strokeCurve([-9, 6], [-5, -11], [3, 10], [9, -6]);
      strokeCurve([-9, -4], [-2, 5], [2, -5], [9, 4]);
      doc.circle(...point(-7, -7), 1.6 * scale).fill();
      doc.circle(...point(7, 7), 1.6 * scale).fill();
      strokePath([[-5, 8], [0, 4], [5, 8]]);
    } else if (label === "Prime Time") {
      [
        ["2", -9],
        ["3", -2.5],
        ["5", 4],
      ].forEach(([number, x]) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(6.5 * scale)
          .fillColor(color)
          .text(number, centerX + x * scale, centerY - 4.5 * scale, {
            width: 5 * scale,
            align: "center",
          });
      });
      doc.circle(...point(-3.2, 0), 0.9 * scale).fill();
      doc.circle(...point(3.2, 0), 0.9 * scale).fill();
      strokePath([[-9, 6], [9, 6]]);
    } else if (label === "Fibonacci") {
      doc.arc(centerX, centerY - 2 * scale, 2 * scale, 0, 300).stroke();
      doc.arc(centerX, centerY - 2 * scale, 5 * scale, 300, 610).stroke();
      doc.arc(centerX, centerY - 2 * scale, 9 * scale, 610, 920).stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(3.7 * scale)
        .fillColor(color)
        .text("1 1 2 3 5", centerX - 10 * scale, centerY + 6 * scale, {
          width: 20 * scale,
          align: "center",
        });
    } else if (label === "Pi Time") {
      strokePath([[-9, -6], [9, -6]]);
      strokePath([[-7, -8], [-7, -4]]);
      strokePath([[7, -8], [7, -4]]);
      strokeCurve([-5, -6], [-4, -1], [-5, 5], [-7, 8]);
      strokeCurve([4, -6], [3, -1], [4, 5], [6, 8]);
      strokePath([[-8, 8], [-5, 8]]);
      strokePath([[4, 8], [8, 8]]);
    } else if (label === "Prime Ladder") {
      strokePath([[-9, 8], [-4, 8], [-4, 3], [1, 3], [1, -2], [6, -2], [6, -8], [9, -8]]);
      [[-7, 5], [-1, 0], [4, -5], [9, -8]].forEach(([x, y]) =>
        doc.circle(...point(x, y), 1.6 * scale).fill(),
      );
    } else if (label === "Golden Run") {
      const star = [];
      for (let index = 0; index < 10; index += 1) {
        const angle = -Math.PI / 2 + (index * Math.PI) / 5;
        const distance = (index % 2 === 0 ? 9 : 4) * scale;
        star.push([centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance]);
      }
      doc.polygon(...star).stroke();
    } else if (label === "Transition Tango") {
      strokeCurve([-9, 4], [-4, 1], [2, 4], [8, 1]);
      strokeCurve([-8, 2], [-3, 6], [3, 6], [8, 2]);
      strokePath([[-8, 3], [7, 0]]);
      [[6, -3], [8, -2], [9, 0], [8, 2], [6, 3], [4, 2], [3, 0], [4, -2]].forEach(
        ([x, y]) => doc.circle(...point(x, y), 1.3 * scale).stroke(),
      );
      strokePath([[0, 1], [-3, -4], [-6, -2]]);
    } else if (label === "Rapid Fire") {
      strokePath([[-9, -5], [2, -5]]);
      strokePath([[-9, 0], [7, 0]]);
      strokePath([[-9, 5], [2, 5]]);
      strokePath([[4, -7], [10, 0], [4, 7]], true);
      doc.fill();
    } else if (label === "Homecoming") {
      strokePath([[-9, -1], [0, -9], [9, -1]]);
      strokePath([[-7, -1], [-7, 8], [7, 8], [7, -1]]);
      doc.rect(...point(-2, 2), 4 * scale, 6 * scale).stroke();
    } else if (label === "N*Sync") {
      [-7, 0, 7].forEach((x, index) => {
        doc.circle(...point(x, -7), 1.8 * scale).fill();
        strokePath([[x, -5], [x, 3]]);
        strokePath([[x, 3], [x - 2.5, 9]]);
        strokePath([[x, 3], [x + 2.5, 9]]);
        strokePath([[x, -3], [x - (index === 1 ? 4 : 3), 1]]);
        strokePath([[x, -3], [x, 3]]);
      });
    }
    doc.restore();
  };
  const sectionTitle = (title, subtitle, x, y, sectionWidth) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(colors.text)
      .text(title, x, y, { width: sectionWidth * 0.7 });
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.cyan)
      .text(String(subtitle || "").toUpperCase(), x, y + 5, {
        width: sectionWidth,
        align: "right",
      });
  };
  const statCard = (x, y, cardWidth, label, value, detail, accent) => {
    panel(x, y, cardWidth, 76, accent);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.muted)
      .text(label, x + 15, y + 13, { width: cardWidth - 28 });
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .fillColor(colors.text)
      .text(String(value), x + 15, y + 29, {
        width: cardWidth - 28,
        height: 28,
        ellipsis: true,
      });
    if (detail) {
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor(colors.muted)
        .text(String(detail), x + 15, y + 61, {
          width: cardWidth - 28,
          ellipsis: true,
        });
    }
  };
  if (PCC_COGS_BUFFER) {
    doc.image(PCC_COGS_BUFFER, 31, 18, {
      fit: [76, 76],
      align: "center",
      valign: "center",
    });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(colors.cyan)
    .text(REPORT_BRAND_TITLE, 120, 31, {
      characterSpacing: 1.2,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(30)
    .fillColor(colors.text)
    .text(report.show.name, 120, 46, { width: 560, ellipsis: true });
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(colors.cyan)
    .text(String(report.show.status || "").toUpperCase(), 692, 38, {
      width: 112,
      align: "right",
    });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(colors.muted)
    .text(new Date(report.show.startedAt).toLocaleString("en-AU"), 650, 55, {
      width: 154,
      align: "right",
    });
  doc
    .moveTo(34, 94)
    .lineTo(width - 34, 94)
    .lineWidth(2)
    .strokeColor(colors.line)
    .stroke();

  const cardGap = 10;
  const cardWidth = (width - 68 - cardGap * 3) / 4;
  const summaryCards = [
    ["Show Duration", formatDuration(showDuration), "", colors.cyan],
    ["Total Takes", totalTakes, `${(totalTakes / showMinutes).toFixed(1)} per minute`, colors.gold],
    ["Cuts Per Minute", (transitions.cut / showMinutes).toFixed(1), `${transitions.cut} total cuts`, colors.purple],
    ["Transitions Per Minute", (totalTakes / showMinutes).toFixed(1), "Cuts, mixes and others", colors.cyan],
    ["Active Sources", sources.length, "Black excluded", colors.gold],
    ["Average Shot", formatDuration(averageShot), `${activeUses} selections`, colors.cyan],
    ["Black / Holding", formatDuration(blackSource?.milliseconds || 0), `${(((blackSource?.milliseconds || 0) / Math.max(1, totalAirtime + (blackSource?.milliseconds || 0))) * 100).toFixed(1)}% of program time`, colors.purple],
    ["Wrong-Bus Alerts", report.wrongBusAlerts || 0, "Dennis Mode", colors.red],
  ];
  summaryCards.forEach((card, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    statCard(
      34 + column * (cardWidth + cardGap),
      111 + row * 86,
      cardWidth,
      card[0],
      card[1],
      card[2],
      card[3],
    );
  });

  panel(34, 292, 474, 269, colors.cyan);
  sectionTitle("Source Share", "Black Excluded", 54, 311, 434);
  const topSources = sortedSources.slice(0, 9);
  topSources.forEach((source, index) => {
    const rowY = 348 + index * 22;
    const share = (source.milliseconds / totalAirtime) * 100;
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.text)
      .text(`${index + 1}. ${source.name}`, 54, rowY, {
        width: 125,
        ellipsis: true,
      });
    doc.roundedRect(182, rowY + 1, 245, 8, 4).fill("#1C2732");
    doc
      .roundedRect(182, rowY + 1, Math.max(2, 245 * (share / 100)), 8, 4)
      .fill(index === 0 ? colors.red : colors.cyan);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.text)
      .text(`${share.toFixed(1)}%`, 437, rowY, { width: 49, align: "right" });
  });

  panel(522, 292, 285, 269, colors.red);
  sectionTitle("Transition Mix", `${totalTakes} Takes`, 542, 311, 245);
  const donutX = 625;
  const donutY = 430;
  const donutOuterRadius = 77;
  const donutInnerRadius = 51;
  const cutAngle = totalTakes ? (transitions.cut / totalTakes) * 360 : 0;
  const mixAngle = totalTakes ? (transitions.mix / totalTakes) * 360 : 0;
  const otherAngle = Math.max(0, 360 - cutAngle - mixAngle);
  const drawDonutSegment = (startAngle, angle, color) => {
    if (angle <= 0) return;
    const steps = Math.max(2, Math.ceil(angle / 3));
    const pointAt = (radius, degrees) => {
      const radians = (degrees * Math.PI) / 180;
      return [
        donutX + Math.cos(radians) * radius,
        donutY + Math.sin(radians) * radius,
      ];
    };
    doc.save().fillColor(color);
    doc.moveTo(...pointAt(donutOuterRadius, startAngle));
    for (let step = 1; step <= steps; step += 1) {
      doc.lineTo(
        ...pointAt(
          donutOuterRadius,
          startAngle + (angle * step) / steps,
        ),
      );
    }
    for (let step = steps; step >= 0; step -= 1) {
      doc.lineTo(
        ...pointAt(
          donutInnerRadius,
          startAngle + (angle * step) / steps,
        ),
      );
    }
    doc.closePath().fill().restore();
  };
  if (totalTakes) {
    let segmentStart = -90;
    drawDonutSegment(segmentStart, cutAngle, colors.red);
    segmentStart += cutAngle;
    drawDonutSegment(segmentStart, mixAngle, colors.cyan);
    segmentStart += mixAngle;
    drawDonutSegment(segmentStart, otherAngle, colors.muted);
  } else {
    doc
      .lineWidth(donutOuterRadius - donutInnerRadius)
      .strokeColor("#26313D")
      .circle(
        donutX,
        donutY,
        (donutOuterRadius + donutInnerRadius) / 2,
      )
      .stroke();
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(colors.text)
    .text(String(totalTakes), donutX - 42, donutY - 10, {
      width: 84,
      align: "center",
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(colors.muted)
    .text("TAKES", donutX - 42, donutY + 18, { width: 84, align: "center" });
  [
    ["CUT", transitions.cut, colors.red],
    ["MIX", transitions.mix, colors.cyan],
    ["OTHER", transitions.other, colors.muted],
  ].forEach(([label, value, color], index) => {
    const legendY = 382 + index * 34;
    doc.rect(714, legendY, 8, 22).fill(color);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.muted)
      .text(label, 731, legendY + 1);
    doc
      .font("Helvetica-Bold")
      .fontSize(15)
      .fillColor(colors.text)
      .text(String(value), 731, legendY + 10);
  });

  doc.addPage();
  doc
    .font("Helvetica-Bold")
    .fontSize(25)
    .fillColor(colors.text)
    .text("Show Rhythm and Award Cabinet", 34, 28);
  panel(34, 84, 773, 205, colors.purple);
  sectionTitle("Take Activity Over Time", "60 Equal Periods", 54, 103, 733);
  const bucketCount = 60;
  const buckets = Array.from({ length: bucketCount }, () => 0);
  for (const event of report.events || []) {
    const offset = Math.max(0, new Date(event.at).getTime() - startedAt);
    const bucket = Math.min(
      bucketCount - 1,
      Math.floor((offset / showDuration) * bucketCount),
    );
    buckets[bucket] += 1;
  }
  const peak = Math.max(1, ...buckets);
  const chartX = 54;
  const chartY = 145;
  const chartWidth = 733;
  const chartHeight = 72;
  for (let line = 0; line <= 4; line += 1) {
    const lineY = chartY + (chartHeight / 4) * line;
    doc
      .moveTo(chartX, lineY)
      .lineTo(chartX + chartWidth, lineY)
      .lineWidth(0.5)
      .strokeColor(colors.line)
      .stroke();
  }
  const barGap = 2;
  const activityBarWidth = (chartWidth - barGap * (bucketCount - 1)) / bucketCount;
  buckets.forEach((count, index) => {
    const activityHeight = (count / peak) * chartHeight;
    doc
      .roundedRect(
        chartX + index * (activityBarWidth + barGap),
        chartY + chartHeight - activityHeight,
        activityBarWidth,
        Math.max(1, activityHeight),
        2,
      )
      .fill(index % 3 === 0 ? colors.cyan : colors.purple);
  });
  const activityAxisPositions = [0, 0.25, 0.5, 0.75, 1];
  const activityAxisY = chartY + chartHeight;
  doc
    .moveTo(chartX, activityAxisY)
    .lineTo(chartX + chartWidth, activityAxisY)
    .lineWidth(0.7)
    .strokeColor(colors.line)
    .stroke();
  activityAxisPositions.forEach((position, index) => {
    const tickX = chartX + chartWidth * position;
    const label = new Date(startedAt + showDuration * position).toLocaleTimeString(
      "en-AU",
      { hour: "numeric", minute: "2-digit" },
    );
    doc
      .moveTo(tickX, activityAxisY)
      .lineTo(tickX, activityAxisY + 4)
      .lineWidth(0.7)
      .strokeColor(colors.muted)
      .stroke();
    const labelWidth = 70;
    const labelX =
      index === 0
        ? tickX
        : index === activityAxisPositions.length - 1
          ? tickX - labelWidth
          : tickX - labelWidth / 2;
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor(colors.muted)
      .text(label, labelX, activityAxisY + 6, {
        width: labelWidth,
        align:
          index === 0
            ? "left"
            : index === activityAxisPositions.length - 1
              ? "right"
              : "center",
      });
  });
  const pdfPeriodDuration = formatDuration(showDuration / bucketCount).replace(
    /^0h 0?/,
    "",
  );
  const pdfUntimedTakes = Math.max(
    0,
    totalTakes - (report.events || []).length,
  );
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(colors.text)
    .text(
      `READ: left to right follows the show; each bar is ${pdfPeriodDuration}. Height = ME1 Program changes (CUT + MIX + OTHER).`,
      54,
      241,
      { width: 733 },
    );
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(colors.muted)
    .text(
      "INTERPRET: tall clusters = fast, high-energy switching; short or flat sections = longer shots, holding or pauses. Colours are visual separators only.",
      54,
      252,
      { width: 733 },
    );
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor(colors.cyan)
    .text(
      "USE: match peaks and lulls to the rundown to find sections that felt rushed, slow or inconsistent, then adjust shot choices, cues or rehearsal.",
      54,
      263,
      { width: 733 },
    );
  if (pdfUntimedTakes) {
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor(colors.gold)
      .text(
        `DATA COVERAGE: ${(report.events || []).length.toLocaleString()} timestamped takes are charted; ${pdfUntimedTakes.toLocaleString()} earlier takes remain in totals but cannot be placed on the timeline.`,
        54,
        275,
        { width: 733 },
      );
  }

  panel(34, 305, 773, 250, colors.gold);
  sectionTitle("Award Scoreboard", "ME1 + ME2", 54, 324, 733);
  const sequenceAwards = special.sequenceAwards;
  const awards = [
    ["T Bar", Math.floor(transitions.mix / 10), colors.gold],
    ["Diversity", diversity.awards, colors.cyan],
    ["Half-Mix", special.halfMixAwards, colors.gold],
    ["Dual ME", special.dualMeAwards, colors.purple],
    ["Bum Cut", special.bumCuts, colors.red],
    ["6/7", special.sixSevenBonuses, colors.cyan],
    ["NIDA", special.nidaAwards, colors.purple],
    ["Prime Time", special.primeAwards, colors.gold],
    ["Fibonacci", special.fibonacciAwards, colors.green],
    ["Pi Time", sequenceAwards.piTime, colors.purple],
    ["Prime Ladder", sequenceAwards.primeLadder, colors.cyan],
    ["Golden Run", sequenceAwards.goldenRun, colors.gold],
    ["Transition Tango", sequenceAwards.transitionTango, colors.purple],
    ["Rapid Fire", sequenceAwards.rapidFire, colors.red],
    ["Homecoming", sequenceAwards.homecoming, colors.cyan],
    ["N*Sync", sequenceAwards.nSync, colors.green],
  ];
  const tileGap = 8;
  const tileWidth = (733 - tileGap * 7) / 8;
  awards.forEach(([label, count, color], index) => {
    const column = index % 8;
    const row = Math.floor(index / 8);
    const tileX = 54 + column * (tileWidth + tileGap);
    const tileY = 360 + row * 91;
    doc
      .roundedRect(tileX, tileY, tileWidth, 82, 6)
      .fillAndStroke(colors.panelAlt, colors.line);
    drawAwardIcon(label, tileX + tileWidth / 2, tileY + 24, 15, color);
    doc
      .font("Helvetica-Bold")
      .fontSize(17)
      .fillColor(colors.text)
      .text(String(count || 0), tileX + 5, tileY + 42, {
        width: tileWidth - 10,
        align: "center",
      });
    doc
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .fillColor(colors.muted)
      .text(label === "Transition Tango" ? "Tango" : String(label), tileX + 5, tileY + 64, {
        width: tileWidth - 10,
        align: "center",
        ellipsis: true,
      });
  });

  doc.addPage();
  doc
    .font("Helvetica-Bold")
    .fontSize(25)
    .fillColor(colors.text)
    .text("What Each Award Represents", 34, 28);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(colors.cyan)
    .text("AWARD SCOREBOARD GUIDE", 34, 59, { characterSpacing: 1.5 });
  const guideGap = 10;
  const guideWidth = (width - 68 - guideGap * 3) / 4;
  const guideHeight = 101;
  AWARD_GUIDE.forEach(([_symbol, label, description, colorName], index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const guideX = 34 + column * (guideWidth + guideGap);
    const guideY = 88 + row * (guideHeight + guideGap);
    const guideColor = colors[colorName] || colors.cyan;
    panel(guideX, guideY, guideWidth, guideHeight, guideColor);
    drawAwardIcon(label, guideX + 28, guideY + 28, 15, guideColor);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(colors.text)
      .text(String(label), guideX + 52, guideY + 19, {
        width: guideWidth - 64,
        height: 18,
        ellipsis: true,
      });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(colors.muted)
      .text(String(description).replaceAll("→", "->"), guideX + 16, guideY + 52, {
        width: guideWidth - 32,
        height: 38,
        lineGap: 2,
        ellipsis: true,
      });
  });

  doc.addPage();
  doc
    .font("Helvetica-Bold")
    .fontSize(25)
    .fillColor(colors.text)
    .text("Performance Detail", 34, 28);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(colors.cyan)
    .text("SOURCE USE / ME2 / PRECISION", 34, 59, { characterSpacing: 1.5 });
  const mostSelected = [...sources].sort((a, b) => b.uses - a.uses)[0];
  const detailCards = [
    ["Top Source", sortedSources[0]?.name || "-", sortedSources[0] ? formatDuration(sortedSources[0].milliseconds) : "", colors.cyan],
    ["Most Selected", mostSelected?.name || "-", `${mostSelected?.uses || 0} uses`, colors.gold],
    ["Longest Cut Streak", (() => {
      let best = 0;
      let run = 0;
      for (const event of [...(report.events || [])].reverse()) {
        run = event.type === "CUT" ? run + 1 : 0;
        best = Math.max(best, run);
      }
      return best;
    })(), "consecutive cuts", colors.red],
    ["ME2 Takes", me2Takes, `${me2.transitions?.mix || 0} mixes`, colors.purple],
  ];
  detailCards.forEach((card, index) => {
    statCard(
      34 + index * (cardWidth + cardGap),
      84,
      cardWidth,
      card[0],
      card[1],
      card[2],
      card[3],
    );
  });
  panel(34, 178, 470, 363, colors.cyan);
  sectionTitle("Source Selection Frequency", "Program Selections", 54, 198, 430);
  const maximumUses = Math.max(1, ...sortedSources.map((source) => source.uses));
  sortedSources.slice(0, 12).forEach((source, index) => {
    const rowY = 238 + index * 23;
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.text)
      .text(`${index + 1}. ${source.name}`, 54, rowY, {
        width: 135,
        ellipsis: true,
      });
    doc.roundedRect(194, rowY + 1, 240, 9, 4).fill("#1C2732");
    doc
      .roundedRect(
        194,
        rowY + 1,
        Math.max(2, 240 * (source.uses / maximumUses)),
        9,
        4,
      )
      .fill(index === 0 ? colors.gold : colors.cyan);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.text)
      .text(String(source.uses), 443, rowY, { width: 39, align: "right" });
  });
  panel(518, 178, 289, 363, colors.purple);
  sectionTitle("Precision Records", "Best Moments", 538, 198, 249);
  const precisionRows = [
    ["Best 45-sec diversity", diversity.bestCount, colors.cyan],
    ["Diversity XP", diversity.totalPoints.toLocaleString(), colors.purple],
    ["Fibonacci B / S / G", `${special.fibonacciTiers?.bronze || 0} / ${special.fibonacciTiers?.silver || 0} / ${special.fibonacciTiers?.gold || 0}`, colors.green],
    ["Longest half-mix", formatDuration(special.halfMixDurations?.[0]?.durationMs || 0), colors.gold],
    ["ME2 cut / mix", `${me2.transitions?.cut || 0} / ${me2.transitions?.mix || 0}`, colors.cyan],
    ["Black / holding", formatDuration(blackSource?.milliseconds || 0), colors.red],
  ];
  precisionRows.forEach(([label, value, color], index) => {
    const rowY = 238 + index * 47;
    doc.rect(538, rowY, 4, 33).fill(color);
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(colors.muted)
      .text(String(label).toUpperCase(), 552, rowY + 2, { width: 135 });
    doc
      .font("Helvetica-Bold")
      .fontSize(17)
      .fillColor(colors.text)
      .text(String(value), 552, rowY + 14, { width: 220, ellipsis: true });
  });

  const awardByTime = new Map();
  const addAwardAt = (at, label) => {
    const key = new Date(at).getTime();
    if (!Number.isFinite(key)) return;
    const current = awardByTime.get(key) || [];
    if (!current.includes(label)) current.push(label);
    awardByTime.set(key, current);
  };
  const addAwards = (events, label) => {
    for (const event of events || []) {
      if (event.me && event.me !== "ME1") continue;
      addAwardAt(event.at, label);
    }
  };
  addAwards(special.bumCutEvents, "Bum Cut");
  addAwards(special.sixSevenEvents, "6/7");
  addAwards(special.nidaEvents, "NIDA");
  addAwards(special.primeEvents, "Prime Time");
  addAwards(special.fibonacciEvents, "Fibonacci");
  for (const event of special.sequenceEvents || []) {
    if (event.me && event.me !== "ME1") continue;
    const labels = {
      piTime: "Pi Time",
      primeLadder: "Prime Ladder",
      goldenRun: "Golden Run",
      transitionTango: "Transition Tango",
      rapidFire: "Rapid Fire",
      homecoming: "Homecoming",
      nSync: "N*Sync",
    };
    addAwardAt(event.at, labels[event.key] || "Award");
  }
  const chronologicalPdfEvents = [...(report.events || [])].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  let pdfMixSequence = 0;
  const pdfDiversitySources = new Map();
  for (const event of chronologicalPdfEvents) {
    if (event.type === "MIX") {
      pdfMixSequence += 1;
      if (pdfMixSequence % 10 === 0) addAwardAt(event.at, "T Bar");
    }
    const round = Math.max(
      0,
      Math.floor((new Date(event.at).getTime() - startedAt) / 45_000),
    );
    if (!pdfDiversitySources.has(round)) {
      pdfDiversitySources.set(round, new Set());
    }
    const sourcesInRound = pdfDiversitySources.get(round);
    const before = sourcesInRound.size;
    for (const name of [event.from, event.to]) {
      const normalized = String(name || "").trim();
      if (normalized && normalized.toLowerCase() !== "black") {
        sourcesInRound.add(normalized);
      }
    }
    if (before < 5 && sourcesInRound.size >= 5) {
      addAwardAt(event.at, "Diversity");
    }
  }
  for (const hold of special.halfMixDurations || []) {
    if (hold.me !== "ME1" || chronologicalPdfEvents.length === 0) continue;
    const holdAt = new Date(hold.at).getTime();
    const closest = chronologicalPdfEvents.reduce((best, event) => {
      const distance = Math.abs(new Date(event.at).getTime() - holdAt);
      return distance < best.distance ? { event, distance } : best;
    }, { event: null, distance: Infinity });
    if (closest.event && closest.distance <= 30_000) {
      addAwardAt(closest.event.at, "Half-Mix");
    }
  }
  const pdfAwardColors = {
    "T Bar": colors.gold,
    Diversity: colors.cyan,
    "Half-Mix": colors.gold,
    "Bum Cut": colors.red,
    "6/7": colors.cyan,
    NIDA: colors.purple,
    "Prime Time": colors.gold,
    Fibonacci: colors.green,
    "Pi Time": colors.purple,
    "Prime Ladder": colors.cyan,
    "Golden Run": colors.gold,
    "Transition Tango": colors.purple,
    "Rapid Fire": colors.red,
    Homecoming: colors.cyan,
    "N*Sync": colors.green,
  };
  const recentEvents = (report.events || []).slice(0, 120);
  const rowsPerPage = 20;
  for (let pageStart = 0; pageStart < recentEvents.length; pageStart += rowsPerPage) {
    doc.addPage();
    const pageEvents = recentEvents.slice(pageStart, pageStart + rowsPerPage);
    doc
      .font("Helvetica-Bold")
      .fontSize(23)
      .fillColor(colors.text)
      .text("Recent Transition Log", 34, 27);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(colors.cyan)
      .text(
        `TRANSITIONS ${pageStart + 1}-${pageStart + pageEvents.length} OF ${report.events?.length || 0} / FULL LOG IN CSV`,
        34,
        56,
        { characterSpacing: 1.1 },
      );
    const columns = [
      ["TIME", 34, 90],
      ["FROM", 130, 165],
      ["TO", 305, 165],
      ["TYPE", 480, 70],
      ["AWARDS", 560, 247],
    ];
    doc.roundedRect(34, 82, 773, 28, 4).fill("#17212C");
    columns.forEach(([label, x, columnWidth]) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor(colors.muted)
        .text(label, x + 8, 92, { width: columnWidth - 12 });
    });
    pageEvents.forEach((event, index) => {
      const rowY = 112 + index * 21.5;
      if (index % 2 === 0) doc.rect(34, rowY, 773, 21.5).fill("#0C1219");
      doc
        .moveTo(34, rowY + 21.5)
        .lineTo(807, rowY + 21.5)
        .lineWidth(0.4)
        .strokeColor(colors.line)
        .stroke();
      const typeColor =
        event.type === "CUT"
          ? colors.red
          : event.type === "MIX"
            ? colors.cyan
            : colors.gold;
      const values = [
        new Date(event.at).toLocaleTimeString("en-AU"),
        event.from,
        event.to,
        event.type,
      ];
      columns.slice(0, 4).forEach(([, x, columnWidth], columnIndex) => {
        doc
          .font(columnIndex === 3 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(8.5)
          .fillColor(columnIndex === 3 ? typeColor : colors.text)
          .text(String(values[columnIndex] || "-"), x + 8, rowY + 6, {
            width: columnWidth - 14,
            height: 11,
            ellipsis: true,
          });
      });
      const eventAwards =
        awardByTime.get(new Date(event.at).getTime()) || [];
      if (eventAwards.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(colors.muted)
          .text("-", 568, rowY + 6);
      } else {
        eventAwards.slice(0, 11).forEach((label, awardIndex) => {
          drawAwardIcon(
            label,
            575 + awardIndex * 19,
            rowY + 10.75,
            7,
            pdfAwardColors[label] || colors.purple,
          );
        });
      }
    });
  }

  const pageRange = doc.bufferedPageRange();
  for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex += 1) {
    doc.switchToPage(pageRange.start + pageIndex);
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(colors.muted)
      .text(REPORT_BRAND_TITLE, 34, height - 22, {
        width: 300,
        characterSpacing: 0.8,
      });
    doc
      .font("Helvetica-Bold")
      .fontSize(7)
      .fillColor(colors.muted)
      .text(`PAGE ${pageIndex + 1} / ${pageRange.count}`, width - 160, height - 22, {
        width: 126,
        align: "right",
      });
  }
  doc.end();
};

const reportCsv = (report) => {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const blackSource = report.sources.find(
    (source) =>
      source.id === 0 || source.name.trim().toLowerCase() === "black",
  );
  const activeSources = report.sources.filter(
    (source) =>
      source.id !== 0 && source.name.trim().toLowerCase() !== "black",
  );
  const diversity = diversityRoundStats(report);
  const me2 = report.me2 || {
    sources: [],
    transitions: { cut: 0, mix: 0, other: 0 },
  };
  const me2Takes =
    me2.transitions.cut + me2.transitions.mix + me2.transitions.other;
  const csvStartedAt = report.show?.startedAt
    ? new Date(report.show.startedAt).getTime()
    : Date.now();
  const csvEndedAt = report.show?.stoppedAt
    ? new Date(report.show.stoppedAt).getTime()
    : report.updatedAt
      ? new Date(report.updatedAt).getTime()
      : Date.now();
  const csvMinutes = Math.max(
    1 / 60,
    (csvEndedAt - csvStartedAt) / 60_000,
  );
  const csvTakes =
    report.transitions.cut +
    report.transitions.mix +
    report.transitions.other;
  const special = report.special || {
    halfMixAwards: 0,
    halfMixDurations: [],
    dualMeAwards: 0,
    bumCuts: 0,
    sixSevenBonuses: 0,
    nidaAwards: 0,
    primeAwards: 0,
    fibonacciAwards: 0,
    fibonacciTiers: { bronze: 0, silver: 0, gold: 0 },
    sequenceAwards: freshSequenceAwards(),
  };
  special.sequenceAwards = {
    ...freshSequenceAwards(),
    ...(special.sequenceAwards || {}),
  };
  const lines = [
    ["Show", report.show.name],
    ["Started", report.show.startedAt],
    ["Stopped", report.show.stoppedAt || ""],
    ["Cuts", report.transitions.cut],
    ["Cuts per minute", (report.transitions.cut / csvMinutes).toFixed(2)],
    ["Mixes", report.transitions.mix],
    ["Transitions per minute", (csvTakes / csvMinutes).toFixed(2)],
    ["Diversity XP (45-second rounds)", diversity.totalPoints],
    ["Diversity Awards", diversity.awards],
    ["Best 45-second diversity", diversity.bestCount],
    ["Black / holding time (seconds)", ((blackSource?.milliseconds || 0) / 1000).toFixed(1)],
    ["ME2 takes", me2Takes],
    ["ME2 cuts", me2.transitions.cut],
    ["ME2 mixes", me2.transitions.mix],
    ["ME2 Take Awards", Math.floor(me2Takes / 10)],
    ["ME2 Mix Awards", Math.floor(me2.transitions.mix / 5)],
    ["Long Half-Mix Awards", special.halfMixAwards],
    ["Dual ME Awards", special.dualMeAwards],
    ["Bum Cuts", special.bumCuts],
    ["6/7 Awards", special.sixSevenBonuses || 0],
    ["NIDA Wipe Awards", special.nidaAwards || 0],
    ["Prime Time Awards", special.primeAwards || 0],
    ["Fibonacci Awards", special.fibonacciAwards || 0],
    ["Fibonacci Bronze", special.fibonacciTiers?.bronze || 0],
    ["Fibonacci Silver", special.fibonacciTiers?.silver || 0],
    ["Fibonacci Gold", special.fibonacciTiers?.gold || 0],
    ["Pi Time Awards", special.sequenceAwards.piTime],
    ["Prime Ladder Awards", special.sequenceAwards.primeLadder],
    ["Golden Run Awards", special.sequenceAwards.goldenRun],
    ["Transition Tango Awards", special.sequenceAwards.transitionTango],
    ["Rapid Fire Awards", special.sequenceAwards.rapidFire],
    ["Homecoming Awards", special.sequenceAwards.homecoming],
    ["N*Sync Awards", special.sequenceAwards.nSync],
    ["Top Half-Mix Hold (seconds)", ((special.halfMixDurations[0]?.durationMs || 0) / 1000).toFixed(2)],
    [],
    ["Active source", "Program time (seconds)", "Uses"],
    ...activeSources
      .sort((a, b) => b.milliseconds - a.milliseconds)
      .map((source) => [
        source.name,
        (source.milliseconds / 1000).toFixed(1),
        source.uses,
      ]),
    [],
    ["Time", "From", "To", "Type"],
    ...report.events.map((event) => [event.at, event.from, event.to, event.type]),
  ];
  return lines.map((row) => row.map(quote).join(",")).join("\n");
};

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-cache");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.url === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
    });
    clients.add(response);
    response.write(`data: ${JSON.stringify(serializableState())}\n\n`);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (request.url === "/state") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(serializableState()));
    return;
  }
  if (request.url === "/settings" && request.method === "GET") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ atemAddress: state.address }));
    return;
  }
  if (request.url === "/settings" && request.method === "POST") {
    try {
      const body = await readBody(request);
      const address = String(body.atemAddress || "").trim();
      if (!validAtemAddress(address)) {
        throw new Error("Enter a valid ATEM IPv4 address, for example 192.168.206.99.");
      }
      await reconnectAtem(address);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(serializableState()));
    } catch (error) {
      response.statusCode = 400;
      response.end(error.message);
    }
    return;
  }
  if (request.url === "/shows") {
    const shows = readdirSync(SHOWS_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const show = JSON.parse(readFileSync(resolve(SHOWS_DIR, file), "utf8")).show;
        return show;
      })
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(shows));
    return;
  }
  if (request.url === "/control" && request.method === "POST") {
    try {
      const body = await readBody(request);
      if (body.action === "start") startShow(body.name);
      else if (body.action === "pause") pauseShow();
      else if (body.action === "stop") stopShow();
      else throw new Error("Unknown show action");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(serializableState()));
    } catch (error) {
      response.statusCode = 400;
      response.end(error.message);
    }
    return;
  }
  if (request.url?.startsWith("/report.pdf")) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const report = reportData(url.searchParams.get("show"));
    if (!report) {
      response.statusCode = 404;
      response.end("Show not found");
      return;
    }
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName(report.show.name).replaceAll(" ", "-") || "show"}-Switch-KPI.pdf"`,
    );
    writeReportPdf(report, response);
    return;
  }
  if (request.url?.startsWith("/report.csv")) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const report = reportData(url.searchParams.get("show"));
    if (!report) {
      response.statusCode = 404;
      response.end("Show not found");
      return;
    }
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName(report.show.name).replaceAll(" ", "-") || "show"}-ME1.csv"`,
    );
    response.end(reportCsv(report));
    return;
  }
  if (request.url?.startsWith("/report")) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const requestedShowId = url.searchParams.get("show");
    const report = reportData(requestedShowId);
    if (!report) {
      response.statusCode = 404;
      response.end("Show not found");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      reportHtml(report, {
        theme: url.searchParams.get("theme") === "light" ? "light" : "dark",
        showId: requestedShowId || report.show?.id || "",
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ATEM monitor listening on port ${PORT} for local network users`);
  console.log(`Connecting Switch KPI to the ATEM at ${state.address}…`);
  atem.connect(state.address);
});

setInterval(broadcast, 1000);
setInterval(() => {
  if (state.show.status !== "idle") persist();
}, 2000);

const shutdown = () => {
  if (state.show.status !== "idle") persist();
  atem.disconnect();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
