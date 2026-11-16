"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type EventItem = {
  id: string;
  at: string;
  from: string;
  to: string;
  type: "CUT" | "MIX" | "OTHER";
};

type SourceItem = {
  id: number;
  name: string;
  milliseconds: number;
  uses: number;
  live: boolean;
};

type DisplayState = {
  connected: boolean;
  address: string;
  updatedAt: string;
  show: {
    name: string;
    status: "idle" | "running" | "paused" | "stopped";
    startedAt: string | null;
  };
  program: { id: number; name: string } | null;
  preview: { id: number; name: string } | null;
  sources: SourceItem[];
  events: EventItem[];
  transitions: { cut: number; mix: number; other: number };
  wrongBusAlerts: number;
  me2: {
    available: boolean;
    program: { id: number; name: string } | null;
    preview: { id: number; name: string } | null;
    sources: SourceItem[];
    events: EventItem[];
    transitions: { cut: number; mix: number; other: number };
  };
  special: {
    halfMixAwards: number;
    dualMeAwards: number;
    bumCuts: number;
    sixSevenBonuses: number;
    nidaAwards: number;
    primeAwards: number;
    fibonacciAwards: number;
    fibonacciTiers: { bronze: number; silver: number; gold: number };
    fibonacciEvents: Array<{
      id: string;
      tier?: "bronze" | "silver" | "gold";
      level?: number;
      sequence: number[];
    }>;
    sequenceAwards: {
      piTime: number;
      primeLadder: number;
      goldenRun: number;
      transitionTango: number;
      rapidFire: number;
      homecoming: number;
      nSync: number;
    };
    sequenceEvents: Array<{
      id: string;
      key: string;
      label: string;
      detail: string;
    }>;
  };
};

type Notice = {
  symbol: string;
  kicker: string;
  title: string;
  detail: string;
  tone: string;
  compact?: boolean;
};

const EMPTY: DisplayState = {
  connected: false,
  address: "192.168.206.99",
  updatedAt: "1970-01-01T00:00:00.000Z",
  show: { name: "Waiting for show", status: "idle", startedAt: null },
  program: null,
  preview: null,
  sources: [],
  events: [],
  transitions: { cut: 0, mix: 0, other: 0 },
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
    dualMeAwards: 0,
    bumCuts: 0,
    sixSevenBonuses: 0,
    nidaAwards: 0,
    primeAwards: 0,
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
};

const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
};

const time = (iso: string) =>
  new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));

const visibleNumber = (name: string, id: number) => {
  const match = name.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : id;
};

const prime = (value: number) => {
  if (!Number.isInteger(value) || value < 2) return false;
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) {
    if (value % divisor === 0) return false;
  }
  return true;
};

const fibonacci = (value: number) => {
  if (!Number.isInteger(value) || value < 1) return false;
  if (value === 1 || value === 2) return true;
  let previous = 1;
  let current = 2;
  while (current < value) {
    [previous, current] = [current, previous + current];
  }
  return current === value;
};

const NumberMarks = ({ source }: { source: { id: number; name: string } }) => {
  const number = visibleNumber(source.name, source.id);
  return (
    <>
      {prime(number) && <i className="display-prime">ℙ</i>}
      {fibonacci(number) && <i className="display-fibonacci">φ</i>}
    </>
  );
};

const diversityStats = (monitor: DisplayState, now: number) => {
  const start = monitor.show.startedAt
    ? new Date(monitor.show.startedAt).getTime()
    : now;
  const roundLength = 45_000;
  const currentRound = Math.max(0, Math.floor((now - start) / roundLength));
  const rounds = new Map<number, Set<string>>();
  const add = (round: number, name: string) => {
    const clean = String(name || "").trim();
    if (!clean || clean.toLowerCase() === "black") return;
    if (!rounds.has(round)) rounds.set(round, new Set());
    rounds.get(round)?.add(clean);
  };
  for (const event of monitor.events) {
    const round = Math.max(
      0,
      Math.floor((new Date(event.at).getTime() - start) / roundLength),
    );
    add(round, event.from);
    add(round, event.to);
  }
  if (monitor.program) add(currentRound, monitor.program.name);
  const counts = [...rounds.values()].map((names) => names.size);
  return {
    best: Math.max(0, ...counts),
    current: rounds.get(currentRound)?.size ?? 0,
    awards: counts.filter((count) => count >= 5).length,
    round: currentRound + 1,
    remaining: start + (currentRound + 1) * roundLength - now,
  };
};

