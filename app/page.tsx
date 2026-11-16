"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type SourceStat = {
  id: number;
  name: string;
  milliseconds: number;
  uses: number;
  live: boolean;
};

type RecentEvent = {
  id: string;
  at: string;
  from: string;
  to: string;
  fromId?: number;
  toId?: number;
  type: "CUT" | "MIX" | "OTHER";
  durationMs?: number;
};

type SequenceAwards = {
  piTime: number;
  primeLadder: number;
  goldenRun: number;
  transitionTango: number;
  rapidFire: number;
  homecoming: number;
  nSync: number;
};

type SequenceKey = keyof SequenceAwards;

type MonitorState = {
  connected: boolean;
  address: string;
  updatedAt: string;
  show: {
    id: string | null;
    name: string;
    status: "idle" | "running" | "paused" | "stopped";
    startedAt: string | null;
    pausedAt: string | null;
    stoppedAt: string | null;
  };
  program: { id: number; name: string } | null;
  preview: { id: number; name: string } | null;
  sources: SourceStat[];
  events: RecentEvent[];
  transitions: { cut: number; mix: number; other: number };
  previewChangesSinceTake: number;
  wrongBusAlerts: number;
  me2: {
    available: boolean;
    program: { id: number; name: string } | null;
    preview: { id: number; name: string } | null;
    sources: SourceStat[];
    events: RecentEvent[];
    transitions: { cut: number; mix: number; other: number };
  };
  special: {
    halfMixAwards: number;
    halfMixDurations: Array<{
      id: string;
      at: string;
      me: string;
      durationMs: number;
    }>;
    dualMeAwards: number;
    bumCuts: number;
    bumCutEvents: Array<{
      id: string;
      at: string;
      me: string;
      intervalMs: number;
    }>;
    sixSevenBonuses: number;
    sixSevenEvents: Array<{
      id: string;
      at: string;
      me: string;
      fromId: number;
      toId: number;
      fromName?: string;
      toName?: string;
      type: "CUT" | "MIX" | "OTHER";
    }>;
    nidaAwards: number;
    nidaEvents: Array<{
      id: string;
      at: string;
      me: string;
      fromId: number;
      toId: number;
    }>;
    primeAwards: number;
    primeEvents: Array<{
      id: string;
      at: string;
      me: string;
      sequence: number[];
    }>;
    fibonacciAwards: number;
    fibonacciTiers: {
      bronze: number;
      silver: number;
      gold: number;
    };
    fibonacciEvents: Array<{
      id: string;
      at: string;
      me: string;
      sequence: number[];
      level?: number;
      tier?: "bronze" | "silver" | "gold";
      uniqueSources?: number;
    }>;
    sequenceAwards: SequenceAwards;
    sequenceEvents: Array<{
      id: string;
      at: string;
      me: string;
      key: SequenceKey;
      label: string;
      detail: string;
      sequence: Array<string | number>;
    }>;
  };
  error: string | null;
};

const EMPTY: MonitorState = {
  connected: false,
  address: "192.168.206.99",
  updatedAt: new Date().toISOString(),
  show: {
    id: null,
    name: "No show started",
    status: "idle",
    startedAt: null,
    pausedAt: null,
    stoppedAt: null,
  },
  program: null,
  preview: null,
  sources: [],
  events: [],
  transitions: { cut: 0, mix: 0, other: 0 },
  previewChangesSinceTake: 0,
  wrongBusAlerts: 0,
  me2: {
    available: false,
    program: null,
    preview: null,
    sources: [],
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
    sequenceAwards: {
      piTime: 0,
      primeLadder: 0,
      goldenRun: 0,
      transitionTango: 0,
      rapidFire: 0,
      homecoming: 0,
      nSync: 0,
    },
    sequenceEvents: [],
  },
  error: null,
};

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
};

const clock = (iso: string) =>
  new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));

const displayedSourceNumber = (name: string, fallbackId: number) => {
  const match = name.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : fallbackId;
};

const isPrimeNumber = (value: number) => {
  if (!Number.isInteger(value) || value < 2) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) {
    if (value % divisor === 0) return false;
  }
  return true;
};

const PrimeMarker = ({ id, name }: { id: number; name: string }) => {
  const number = displayedSourceNumber(name, id);
  return isPrimeNumber(number) ? (
    <span
      className="prime-marker"
      title={`Prime-numbered source ${number}`}
      aria-label={`Prime-numbered source ${number}`}
    >
      ℙ
    </span>
  ) : null;
};

const isFibonacciNumber = (value: number) => {
  if (!Number.isInteger(value) || value < 1) return false;
  if (value === 1 || value === 2) return true;
  let previous = 1;
  let current = 2;
  while (current < value) {
    [previous, current] = [current, previous + current];
  }
  return current === value;
};

const FibonacciMarker = ({ id, name }: { id: number; name: string }) => {
  const number = displayedSourceNumber(name, id);
  return isFibonacciNumber(number) ? (
    <span
      className="fibonacci-marker"
      title={`Fibonacci-numbered source ${number}`}
      aria-label={`Fibonacci-numbered source ${number}`}
    >
      φ
    </span>
  ) : null;
};

const gameStats = (monitor: MonitorState, timestamp = Date.now()) => {
  const activeSources = monitor.sources.filter(
    (source) =>
      source.id !== 0 && source.name.trim().toLowerCase() !== "black",
  );
  const total =
    monitor.transitions.cut +
    monitor.transitions.mix +
    monitor.transitions.other;
  const awards = Math.floor(monitor.transitions.mix / 10);
  const showStartedAt = monitor.show?.startedAt
    ? new Date(monitor.show.startedAt).getTime()
    : timestamp;
  const roundLength = 45 * 1000;
  const currentRound = Math.max(
    0,
    Math.floor((timestamp - showStartedAt) / roundLength),
  );
  const roundSources = new Map<number, Set<string>>();
  const addRoundSource = (round: number, name: string) => {
    const normalized = name.trim();
    if (!normalized || normalized.toLowerCase() === "black") return;
    if (!roundSources.has(round)) roundSources.set(round, new Set());
    roundSources.get(round)?.add(normalized);
  };
  let lastSource: string | null = null;
  let lastRound = 0;
  for (const event of [...monitor.events].reverse()) {
    const eventTime = new Date(event.at).getTime();
    const round = Math.max(
      0,
      Math.floor((eventTime - showStartedAt) / roundLength),
    );
    if (lastSource && round > lastRound) {
      for (let index = lastRound + 1; index <= round; index += 1) {
        addRoundSource(index, lastSource);
      }
    }
    addRoundSource(round, event.from);
    addRoundSource(round, event.to);
    lastSource = event.to;
    lastRound = round;
  }
  if (lastSource && currentRound > lastRound) {
    for (let index = lastRound + 1; index <= currentRound; index += 1) {
      addRoundSource(index, lastSource);
    }
  }
  if (monitor.program) addRoundSource(currentRound, monitor.program.name);

  const pointsForSources = (count: number) =>
    count * 100 +
    (count >= 5 ? 250 : 0) +
    (count >= 8 ? 500 : 0) +
    (count >= 10 ? 750 : 0) +
    (count >= 12 ? 1000 : 0);
  const roundCounts = [...roundSources.values()].map((names) => names.size);
  const sourceCount = roundSources.get(currentRound)?.size ?? 0;
  const diversityPoints = pointsForSources(sourceCount);
  const totalDiversityPoints = roundCounts.reduce(
    (sum, count) => sum + pointsForSources(count),
    0,
  );
  const bestDiversityCount = Math.max(0, ...roundCounts);
  const diversityAwards = roundCounts.filter((count) => count >= 5).length;
  const roundEndsAt = showStartedAt + (currentRound + 1) * roundLength;
  const xp =
    monitor.transitions.cut * 8 +
    monitor.transitions.mix * 25 +
    monitor.transitions.other * 15 +
    totalDiversityPoints +
    awards * 200;
  const achievements = [
    { key: "first", label: "First Take", icon: "01", unlocked: total >= 1 },
    { key: "scout", label: "Source Scout", icon: "05", unlocked: activeSources.length >= 5 },
    { key: "cut25", label: "Cut Sprinter", icon: "25", unlocked: monitor.transitions.cut >= 25 },
    { key: "mix10", label: "Blend Boss", icon: "10", unlocked: monitor.transitions.mix >= 10 },
    { key: "tbar", label: "T Bar Hero", icon: "TB", unlocked: awards >= 1 },
    { key: "century", label: "Century Club", icon: "100", unlocked: total >= 100 },
    { key: "variety", label: "Full Deck", icon: "08", unlocked: activeSources.length >= 8 },
    { key: "cut200", label: "Cut Commander", icon: "200", unlocked: monitor.transitions.cut >= 200 },
  ];
  return {
    total,
    awards,
    xp,
    achievements,
    sourceCount,
    diversityPoints,
    totalDiversityPoints,
    bestDiversityCount,
    diversityAwards,
    currentRound: currentRound + 1,
    roundEndsAt,
  };
};

