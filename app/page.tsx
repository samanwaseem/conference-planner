"use client";

/**
 * app/page.tsx: IBA Karachi · GenUI Conference Planner
 *
 * Pipeline (mirrors the lecture):
 *   intent → interpretation → task data model → UI specification → rendering → feedback & adaptation
 *
 *  - The MODEL (via /api/genui, Vercel AI SDK) produces the UI specification.
 *  - Our CODE detects clashes and builds schedules (guardrails), then renders catalog components.
 *  - The user stays in control: approve clash fixes, edit values, ask for changes, undo.
 *
 * Needs: lib/genui.ts, app/api/genui/route.ts, /public/iba-logo.png, lucide-react.
 * (If your project uses src/, change the "../lib/genui" import path.)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, BarChart3, Bot, CalendarDays, CalendarPlus, Check, CheckCircle2, Clock, Coffee,
  GraduationCap, Landmark, Layers, ListChecks, Loader2, MessageSquareText, Mic2, RotateCcw, Send, ShieldCheck,
  Sparkles, Terminal, Undo2, Users, Wallet, Wand2,
} from "lucide-react";
import {
  SLOTS, buildSchedule, clampParams, detectClash, listToSemesters, localGenerate, localRefine, parseRequest, semestersToList,
  type ClashReport, type CompName, type PlannerParams, type Resolution, type Schedule, type Session, type SessionKind, type Spec,
} from "../lib/genui";

const NAVY = "#4A1D24";
const MAROON = "#800000";

type Phase = "form" | "processing" | "clash" | "generating" | "dashboard";
type ToolEvent = { id: number; tool: string; args?: string; status: "running" | "done" };
type Source = "ai" | "local";
type Workspace = { params: PlannerParams; resolution: Resolution; spec: Spec; schedule: Schedule; source: Source };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls the AI route; if it is unreachable, falls back to the same offline logic in the browser. */
async function callApi(body: any): Promise<{ params?: PlannerParams; spec: Spec; source: Source }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch("/api/genui", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    const params = clampParams(body.params ?? {});
    if (body.action === "generate") return { params, spec: localGenerate(params, body.keep), source: "local" };
    return { ...localRefine(String(body.instruction ?? ""), params, body.spec ?? localGenerate(params)), source: "local" };
  }
}

function describeDiff(a: PlannerParams, b: PlannerParams): string {
  const parts: string[] = [];
  (["days", "budget", "tutorials", "topic", "semesters"] as const).forEach((k) => {
    if (a[k] !== b[k]) parts.push(`${k} ${a[k]} → ${b[k]}`);
  });
  return parts.length ? `Brief updated: ${parts.join(", ")}.` : "";
}

/* ─────────────────────────────── Components ─────────────────────────────── */

const MONO = "'DM Mono', ui-monospace, monospace";
const SERIF = "'Cormorant Garamond', Georgia, serif";
const LINE = "#E3D7C6";
const WASH = "#F4ECE0";

const STEPS: { label: string; phases: Phase[] }[] = [
  { label: "BRIEF", phases: ["form"] },
  { label: "REVIEW", phases: ["processing", "clash"] },
  { label: "PLAN", phases: ["generating", "dashboard"] },
];

/** Sessions that must land on Day 1, in order. */
function day1Demand(p: PlannerParams) {
  return ["Opening Session", `${p.topic} Keynote`, ...Array.from({ length: p.tutorials }, (_, i) => `Tutorial ${i + 1}`)];
}