const bingoFor = (
  monitor: DisplayState,
  diversity: ReturnType<typeof diversityStats>,
  sources: SourceItem[],
) => {
  const takes =
    monitor.transitions.cut +
    monitor.transitions.mix +
    monitor.transitions.other;
  const tBars = Math.floor(monitor.transitions.mix / 10);
  const maxAir = Math.max(0, ...sources.map((source) => source.milliseconds));
  const boards: Array<Array<{ label: string; done: boolean }>> = [
    [
      { label: "10 CUTS", done: monitor.transitions.cut >= 10 },
      { label: "5 MIXES", done: monitor.transitions.mix >= 5 },
      { label: "5 IN 45", done: diversity.best >= 5 },
      { label: "50 CUTS", done: monitor.transitions.cut >= 50 },
      { label: "T BAR!", done: tBars >= 1 },
      { label: "8 IN 45", done: diversity.best >= 8 },
      { label: "100 TAKES", done: takes >= 100 },
      { label: "20 MIXES", done: monitor.transitions.mix >= 20 },
      { label: "5 MIN AIR", done: maxAir >= 300_000 },
    ],
    [
      { label: "750 CUTS", done: monitor.transitions.cut >= 750 },
      { label: "300 MIXES", done: monitor.transitions.mix >= 300 },
      { label: "10 IN 45", done: diversity.best >= 10 },
      { label: "900 CUTS", done: monitor.transitions.cut >= 900 },
      { label: "35 T BARS", done: tBars >= 35 },
      { label: "12 IN 45", done: diversity.best >= 12 },
      { label: "1,250 TAKES", done: takes >= 1_250 },
      { label: "400 MIXES", done: monitor.transitions.mix >= 400 },
      { label: "45 MIN AIR", done: maxAir >= 2_700_000 },
    ],
    [
      { label: "1,000 CUTS", done: monitor.transitions.cut >= 1_000 },
      { label: "500 MIXES", done: monitor.transitions.mix >= 500 },
      { label: "20 DIVERSITY", done: diversity.awards >= 20 },
      { label: "1,250 CUTS", done: monitor.transitions.cut >= 1_250 },
      { label: "60 T BARS", done: tBars >= 60 },
      { label: "12 IN 45", done: diversity.best >= 12 },
      { label: "2,000 TAKES", done: takes >= 2_000 },
      { label: "700 MIXES", done: monitor.transitions.mix >= 700 },
      { label: "60 MIN AIR", done: maxAir >= 3_600_000 },
    ],
    [
      { label: "1,500 CUTS", done: monitor.transitions.cut >= 1_500 },
      { label: "800 MIXES", done: monitor.transitions.mix >= 800 },
      { label: "40 DIVERSITY", done: diversity.awards >= 40 },
      { label: "2,000 CUTS", done: monitor.transitions.cut >= 2_000 },
      { label: "100 T BARS", done: tBars >= 100 },
      { label: "12 IN 45", done: diversity.best >= 12 },
      { label: "3,000 TAKES", done: takes >= 3_000 },
      { label: "1,200 MIXES", done: monitor.transitions.mix >= 1_200 },
      { label: "90 MIN AIR", done: maxAir >= 5_400_000 },
    ],
    [
      { label: "2,500 CUTS", done: monitor.transitions.cut >= 2_500 },
      { label: "1,500 MIXES", done: monitor.transitions.mix >= 1_500 },
      { label: "75 DIVERSITY", done: diversity.awards >= 75 },
      { label: "3,000 CUTS", done: monitor.transitions.cut >= 3_000 },
      { label: "200 T BARS", done: tBars >= 200 },
      { label: "12 IN 45", done: diversity.best >= 12 },
      { label: "5,000 TAKES", done: takes >= 5_000 },
      { label: "2,500 MIXES", done: monitor.transitions.mix >= 2_500 },
      { label: "120 MIN AIR", done: maxAir >= 7_200_000 },
    ],
  ];
  const index = boards.findIndex((board) => !board.every((tile) => tile.done));
  const activeIndex = index === -1 ? 4 : index;
  return { level: activeIndex + 1, tiles: boards[activeIndex] };
};