export default function Home() {
  const [data, setData] = useState<MonitorState>(EMPTY);
  const [now, setNow] = useState(Date.now());
  const [hydrated, setHydrated] = useState(false);
  const [showName, setShowName] = useState("");
  const [atemAddress, setAtemAddress] = useState(EMPTY.address);
  const [atemAddressDirty, setAtemAddressDirty] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [savedShows, setSavedShows] = useState<MonitorState["show"][]>([]);
  const [controlBusy, setControlBusy] = useState(false);
  const [awardVisible, setAwardVisible] = useState(false);
  const [achievementUnlock, setAchievementUnlock] = useState<string | null>(null);
  const [diversityBurst, setDiversityBurst] = useState<number | null>(null);
  const [diversityAwardVisible, setDiversityAwardVisible] = useState(false);
  const [wrongBusVisible, setWrongBusVisible] = useState(false);
  const [me2AwardMessage, setMe2AwardMessage] = useState<string | null>(null);
  const [specialAwardMessage, setSpecialAwardMessage] = useState<string | null>(null);
  const [bumCutVisible, setBumCutVisible] = useState(false);
  const [sixSevenVisible, setSixSevenVisible] = useState(false);
  const [nidaVisible, setNidaVisible] = useState(false);
  const [primeVisible, setPrimeVisible] = useState(false);
  const [fibonacciAlert, setFibonacciAlert] = useState<
    "bronze" | "silver" | "gold" | null
  >(null);
  const [sequenceAlert, setSequenceAlert] = useState<{
    key: SequenceKey;
    label: string;
    detail: string;
  } | null>(null);
  const [bingoLevelUp, setBingoLevelUp] = useState<number | null>(null);
  const previousMixes = useRef<number | null>(null);
  const previousAchievements = useRef<Set<string> | null>(null);
  const previousSourceCount = useRef<number | null>(null);
  const previousDiversityAwards = useRef<number | null>(null);
  const previousWrongBusAlerts = useRef<number | null>(null);
  const previousMe2TakeAwards = useRef<number | null>(null);
  const previousMe2MixAwards = useRef<number | null>(null);
  const previousHalfMixAwards = useRef<number | null>(null);
  const previousDualMeAwards = useRef<number | null>(null);
  const previousBumCuts = useRef<number | null>(null);
  const previousSixSevenBonuses = useRef<number | null>(null);
  const previousNidaAwards = useRef<number | null>(null);
  const previousPrimeAwards = useRef<number | null>(null);
  const previousFibonacciAwards = useRef<number | null>(null);
  const previousSequenceAwards = useRef<SequenceAwards | null>(null);
  const previousBingoLevel = useRef<number | null>(null);

  const monitorBase =
    hydrated && typeof window !== "undefined"
      ? `http://${window.location.hostname}:3001`
      : "http://localhost:3001";
  const show = data.show ?? EMPTY.show;

  useEffect(() => {
    setHydrated(true);
    let stream: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const monitorHost =
        typeof window === "undefined" ? "localhost" : window.location.hostname;
      stream = new EventSource(`http://${monitorHost}:3001/events`);
      stream.onmessage = (event) => {
        const nextData = JSON.parse(event.data) as MonitorState;
        nextData.show ??= EMPTY.show;
        nextData.previewChangesSinceTake ??= 0;
        nextData.wrongBusAlerts ??= 0;
        nextData.me2 ??= EMPTY.me2;
        nextData.special ??= EMPTY.special;
        nextData.special.sixSevenBonuses ??= 0;
        nextData.special.sixSevenEvents ??= [];
        nextData.special.nidaAwards ??= 0;
        nextData.special.nidaEvents ??= [];
        nextData.special.primeAwards ??= 0;
        nextData.special.primeEvents ??= [];
        nextData.special.fibonacciAwards ??= 0;
        nextData.special.fibonacciTiers ??= { bronze: 0, silver: 0, gold: 0 };
        nextData.special.fibonacciEvents ??= [];
        nextData.special.sequenceAwards ??= EMPTY.special.sequenceAwards;
        nextData.special.sequenceEvents ??= [];
        if (
          previousMixes.current !== null &&
          nextData.transitions.mix > 0 &&
          Math.floor(nextData.transitions.mix / 10) >
            Math.floor(previousMixes.current / 10)
        ) {
          setAwardVisible(true);
          window.setTimeout(() => setAwardVisible(false), 4200);
        }
        const nextGame = gameStats(nextData);
        if (
          previousSourceCount.current !== null &&
          nextGame.sourceCount > previousSourceCount.current
        ) {
          setDiversityBurst(nextGame.sourceCount);
          window.setTimeout(() => setDiversityBurst(null), 3200);
        }
        previousSourceCount.current = nextGame.sourceCount;
        if (
          previousDiversityAwards.current !== null &&
          nextGame.diversityAwards > previousDiversityAwards.current
        ) {
          setDiversityAwardVisible(true);
          window.setTimeout(() => setDiversityAwardVisible(false), 4500);
        }
        previousDiversityAwards.current = nextGame.diversityAwards;
        if (
          previousWrongBusAlerts.current !== null &&
          nextData.wrongBusAlerts > previousWrongBusAlerts.current
        ) {
          setWrongBusVisible(true);
          window.setTimeout(() => setWrongBusVisible(false), 4200);
        }
        previousWrongBusAlerts.current = nextData.wrongBusAlerts;
        const me2Takes =
          nextData.me2.transitions.cut +
          nextData.me2.transitions.mix +
          nextData.me2.transitions.other;
        const me2TakeAwards = Math.floor(me2Takes / 10);
        const me2MixAwards = Math.floor(nextData.me2.transitions.mix / 5);
        if (
          previousMe2MixAwards.current !== null &&
          me2MixAwards > previousMe2MixAwards.current
        ) {
          setMe2AwardMessage("ME2 MIX MASTER");
          window.setTimeout(() => setMe2AwardMessage(null), 4300);
        } else if (
          previousMe2TakeAwards.current !== null &&
          me2TakeAwards > previousMe2TakeAwards.current
        ) {
          setMe2AwardMessage("SECOND DECK AWARD");
          window.setTimeout(() => setMe2AwardMessage(null), 4300);
        }
        previousMe2TakeAwards.current = me2TakeAwards;
        previousMe2MixAwards.current = me2MixAwards;
        if (
          previousDualMeAwards.current !== null &&
          nextData.special.dualMeAwards > previousDualMeAwards.current
        ) {
          setSpecialAwardMessage("DUAL ME AWARD");
          window.setTimeout(() => setSpecialAwardMessage(null), 4400);
        } else if (
          previousHalfMixAwards.current !== null &&
          nextData.special.halfMixAwards > previousHalfMixAwards.current
        ) {
          setSpecialAwardMessage("LONG HALF-MIX AWARD");
          window.setTimeout(() => setSpecialAwardMessage(null), 4400);
        }
        if (
          previousBumCuts.current !== null &&
          nextData.special.bumCuts > previousBumCuts.current
        ) {
          setBumCutVisible(true);
          window.setTimeout(() => setBumCutVisible(false), 3600);
        }
        previousHalfMixAwards.current = nextData.special.halfMixAwards;
        previousDualMeAwards.current = nextData.special.dualMeAwards;
        previousBumCuts.current = nextData.special.bumCuts;
        if (
          previousSixSevenBonuses.current !== null &&
          nextData.special.sixSevenBonuses >
            previousSixSevenBonuses.current
        ) {
          setSixSevenVisible(true);
          window.setTimeout(() => setSixSevenVisible(false), 5000);
        }
        previousSixSevenBonuses.current = nextData.special.sixSevenBonuses;
        if (
          previousNidaAwards.current !== null &&
          nextData.special.nidaAwards > previousNidaAwards.current
        ) {
          setNidaVisible(true);
          window.setTimeout(() => setNidaVisible(false), 4600);
        }
        if (
          previousPrimeAwards.current !== null &&
          nextData.special.primeAwards > previousPrimeAwards.current
        ) {
          setPrimeVisible(true);
          window.setTimeout(() => setPrimeVisible(false), 4600);
        }
        if (
          previousFibonacciAwards.current !== null &&
          nextData.special.fibonacciAwards >
            previousFibonacciAwards.current
        ) {
          const tier =
            nextData.special.fibonacciEvents[0]?.tier ?? "bronze";
          setFibonacciAlert(tier);
          window.setTimeout(() => setFibonacciAlert(null), 4800);
        }
        previousNidaAwards.current = nextData.special.nidaAwards;
        previousPrimeAwards.current = nextData.special.primeAwards;
        previousFibonacciAwards.current =
          nextData.special.fibonacciAwards;
        if (previousSequenceAwards.current) {
          const changedSequence = (
            Object.keys(nextData.special.sequenceAwards) as SequenceKey[]
          ).find(
            (key) =>
              nextData.special.sequenceAwards[key] >
              (previousSequenceAwards.current?.[key] ?? 0),
          );
          if (changedSequence) {
            const latest = nextData.special.sequenceEvents.find(
              (item) => item.key === changedSequence,
            );
            setSequenceAlert({
              key: changedSequence,
              label: latest?.label ?? changedSequence,
              detail: latest?.detail ?? "Sequence completed",
            });
            window.setTimeout(() => setSequenceAlert(null), 4800);
          }
        }
        previousSequenceAwards.current = {
          ...nextData.special.sequenceAwards,
        };
        const unlockedKeys = new Set(
          nextGame.achievements
            .filter((achievement) => achievement.unlocked)
            .map((achievement) => achievement.key),
        );
        if (previousAchievements.current !== null) {
          const newlyUnlocked = nextGame.achievements.find(
            (achievement) =>
              achievement.unlocked &&
              !previousAchievements.current?.has(achievement.key),
          );
          if (newlyUnlocked) {
            setAchievementUnlock(newlyUnlocked.label);
            window.setTimeout(() => setAchievementUnlock(null), 3600);
          }
        }
        previousAchievements.current = unlockedKeys;
        previousMixes.current = nextData.transitions.mix;
        setData(nextData);
      };
      stream.onerror = () => {
        stream?.close();
        setData((current) => ({ ...current, connected: false }));
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(ticker);
      clearTimeout(reconnectTimer);
      stream?.close();
    };
  }, []);

  useEffect(() => {
    if (show.status === "idle" || show.status === "stopped") {
      setShowName("");
    }
    if (show.status !== "idle") {
      fetch(`${monitorBase}/shows`)
        .then((response) => response.json())
        .then(setSavedShows)
        .catch(() => {});
    }
  }, [show.id, show.status, monitorBase]);

  useEffect(() => {
    if (!atemAddressDirty && data.address) setAtemAddress(data.address);
  }, [atemAddressDirty, data.address]);

  const blackSource = useMemo(
    () =>
      data.sources.find(
        (source) =>
          source.id === 0 || source.name.trim().toLowerCase() === "black",
      ),
    [data.sources],
  );
  const sources = useMemo(
    () =>
      data.sources
        .filter(
          (source) =>
            source.id !== 0 && source.name.trim().toLowerCase() !== "black",
        )
        .sort((a, b) => b.milliseconds - a.milliseconds),
    [data.sources],
  );
  const totalAirtime = Math.max(
    1,
    sources.reduce((sum, source) => sum + source.milliseconds, 0),
  );
  const totalTransitions =
    data.transitions.cut + data.transitions.mix + data.transitions.other;
  const cutMixTotal = data.transitions.cut + data.transitions.mix;
  const tBarAwards = Math.floor(data.transitions.mix / 10);
  const tBarProgress = data.transitions.mix % 10;
  const games = gameStats(data, now);
  const level = Math.floor(games.xp / 500) + 1;
  const levelProgress = games.xp % 500;
  const nextDiversityGoal =
    [5, 8, 10, 12].find((goal) => goal > games.sourceCount) ?? null;
  const currentStreakType = data.events[0]?.type ?? "CUT";
  let currentStreak = 0;
  for (const event of data.events) {
    if (event.type !== currentStreakType) break;
    currentStreak += 1;
  }
  const longestStreak = (type: RecentEvent["type"]) => {
    let best = 0;
    let run = 0;
    for (const event of [...data.events].reverse()) {
      run = event.type === type ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  };
  const topSource = sources[0];
  const maxSourceAirtime = Math.max(
    0,
    ...sources.map((source) => source.milliseconds),
  );
  const bingoLevels: Array<
    Array<{ label: string; done: boolean; hero?: boolean }>
  > = [
    [
      { label: "10 CUTS", done: data.transitions.cut >= 10 },
      { label: "5 MIXES", done: data.transitions.mix >= 5 },
      { label: "5 IN 45 SEC", done: games.bestDiversityCount >= 5 },
      { label: "50 CUTS", done: data.transitions.cut >= 50 },
      { label: "T BAR!", done: tBarAwards >= 1, hero: true },
      { label: "8 IN 45 SEC", done: games.bestDiversityCount >= 8 },
      { label: "100 TAKES", done: games.total >= 100 },
      { label: "20 MIXES", done: data.transitions.mix >= 20 },
      { label: "5 MIN AIR", done: maxSourceAirtime >= 300_000 },
    ],
    [
      { label: "750 CUTS", done: data.transitions.cut >= 750 },
      { label: "300 MIXES", done: data.transitions.mix >= 300 },
      { label: "10 IN 45 SEC", done: games.bestDiversityCount >= 10 },
      { label: "900 CUTS", done: data.transitions.cut >= 900 },
      { label: "35 T BARS", done: tBarAwards >= 35, hero: true },
      { label: "12 IN 45 SEC", done: games.bestDiversityCount >= 12 },
      { label: "1,250 TAKES", done: games.total >= 1_250 },
      { label: "400 MIXES", done: data.transitions.mix >= 400 },
      { label: "45 MIN AIR", done: maxSourceAirtime >= 2_700_000 },
    ],
    [
      { label: "1,000 CUTS", done: data.transitions.cut >= 1_000 },
      { label: "500 MIXES", done: data.transitions.mix >= 500 },
      { label: "20 DIVERSITY", done: games.diversityAwards >= 20 },
      { label: "1,250 CUTS", done: data.transitions.cut >= 1_250 },
      { label: "60 T BARS", done: tBarAwards >= 60, hero: true },
      { label: "12 IN 45 SEC", done: games.bestDiversityCount >= 12 },
      { label: "2,000 TAKES", done: games.total >= 2_000 },
      { label: "700 MIXES", done: data.transitions.mix >= 700 },
      { label: "60 MIN AIR", done: maxSourceAirtime >= 3_600_000 },
    ],
    [
      { label: "1,500 CUTS", done: data.transitions.cut >= 1_500 },
      { label: "800 MIXES", done: data.transitions.mix >= 800 },
      { label: "40 DIVERSITY", done: games.diversityAwards >= 40 },
      { label: "2,000 CUTS", done: data.transitions.cut >= 2_000 },
      { label: "100 T BARS", done: tBarAwards >= 100, hero: true },
      { label: "12 IN 45 SEC", done: games.bestDiversityCount >= 12 },
      { label: "3,000 TAKES", done: games.total >= 3_000 },
      { label: "1,200 MIXES", done: data.transitions.mix >= 1_200 },
      { label: "90 MIN AIR", done: maxSourceAirtime >= 5_400_000 },
    ],
    [
      { label: "2,500 CUTS", done: data.transitions.cut >= 2_500 },
      { label: "1,500 MIXES", done: data.transitions.mix >= 1_500 },
      { label: "75 DIVERSITY", done: games.diversityAwards >= 75 },
      { label: "3,000 CUTS", done: data.transitions.cut >= 3_000 },
      { label: "200 T BARS", done: tBarAwards >= 200, hero: true },
      { label: "12 IN 45 SEC", done: games.bestDiversityCount >= 12 },
      { label: "5,000 TAKES", done: games.total >= 5_000 },
      { label: "2,500 MIXES", done: data.transitions.mix >= 2_500 },
      { label: "120 MIN AIR", done: maxSourceAirtime >= 7_200_000 },
    ],
  ];
  const firstIncompleteBingoLevel = bingoLevels.findIndex(
    (board) => !board.every((tile) => tile.done),
  );
  const bingoLevelIndex =
    firstIncompleteBingoLevel === -1
      ? bingoLevels.length - 1
      : firstIncompleteBingoLevel;
  const bingoLevel = bingoLevelIndex + 1;
  const completedBingoLevels =
    firstIncompleteBingoLevel === -1
      ? bingoLevels.length
      : firstIncompleteBingoLevel;
  const bingo = bingoLevels[bingoLevelIndex];
  const bingoComplete = bingo.every((tile) => tile.done);
  const bingoLines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ].filter((line) => line.every((index) => bingo[index].done)).length;

  useEffect(() => {
    if (
      previousBingoLevel.current !== null &&
      bingoLevel > previousBingoLevel.current
    ) {
      setBingoLevelUp(bingoLevel);
      const timer = window.setTimeout(() => setBingoLevelUp(null), 4800);
      previousBingoLevel.current = bingoLevel;
      return () => window.clearTimeout(timer);
    }
    previousBingoLevel.current = bingoLevel;
  }, [bingoLevel]);
  const me2Sources = [...data.me2.sources]
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
    data.me2.transitions.cut +
    data.me2.transitions.mix +
    data.me2.transitions.other;
  const me2TakeAwards = Math.floor(me2Takes / 10);
  const me2MixAwards = Math.floor(data.me2.transitions.mix / 5);
  const uptime = show.startedAt
    ? now - new Date(show.startedAt).getTime()
    : 0;
  const elapsedShowMinutes = uptime > 0 ? uptime / 60_000 : 0;
  const cutsPerMinute =
    elapsedShowMinutes > 0 ? data.transitions.cut / elapsedShowMinutes : 0;
  const transitionsPerMinute =
    elapsedShowMinutes > 0 ? totalTransitions / elapsedShowMinutes : 0;

  const controlShow = async (action: "start" | "pause" | "stop") => {
    if (
      action === "stop" &&
      !window.confirm("Stop this show and create its final report?")
    ) {
      return;
    }
    setControlBusy(true);
    try {
      const response = await fetch(`${monitorBase}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: showName }),
      });
      if (!response.ok) throw new Error(await response.text());
      setData(await response.json());
    } finally {
      setControlBusy(false);
    }
  };

  const openReport = (showId?: string | null, csv = false) => {
    const path = csv ? "report.csv" : "report";
    const query = showId ? `?show=${encodeURIComponent(showId)}` : "";
    window.open(`${monitorBase}/${path}${query}`, "_blank", "noopener,noreferrer");
  };

  const openDisplay = () => {
    window.open("/display", "switch-kpi-display", "noopener,noreferrer");
  };

  const saveAtemAddress = async () => {
    if (!atemAddress.trim()) return;
    setSettingsBusy(true);
    setSettingsMessage("Connecting…");
    try {
      const response = await fetch(`${monitorBase}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atemAddress: atemAddress.trim() }),
      });
      if (!response.ok) throw new Error(await response.text());
      const nextData = (await response.json()) as MonitorState;
      setData(nextData);
      setAtemAddress(nextData.address);
      setAtemAddressDirty(false);
      setSettingsMessage("Saved · show data preserved");
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : "Could not update the ATEM IP.",
      );
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <main className="dashboard">
      {awardVisible && (
        <div className="award-celebration" role="status" aria-live="assertive">
          <div className="award-rays" />
          <div className="award-tbar">
            <span className="tbar-handle" />
            <span className="tbar-stem" />
          </div>
          <p>10 MIX COMBO</p>
          <strong>T BAR AWARD</strong>
          <span>+1 AWARD UNLOCKED</span>
        </div>
      )}
      {achievementUnlock && (
        <div className="achievement-toast" role="status" aria-live="polite">
          <span>ACHIEVEMENT UNLOCKED</span>
          <strong>{achievementUnlock}</strong>
          <small>+ bonus XP</small>
        </div>
      )}
      {diversityBurst !== null && (
        <div className="diversity-burst" role="status" aria-live="polite">
          <span>NEW SOURCE DISCOVERED</span>
          <strong>+100 DIVERSITY XP</strong>
          <small>{diversityBurst} active sources in play</small>
        </div>
      )}
      {diversityAwardVisible && (
        <div className="diversity-award" role="status" aria-live="assertive">
          <div className="diversity-orbit" />
          <span>5 SOURCES · 45 SECONDS</span>
          <strong>DIVERSITY AWARD</strong>
          <b>+1 AWARD · ROUND CLEARED</b>
        </div>
      )}
      {(wrongBusVisible || data.previewChangesSinceTake >= 4) && (
        <div className="wrong-bus-banner" role="alert" aria-live="assertive">
          <span>⚠ PREVIEW BUS STREAK DETECTED ⚠</span>
          <strong>DENNIS MODE</strong>
          <b>YOU’RE CUTTING THE WRONG BUS</b>
        </div>
      )}
      {me2AwardMessage && (
        <div className="me2-award" role="status" aria-live="assertive">
          <span>ME2 MILESTONE UNLOCKED</span>
          <strong>{me2AwardMessage}</strong>
          <b>SECOND MIX EFFECTS · BIG ENERGY</b>
        </div>
      )}
      {specialAwardMessage && (
        <div className="special-award" role="status" aria-live="assertive">
          <span>OPERATOR MILESTONE</span>
          <strong>{specialAwardMessage}</strong>
          <b>{specialAwardMessage === "DUAL ME AWARD" ? "ME1 + ME2 · DOUBLE DECK" : "HELD AT HALF · SMOOTH CONTROL"}</b>
        </div>
      )}
      {bumCutVisible && (
        <div className="bum-cut-alert" role="alert" aria-live="assertive">
          <span>⚡ TWO CUTS UNDER 500 MS ⚡</span>
          <strong>BUM CUT</strong>
          <b>SLOW DOWN, SPEED RACER</b>
        </div>
      )}
      {sixSevenVisible && (
        <div className="six-seven-bonus" role="status" aria-live="assertive">
          <div className="six-seven-image">
            <img src="/67-kid.jpg" alt="6/7 award" />
          </div>
          <span>SOURCE 6 ↔ SOURCE 7</span>
          <strong>6/7</strong>
          <b>6/7</b>
        </div>
      )}
      {nidaVisible && (
        <div className="nida-award" role="status" aria-live="assertive">
          <span>WIPE TRANSITION · ME1 / ME2</span>
          <strong>NIDA AWARD</strong>
          <b>DRAMA · THEATRE · TRANSITION</b>
        </div>
      )}
      {primeVisible && (
        <div className="prime-award" role="status" aria-live="assertive">
          <span>2 · 3 · 5 · 7 · 11 · 13</span>
          <strong>PRIME TIME</strong>
          <b>3 PRIME INPUTS IN A ROW</b>
        </div>
      )}
      {fibonacciAlert && (
        <div
          className={`fibonacci-award ${fibonacciAlert === "bronze" ? "compact" : ""}`}
          role="status"
          aria-live="assertive"
        >
          <span>1 · 2 · 3 · 5 · 8 · 13 · 21</span>
          <strong>FIBONACCI {fibonacciAlert.toUpperCase()}</strong>
          <b>
            {fibonacciAlert === "gold"
              ? "5 DISTINCT SOURCES · TOP LEVEL"
              : fibonacciAlert === "silver"
                ? "4 DISTINCT SOURCES · LEVEL UP"
                : "3 DISTINCT SOURCES · FIRST HIT"}
          </b>
        </div>
      )}
      {sequenceAlert && (
        <div
          className={`sequence-award ${sequenceAlert.key}`}
          role="status"
          aria-live="assertive"
        >
          <span>DIRECTOR SEQUENCE COMPLETE</span>
          <strong>{sequenceAlert.label}</strong>
          <b>{sequenceAlert.detail}</b>
        </div>
      )}
      {bingoLevelUp !== null && (
        <div className="bingo-level-up" role="status" aria-live="assertive">
          <span>ALL 9 SQUARES CLEARED</span>
          <strong>LEVEL {bingoLevelUp}</strong>
          <b>NEW BINGO BOARD UNLOCKED</b>
        </div>
      )}
      <header className="topbar">
        <div className="brand-lockup">
          <img src="/pcc-cogs.png" alt="" />
          <div>
            <p className="eyebrow">PCC · ATEM LIVE ANALYTICS</p>
            <h1>Switch KPI</h1>
            <span>ME1 + ME2 activity, awards and show reports</span>
          </div>
        </div>
        <div className="display-tools">
          <div className="connection">
            <span className={`status-dot ${data.connected ? "online" : ""}`} />
            <div>
              <strong>{data.connected ? "ATEM connected" : "Waiting for ATEM"}</strong>
              <span>
                {data.address} · {show.status === "idle" ? "no show" : "show"}{" "}
                {hydrated && show.startedAt ? formatDuration(uptime) : "—"}
              </span>
            </div>
          </div>
          <button
            className="fullscreen-button"
            onClick={openDisplay}
            type="button"
          >
            <span aria-hidden="true">⛶</span>
            Open Display
          </button>
        </div>
      </header>

      <section className="show-control" aria-label="Show controls">
        <div className="show-identity">
          <span className={`show-state ${show.status}`}>{show.status}</span>
          <div>
            <small>CURRENT SHOW</small>
            <strong>{show.name}</strong>
          </div>
        </div>
        <input
          aria-label="New show name"
          disabled={show.status === "running" || show.status === "paused"}
          onChange={(event) => setShowName(event.target.value)}
          placeholder="Optional new show name"
          value={showName}
        />
        <form
          className="atem-address-control"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAtemAddress();
          }}
        >
          <label htmlFor="atem-address">ATEM IP</label>
          <div>
            <input
              id="atem-address"
              inputMode="decimal"
              onChange={(event) => {
                setAtemAddress(event.target.value);
                setAtemAddressDirty(true);
                setSettingsMessage("");
              }}
              placeholder="192.168.206.99"
              value={atemAddress}
            />
            <button disabled={settingsBusy} type="submit">
              {settingsBusy ? "Connecting" : "Apply"}
            </button>
          </div>
          <small>{settingsMessage || "Saved on this Switch KPI server"}</small>
        </form>
        <div className="control-actions">
          <button
            className="start"
            disabled={controlBusy || show.status === "running"}
            onClick={() => controlShow("start")}
          >
            {show.status === "paused" ? "Resume" : "Start"}
          </button>
          <button
            disabled={controlBusy || show.status !== "running"}
            onClick={() => controlShow("pause")}
          >
            Pause
          </button>
          <button
            className="stop"
            disabled={
              controlBusy ||
              !["running", "paused"].includes(show.status)
            }
            onClick={() => controlShow("stop")}
          >
            Stop
          </button>
          <button
            disabled={!["paused", "stopped"].includes(show.status)}
            onClick={() => openReport(show.id)}
          >
            {show.status === "paused" ? "Midway Report" : "Report"}
          </button>
        </div>
      </section>

      <section className="live-strip" aria-label="Current bus status">
        <article className="bus program">
          <span>PROGRAM</span>
          <strong>
            {data.program?.name ?? "—"}
            {data.program && <PrimeMarker {...data.program} />}
            {data.program && <FibonacciMarker {...data.program} />}
          </strong>
          <small>{data.program ? `Input ${data.program.id}` : "No ME1 signal yet"}</small>
        </article>
        <div className="take-indicator" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <article className="bus preview">
          <span>PREVIEW</span>
          <strong>
            {data.preview?.name ?? "—"}
            {data.preview && <PrimeMarker {...data.preview} />}
            {data.preview && <FibonacciMarker {...data.preview} />}
          </strong>
          <small>{data.preview ? `Input ${data.preview.id}` : "No preview signal yet"}</small>
          {data.previewChangesSinceTake > 0 && (
            <em className={data.previewChangesSinceTake >= 3 ? "danger" : ""}>
              Preview streak {data.previewChangesSinceTake}
            </em>
          )}
          {data.wrongBusAlerts > 0 && (
            <em className="dennis-count">Dennis alerts {data.wrongBusAlerts}</em>
          )}
        </article>
        <article className="session-card">
          <span>SESSION EVENTS</span>
          <strong>{totalTransitions}</strong>
          <small>
            {cutsPerMinute.toFixed(1)} cuts/min ·{" "}
            {transitionsPerMinute.toFixed(1)} transitions/min
          </small>
        </article>
      </section>

      {data.error && (
        <div className="notice">
          <strong>Connection note</strong>
          <span>{data.error}</span>
        </div>
      )}

      <section className="wallboard" aria-label="16 by 9 dashboard overview">
        <article className="wall-card wall-sources">
          <div className="wall-heading">
            <div>
              <small>ME1 SOURCE SHARE</small>
              <strong>Top sources</strong>
            </div>
            <span>Black excluded</span>
          </div>
          <div className="wall-source-list">
            {sources.slice(0, 8).map((source, index) => {
              const percentage = (source.milliseconds / totalAirtime) * 100;
              return (
                <div className={source.live ? "live" : ""} key={source.id}>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <span>
                    {source.name}
                    <PrimeMarker id={source.id} name={source.name} />
                    <FibonacciMarker id={source.id} name={source.name} />
                  </span>
                  <div>
                    <i style={{ width: `${Math.max(1, percentage)}%` }} />
                  </div>
                  <strong>{percentage.toFixed(1)}%</strong>
                  <small>{formatDuration(source.milliseconds)}</small>
                </div>
              );
            })}
          </div>
        </article>

        <article className="wall-card wall-kpi">
          <div className="wall-heading">
            <div>
              <small>DIRECTOR KPI</small>
              <strong>Bingo Level {bingoLevel}</strong>
            </div>
            <span>{bingoLines} lines</span>
          </div>
          <div className="wall-stats">
            <div><span>TAKES</span><b>{games.total}</b></div>
            <div><span>CUTS</span><b>{data.transitions.cut}</b></div>
            <div><span>MIXES</span><b>{data.transitions.mix}</b></div>
            <div><span>DIVERSITY</span><b>{games.bestDiversityCount}</b></div>
          </div>
          <div className="wall-bingo">
            {bingo.map((tile) => (
              <div className={tile.done ? "done" : ""} key={tile.label}>
                <b>{tile.done ? "✓" : "·"}</b>
                <span>{tile.label}</span>
              </div>
            ))}
          </div>
          <div className="wall-progress">
            <span>LEVEL {level} · {games.xp.toLocaleString()} XP</span>
            <div><i style={{ width: `${(levelProgress / 500) * 100}%` }} /></div>
          </div>
        </article>

        <article className="wall-card wall-events">
          <div className="wall-heading">
            <div>
              <small>ME1 EVENT LOG</small>
              <strong>Recent takes</strong>
            </div>
            <span>
              {cutMixTotal
                ? ((data.transitions.mix / cutMixTotal) * 100).toFixed(0)
                : 0}
              % mix
            </span>
          </div>
          <div className="wall-event-list">
            {data.events.slice(0, 9).map((event) => (
              <div key={event.id}>
                <time>{hydrated ? clock(event.at) : "—"}</time>
                <span><b>{event.to}</b><small>from {event.from}</small></span>
                <strong className={event.type.toLowerCase()}>{event.type}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="wall-card wall-me2">
          <div className="wall-me2-title">
            <small>SECOND MIX EFFECTS</small>
            <strong>ME2</strong>
            <span>{data.me2.available ? "ONLINE" : "NOT AVAILABLE"}</span>
          </div>
          <div><small>PROGRAM</small><strong>{data.me2.program?.name ?? "—"}</strong></div>
          <div><small>PREVIEW</small><strong>{data.me2.preview?.name ?? "—"}</strong></div>
          <div><small>TAKES</small><strong>{me2Takes}</strong></div>
          <div><small>CUT / MIX</small><strong>{data.me2.transitions.cut} / {data.me2.transitions.mix}</strong></div>
          <div><small>AWARDS</small><strong>{me2TakeAwards + me2MixAwards}</strong></div>
        </article>
      </section>

      <section className="arcade-panel" aria-label="Switcher Arcade">
        <div className="arcade-title">
          <div>
            <p className="eyebrow">SWITCHER ARCADE</p>
            <h2>Director KPI</h2>
          </div>
          <span>{games.achievements.filter((item) => item.unlocked).length}/8 achievements</span>
        </div>

        <article className="level-card">
          <span className="level-number">{level}</span>
          <div>
            <small>OPERATOR LEVEL</small>
            <strong>{games.xp.toLocaleString()} XP</strong>
            <div className="xp-bar"><span style={{ width: `${(levelProgress / 500) * 100}%` }} /></div>
            <p>{500 - levelProgress} XP to level {level + 1}</p>
          </div>
        </article>

        <article className="combo-card">
          <small>HOT HAND</small>
          <strong>{currentStreak}× {currentStreakType}</strong>
          <span>Best cut streak {longestStreak("CUT")}</span>
          <span>Best mix streak {longestStreak("MIX")}</span>
        </article>

        <article className="diversity-card">
          <div>
            <small>DIVERSITY QUEST · ROUND {games.currentRound}</small>
            <strong>{games.diversityPoints.toLocaleString()} XP</strong>
            <span>
              {games.sourceCount} sources this round · {games.diversityAwards} awards
            </span>
          </div>
          <div className="diversity-pips" aria-label={`${games.sourceCount} active sources used`}>
            {Array.from({ length: 12 }, (_, index) => (
              <span className={index < games.sourceCount ? "filled" : ""} key={index} />
            ))}
          </div>
          <p>
            {nextDiversityGoal
              ? `${nextDiversityGoal - games.sourceCount} more to unlock the ${nextDiversityGoal}-source bonus`
              : "Maximum diversity bonus unlocked"}
          </p>
          <p>
            {formatDuration(Math.max(0, games.roundEndsAt - now))} left ·{" "}
            {games.totalDiversityPoints.toLocaleString()} total Diversity XP · best{" "}
            {games.bestDiversityCount}
          </p>
        </article>

        <article className="champion-card">
          <small>SOURCE CHAMPION</small>
          <strong>
            {topSource?.name ?? "Waiting…"}
            {topSource && <PrimeMarker id={topSource.id} name={topSource.name} />}
            {topSource && (
              <FibonacciMarker id={topSource.id} name={topSource.name} />
            )}
          </strong>
          <span>{topSource ? formatDuration(topSource.milliseconds) : "No airtime yet"}</span>
          <div className="crown">♛</div>
        </article>

        <article
          className={`bingo-card level-${bingoLevel} ${
            bingoLevel > 1 ? "advanced" : ""
          }`}
        >
          <div className="bingo-heading">
            <div>
              <small>SHOW BINGO · LEVEL {bingoLevel}</small>
              <strong>
                {bingoComplete
                  ? `LEVEL ${bingoLevel} COMPLETE`
                  : `${bingoLines} lines${
                      completedBingoLevels === 1
                        ? " · L1 CLEAR"
                        : completedBingoLevels > 1
                          ? ` · L1–${completedBingoLevels} CLEAR`
                          : ""
                    }`}
              </strong>
            </div>
            <span>
              BINGO {["I", "II", "III", "IV", "V"][bingoLevel - 1]}
            </span>
          </div>
          <div className="bingo-grid">
            {bingo.map((tile) => (
              <div className={`${tile.done ? "done" : ""} ${tile.hero ? "hero" : ""}`} key={tile.label}>
                <span>{tile.done ? "✓" : "·"}</span>
                <small>{tile.label}</small>
              </div>
            ))}
          </div>
        </article>

        <article className="achievement-card">
          <small>TROPHY CABINET</small>
          <div className="achievement-grid">
            {games.achievements.map((achievement) => (
              <div className={achievement.unlocked ? "unlocked" : ""} key={achievement.key}>
                <b>{achievement.icon}</b>
                <span>{achievement.label}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="me2-panel" aria-label="ME2 Activity">
        <div className="me2-heading">
          <div>
            <p className="eyebrow">SECOND MIX EFFECTS</p>
            <h2>ME2 Activity</h2>
          </div>
          <span className={data.me2.available ? "available" : ""}>
            {data.me2.available ? "ME2 ONLINE" : "ME2 NOT AVAILABLE"}
          </span>
        </div>
        {data.me2.available ? (
          <div className="me2-grid">
            <article className="me2-buses">
              <div>
                <small>ME2 PROGRAM</small>
                <strong>
                  {data.me2.program?.name ?? "—"}
                  {data.me2.program && <PrimeMarker {...data.me2.program} />}
                  {data.me2.program && (
                    <FibonacciMarker {...data.me2.program} />
                  )}
                </strong>
                <span>{data.me2.program ? `Input ${data.me2.program.id}` : "Waiting"}</span>
              </div>
              <div>
                <small>ME2 PREVIEW</small>
                <strong>
                  {data.me2.preview?.name ?? "—"}
                  {data.me2.preview && <PrimeMarker {...data.me2.preview} />}
                  {data.me2.preview && (
                    <FibonacciMarker {...data.me2.preview} />
                  )}
                </strong>
                <span>{data.me2.preview ? `Input ${data.me2.preview.id}` : "Waiting"}</span>
              </div>
            </article>
            <article className="me2-score">
              <div><small>TAKES</small><strong>{me2Takes}</strong></div>
              <div><small>CUTS</small><strong>{data.me2.transitions.cut}</strong></div>
              <div><small>MIXES</small><strong>{data.me2.transitions.mix}</strong></div>
              <div><small>AWARDS</small><strong>{me2TakeAwards + me2MixAwards}</strong></div>
            </article>
            <article className="me2-sources">
              <div className="me2-subhead"><small>ME2 SOURCE SHARE</small><span>{me2Sources.length} sources</span></div>
              {me2Sources.slice(0, 5).map((source) => {
                const percentage = (source.milliseconds / me2TotalAirtime) * 100;
                return (
                  <div className="me2-source-row" key={source.id}>
                    <span>
                      {source.name}
                      <PrimeMarker id={source.id} name={source.name} />
                      <FibonacciMarker id={source.id} name={source.name} />
                    </span>
                    <div><i style={{ width: `${Math.max(1, percentage)}%` }} /></div>
                    <b>{percentage.toFixed(0)}%</b>
                  </div>
                );
              })}
            </article>
            <article className="me2-events">
              <div className="me2-subhead"><small>RECENT ME2 TAKES</small><span>Newest first</span></div>
              {data.me2.events.length === 0 ? (
                <p>No ME2 takes recorded in this show yet.</p>
              ) : (
                data.me2.events.slice(0, 5).map((event) => (
                  <div key={event.id}>
                    <time>{hydrated ? clock(event.at) : "—"}</time>
                    <span>{event.to}</span>
                    <b className={event.type.toLowerCase()}>{event.type}</b>
                  </div>
                ))
              )}
            </article>
          </div>
        ) : (
          <p className="me2-unavailable">
            This switcher has not reported a second mix-effects block.
          </p>
        )}
      </section>

      <details className="special-panel" aria-label="Director KPI bonuses">
        <summary className="special-heading">
          <div>
            <p className="eyebrow">DIRECTOR KPI CHALLENGES</p>
            <h2>Bonuses hidden</h2>
          </div>
          <span className="bonus-toggle">ME1 + ME2</span>
        </summary>
        <div className="special-grid">
          <article>
            <small>LONG HALF-MIX AWARDS</small>
            <strong>{data.special.halfMixAwards}</strong>
            <span>Mix held at 40–60% for 2+ seconds</span>
          </article>
          <article>
            <small>DUAL ME AWARDS</small>
            <strong>{data.special.dualMeAwards}</strong>
            <span>Cuts on both MEs within 5 seconds</span>
          </article>
          <article className="bum-stat">
            <small>BUM CUTS</small>
            <strong>{data.special.bumCuts}</strong>
            <span>Same-ME cuts less than 500 ms apart</span>
          </article>
          <article className="six-seven-stat">
            <small>6/7 AWARDS</small>
            <strong>{data.special.sixSevenBonuses}</strong>
            <span>Cut or mix directly between sources labelled 6 and 7</span>
          </article>
          <article className="nida-stat">
            <small>NIDA AWARDS</small>
            <strong>{data.special.nidaAwards}</strong>
            <span>Use a wipe transition instead of a mix</span>
          </article>
          <article className="prime-stat">
            <small>PRIME TIME AWARDS</small>
            <strong>{data.special.primeAwards}</strong>
            <span>Three prime-numbered inputs in a row on one ME</span>
          </article>
          <article className="fibonacci-stat">
            <small>FIBONACCI AWARDS</small>
            <strong>{data.special.fibonacciAwards}</strong>
            <span>
              Bronze {data.special.fibonacciTiers.bronze} · Silver{" "}
              {data.special.fibonacciTiers.silver} · Gold{" "}
              {data.special.fibonacciTiers.gold}
            </span>
          </article>
          <article className="sequence-stat">
            <small>SEQUENCE AWARDS</small>
            <strong>
              {Object.values(data.special.sequenceAwards).reduce(
                (sum, count) => sum + count,
                0,
              )}
            </strong>
            <div className="sequence-mini-grid">
              <span>π {data.special.sequenceAwards.piTime}</span>
              <span>P↑ {data.special.sequenceAwards.primeLadder}</span>
              <span>G {data.special.sequenceAwards.goldenRun}</span>
              <span>T {data.special.sequenceAwards.transitionTango}</span>
              <span>RF {data.special.sequenceAwards.rapidFire}</span>
              <span>⌂ {data.special.sequenceAwards.homecoming}</span>
              <span>♪ {data.special.sequenceAwards.nSync}</span>
            </div>
          </article>
          <article className="half-records">
            <small>TOP HALF-MIX HOLDS</small>
            {data.special.halfMixDurations.length === 0 ? (
              <span>No qualifying holds yet</span>
            ) : (
              data.special.halfMixDurations.slice(0, 5).map((hold, index) => (
                <div key={hold.id}>
                  <b>#{index + 1}</b>
                  <span>{hold.me}</span>
                  <strong>{(hold.durationMs / 1000).toFixed(2)}s</strong>
                </div>
              ))
            )}
          </article>
        </div>
      </details>

      <div className="content-grid">
        <section className="panel usage-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SOURCE SHARE</p>
              <h2>Time on program</h2>
            </div>
            <span>ME1 · this session</span>
          </div>

          {blackSource && (
            <article className="black-holding-card">
              <div>
                <span className={`black-lamp ${blackSource.live ? "live" : ""}`} />
                <p>
                  <small>BLACK / HOLDING TIME</small>
                  <strong>{blackSource.live ? "Currently in black" : "Recorded separately"}</strong>
                </p>
              </div>
              <p>
                <strong>{formatDuration(blackSource.milliseconds)}</strong>
                <small>{blackSource.uses} {blackSource.uses === 1 ? "use" : "uses"} · excluded from source share</small>
              </p>
            </article>
          )}

          <div className="source-list">
            {sources.length === 0 ? (
              <div className="empty-state">
                <span className="signal-glyph">⌁</span>
                <strong>Listening for ME1 activity</strong>
                <p>Source usage will appear as soon as the ATEM reports its current state.</p>
              </div>
            ) : (
              sources.map((source, index) => {
                const percentage = (source.milliseconds / totalAirtime) * 100;
                return (
                  <article className="source-row" key={source.id}>
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <div className="source-details">
                      <div className="source-title">
                        <strong>
                          {source.name}
                          <PrimeMarker id={source.id} name={source.name} />
                          <FibonacciMarker id={source.id} name={source.name} />
                          {source.live && <i>LIVE</i>}
                        </strong>
                        <span>{percentage.toFixed(1)}%</span>
                      </div>
                      <div className="bar">
                        <span style={{ width: `${Math.max(1.5, percentage)}%` }} />
                      </div>
                      <div className="source-meta">
                        <span>{formatDuration(source.milliseconds)}</span>
                        <span>{source.uses} {source.uses === 1 ? "use" : "uses"}</span>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <aside className="side-column">
          <section className="panel transition-panel">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">TRANSITION TYPE</p>
                <h2>Cut vs mix</h2>
              </div>
            </div>
            <div className="donut-row">
              <div
                className="donut"
                style={{
                  background: `conic-gradient(var(--red) 0 ${
                    cutMixTotal ? (data.transitions.cut / cutMixTotal) * 100 : 0
                  }%, var(--cyan) 0 100%)`,
                }}
              >
                <div>
                  <strong>{cutMixTotal}</strong>
                  <span>takes</span>
                </div>
              </div>
              <div className="legend">
                <div>
                  <span className="legend-swatch cut" />
                  <p><strong>Cuts</strong><small>{data.transitions.cut}</small></p>
                  <b>{cutMixTotal ? ((data.transitions.cut / cutMixTotal) * 100).toFixed(0) : 0}%</b>
                </div>
                <div>
                  <span className="legend-swatch mix" />
                  <p><strong>Mixes</strong><small>{data.transitions.mix}</small></p>
                  <b>{cutMixTotal ? ((data.transitions.mix / cutMixTotal) * 100).toFixed(0) : 0}%</b>
                </div>
                {data.transitions.other > 0 && (
                  <div>
                    <span className="legend-swatch other" />
                    <p><strong>Other</strong><small>{data.transitions.other}</small></p>
                    <b>—</b>
                  </div>
                )}
              </div>
            </div>
            <div className="award-progress">
              <div className="award-copy">
                <span className="mini-tbar" aria-hidden="true">⊤</span>
                <p>
                  <strong>T BAR AWARD</strong>
                  <small>{tBarAwards} earned · every 10 mixes</small>
                </p>
                <b>{tBarProgress}/10</b>
              </div>
              <div className="award-pips" aria-label={`${tBarProgress} of 10 mix points`}>
                {Array.from({ length: 10 }, (_, index) => (
                  <span
                    className={index < tBarProgress ? "filled" : ""}
                    key={index}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="panel recent-panel">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">EVENT LOG</p>
                <h2>Most recent takes</h2>
              </div>
              <span>Newest first</span>
            </div>
            <div className="event-list">
              {data.events.length === 0 ? (
                <p className="events-empty">No cuts or mixes recorded yet.</p>
              ) : (
                data.events.slice(0, 12).map((event) => (
                  <article key={event.id}>
                    <time>{hydrated ? clock(event.at) : "—"}</time>
                    <div>
                      <strong>{event.to}</strong>
                      <span>from {event.from}</span>
                    </div>
                    <b className={event.type.toLowerCase()}>{event.type}</b>
                  </article>
                ))
              )}
            </div>
          </section>

          {savedShows.length > 0 && (
            <section className="panel saved-panel">
              <div className="panel-heading compact">
                <div>
                  <p className="eyebrow">ARCHIVE</p>
                  <h2>Saved show reports</h2>
                </div>
              </div>
              <div className="saved-list">
                {savedShows.slice(0, 6).map((show) => (
                  <article key={show.id}>
                    <div>
                      <strong>{show.name}</strong>
                      <span>
                        {show.startedAt
                          ? new Intl.DateTimeFormat("en-AU", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(show.startedAt))
                          : "Unknown date"}
                      </span>
                    </div>
                    <button onClick={() => openReport(show.id)}>View</button>
                    <button onClick={() => openReport(show.id, true)}>CSV</button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      <section className="rules-panel" aria-label="Bingo and award rules">
        <div className="rules-heading">
          <div>
            <p className="eyebrow">DIRECTOR KPI GUIDE</p>
            <h2>How the awards and KPIs work</h2>
          </div>
          <span>All progress is for this show only</span>
        </div>
        <div className="rules-grid">
          <article>
            <div className="rule-number">01</div>
            <h3>Show Bingo</h3>
            <p>
              Complete any horizontal, vertical, or diagonal line on the 3×3
              board. A completed square stays lit for the rest of the show.
              Completing all nine squares automatically unlocks the next
              board, with five increasingly demanding levels in total.
            </p>
            <dl className="bingo-rules">
              <div><dt>10 / 50 Cuts</dt><dd>Make that many ME1 cuts.</dd></div>
              <div><dt>5 / 20 Mixes</dt><dd>Make that many ME1 mixes.</dd></div>
              <div><dt>5 / 8 in 45 sec</dt><dd>Use that many unique non-Black sources in one diversity round.</dd></div>
              <div><dt>T BAR!</dt><dd>Earn a T Bar Award by completing 10 ME1 mixes.</dd></div>
              <div><dt>100 Takes</dt><dd>Reach 100 total ME1 cuts, mixes, or other transitions.</dd></div>
              <div><dt>5 Min Air</dt><dd>Keep one non-Black source on ME1 Program for five accumulated minutes.</dd></div>
              <div><dt>Level 2</dt><dd>Endurance targets up to 900 cuts, 400 mixes, 1,250 takes, and 45 minutes of source airtime.</dd></div>
              <div><dt>Level 3</dt><dd>Marathon targets up to 1,250 cuts, 700 mixes, 2,000 takes, and 20 Diversity Awards.</dd></div>
              <div><dt>Level 4</dt><dd>Broadcast-legend targets up to 2,000 cuts, 1,200 mixes, 3,000 takes, and 100 T Bars.</dd></div>
              <div><dt>Level 5</dt><dd>The final board: 3,000 cuts, 2,500 mixes, 5,000 takes, 200 T Bars, and 120 minutes of airtime.</dd></div>
            </dl>
          </article>

          <article>
            <div className="rule-number">02</div>
            <h3>Diversity rounds</h3>
            <p>
              Every round lasts <strong>45 seconds</strong>. Switch KPI counts
              each different non-Black source used on ME1 Program during that
              window. Black is recorded separately and never adds diversity.
            </p>
            <div className="score-table">
              <div><span>Each unique source</span><b>+100 XP</b></div>
              <div><span>Reach 5 sources</span><b>+250 XP + award</b></div>
              <div><span>Reach 8 sources</span><b>+500 XP</b></div>
              <div><span>Reach 10 sources</span><b>+750 XP</b></div>
              <div><span>Reach 12 sources</span><b>+1,000 XP</b></div>
            </div>
            <p className="rule-note">
              The live source count resets when the next round begins, but XP,
              awards, the best-round score, and unlocked Bingo squares remain.
            </p>
          </article>

          <article>
            <div className="rule-number">03</div>
            <h3>Award cabinet</h3>
            <dl className="award-rules">
              <div><dt>T Bar Award</dt><dd>Every 10 ME1 mixes.</dd></div>
              <div><dt>Diversity Award</dt><dd>Five unique sources inside one 45-second round.</dd></div>
              <div><dt>Second Deck / ME2 Mix Master</dt><dd>Every 10 ME2 takes / every 5 ME2 mixes.</dd></div>
              <div><dt>Long Half-Mix</dt><dd>Hold a mix at 40–60% for at least two seconds.</dd></div>
            </dl>
            <p className="rule-note warning">
              Dennis Mode and Bum Cut are operator alerts, not positive awards.
            </p>
          </article>

          <article className="sequence-guide">
            <div className="rule-number">04</div>
            <h3>Sequence awards and pace</h3>
            <p>
              Sequences are tracked independently on ME1 and ME2. The numbered
              awards use the visible number in the source label; switching to a
              different pattern simply starts a new attempt.
            </p>
            <dl className="award-rules sequence-rules">
              <div><dt>Pi Time</dt><dd>Use sources 3 → 1 → 4 → 1 → 5 in that exact order.</dd></div>
              <div><dt>Prime Ladder</dt><dd>Use sources 2 → 3 → 5 → 7 in ascending prime order.</dd></div>
              <div><dt>Golden Run</dt><dd>Use sources 1 → 2 → 3 → 5 → 8 in exact Fibonacci order.</dd></div>
              <div><dt>Transition Tango</dt><dd>Alternate CUT and MIX four times: either CUT–MIX–CUT–MIX or the reverse.</dd></div>
              <div><dt>Rapid Fire</dt><dd>Complete five Program takes on one ME inside five seconds.</dd></div>
              <div><dt>Homecoming</dt><dd>Leave one source, visit five different sources, then return to the opening source.</dd></div>
              <div><dt>N*Sync</dt><dd>Make three consecutive shot lengths that are all within 20% of each other.</dd></div>
              <div><dt>Fibonacci levels</dt><dd>Three distinct Fibonacci sources earns Bronze, four earns Silver, and five earns Gold without breaking the run.</dd></div>
              <div><dt>Pace statistics</dt><dd>Cuts/min counts ME1 cuts per elapsed show minute. Transitions/min includes ME1 cuts, mixes and other transitions.</dd></div>
            </dl>
          </article>
        </div>
      </section>

      <footer>
        <span>SWITCH KPI / PCC / ATEM MONITOR</span>
        <span>Statistics are saved against the current show</span>
      </footer>
    </main>
  );
}