/** The supplied PNG has a white background and wide padding: crop it with CSS and let it blend into the header. */
function Logo() {
  const [ok, setOk] = useState(true);
  if (!ok) {
    return (
      <div className="h-14 w-14 grid place-items-center text-white" style={{ background: MAROON }} aria-label="IBA Karachi">
        <Landmark className="h-7 w-7" />
      </div>
    );
  }
  return (
    <div style={{ width: 220, height: 71, overflow: "hidden", position: "relative", flexShrink: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/iba-logo.png" alt="IBA Karachi" onError={() => setOk(false)} style={{ position: "absolute", maxWidth: "none", width: 245, height: 245, left: -13, top: -87, mixBlendMode: "multiply" }} />
    </div>
  );
}

function PortalHeader({ phase }: { phase: Phase }) {
  const current = STEPS.findIndex((s) => s.phases.includes(phase));
  return (
    <header style={{ background: "#FBF6EE", borderBottom: `1px solid ${LINE}` }}>
      <div className="h-2" style={{ background: MAROON }} />
      <div className="mx-auto max-w-6xl px-5 py-3 flex items-center gap-6">
        <Logo />
        <div className="hidden md:block h-12 w-px" style={{ background: LINE }} />
        <div className="hidden md:block leading-tight">
          <div className="text-3xl font-semibold" style={{ color: MAROON, fontFamily: SERIF }}>Conference Planner</div>
          <div className="text-[11px] tracking-[0.22em] text-stone-500" style={{ fontFamily: MONO }}>EVENTS OFFICE · GENUI PROTOTYPE</div>
        </div>
        <div className="flex-1" />
        <ol className="hidden sm:flex items-center gap-2 text-xs" style={{ fontFamily: MONO }} aria-label="Progress">
          {STEPS.map((s, i) => {
            const active = i === current && phase !== "dashboard";
            const done = i < current || phase === "dashboard";
            return (
              <li key={s.label} className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-full border transition-colors" style={{ background: active ? MAROON : "transparent", color: active ? "#fff" : done ? MAROON : "#9C8C7A", borderColor: active || done ? MAROON : LINE, fontWeight: active ? 600 : 400 }}>
                  {done && !active ? "✓ " : `${String(i + 1).padStart(2, "0")} `}{s.label}
                </span>
                {i < STEPS.length - 1 && <span className="w-4 h-px" style={{ background: LINE }} />}
              </li>
            );
          })}
        </ol>
      </div>
    </header>
  );
}

function ToolTrace({ events }: { events: ToolEvent[] }) {
  if (!events.length) return null;
  return (
    <aside aria-label="AI tool calls" className="rounded-md border p-4 text-xs space-y-2.5 bg-white" style={{ borderColor: LINE, fontFamily: MONO }}>
      <div className="flex items-center gap-2 text-sm font-semibold font-sans" style={{ color: NAVY }}>
        <Terminal className="h-4 w-4" /> Tool calls
      </div>
      {events.map((e) => (
        <div key={e.id} className="flex items-start gap-2">
          {e.status === "running" ? <Loader2 className="h-3.5 w-3.5 mt-0.5 animate-spin shrink-0" style={{ color: MAROON }} /> : <Check className="h-3.5 w-3.5 mt-0.5 text-emerald-600 shrink-0" />}
          <div className="min-w-0">
            <span style={{ color: NAVY }}>{e.tool}()</span>
            {e.args && <div className="text-stone-500 truncate">{e.args}</div>}
          </div>
        </div>
      ))}
    </aside>
  );
}

/** Live Day-1 preview: re-renders as the user edits the brief. */
function LivePreview({ p }: { p: PlannerParams }) {
  const demand = day1Demand(p);
  const placed = demand.slice(0, SLOTS.length);
  const overflow = demand.slice(SLOTS.length);
  return (
    <section className="bg-white rounded-md border" style={{ borderColor: LINE }} aria-live="polite">
      <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: LINE }}>
        <h3 className="text-sm font-semibold" style={{ color: NAVY }}>Day 1 preview</h3>
        <span
          className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
          style={{ fontFamily: MONO, background: overflow.length ? MAROON : "#E6F4EA", color: overflow.length ? "#fff" : "#1E6B34" }}
        >
          {overflow.length ? `${overflow.length} OVER CAPACITY` : "FITS"}
        </span>
      </div>
      <ul>
        {SLOTS.map((slot, i) => (
          <li key={slot.id} className="flex items-stretch border-b last:border-b-0" style={{ borderColor: LINE }}>
            <div className="w-24 px-4 py-3 text-xs text-stone-500 border-r" style={{ fontFamily: MONO, borderColor: LINE }}>{slot.start}</div>
            <div className="flex-1 px-4 py-3 text-sm">
              {placed[i] ? (
                <span className="font-medium" style={{ color: i === 1 ? MAROON : NAVY }}>{placed[i]}</span>
              ) : (
                <span className="text-stone-300">free</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {overflow.length > 0 && (
        <div className="px-5 py-3 border-t flex flex-wrap gap-2" style={{ borderColor: LINE, background: "repeating-linear-gradient(135deg,#fff,#fff 6px,#F9ECEC 6px,#F9ECEC 12px)" }}>
          {overflow.map((o) => (
            <span key={o} className="text-xs font-semibold rounded-sm border px-2 py-1 bg-white" style={{ color: MAROON, borderColor: MAROON }}>{o}: no slot</span>
          ))}
        </div>
      )}
    </section>
  );
}

const TEST_CASE_TEXT = "2 Days, Budget $1000, Topic: AI, 4 Tutorials, Target: 7th & 8th Semester";

function SemesterPicker({ value, onChange, idPrefix }: { value: number[]; onChange: (v: number[]) => void; idPrefix: string }) {
  const ord = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
  return (
    <fieldset>
      <legend className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">TARGET SEMESTER</legend>
      <div className="flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
          const on = value.includes(n);
          return (
            <label key={n} htmlFor={`${idPrefix}-${n}`} className="cursor-pointer select-none inline-flex items-center gap-2 rounded-md border px-3 h-10 text-sm transition-colors" style={{ borderColor: on ? MAROON : LINE, background: on ? "#F6E4E1" : "#fff", color: on ? MAROON : "#57534E", fontWeight: on ? 600 : 400 }}>
              <input id={`${idPrefix}-${n}`} type="checkbox" checked={on} onChange={() => { const next = on ? value.filter((x) => x !== n) : [...value, n]; if (next.length) onChange(next.sort((a, b) => a - b)); }} className="h-4 w-4 accent-[#800000]" />
              {ord[n]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function NumberField({ id, label, value, onChange, min, max }: { id: string; label: string; value: number; onChange: (n: number) => void; min: number; max: number }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">{label}</label>
      <div className="flex border rounded-md bg-white overflow-hidden focus-within:ring-2 focus-within:ring-[#800000]" style={{ borderColor: LINE }}>
        <button type="button" aria-label={`Decrease ${label}`} onClick={() => onChange(Math.max(min, value - 1))} className="w-10 h-10 hover:bg-stone-50 text-stone-600">−</button>
        <input id={id} type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, +e.target.value || min)))} className="flex-1 min-w-0 text-center outline-none" style={{ fontFamily: MONO }} />
        <button type="button" aria-label={`Increase ${label}`} onClick={() => onChange(Math.min(max, value + 1))} className="w-10 h-10 hover:bg-stone-50 text-stone-600">+</button>
      </div>
    </div>
  );
}

function BriefScreen({ onSubmit }: { onSubmit: (p: PlannerParams) => void }) {
  const [days, setDays] = useState(2);
  const [budget, setBudget] = useState(1000);
  const [topic, setTopic] = useState("AI");
  const [tutorials, setTutorials] = useState(4);
  const [sems, setSems] = useState<number[]>([7, 8]);
  const [chat, setChat] = useState("");
  const [chatError, setChatError] = useState("");

  const current: PlannerParams = { days, budget, topic: topic.trim() || "AI", tutorials, semesters: listToSemesters(sems) };

  const applyDemo = () => {
    setDays(2); setBudget(1000); setTopic("AI"); setTutorials(4); setSems([7, 8]);
    setChat(TEST_CASE_TEXT); setChatError("");
  };

  const submitChat = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseRequest(chat);
    const needed: (keyof PlannerParams)[] = ["days", "budget", "topic", "tutorials", "semesters"];
    const missing = needed.filter((k) => parsed[k] === undefined);
    if (missing.length) {
      setChatError(`Missing: ${missing.join(", ")}. Example: ${TEST_CASE_TEXT}`);
      return;
    }
    const full = parsed as PlannerParams;
    setSems(semestersToList(full.semesters).length ? semestersToList(full.semesters) : [7, 8]);
    onSubmit(full);
  };

  const input = "w-full h-10 rounded-md border bg-white px-3 focus:outline-none focus:ring-2 focus:ring-[#800000]";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-5xl font-semibold tracking-tight" style={{ color: NAVY }}>New conference brief</h2>
          <p className="text-stone-600 mt-1">Fill in the details. The preview updates as you type.</p>
        </div>
        <button type="button" onClick={applyDemo} className="inline-flex items-center gap-2 h-10 px-4 rounded-md border text-sm font-semibold hover:bg-[#FBF6EE]" style={{ color: MAROON, borderColor: MAROON }}>
          <Wand2 className="h-4 w-4" /> Load demo request
        </button>
      </div>

      <div className="grid lg:grid-cols-5 gap-6 items-start">
        <form
          className="lg:col-span-3 bg-white rounded-md border p-6 grid sm:grid-cols-2 gap-5"
          style={{ borderColor: LINE, borderTop: `4px solid ${NAVY}` }}
          onSubmit={(e) => { e.preventDefault(); onSubmit(current); }}
        >
          <NumberField id="days" label="NUMBER OF DAYS" value={days} onChange={setDays} min={1} max={5} />
          <div>
            <label htmlFor="budget" className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">SPEAKER BUDGET (USD)</label>
            <input id="budget" type="number" min={100} step={50} value={budget} onChange={(e) => setBudget(+e.target.value || 0)} className={input} style={{ borderColor: LINE, fontFamily: MONO }} />
          </div>
          <div>
            <label htmlFor="topic" className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">SPEAKER TOPIC</label>
            <input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} className={input} style={{ borderColor: LINE }} />
          </div>
          <NumberField id="tutorials" label="STUDENT TUTORIALS" value={tutorials} onChange={setTutorials} min={1} max={8} />
          <div className="sm:col-span-2"><SemesterPicker idPrefix="sem" value={sems} onChange={setSems} /></div>
          <div className="sm:col-span-2">
            <button type="submit" className="h-11 px-6 inline-flex items-center gap-2 rounded-md text-white font-semibold hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#800000]" style={{ background: MAROON }}>
              <Sparkles className="h-4 w-4" /> Generate plan
            </button>
          </div>
        </form>

        <div className="lg:col-span-2"><LivePreview p={current} /></div>
      </div>

      <form onSubmit={submitChat} className="bg-white rounded-md border p-4" style={{ borderColor: LINE }}>
        <label htmlFor="chat" className="flex items-center gap-2 text-xs font-semibold text-stone-600 tracking-wide mb-2">
          <MessageSquareText className="h-4 w-4" style={{ color: MAROON }} /> OR DESCRIBE IT IN ONE LINE
        </label>
        <div className="flex gap-2">
          <input id="chat" value={chat} onChange={(e) => { setChat(e.target.value); setChatError(""); }} placeholder={TEST_CASE_TEXT} className={input} style={{ borderColor: LINE, fontFamily: MONO, fontSize: 13 }} />
          <button type="submit" className="h-10 px-4 inline-flex items-center gap-2 rounded-md text-white font-semibold hover:opacity-90" style={{ background: NAVY }}>
            <Send className="h-4 w-4" /> Send
          </button>
        </div>
        {chatError && <p className="text-sm mt-2" style={{ color: MAROON }}>{chatError}</p>}
      </form>
    </div>
  );
}

function ProcessingCard({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="bg-white rounded-md border p-8 flex items-center gap-4" style={{ borderColor: LINE }} role="status">
      <Loader2 className="h-8 w-8 animate-spin" style={{ color: MAROON }} />
      <div>
        <p className="text-3xl font-semibold" style={{ color: NAVY, fontFamily: SERIF }}>{title}</p>
        <p className="text-stone-600 text-sm mt-1">{sub}</p>
      </div>
    </div>
  );
}

/** Compact read-only Day 1 timetable used to preview each resolution. */
function MiniDay({ schedule, day = 0 }: { schedule: Schedule; day?: number }) {
  return (
    <ul className="rounded-md border overflow-hidden text-xs bg-white" style={{ borderColor: LINE }}>
      {SLOTS.map((slot, i) => {
        const s = schedule[day][i];
        const st = KIND_STYLE[s.kind];
        return (
          <li key={slot.id} className="flex border-b last:border-b-0" style={{ borderColor: LINE }}>
            <span className="w-16 px-2 py-1.5 text-stone-500 border-r shrink-0" style={{ fontFamily: MONO, borderColor: LINE }}>{slot.start.replace(" ", "")}</span>
            <span className="flex-1 px-2 py-1.5 truncate font-medium" style={{ background: st.bg, color: st.fg }}>{s.title}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** GenUI component #1: rendered only when `detect_clash` reports a conflict. */
function ClashResolver({ report, params, onResolve }: { report: ClashReport; params: PlannerParams; onResolve: (r: Exclude<Resolution, "none">) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <section role="alert" className="bg-white rounded-md border overflow-hidden" style={{ borderColor: LINE }}>
      <div className="px-6 py-5 flex gap-4 text-white" style={{ background: MAROON }}>
        <AlertTriangle className="h-7 w-7 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-3xl font-semibold">Your decision is needed</h2>
          <p className="mt-1 text-white/90 leading-relaxed">{report.message}</p>
        </div>
      </div>
      <div className="p-6 grid md:grid-cols-2 gap-5">
        {report.options.map((o, i) => {
          const preview = buildSchedule(params, o.id);
          const accent = i === 0 ? NAVY : MAROON;
          return (
            <div key={o.id} className="rounded-md border-2 p-4 flex flex-col gap-3 transition-shadow" style={{ borderColor: hover === o.id ? accent : LINE, boxShadow: hover === o.id ? "0 8px 24px -12px rgba(0,32,91,.4)" : "none" }} onMouseEnter={() => setHover(o.id)} onMouseLeave={() => setHover(null)}>
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: accent }}>
                {o.id === "move-to-day-2" ? <CalendarPlus className="h-4 w-4" /> : <Layers className="h-4 w-4" />} Option {i === 0 ? "A" : "B"}
              </div>
              <p className="text-sm text-stone-600">{o.detail}</p>
              <MiniDay schedule={preview} />
              <button type="button" onClick={() => onResolve(o.id)} className="mt-auto h-10 rounded-md text-white text-sm font-semibold hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#800000]" style={{ background: accent }}>
                [{o.label}]
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function sessionNumbers(s: Session): number[] {
  return s.kind === "tutorial" ? (s.title.match(/\d+/g) || []).map(Number) : [];
}

function SpeakerCard({ spec, topic, budget }: { spec: Spec; topic: string; budget: number }) {
  const { fee, travel, name } = spec.speaker;
  const total = fee + travel;
  const pct = Math.min(100, Math.round((total / budget) * 100));
  const initials = name.replace(/^Dr\.?\s*/i, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <section className="bg-white rounded-md border h-full" style={{ borderColor: LINE, borderTop: `4px solid ${MAROON}` }}>
      <div className="p-5 flex items-center gap-4">
        <div className="h-14 w-14 rounded-md grid place-items-center text-white text-xl font-semibold" style={{ background: NAVY }}>{initials}</div>
        <div>
          <div className="inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide" style={{ color: MAROON, fontFamily: MONO }}><Mic2 className="h-3 w-3" /> KEYNOTE SPEAKER</div>
          <h3 className="text-3xl font-semibold" style={{ color: NAVY }}>{name}</h3>
          <p className="text-sm text-stone-600">{topic} in HCI <span className="text-stone-400">(mock speaker)</span></p>
        </div>
      </div>
      <div className="px-5 pb-5">
        <div className="flex items-center gap-2 text-xs font-semibold text-stone-600 tracking-wide mb-2"><Wallet className="h-4 w-4" /> COST VS ${budget.toLocaleString()} BUDGET</div>
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-stone-600">Speaker honorarium</dt><dd style={{ fontFamily: MONO }}>${fee}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-600">Travel & hospitality</dt><dd style={{ fontFamily: MONO }}>${travel}</dd></div>
          <div className="flex justify-between border-t pt-2 mt-2 font-semibold" style={{ borderColor: LINE, color: NAVY }}><dt>Total</dt><dd style={{ fontFamily: MONO }}>${total}</dd></div>
        </dl>
        <div className="mt-3 h-2 rounded-sm overflow-hidden" style={{ background: WASH }} aria-hidden><div className="h-full" style={{ width: `${pct}%`, background: NAVY }} /></div>
        <p className="mt-2 text-xs text-emerald-700 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Within budget, ${budget - total} remaining</p>
      </div>
    </section>
  );
}

function TutorialList({ schedule, spec, semesters, focus, setFocus }: { schedule: Schedule; spec: Spec; semesters: string; focus: number | null; setFocus: (n: number | null) => void }) {
  const where = useMemo(() => {
    const map: Record<number, string> = {};
    schedule.forEach((day, d) => day.forEach((s, i) => sessionNumbers(s).forEach((n) => { if (!map[n]) map[n] = `Day ${d + 1} · ${SLOTS[i].start}`; })));
    return map;
  }, [schedule]);
  return (
    <section className="bg-white rounded-md border h-full" style={{ borderColor: LINE, borderTop: `4px solid ${NAVY}` }}>
      <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-2"><GraduationCap className="h-5 w-5" style={{ color: MAROON }} /><h3 className="font-semibold" style={{ color: NAVY }}>Student tutorials</h3></div>
        <span className="text-[11px] text-stone-500" style={{ fontFamily: MONO }}>HOVER TO LOCATE</span>
      </div>
      <ul>
        {spec.tutorialTitles.map((title, i) => {
          const n = i + 1;
          return (
            <li key={n} tabIndex={0} onMouseEnter={() => setFocus(n)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(n)} onBlur={() => setFocus(null)} className="px-5 py-3.5 border-b last:border-b-0 flex gap-3 items-start cursor-default outline-none" style={{ borderColor: LINE, background: focus === n ? "#F7EDE0" : "transparent" }}>
              <span className="h-7 w-7 rounded-sm grid place-items-center text-xs font-semibold text-white shrink-0" style={{ background: NAVY, fontFamily: MONO }}>T{n}</span>
              <div className="min-w-0">
                <p className="font-medium text-stone-900">{title}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-stone-500 inline-flex items-center gap-1" style={{ fontFamily: MONO }}><Clock className="h-3 w-3" /> {where[n] ?? "Unscheduled"}</span>
                  <span className="inline-flex items-center gap-1 font-semibold rounded-sm px-2 py-0.5" style={{ background: "#F9ECEC", color: MAROON }}><Users className="h-3 w-3" /> {semesters} Semester Students</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BudgetChart({ spec, budget }: { spec: Spec; budget: number }) {
  const rest = Math.max(0, budget - spec.speaker.fee - spec.speaker.travel);
  const rows = [
    { label: "Speaker honorarium", v: spec.speaker.fee, c: NAVY },
    { label: "Travel & hospitality", v: spec.speaker.travel, c: MAROON },
    { label: "Unallocated", v: rest, c: "#D9C7B2" },
  ];
  return (
    <section className="bg-white rounded-md border h-full" style={{ borderColor: LINE, borderTop: `4px solid ${NAVY}` }}>
      <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: LINE }}><BarChart3 className="h-5 w-5" style={{ color: MAROON }} /><h3 className="font-semibold" style={{ color: NAVY }}>Budget breakdown</h3></div>
      <div className="p-5 space-y-4">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between text-sm mb-1"><span className="text-stone-700">{r.label}</span><span style={{ fontFamily: MONO }}>${r.v} · {Math.round((r.v / budget) * 100)}%</span></div>
            <div className="h-3 rounded-sm" style={{ background: WASH }}><div className="h-full rounded-sm transition-all" style={{ width: `${(r.v / budget) * 100}%`, background: r.c }} /></div>
          </div>
        ))}
        <p className="text-xs text-stone-500">Total budget ${budget.toLocaleString()}</p>
      </div>
    </section>
  );
}

/** Autonomy control: consequential actions need explicit approval. */
function TaskChecklist({ tasks, speakerName }: { tasks: string[]; speakerName: string }) {
  const [state, setState] = useState<Record<number, "confirm" | "done">>({});
  const needsApproval = (t: string) => /\b(send|invit|email|publish)/i.test(t);
  return (
    <section className="bg-white rounded-md border h-full" style={{ borderColor: LINE, borderTop: `4px solid ${MAROON}` }}>
      <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: LINE }}><ListChecks className="h-5 w-5" style={{ color: MAROON }} /><h3 className="font-semibold" style={{ color: NAVY }}>Next steps</h3></div>
      <ul>
        {tasks.map((t, i) => {
          const s = state[i];
          const gated = needsApproval(t);
          return (
            <li key={i} className="px-5 py-3 border-b last:border-b-0 text-sm" style={{ borderColor: LINE }}>
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  aria-label={`Mark "${t}" ${s === "done" ? "not done" : "done"}`}
                  onClick={() => (gated && s !== "done" ? setState({ ...state, [i]: "confirm" }) : setState({ ...state, [i]: s === "done" ? undefined as never : "done" }))}
                  className="mt-0.5 h-5 w-5 rounded-sm border grid place-items-center shrink-0"
                  style={{ borderColor: s === "done" ? NAVY : "#B8A58E", background: s === "done" ? NAVY : "#fff" }}
                >
                  {s === "done" && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
                <div className="flex-1">
                  <span className={s === "done" ? "line-through text-stone-400" : "text-stone-800"}>{t}</span>
                  {gated && s !== "done" && <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: MAROON, fontFamily: MONO }}><ShieldCheck className="h-3 w-3" />NEEDS YOUR APPROVAL</span>}
                  {gated && s === "done" && <span className="ml-2 text-[11px] text-emerald-700" style={{ fontFamily: MONO }}>SENT (SIMULATED)</span>}
                  {s === "confirm" && (
                    <div className="mt-2 rounded-md border p-3 flex flex-wrap items-center gap-3" style={{ borderColor: MAROON, background: "#FBF3F3" }}>
                      <span className="text-stone-800">Approve this action for {speakerName}? Nothing is really sent in this demo.</span>
                      <span className="flex gap-2">
                        <button onClick={() => setState({ ...state, [i]: "done" })} className="h-8 px-3 rounded-md text-white text-xs font-semibold" style={{ background: NAVY }}>Approve</button>
                        <button onClick={() => setState({ ...state, [i]: undefined as never })} className="h-8 px-3 rounded-md border text-xs font-semibold" style={{ borderColor: LINE }}>Cancel</button>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Uncertainty cue: what the AI assumed. */
function Assumptions({ items, source }: { items: string[]; source: Source }) {
  return (
    <details className="bg-white rounded-md border px-5 py-3 text-sm" style={{ borderColor: LINE }}>
      <summary className="cursor-pointer font-semibold flex items-center gap-2 select-none" style={{ color: NAVY }}>
        <Bot className="h-4 w-4" style={{ color: MAROON }} /> What the AI assumed ({items.length})
        <span className="ml-auto text-[11px] font-semibold rounded-sm px-2 py-0.5" style={{ fontFamily: MONO, background: source === "ai" ? "#F3E7D8" : "#FBEBCB", color: source === "ai" ? NAVY : "#8A5A00" }} title={source === "ai" ? "Generated by a live model" : "No API key or model unreachable: offline simulation"}>
          {source === "ai" ? "LIVE MODEL" : "OFFLINE SIMULATION"}
        </span>
      </summary>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-stone-700">{items.map((a, i) => <li key={i}>{a}</li>)}</ul>
    </details>
  );
}

function AdjustPanel({ params, onChange, disabled }: { params: PlannerParams; onChange: (p: PlannerParams) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(params);
  useEffect(() => setDraft(params), [params]);
  useEffect(() => {
    if (JSON.stringify(clampParams(draft)) === JSON.stringify(params)) return;
    const t = setTimeout(() => onChange(clampParams(draft)), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const input = "w-full h-10 rounded-md border bg-white px-3 focus:outline-none focus:ring-2 focus:ring-[#800000]";
  return (
    <section className="bg-white rounded-md border p-5" style={{ borderColor: LINE }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold" style={{ color: NAVY }}>Adjust the brief</h3>
        <span className="text-[11px] text-stone-500" style={{ fontFamily: MONO }}>CHANGES REGENERATE THE WORKSPACE</span>
      </div>
      <fieldset disabled={disabled} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 disabled:opacity-60">
        <NumberField id="adj-days" label="DAYS" value={draft.days} onChange={(n) => setDraft({ ...draft, days: n })} min={1} max={5} />
        <div>
          <label htmlFor="adj-budget" className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">BUDGET (USD)</label>
          <input id="adj-budget" type="number" min={100} step={50} value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: +e.target.value || 0 })} className={input} style={{ borderColor: LINE, fontFamily: MONO }} />
        </div>
        <div>
          <label htmlFor="adj-topic" className="block text-xs font-semibold text-stone-600 mb-1.5 tracking-wide">TOPIC</label>
          <input id="adj-topic" value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} className={input} style={{ borderColor: LINE }} />
        </div>
        <NumberField id="adj-tuts" label="TUTORIALS" value={draft.tutorials} onChange={(n) => setDraft({ ...draft, tutorials: n })} min={1} max={8} />
      </fieldset>
      <div className="mt-4"><SemesterPicker idPrefix="adj-sem" value={semestersToList(draft.semesters)} onChange={(v) => setDraft({ ...draft, semesters: listToSemesters(v) })} /></div>
    </section>
  );
}

function RefineBar({ onSend, disabled }: { onSend: (t: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const chips = ["Add a budget chart", "Add a task checklist", "Make it 5 tutorials", "Remove the budget chart"];
  const submit = (t: string) => { if (t.trim()) { onSend(t.trim()); setText(""); } };
  return (
    <section className="bg-white rounded-md border p-5" style={{ borderColor: LINE, borderTop: `4px solid ${MAROON}` }}>
      <label htmlFor="refine" className="flex items-center gap-2 text-sm font-semibold mb-2" style={{ color: NAVY }}>
        <Sparkles className="h-4 w-4" style={{ color: MAROON }} /> Ask the AI to reshape this workspace
      </label>
      <form onSubmit={(e) => { e.preventDefault(); submit(text); }} className="flex gap-2">
        <input id="refine" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} placeholder="e.g. add a budget chart, or make it 3 days" className="flex-1 h-10 rounded-md border px-3 focus:outline-none focus:ring-2 focus:ring-[#800000]" style={{ borderColor: LINE }} />
        <button type="submit" disabled={disabled} className="h-10 px-4 inline-flex items-center gap-2 rounded-md text-white font-semibold disabled:opacity-50" style={{ background: NAVY }}><Send className="h-4 w-4" /> Apply</button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {chips.map((c) => (
          <button key={c} disabled={disabled} onClick={() => submit(c)} className="text-xs rounded-full border px-3 py-1 hover:bg-stone-50 disabled:opacity-50" style={{ borderColor: LINE, color: NAVY }}>{c}</button>
        ))}
      </div>
    </section>
  );
}

function Dashboard(props: {
  ws: Workspace; busy: boolean; log: string[]; canUndo: boolean; canSwitch: boolean;
  onReset: () => void; onUndo: () => void; onSwitch: () => void; onEdit: (p: PlannerParams) => void; onRefine: (t: string) => void;
}) {
  const { ws, busy } = props;
  const { params, spec, schedule, resolution } = ws;
  const [focus, setFocus] = useState<number | null>(null);

  const registry: Record<CompName, { span: string; node: React.ReactNode }> = {
    SpeakerCard: { span: "", node: <SpeakerCard spec={spec} topic={params.topic} budget={params.budget} /> },
    TutorialList: { span: "", node: <TutorialList schedule={schedule} spec={spec} semesters={params.semesters} focus={focus} setFocus={setFocus} /> },
    ScheduleTable: { span: "lg:col-span-2", node: <ScheduleTable schedule={schedule} resolution={resolution} focus={focus} /> },
    BudgetChart: { span: "", node: <BudgetChart spec={spec} budget={params.budget} /> },
    TaskChecklist: { span: "", node: <TaskChecklist tasks={spec.tasks} speakerName={spec.speaker.name} /> },
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.2em] flex items-center gap-2" style={{ fontFamily: MONO, color: MAROON }}>
            PLAN GENERATED {busy && <span className="inline-flex items-center gap-1 text-stone-500"><Loader2 className="h-3 w-3 animate-spin" /> UPDATING…</span>}
          </div>
          <h2 className="text-5xl font-semibold tracking-tight mt-1" style={{ color: NAVY }}>{params.topic} Conference · {params.days} {params.days === 1 ? "day" : "days"}</h2>
          <p className="text-stone-600 mt-1">{params.tutorials} tutorials for {params.semesters} semester students · ${params.budget.toLocaleString()} speaker budget</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={props.onUndo} disabled={!props.canUndo || busy} className="h-10 px-4 inline-flex items-center gap-2 rounded-md border text-sm font-semibold hover:bg-[#FBF6EE] disabled:opacity-40" style={{ color: NAVY, borderColor: NAVY }}><Undo2 className="h-4 w-4" /> Undo</button>
          {props.canSwitch && (
            <button onClick={props.onSwitch} disabled={busy} className="h-10 px-4 inline-flex items-center gap-2 rounded-md border text-sm font-semibold hover:bg-[#FBF6EE] disabled:opacity-40" style={{ color: MAROON, borderColor: MAROON }}><Layers className="h-4 w-4" /> Try the other option</button>
          )}
          <button onClick={props.onReset} className="h-10 px-4 inline-flex items-center gap-2 rounded-md border text-sm font-semibold hover:bg-[#FBF6EE]" style={{ color: NAVY, borderColor: NAVY }}><RotateCcw className="h-4 w-4" /> New brief</button>
        </div>
      </div>

      <Assumptions items={spec.assumptions} source={ws.source} />
      <AdjustPanel params={params} onChange={props.onEdit} disabled={busy} />

      <div className="grid lg:grid-cols-2 gap-6 items-stretch">
        {spec.components.map((c) => (
          <div key={c} className={registry[c].span}>{registry[c].node}</div>
        ))}
      </div>

      <RefineBar onSend={props.onRefine} disabled={busy} />

      {props.log.length > 0 && (
        <section className="bg-white rounded-md border px-5 py-3 text-sm" style={{ borderColor: LINE }} aria-label="Activity history">
          <div className="text-[11px] tracking-[0.2em] text-stone-500 mb-2" style={{ fontFamily: MONO }}>ACTIVITY</div>
          <ul className="space-y-1 text-stone-700">{props.log.slice(0, 5).map((l, i) => <li key={i} className={i === 0 ? "font-medium" : "text-stone-500"}>{l}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

/* ─────────────────────────── Page / state machine ───────────────────────── */

export default function Page() {
  const [phase, setPhase] = useState<Phase>("form");
  const [ws, setWs] = useState<Workspace | null>(null);
  const [past, setPast] = useState<Workspace[]>([]);
  const [pending, setPending] = useState<{ params: PlannerParams; spec?: Spec; report: ClashReport } | null>(null);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const runId = useRef(0);
  const wsRef = useRef<Workspace | null>(null);
  wsRef.current = ws;

  const trace = (tool: string, args?: string) => {
    const id = ++counter.current;
    setEvents((e) => [...e, { id, tool, args, status: "running" }]);
    return id;
  };
  const done = (id: number) => setEvents((e) => e.map((x) => (x.id === id ? { ...x, status: "done" } : x)));
  const step = async (tool: string, args: string | undefined, ms: number) => { const id = trace(tool, args); await wait(ms); done(id); };

  /** The GenUI pipeline. Every path (new brief, value edit, chat edit, clash fix) goes through here. */
  const runPipeline = async (o: { params: PlannerParams; instruction?: string; resolution?: Resolution; spec?: Spec; prevSpec?: Spec; fresh?: boolean; message?: string }) => {
    const myRun = ++runId.current;
    const alive = () => myRun === runId.current;
    const before = wsRef.current;
    if (o.fresh) { setEvents([]); setPhase("processing"); } else if (before && phase !== "clash") setBusy(true);
    let params = o.params;
    let spec = o.spec;
    let source: Source = before?.source ?? "local";

    if (o.instruction) {
      const id = trace("interpret_edit", o.instruction);
      const r = await callApi({ action: "refine", instruction: o.instruction, params, spec: o.prevSpec });
      done(id);
      if (!alive()) return;
      params = clampParams(r.params ?? params);
      spec = r.spec;
      source = r.source;
    } else if (o.fresh) {
      await step("parse_request", JSON.stringify(params), 500);
      await step("check_budget", `$${params.budget}`, 400);
    }
    if (!alive()) return;

    await step("detect_clash", `${params.tutorials} tutorials · ${params.days} day(s)`, 700);
    if (!alive()) return;
    const report = detectClash(params);
    let resolution: Resolution = "none";
    if (report.hasClash) {
      const wanted = o.resolution ?? (o.fresh ? undefined : before?.resolution);
      const valid = report.options.find((x) => x.id === wanted);
      if (!valid) {
        setBusy(false);
        setPending({ params, spec, report });
        setPhase("clash");
        return;
      }
      resolution = valid.id;
    }

    if (!spec) {
      setPhase((p) => (p === "clash" ? "generating" : p));
      const id = trace("generate_ui_spec", `resolution=${resolution}`);
      const r = await callApi({ action: "generate", params, resolution, keep: o.prevSpec?.components });
      done(id);
      if (!alive()) return;
      spec = r.spec;
      source = r.source;
    }
    await step("build_schedule", `resolution=${resolution}`, 400);
    await step("render_workspace", spec.components.join(", "), 400);
    if (!alive()) return;

    const next: Workspace = { params, resolution, spec, schedule: buildSchedule(params, resolution), source };
    if (before && JSON.stringify([before.params, before.resolution, before.spec]) !== JSON.stringify([next.params, next.resolution, next.spec])) {
      setPast((p) => [...p.slice(-9), before]);
    }
    const msg =
      o.message ||
      spec.reply ||
      (before ? describeDiff(before.params, params) : "") ||
      (before ? "Workspace refreshed." : `Workspace generated by ${source === "ai" ? "the live model" : "the offline simulation"}.`);
    setLog((l) => [msg, ...l]);
    setPending(null);
    setWs(next);
    setBusy(false);
    setPhase("dashboard");
  };

  const handleSubmit = (p: PlannerParams) => { setWs(null); setPast([]); setLog([]); runPipeline({ params: clampParams(p), fresh: true }); };
  const handleResolve = (r: Exclude<Resolution, "none">) => {
    if (!pending) return;
    runPipeline({ params: pending.params, resolution: r, spec: pending.spec, prevSpec: wsRef.current?.spec, fresh: !wsRef.current, message: r === "merge-block" ? "Applied: merged 2-hour tutorial block." : "Applied: moved tutorial(s) to Day 2." });
  };
  const handleEdit = (p: PlannerParams) => { if (ws) runPipeline({ params: p, prevSpec: ws.spec }); };
  const handleRefine = (t: string) => { if (ws) runPipeline({ params: ws.params, instruction: t, prevSpec: ws.spec }); };
  const handleSwitch = () => {
    if (!ws) return;
    const other = detectClash(ws.params).options.find((o) => o.id !== ws.resolution);
    if (other) runPipeline({ params: ws.params, resolution: other.id, spec: ws.spec, prevSpec: ws.spec, message: `Switched to: ${other.label}.` });
  };
  const undo = () => {
    runId.current++;
    const last = past[past.length - 1];
    if (!last) return;
    setPast((p) => p.slice(0, -1));
    setWs(last);
    setBusy(false);
    setLog((l) => ["Undid the last change.", ...l]);
  };
  const reset = () => { runId.current++; setPhase("form"); setWs(null); setPast([]); setPending(null); setEvents([]); setLog([]); setBusy(false); };
  const back = () => { runId.current++; setBusy(false); if (ws) { setPending(null); setPhase("dashboard"); } else reset(); };

  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [phase]);

  const canSwitch = !!ws && detectClash(ws.params).hasClash && detectClash(ws.params).options.length > 1;

  return (
    <div className="min-h-screen text-stone-900" style={{ background: "#F4ECE0", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <PortalHeader phase={phase} />
      <main className="mx-auto max-w-6xl px-5 py-8 space-y-6">
        {(phase === "processing" || phase === "clash" || phase === "generating") && (
          <button onClick={back} className="inline-flex items-center gap-1.5 text-sm text-stone-600 hover:text-stone-900"><ArrowLeft className="h-4 w-4" /> {ws ? "Cancel change" : "Start over"}</button>
        )}
        {phase === "form" && <BriefScreen onSubmit={handleSubmit} />}
        {phase === "processing" && (
          <div className="grid lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2"><ProcessingCard title="Checking your plan…" sub="Reading your request, budget and the IBA time slots." /></div>
            <ToolTrace events={events} />
          </div>
        )}
        {phase === "clash" && pending && (
          <div className="grid lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2"><ClashResolver report={pending.report} params={pending.params} onResolve={handleResolve} /></div>
            <ToolTrace events={events} />
          </div>
        )}
        {phase === "generating" && (
          <div className="grid lg:grid-cols-3 gap-6 items-start">
            <div className="lg:col-span-2"><ProcessingCard title="Building your dashboard…" sub="The model is writing the UI specification." /></div>
            <ToolTrace events={events} />
          </div>
        )}
        {phase === "dashboard" && ws && (
          <>
            <Dashboard ws={ws} busy={busy} log={log} canUndo={past.length > 0} canSwitch={canSwitch} onReset={reset} onUndo={undo} onSwitch={handleSwitch} onEdit={handleEdit} onRefine={handleRefine} />
            <details className="text-sm" open={busy}><summary className="cursor-pointer text-stone-600">Show AI tool calls</summary><div className="mt-3 max-w-xl"><ToolTrace events={events} /></div></details>
          </>
        )}
      </main>
      <footer className="mt-10 border-t py-6 text-center text-xs text-stone-500" style={{ borderColor: LINE }}>Institute of Business Administration, Karachi · GenUI prototype for HCI coursework</footer>
    </div>
  );
}
const KIND_STYLE: Record<SessionKind, { bg: string; fg: string; border: string }> = {
  opening: { bg: "#F3E7D8", fg: NAVY, border: NAVY },
  keynote: { bg: MAROON, fg: "#fff", border: "#5A0000" },
  tutorial: { bg: NAVY, fg: "#fff", border: "#2B1015" },
  panel: { bg: "#F9ECEC", fg: MAROON, border: MAROON },
  showcase: { bg: "#F3E7D8", fg: NAVY, border: NAVY },
  closing: { bg: "#F9ECEC", fg: MAROON, border: MAROON },
  open: { bg: "#FCF8F1", fg: "#B9AB98", border: LINE },
};

function ScheduleTable({ schedule, resolution, focus }: { schedule: Schedule; resolution: Resolution; focus: number | null }) {
  return (
    <section className="bg-white rounded-md border" style={{ borderColor: LINE }}>
      <div className="px-5 py-3 border-b flex flex-wrap items-center justify-between gap-2" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-2"><CalendarDays className="h-5 w-5" style={{ color: MAROON }} /><h3 className="font-semibold" style={{ color: NAVY }}>{schedule.length}-day schedule</h3></div>
        {resolution !== "none" && (
          <span className="text-[11px] rounded-sm px-2 py-1 font-semibold" style={{ fontFamily: MONO, color: MAROON, background: "#F9ECEC" }}>
            {resolution === "merge-block" ? "MERGED 2-HOUR TUTORIAL BLOCK" : "1 TUTORIAL MOVED TO DAY 2"}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse min-w-[640px]">
          <thead>
            <tr style={{ background: WASH }}>
              <th className="px-4 py-2 w-44 text-left text-[11px] text-stone-500 font-medium border-b border-r" style={{ fontFamily: MONO, borderColor: LINE }}>TIME SLOT</th>
              {schedule.map((_, d) => (<th key={d} className="px-4 py-2 text-left font-semibold border-b" style={{ color: NAVY, borderColor: LINE }}>Day {d + 1}</th>))}
            </tr>
          </thead>
          <tbody>
            {SLOTS.map((slot, i) => (
              <tr key={slot.id}>
                <th scope="row" className="px-4 py-3 text-left text-xs font-medium text-stone-600 whitespace-nowrap border-b border-r align-top" style={{ fontFamily: MONO, borderColor: LINE }}>{slot.label}</th>
                {schedule.map((day, d) => {
                  const s = day[i];
                  const st = KIND_STYLE[s.kind];
                  const hit = focus !== null && sessionNumbers(s).includes(focus);
                  const dim = focus !== null && !hit;
                  return (
                    <td key={d} className="p-1.5 border-b align-top" style={{ borderColor: LINE }}>
                      <div className="rounded-sm px-3 py-2 border-l-4 transition-all" style={{ background: st.bg, color: st.fg, borderLeftColor: st.border, opacity: dim ? 0.3 : 1, outline: hit ? `3px solid ${MAROON}` : "none", outlineOffset: 1 }}>
                        <div className="font-semibold leading-snug">{s.title}</div>
                        {s.note && <div className="text-xs opacity-80 mt-0.5">{s.note}</div>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-2.5 text-xs text-stone-500 border-t flex items-center gap-1.5" style={{ borderColor: LINE }}><Coffee className="h-3.5 w-3.5" /> Only standard IBA slots are used; 15-minute breaks sit between slots.</p>
    </section>
  );
}


