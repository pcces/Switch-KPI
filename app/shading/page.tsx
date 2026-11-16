"use client";

import { useEffect, useMemo, useState } from "react";
import "./shading.css";

type Camera = {
  id: string; name: string; role: string; host: string | null; controller: string;
  online: boolean; adjustments: number; adjustmentsPerMinute: number; variance: number;
  meanMagnitude: number; lastMagnitude: number; lastAdjustmentAt: string | null;
  iris?: number; gainDb?: number;
  metrics: { luma: number; r: number; g: number; b: number; contrast: number } | null;
  note: string; history: number[];
};
type Event = { id: string; camera: string; at: string; magnitude: number; parameter?: string; lumaDelta: number; colourDelta: number };
type State = {
  startedAt: string; updatedAt: string; cameras: Camera[]; events: Event[];
  cyanView: Record<string, any> & { duplicateConfiguration: boolean };
};

const EMPTY: State = { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cameras: [], events: [], cyanView: { duplicateConfiguration: false } };
const number = (value: number, digits = 1) => Number(value || 0).toFixed(digits);
const time = (iso?: string | null) => iso ? new Intl.DateTimeFormat("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso)) : "—";

function Spark({ values }: { values: number[] }) {
  const max = Math.max(5, ...values);
  return <div className="shade-spark" aria-label="Recent adjustment magnitude">{values.slice(-60).map((value, index) => <i key={index} style={{ height: `${Math.max(3, value / max * 100)}%` }} className={value >= 8 ? "hit" : ""} />)}</div>;
}

function CameraParameterGraph({ events, camera }: { events: Event[]; camera: string }) {
  const now = Date.now();
  const windowMs = 10 * 60_000;
  const bins = 60;
  const parameters = ["Iris / Gain", "Master Black", "RGB"];
  const cameraEvents = events.filter((event) => event.camera === camera);
  const series = parameters.map((parameter) => {
    const values = Array.from({ length: bins }, () => 0);
    const recent = cameraEvents.filter(
      (event) =>
        event.parameter === parameter &&
        now - new Date(event.at).getTime() <= windowMs,
    );
    for (const event of recent) {
      const age = now - new Date(event.at).getTime();
      const index = Math.min(
        bins - 1,
        Math.max(0, Math.floor(((windowMs - age) / windowMs) * bins)),
      );
      values[index] = Math.max(values[index], event.magnitude);
    }
    return { parameter, values, count: recent.length };
  });
  const max = Math.max(8, ...series.flatMap((item) => item.values));
  return <section className="camera-parameter-graph">
    <header><strong>CONTROL ACTIVITY</strong><span>10 MIN</span></header>
    <div className="camera-parameter-series">
      {series.map((item) => <article key={item.parameter} className={`parameter-row parameter-${item.parameter.replaceAll(" ", "-").replace("/", "-").toLowerCase()}`}>
        <div><strong>{item.parameter}</strong><small>{item.count}</small></div>
        <div className="parameter-bars" aria-label={`${item.parameter} activity`}>
          {item.values.map((value, index) => <i key={index} className={value ? "active" : ""} style={{ height: `${value ? Math.max(8, value / max * 100) : 2}%` }} title={value ? `${number(value)} magnitude` : "No change"} />)}
        </div>
        <b>{number(Math.max(0, ...item.values))}</b>
      </article>)}
    </div>
  </section>;
}

export default function ShadingDashboard() {
  const [data, setData] = useState<State>(EMPTY);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const host = window.location.hostname;
    const stream = new EventSource(`http://${host}:3002/events`);
    stream.onopen = () => setConnected(true);
    stream.onmessage = (event) => setData(JSON.parse(event.data));
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, []);
  const active = data.cameras.filter((camera) => camera.online);
  const total = data.cameras.reduce((sum, camera) => sum + camera.adjustments, 0);
  const mostAdjusted = useMemo(() => [...data.cameras].sort((a, b) => b.adjustments - a.adjustments)[0], [data.cameras]);

  return <main className="shade-dashboard">
    <header className="shade-header">
      <div><p>LIVE SHADING TELEMETRY</p><h1>Camera Image Adjustments</h1></div>
      <div className="shade-live"><i className={connected ? "online" : ""}/><span><strong>{connected ? "MONITORING" : "RECONNECTING"}</strong><small>{active.length}/{data.cameras.length} image feeds · {time(data.updatedAt)}</small></span></div>
    </header>

    {data.cyanView.duplicateConfiguration && <div className="shade-warning"><strong>CYANVIEW MAPPING CHECK</strong><span>192.168.206.225 and .252 currently report the same CAM 6 / CAM 7 configuration. CAM 3 has no unique feed yet.</span></div>}

    <section className="shade-summary">
      <article><span>TOTAL ADJUSTMENTS</span><strong>{total}</strong><small>since {time(data.startedAt)}</small></article>
      <article><span>CAMERAS ONLINE</span><strong>{active.length}<em> / {data.cameras.length}</em></strong><small>read-only image feeds</small></article>
      <article><span>MOST ADJUSTED</span><strong>{mostAdjusted?.adjustments ? mostAdjusted.name : "—"}</strong><small>{mostAdjusted?.adjustments || 0} detected events</small></article>
      <article><span>LATEST CHANGE</span><strong>{data.events[0]?.camera || "—"}</strong><small>{time(data.events[0]?.at)}</small></article>
    </section>

    <section className="shade-grid">
      {data.cameras.map((camera) => <article className={`shade-card ${camera.online ? "" : "offline"}`} key={camera.id}>
        <div className="shade-card-title"><div><i className={camera.online ? "online" : ""}/><span><strong>{camera.name}</strong><small>{camera.role} · {camera.controller}</small></span></div><b>{camera.online ? "LIVE" : "NO FEED"}</b></div>
        <div className="shade-count"><strong>{camera.adjustments}</strong><span>adjustments<small>{number(camera.adjustmentsPerMinute, 2)} / min</small></span></div>
        <Spark values={camera.history || []}/>
        <div className="shade-stats">
          <span><small>MEAN SIZE</small><strong>{number(camera.meanMagnitude)}</strong></span>
          <span><small>VARIANCE</small><strong>{number(camera.variance)}</strong></span>
          <span><small>LAST SIZE</small><strong>{number(camera.lastMagnitude)}</strong></span>
        </div>
        <div className="shade-levels">
          <span>LUMA <b>{camera.metrics ? number(camera.metrics.luma, 0) : "—"}</b></span>
          <span>R <b>{camera.metrics ? number(camera.metrics.r, 0) : "—"}</b></span>
          <span>G <b>{camera.metrics ? number(camera.metrics.g, 0) : "—"}</b></span>
          <span>B <b>{camera.metrics ? number(camera.metrics.b, 0) : "—"}</b></span>
        </div>
        {(camera.iris !== undefined || camera.gainDb !== undefined) && <div className="camera-exposure-values">
          <span><small>CURRENT IRIS</small><strong>f/{number(camera.iris ?? 0, 1)}</strong></span>
          <span><small>CURRENT GAIN</small><strong>{camera.gainDb && camera.gainDb > 0 ? "+" : ""}{number(camera.gainDb ?? 0, 1)} dB</strong></span>
          <em>confirmed reference</em>
        </div>}
        <CameraParameterGraph events={data.events} camera={camera.name}/>
        <footer><span>{camera.note}</span><time>last adjustment {time(camera.lastAdjustmentAt)}</time></footer>
      </article>)}
    </section>

    <section className="shade-events">
      <header><div><p>EVENT LOG</p><h2>Recent adjustments</h2></div><span>Strict shading filter · threshold 8.0</span></header>
      <div>{data.events.length ? data.events.slice(0, 20).map((event) => <article key={event.id}><time>{time(event.at)}</time><strong>{event.camera} · {event.parameter || "Image"}</strong><span>Magnitude <b>{number(event.magnitude)}</b></span><span>Luma Δ <b>{event.lumaDelta > 0 ? "+" : ""}{number(event.lumaDelta)}</b></span><span>RGB Δ <b>{number(event.colourDelta)}</b></span></article>) : <p className="shade-empty">Monitoring Iris, Gain, Master Black and RGB. Waiting for a confirmed adjustment.</p>}</div>
    </section>
  </main>;
}
