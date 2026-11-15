import { useEffect, useState } from "react";
import type { AccountUsage, MinuteLimit, MinuteUsage } from "../../../src/core/types";
import { api } from "../api";
import { fmtTokens } from "../lib/format";
import { usageTone } from "../lib/usage";
import { niceTicks, useWidth } from "./Insights";
import "./insights.css";

/**
 * An account on a service that caps tokens a minute (Morph): what is left of
 * this minute's caps, as the last reading's reply headers said, and the last
 * hour or week of tokens a minute set against them (`src/core/minutes.ts`).
 */

const PART = { input: "Uncached input", output: "Output" } as const;
const PARTS = ["input", "output"] as const;

function burstText(b: MinuteLimit["burst"]): string {
  if (!b) return "";
  if (b.state === "ready") return "reserve full";
  if (b.state === "active") return `reserve in use · ${fmtTokens(b.remaining)} left`;
  if (b.state === "refilling") return `reserve refilling · ${fmtTokens(b.remaining)}`;
  return `reserve ${b.state}`;
}

/** This minute's caps, one bar each. */
export function MinuteMeter({ perMinute }: { perMinute: NonNullable<AccountUsage["perMinute"]> }) {
  return (
    <>
      {perMinute.limits.map((l) => {
        const used = Math.max(0, l.limit - l.remaining);
        const pct = (used / l.limit) * 100;
        const label = `${PART[l.part]} a minute`;
        return (
          <div key={l.part} className="ubar ubar-short" data-tone={l.burst?.state === "active" ? "bad" : usageTone(pct)}>
            <div className="ubar-head">
              <span className="ubar-label">{label}</span>
              <span className="ubar-pct">
                {fmtTokens(used)} <span className="ubar-claim">of {fmtTokens(l.limit)}</span>
              </span>
              <span className="ubar-reset">{burstText(l.burst)}</span>
            </div>
            <div
              className="ubar-track"
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={l.limit}
              aria-valuenow={used}
              aria-valuetext={`${fmtTokens(used)} of ${fmtTokens(l.limit)} used this minute${l.burst ? `, ${burstText(l.burst)}` : ""}`}
              title={`${perMinute.model}: ${used.toLocaleString()} of ${l.limit.toLocaleString()} used this minute`}
            >
              <i className="ubar-used" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

const TIME_FMT = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat([], { weekday: "short" });
const WHEN_FMT = new Intl.DateTimeFormat([], { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The last hour or week of tokens a minute, as a share of each cap. */
export function MinuteHistory({ accountId }: { accountId: string }) {
  const [span, setSpan] = useState<"hour" | "week">("hour");
  const [data, setData] = useState<MinuteUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .minutes(accountId, span)
        .then((d) => {
          if (!live) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(() => void load(), span === "hour" ? 60_000 : 10 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [accountId, span]);

  const shown = data && data.step === (span === "hour" ? 60_000 : 3_600_000) ? data : null;
  const what = span === "hour" ? "this hour" : "this week";

  return (
    <section className="pm" aria-label="Tokens a minute">
      <div className="pm-head">
        <span className="pm-title">Tokens a minute</span>
        <div className="seg" role="group" aria-label="Span">
          {(["hour", "week"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={span === s} onClick={() => setSpan(s)}>
              {s === "hour" ? "Hour" : "Week"}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="error-line">{error}</p>
      ) : !shown ? (
        <p className="hint">Reading…</p>
      ) : !shown.limits ? (
        <p className="hint">No per-minute caps read yet: refresh the account's usage.</p>
      ) : (
        <>
          <ul className="pm-lines">
            {PARTS.map((p) => {
              const over = shown.over[p];
              const peak = Math.max(...shown.buckets.map((b) => (p === "input" ? b.inputPeak : b.outputPeak)));
              const cap = fmtTokens(shown.limits![p]);
              return (
                <li key={p}>
                  <span className="ins-key" data-part={p} />
                  {over
                    ? `${PART[p]} went over its ${cap} cap in ${over.toLocaleString()} of ${shown.minutes.toLocaleString()} minutes (${Math.round((over / shown.minutes) * 100)}%); busiest ${fmtTokens(peak)}.`
                    : `${PART[p]} stayed under its ${cap} cap; busiest ${fmtTokens(peak)}.`}
                </li>
              );
            })}
            <li title="omp retries a 429 by itself; only one it gave up on stops the turn and is counted here.">
              <span className="ins-key pm-key-hit" />
              {shown.hits.length
                ? `${shown.hits.length.toLocaleString()} turn${shown.hits.length === 1 ? "" : "s"} stopped on a 429 ${what}.`
                : `No turn stopped on a 429 ${what}.`}
            </li>
          </ul>
          <Chart data={shown} limits={shown.limits} />
        </>
      )}
    </section>
  );
}

const PAD = { left: 38, right: 6, top: 8, bottom: 20 };

function Chart({ data, limits }: { data: MinuteUsage; limits: NonNullable<MinuteUsage["limits"]> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.buckets.length;
  const H = 130;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const band = n ? plotW / n : 0;
  const pctOf = (p: "input" | "output", b: MinuteUsage["buckets"][number]) => (b[p] / limits[p]) * 100;
  const top = Math.max(100, ...data.buckets.flatMap((b) => PARTS.map((p) => pctOf(p, b))));
  const ticks = niceTicks(top, 3);
  const yMax = ticks[ticks.length - 1]!;
  const yOf = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / yMax);
  const xOf = (i: number) => PAD.left + (i + 0.5) * band;
  const xAt = (t: number) => PAD.left + ((t - data.from) / data.step) * band;
  const path = (p: "input" | "output") => data.buckets.map((b, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(pctOf(p, b)).toFixed(1)}`).join("");

  // Every quarter hour over an hour; local midnight over a week.
  const marks: { i: number; label: string }[] = [];
  data.buckets.forEach((_, i) => {
    const t = data.from + i * data.step;
    const d = new Date(t);
    if (data.step < 3_600_000 ? d.getMinutes() % 15 === 0 : d.getHours() === 0) {
      marks.push({ i, label: data.step < 3_600_000 ? TIME_FMT.format(t) : DAY_FMT.format(t) });
    }
  });

  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.left) / band);
    setHover(i >= 0 && i < n ? i : null);
  };
  const b = hover !== null ? data.buckets[hover]! : null;
  const at = hover !== null ? data.from + hover * data.step : 0;
  const hitsIn = hover !== null ? data.hits.filter((t) => t >= at && t < at + data.step).length : 0;
  const minute = data.step === 60_000;

  return (
    <div className="pm-chart" ref={ref}>
      {width > 0 ? (
        <>
          <svg
            width={width}
            height={H}
            className="ins-svg"
            role="img"
            aria-label={`Uncached input and output tokens a minute, as a share of each cap, ${minute ? "by minute" : "by hour"}`}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          >
            {ticks.map((v) => (
              <g key={v}>
                <line className="ins-grid" x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} />
                <text className="ins-axis" x={PAD.left - 6} y={yOf(v)} dy="0.32em" textAnchor="end">
                  {v}%
                </text>
              </g>
            ))}
            {marks.map((m) => (
              <g key={m.i}>
                <line className="ins-grid" x1={PAD.left + m.i * band} x2={PAD.left + m.i * band} y1={PAD.top} y2={H - PAD.bottom + 4} />
                <text className="ins-axis" x={PAD.left + m.i * band + 3} y={H - 6}>
                  {m.label}
                </text>
              </g>
            ))}
            <line className="pm-cap" x1={PAD.left} x2={width - PAD.right} y1={yOf(100)} y2={yOf(100)} />
            {hover !== null ? <rect className="ins-hover" x={PAD.left + hover * band} y={PAD.top} width={Math.max(1, band)} height={H - PAD.top - PAD.bottom} /> : null}
            {PARTS.map((p) => (
              <path key={p} className="pm-line" data-part={p} d={path(p)} />
            ))}
            {data.hits.map((t) => (
              <circle key={t} className="ins-hit" cx={xAt(t)} cy={PAD.top} r={4}>
                <title>Stopped on a 429 {WHEN_FMT.format(t)}</title>
              </circle>
            ))}
          </svg>
          {b ? (
            <div className="ins-tip" data-docked="">
              <div className="ins-tip-head">
                {minute ? TIME_FMT.format(at) : `${WHEN_FMT.format(at)}, an hour`}
                {hitsIn ? <b>{hitsIn} stopped on a 429</b> : null}
              </div>
              {PARTS.map((p) => (
                <div key={p} className="ins-tip-row">
                  <span className="ins-key" data-part={p} />
                  <span>{PART[p]}</span>
                  <span className="num">
                    {fmtTokens(b[p])} · {Math.round(pctOf(p, b))}%
                    {minute ? "" : ` · busiest ${fmtTokens(p === "input" ? b.inputPeak : b.outputPeak)}`}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