export default function DisplayPage() {
  const [data, setData] = useState<DisplayState>(EMPTY);
  const [now, setNow] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [takeFlash, setTakeFlash] = useState<EventItem | null>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const previous = useRef<Record<string, number> | null>(null);
  const previousEventId = useRef<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const diversity = diversityStats(data, now);
  const bingo = bingoFor(data, diversity, sources);
  const takes =
    data.transitions.cut + data.transitions.mix + data.transitions.other;
  const me2Takes =
    data.me2.transitions.cut +
    data.me2.transitions.mix +
    data.me2.transitions.other;
  const elapsedShowMinutes =
    data.show.startedAt && now
      ? Math.max(0, now - new Date(data.show.startedAt).getTime()) / 60_000
      : 0;
  const cutsPerMinute =
    elapsedShowMinutes > 0 ? data.transitions.cut / elapsedShowMinutes : 0;
  const transitionsPerMinute =
    elapsedShowMinutes > 0 ? takes / elapsedShowMinutes : 0;
  const awardCount =
    Math.floor(data.transitions.mix / 10) +
    diversity.awards +
    Math.floor(me2Takes / 10) +
    Math.floor(data.me2.transitions.mix / 5) +
    data.special.halfMixAwards +
    data.special.dualMeAwards +
    data.special.sixSevenBonuses +
    data.special.nidaAwards +
    data.special.primeAwards +
    data.special.fibonacciAwards +
    Object.values(data.special.sequenceAwards).reduce(
      (sum, count) => sum + count,
      0,
    );
  const xp =
    data.transitions.cut * 10 +
    data.transitions.mix * 25 +
    diversity.current * 100 +
    awardCount * 500;
  const directorLevel = Math.floor(xp / 2500) + 1;
  const xpProgress = (xp % 2500) / 25;
  const recentThirtySeconds = data.events.filter(
    (event) => now > 0 && now - new Date(event.at).getTime() <= 30_000,
  ).length;
  const directorHeat = Math.min(100, recentThirtySeconds * 12);
  const leadingType = data.events[0]?.type;
  const takeStreak = leadingType
    ? data.events.findIndex((event) => event.type !== leadingType)
    : 0;
  const visibleStreak =
    takeStreak === -1 ? Math.min(data.events.length, 99) : takeStreak;
  const mixesToTBar = 10 - (data.transitions.mix % 10 || 10);
  const awardRack = [
    ["⊤", Math.floor(data.transitions.mix / 10), "T BAR"],
    ["D", diversity.awards, "DIVERSITY"],
    ["½", data.special.halfMixAwards, "HALF MIX"],
    ["Ⅱ", data.special.dualMeAwards, "DUAL ME"],
    ["67", data.special.sixSevenBonuses, "6/7"],
    ["N", data.special.nidaAwards, "NIDA"],
    ["ℙ", data.special.primeAwards, "PRIME"],
    ["φ", data.special.fibonacciAwards, "FIBONACCI"],
    ["π", data.special.sequenceAwards.piTime, "PI TIME"],
    ["P↑", data.special.sequenceAwards.primeLadder, "PRIME LADDER"],
    ["G", data.special.sequenceAwards.goldenRun, "GOLDEN RUN"],
    ["T", data.special.sequenceAwards.transitionTango, "TANGO"],
    ["RF", data.special.sequenceAwards.rapidFire, "RAPID FIRE"],
    ["⌂", data.special.sequenceAwards.homecoming, "HOMECOMING"],
    ["♪", data.special.sequenceAwards.nSync, "N*SYNC"],
  ] as const;

  const showNotice = (next: Notice) => {
    setNotice(next);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4800);
  };

  useEffect(() => {
    const host = window.location.hostname;
    const stream = new EventSource(`http://${host}:3001/events`);
    stream.onmessage = (event) => {
      const next = JSON.parse(event.data) as DisplayState;
      next.me2 ??= EMPTY.me2;
      next.special = { ...EMPTY.special, ...(next.special || {}) };
      const nextDiversity = diversityStats(next, Date.now());
      const nextSources = next.sources.filter(
        (source) =>
          source.id !== 0 && source.name.trim().toLowerCase() !== "black",
      );
      const nextBingo = bingoFor(next, nextDiversity, nextSources);
      const nextMe2Takes =
        next.me2.transitions.cut +
        next.me2.transitions.mix +
        next.me2.transitions.other;
      const counters = {
        takes:
          next.transitions.cut +
          next.transitions.mix +
          next.transitions.other,
        tbar: Math.floor(next.transitions.mix / 10),
        diversity: nextDiversity.awards,
        dennis: next.wrongBusAlerts || 0,
        me2: Math.floor(nextMe2Takes / 10),
        me2mix: Math.floor(next.me2.transitions.mix / 5),
        half: next.special.halfMixAwards,
        dual: next.special.dualMeAwards,
        bum: next.special.bumCuts,
        sixseven: next.special.sixSevenBonuses,
        nida: next.special.nidaAwards,
        prime: next.special.primeAwards,
        fibonacci: next.special.fibonacciAwards,
        piTime: next.special.sequenceAwards.piTime,
        primeLadder: next.special.sequenceAwards.primeLadder,
        goldenRun: next.special.sequenceAwards.goldenRun,
        transitionTango: next.special.sequenceAwards.transitionTango,
        rapidFire: next.special.sequenceAwards.rapidFire,
        homecoming: next.special.sequenceAwards.homecoming,
        nSync: next.special.sequenceAwards.nSync,
        bingo: nextBingo.level,
      };
      if (previous.current) {
        const newestEvent = next.events[0];
        if (
          newestEvent &&
          previousEventId.current &&
          newestEvent.id !== previousEventId.current
        ) {
          setTakeFlash(newestEvent);
          if (takeTimer.current) clearTimeout(takeTimer.current);
          takeTimer.current = setTimeout(() => setTakeFlash(null), 1350);
        }
        const fibonacciTier =
          next.special.fibonacciEvents[0]?.tier ?? "bronze";
        const sequenceNotice = (
          key: keyof DisplayState["special"]["sequenceAwards"],
          symbol: string,
          tone: string,
          compact = false,
        ): Notice => {
          const latest = next.special.sequenceEvents.find(
            (event) => event.key === key,
          );
          return {
            symbol,
            kicker: "DIRECTOR SEQUENCE COMPLETE",
            title: latest?.label ?? key,
            detail: latest?.detail ?? "SEQUENCE COMPLETE",
            tone,
            compact,
          };
        };
        const candidates: Array<[keyof typeof counters, Notice]> = [
          ["tbar", { symbol: "⊤", kicker: "10 MIX COMBO", title: "T BAR AWARD", detail: "SMOOTH HANDS · BIG POINTS", tone: "gold" }],
          ["diversity", { symbol: "D", kicker: "5 SOURCES · 45 SECONDS", title: "DIVERSITY AWARD", detail: "ROUND CLEARED", tone: "purple" }],
          ["me2", { symbol: "Ⅱ", kicker: "ME2 MILESTONE", title: "SECOND DECK AWARD", detail: "DOUBLE DECK ENERGY", tone: "cyan" }],
          ["me2mix", { symbol: "Ⅱ", kicker: "ME2 MIX COMBO", title: "ME2 MIX MASTER", detail: "SECOND MIX EFFECTS", tone: "cyan" }],
          ["half", { symbol: "½", kicker: "HELD AT HALF", title: "LONG HALF-MIX", detail: "SMOOTH CONTROL", tone: "gold" }],
          ["dual", { symbol: "Ⅱ", kicker: "ME1 + ME2", title: "DUAL ME AWARD", detail: "TWO DECKS · ONE DIRECTOR", tone: "purple" }],
          ["bum", { symbol: "⚡", kicker: "UNDER 500 MS", title: "BUM CUT", detail: "SLOW DOWN, SPEED RACER", tone: "red" }],
          ["sixseven", { symbol: "67", kicker: "SOURCE 6 ↔ SOURCE 7", title: "6/7", detail: "6/7", tone: "cyan" }],
          ["nida", { symbol: "N", kicker: "WIPE TRANSITION", title: "NIDA AWARD", detail: "DRAMA · THEATRE · TRANSITION", tone: "red" }],
          ["piTime", sequenceNotice("piTime", "π", "purple")],
          ["primeLadder", sequenceNotice("primeLadder", "P↑", "purple")],
          ["goldenRun", sequenceNotice("goldenRun", "G", "gold")],
          ["homecoming", sequenceNotice("homecoming", "⌂", "green")],
          ["transitionTango", sequenceNotice("transitionTango", "T", "cyan")],
          ["rapidFire", sequenceNotice("rapidFire", "RF", "red")],
          ["nSync", sequenceNotice("nSync", "♪", "green")],
          ["prime", { symbol: "ℙ", kicker: "3 PRIME SOURCES", title: "PRIME TIME", detail: "2 · 3 · 5 · 7 · 11 · 13", tone: "purple" }],
          ["fibonacci", {
            symbol: "φ",
            kicker: "GOLDEN RATIO COMBO",
            title: `FIBONACCI ${fibonacciTier.toUpperCase()}`,
            detail:
              fibonacciTier === "gold"
                ? "5 DISTINCT SOURCES · TOP LEVEL"
                : fibonacciTier === "silver"
                  ? "4 DISTINCT SOURCES · LEVEL UP"
                  : "3 DISTINCT SOURCES · FIRST HIT",
            tone: "green",
            compact: fibonacciTier === "bronze",
          }],
          ["bingo", { symbol: String(nextBingo.level), kicker: "ALL 9 SQUARES CLEARED", title: `BINGO LEVEL ${nextBingo.level}`, detail: "NEW BOARD UNLOCKED", tone: "purple" }],
          ["dennis", { symbol: "⚠", kicker: "PREVIEW BUS STREAK", title: "DENNIS MODE", detail: "YOU’RE CUTTING THE WRONG BUS", tone: "warning" }],
        ];
        const triggered = candidates.find(
          ([key]) => counters[key] > (previous.current?.[key] ?? 0),
        );
        if (triggered) showNotice(triggered[1]);
      }
      previousEventId.current = next.events[0]?.id ?? null;
      previous.current = counters;
      setData(next);
    };
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stream.close();
      clearInterval(ticker);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (takeTimer.current) clearTimeout(takeTimer.current);
    };
  }, []);

  useEffect(() => {
    const changed = () => setNativeFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      await document.exitFullscreen();
    } else if (typeof document.documentElement.requestFullscreen === "function") {
      await document.documentElement.requestFullscreen();
    }
  };

  return (
    <main className="display-page">
      <div className="display-aurora" aria-hidden="true" />
      <div className="display-grid-floor" aria-hidden="true" />
      {notice && (
        <div className={`display-notice ${notice.tone} ${notice.compact ? "compact" : ""}`} role="status" aria-live="assertive">
          <div className="display-confetti" aria-hidden="true">
            {Array.from({ length: 32 }, (_, index) => (
              <i
                key={index}
                style={{
                  "--confetti-x": `${(index * 37) % 100}vw`,
                  "--confetti-delay": `${(index % 8) * 0.07}s`,
                  "--confetti-turn": `${(index * 47) % 360}deg`,
                } as React.CSSProperties}
              />
            ))}
          </div>
          {notice.symbol === "67" && (
            <img src="/67-kid.jpg" alt="" />
          )}
          <i>{notice.symbol}</i>
          <span>{notice.kicker}</span>
          <strong>{notice.title}</strong>
          <b>{notice.detail}</b>
        </div>
      )}
      {takeFlash && (
        <div
          className={`display-take-flash ${takeFlash.type.toLowerCase()}`}
          key={takeFlash.id}
          aria-live="polite"
        >
          <span>NOW ON AIR</span>
          <strong>{takeFlash.type}</strong>
          <b>{takeFlash.to}</b>
        </div>
      )}

      <header className="display-header">
        <div>
          <img className="display-brand-mark" src="/pcc-cogs.png" alt="" />
          <span className={`display-live-dot ${data.connected ? "online" : ""}`} />
          <p><small>SWITCH KPI · PCC · DIRECTOR DISPLAY</small><strong>{data.show.name}</strong></p>
        </div>
        <div className="display-header-stats">
          <div className="display-level">
            <i>LVL {directorLevel}</i>
            <span><b style={{ width: `${xpProgress}%` }} /></span>
            <small>{xp.toLocaleString()} XP</small>
          </div>
          <span>{data.show.status.toUpperCase()}</span>
          <b>{duration(data.show.startedAt && now ? now - new Date(data.show.startedAt).getTime() : 0)}</b>
          <button onClick={toggleFullscreen}>
            {nativeFullscreen ? "Exit Full Screen" : "Full Screen"}
          </button>
          <a href="/">Dashboard</a>
        </div>
      </header>

      <section className="display-buses">
        <article className="program">
          <small><i className="on-air-pulse" /> ME1 PROGRAM · ON AIR</small>
          <strong>{data.program?.name ?? "—"} {data.program && <NumberMarks source={data.program} />}</strong>
          <span>{data.program ? `Input ${data.program.id}` : "Waiting for signal"}</span>
        </article>
        <div className="display-take-arrow"><span>→</span></div>
        <article className="preview">
          <small>ME1 PREVIEW</small>
          <strong>{data.preview?.name ?? "—"} {data.preview && <NumberMarks source={data.preview} />}</strong>
          <span>{data.preview ? `Input ${data.preview.id}` : "Waiting for signal"}</span>
        </article>
        <article className="display-total">
          <small>TOTAL TAKES</small>
          <strong>{takes}</strong>
          <span>
            {cutsPerMinute.toFixed(1)} CUTS/MIN ·{" "}
            {transitionsPerMinute.toFixed(1)} TRANSITIONS/MIN
          </span>
        </article>
      </section>

      <section className="display-main-grid">
        <article className="display-panel display-sources">
          <div className="display-panel-title"><span>ME1 SOURCE SHARE</span><b>TOP 8</b></div>
          {sources.slice(0, 8).map((source, index) => {
            const percentage = (source.milliseconds / totalAirtime) * 100;
            return (
              <div className={`display-source ${source.live ? "live" : ""}`} key={source.id}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span>{source.name}<NumberMarks source={source} /></span>
                <div><i style={{ width: `${Math.max(1, percentage)}%` }} /></div>
                <strong>{percentage.toFixed(1)}%</strong>
                <small>{duration(source.milliseconds)}</small>
              </div>
            );
          })}
        </article>

        <article className="display-panel display-kpi">
          <div className="display-panel-title"><span>BINGO LEVEL {bingo.level}</span><b>{bingo.tiles.filter((tile) => tile.done).length}/9</b></div>
          <div className="display-score-grid">
            <div><span>CUTS</span><b>{data.transitions.cut}</b></div>
            <div><span>MIXES</span><b>{data.transitions.mix}</b></div>
            <div><span>T BARS</span><b>{Math.floor(data.transitions.mix / 10)}</b></div>
            <div><span>DIVERSITY</span><b>{diversity.best}</b></div>
          </div>
          <div className="display-heat">
            <span><b>DIRECTOR HEAT</b><small>{recentThirtySeconds * 2} takes/min</small></span>
            <div><i style={{ width: `${directorHeat}%` }} /></div>
            <strong>{directorHeat >= 75 ? "🔥 HOT" : directorHeat >= 40 ? "WARM" : "COOL"}</strong>
          </div>
          <div className="display-bingo">
            {bingo.tiles.map((tile) => (
              <div className={tile.done ? "done" : ""} key={tile.label}>
                <b>{tile.done ? "✓" : "·"}</b><span>{tile.label}</span>
              </div>
            ))}
          </div>
          <div className="display-diversity">
            <span>ROUND {diversity.round} · {diversity.current} SOURCES</span>
            <b>{duration(Math.max(0, diversity.remaining))} LEFT</b>
          </div>
        </article>

        <article className="display-panel display-events">
          <div className="display-panel-title"><span>RECENT TAKES</span><b>{data.transitions.mix ? `${Math.round((data.transitions.mix / Math.max(1, takes)) * 100)}% MIX` : "CUT MODE"}</b></div>
          <div className="display-combo">
            <span><small>LIVE COMBO</small><b>{visibleStreak}× {leadingType || "READY"}</b></span>
            <span><small>NEXT T BAR</small><b>{mixesToTBar || 10} MIXES</b></span>
          </div>
          {data.events.slice(0, 9).map((event) => (
            <div className="display-event" key={event.id}>
              <time>{time(event.at)}</time>
              <span><b>{event.to}</b><small>from {event.from}</small></span>
              <strong className={event.type.toLowerCase()}>{event.type}</strong>
            </div>
          ))}
        </article>
      </section>

      <footer className="display-footer">
        <section className="display-me2">
          <div><small>SECOND MIX EFFECTS</small><strong>ME2</strong><span>{data.me2.available ? "ONLINE" : "NOT AVAILABLE"}</span></div>
          <div><small>PROGRAM</small><strong>{data.me2.program?.name ?? "—"}</strong></div>
          <div><small>PREVIEW</small><strong>{data.me2.preview?.name ?? "—"}</strong></div>
          <div><small>TAKES</small><strong>{me2Takes}</strong></div>
          <div><small>CUT / MIX</small><strong>{data.me2.transitions.cut} / {data.me2.transitions.mix}</strong></div>
          <div><small>AWARDS</small><strong>{awardCount}</strong></div>
        </section>
        <div className="display-award-ticker">
          <strong>AWARD CABINET</strong>
          <div>
            {[...awardRack, ...awardRack].map(([symbol, count, label], index) => (
              <span key={`${label}-${index}`}><i>{symbol}</i>{label}<b>×{count}</b></span>
            ))}
          </div>
        </div>
      </footer>
    </main>
  );
}
