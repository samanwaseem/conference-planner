/**
 * Shared GenUI logic (runs on the server AND in the browser).
 *
 *  - UI "spec" types: what the model is allowed to produce
 *  - Deterministic tools: detectClash, buildSchedule (guardrails the model cannot break)
 *  - Offline fallbacks (localGenerate / localRefine) so the demo works with no API key
 */

export const SLOTS = [
  { id: "s1", label: "08:30 AM – 09:45 AM", start: "08:30 AM" },
  { id: "s2", label: "10:00 AM – 11:15 AM", start: "10:00 AM" },
  { id: "s3", label: "11:30 AM – 12:45 PM", start: "11:30 AM" },
  { id: "s4", label: "01:00 PM – 02:15 PM", start: "01:00 PM" },
  { id: "s5", label: "02:30 PM – 03:45 PM", start: "02:30 PM" },
] as const;

/** The component catalog: the ONLY things the model may put on screen. */
export const COMPONENTS = ["SpeakerCard", "TutorialList", "ScheduleTable", "BudgetChart", "TaskChecklist"] as const;
export type CompName = (typeof COMPONENTS)[number];

export type PlannerParams = { days: number; budget: number; topic: string; tutorials: number; semesters: string };
export type Resolution = "move-to-day-2" | "merge-block" | "none";
export type ClashReport = {
  hasClash: boolean;
  message: string;
  options: { id: Exclude<Resolution, "none">; label: string; detail: string }[];
};
export type SessionKind = "opening" | "keynote" | "tutorial" | "panel" | "showcase" | "closing" | "open";
export type Session = { kind: SessionKind; title: string; note?: string; continued?: boolean };
export type Schedule = Session[][];

/** The UI specification the model fills in. Rendering is done by our own components. */
export type Spec = {
  components: CompName[];
  assumptions: string[];
  speaker: { name: string; bio: string; fee: number; travel: number };
  tutorialTitles: string[];
  tasks: string[];
  reply?: string;
};


/* ───────────────────────────── Semester helpers ─────────────────────────── */

const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

/** "7th & 8th" → [7, 8] */
export function semestersToList(text: string): number[] {
  const nums = Array.from(text.matchAll(/([1-8])\s*(?:st|nd|rd|th)/gi)).map((m) => +m[1]);
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

/** [5, 6, 7] → "5th, 6th & 7th" */
export function listToSemesters(list: number[]): string {
  const names = Array.from(new Set(list)).filter((n) => n >= 1 && n <= 8).sort((a, b) => a - b).map((n) => ORD[n]);
  if (names.length === 0) return "7th & 8th";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/* ───────────────────────────── Parameter helpers ────────────────────────── */

export function clampParams(p: Partial<PlannerParams>): PlannerParams {
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    days: n(p.days, 1, 5, 2),
    budget: n(p.budget, 100, 1_000_000, 1000),
    topic: (p.topic ?? "AI").toString().trim().slice(0, 40) || "AI",
    tutorials: n(p.tutorials, 1, 8, 4),
    semesters: listToSemesters(semestersToList((p.semesters ?? "").toString())),
  };
}

/** Free-text → params (used by the one-line "describe it" box). */
export function parseRequest(text: string): Partial<PlannerParams> {
  const out: Partial<PlannerParams> = {};
  const days = text.match(/(\d+)\s*day/i);
  const budget = text.match(/\$\s*([\d,]+)/) || text.match(/budget\D*([\d,]+)/i);
  const topic = text.match(/topic\s*[:\-]\s*([^,]+)/i);
  const tuts = text.match(/(\d+)\s*tutorial/i);
  const target = text.match(/target\s*[:\-]\s*([^,]+)/i);
  if (days) out.days = parseInt(days[1], 10);
  if (budget) out.budget = parseInt(budget[1].replace(/,/g, ""), 10);
  if (topic) out.topic = topic[1].trim();
  if (tuts) out.tutorials = parseInt(tuts[1], 10);
  if (target) out.semesters = target[1].replace(/semesters?/i, "").trim();
  return out;
}

/* ───────────────────────────── Deterministic tools ──────────────────────── */

/** Tool: detect_clash. Day 1 always hosts the Opening Session and the Keynote. */
export function detectClash(p: PlannerParams): ClashReport {
  const freeSlotsDay1 = SLOTS.length - 2;
  const hasClash = p.tutorials > freeSlotsDay1;
  const options: ClashReport["options"] = [];
  if (p.days >= 2 && p.tutorials - freeSlotsDay1 <= SLOTS.length) {
    options.push({
      id: "move-to-day-2",
      label: "Move 1 Tutorial to Day 2",
      detail: "Day 1 keeps the keynote and 3 tutorials. The remaining tutorial(s) open Day 2.",
    });
  }
  options.push({
    id: "merge-block",
    label: "Merge Tutorials into a single 2-hour block",
    detail: "All tutorials run back-to-back across two consecutive slots on Day 1.",
  });
  return {
    hasClash,
    options,
    message: `GenUI Alert: Scheduling conflict detected. You requested ${p.tutorials} tutorials for ${p.semesters} semester, but standard IBA time slots (08:30 AM, 10:00 AM, 11:30 AM, 01:00 PM, 02:30 PM) on Day 1 cannot accommodate the ${p.topic} Keynote and all tutorials without overlap.`,
  };
}

/** Tool: build_schedule. Uses ONLY the five standard slots, whatever the model says. */
export function buildSchedule(p: PlannerParams, resolution: Resolution): Schedule {
  const open = (): Session => ({ kind: "open", title: "Open / Networking" });
  const days: Schedule = Array.from({ length: p.days }, () => SLOTS.map(open));
  const put = (d: number, i: number, s: Session, onlyIfOpen = false) => {
    if (!days[d] || i < 0 || i >= SLOTS.length) return;
    if (onlyIfOpen && days[d][i].kind !== "open") return;
    days[d][i] = s;
  };
  const tut = (n: number): Session => ({ kind: "tutorial", title: `Tutorial ${n}`, note: `${p.semesters} Semester` });

  put(0, 0, { kind: "opening", title: "Opening Session & Registration" });
  put(0, 1, { kind: "keynote", title: `${p.topic} Keynote`, note: "Keynote speaker" });

  if (resolution === "merge-block") {
    const nums = Array.from({ length: p.tutorials }, (_, i) => i + 1);
    const half = Math.ceil(nums.length / 2);
    put(0, 2, { kind: "tutorial", title: `Tutorial Lab: T${nums.slice(0, half).join(" & T")}`, note: "2-hour merged block · part 1" });
    put(0, 3, { kind: "tutorial", title: `Tutorial Lab: T${(nums.slice(half).length ? nums.slice(half) : nums).join(" & T")}`, note: "2-hour merged block · part 2", continued: true });
    put(0, 4, { kind: "panel", title: "Speaker Q&A", note: "Open floor with the keynote speaker" });
    if (p.days >= 2) {
      put(1, 0, { kind: "showcase", title: "Student Project Showcase" });
      put(1, 1, { kind: "panel", title: `${p.topic} Industry Panel` });
      put(1, 3, { kind: "closing", title: "Closing & Certificates" });
    }
  } else if (resolution === "move-to-day-2" && p.days >= 2) {
    const onDay1 = Math.min(3, p.tutorials);
    for (let i = 0; i < onDay1; i++) put(0, 2 + i, tut(i + 1));
    for (let i = onDay1; i < p.tutorials; i++) put(1, i - onDay1, tut(i + 1));
    const next = p.tutorials - onDay1;
    put(1, next, { kind: "panel", title: `${p.topic} Industry Panel` }, true);
    put(1, next + 1, { kind: "showcase", title: "Student Project Showcase" }, true);
    put(1, 4, { kind: "closing", title: "Closing & Certificates" }, true);
  } else {
    let i = 0;
    for (let slot = 2; slot < SLOTS.length && i < p.tutorials; slot++, i++) put(0, slot, tut(i + 1));
    for (let slot = 0; i < p.tutorials && p.days >= 2 && slot < SLOTS.length; slot++, i++) put(1, slot, tut(i + 1));
    if (p.days >= 2) put(p.days - 1, 4, { kind: "closing", title: "Closing & Certificates" }, true);
  }
  return days;
}

/* ───────────────────────────── Spec guardrails + fallbacks ──────────────── */

const defaultTitles = (topic: string) => [
  `Hands-on ${topic} with Python`,
  `Prompt Engineering for Product Teams`,
  `Designing Human-Centred ${topic} Interfaces`,
  `Evaluating ${topic} Systems: Usability & Bias`,
  `Building a ${topic} Prototype in a Weekend`,
  `Ethics and Responsible ${topic}`,
  `Data Pipelines for ${topic}`,
  `Presenting ${topic} Research`,
];

export function localGenerate(p: PlannerParams, keep?: CompName[]): Spec {
  const fee = Math.min(850, Math.floor(p.budget * 0.85));
  return {
    components: keep && keep.length ? keep : ["SpeakerCard", "TutorialList", "ScheduleTable"],
    assumptions: [
      "The keynote speaker is a mock profile, not a real booking.",
      "Each session uses one standard 75-minute IBA slot.",
      "Day 1 always starts with an Opening Session, then the keynote.",
    ],
    speaker: {
      name: "Dr. Alan Turing",
      bio: `Keynote on ${p.topic} in HCI`,
      fee,
      travel: Math.min(100, Math.floor(p.budget * 0.1), p.budget - fee),
    },
    tutorialTitles: defaultTitles(p.topic).slice(0, p.tutorials),
    tasks: [
      "Send speaker invitation",
      "Book rooms for each time slot",
      `Open tutorial registration for ${p.semesters} semester students`,
      "Publish the schedule to students",
    ],
  };
}

/** Enforce the rules the model must never break, whatever it returned. */
export function normalizeSpec(s: Partial<Spec>, p: PlannerParams): Spec {
  const base = localGenerate(p);
  const comps = (s.components ?? base.components).filter((c, i, a) => (COMPONENTS as readonly string[]).includes(c) && a.indexOf(c) === i);
  if (!comps.includes("ScheduleTable")) comps.push("ScheduleTable");
  const sp = { ...base.speaker, ...(s.speaker ?? {}) };
  sp.fee = Math.max(0, Math.min(Math.round(Number(sp.fee)) || base.speaker.fee, p.budget));
  sp.travel = Math.max(0, Math.min(Math.round(Number(sp.travel)) || 0, p.budget - sp.fee));
  return {
    components: comps as CompName[],
    assumptions: (s.assumptions?.length ? s.assumptions : base.assumptions).slice(0, 5),
    speaker: sp,
    tutorialTitles: Array.from({ length: p.tutorials }, (_, i) => s.tutorialTitles?.[i] || base.tutorialTitles[i] || `Tutorial ${i + 1}`),
    tasks: (s.tasks?.length ? s.tasks : base.tasks).slice(0, 6),
    reply: s.reply,
  };
}

/** Offline stand-in for the model's "edit the workspace" step (keyword rules). */
export function localRefine(instruction: string, params: PlannerParams, spec: Spec): { params: PlannerParams; spec: Spec } {
  const t = instruction.toLowerCase();
  const remove = /\b(remove|hide|drop|delete|without)\b/.test(t);
  const next = { ...params };
  const comps = [...spec.components];
  const changes: string[] = [];
  const toggle = (c: CompName, label: string) => {
    const has = comps.includes(c);
    if (remove && has) { comps.splice(comps.indexOf(c), 1); changes.push(`removed the ${label}`); }
    else if (!remove && !has) { comps.push(c); changes.push(`added a ${label}`); }
  };
  if (/chart|breakdown|spend/.test(t)) toggle("BudgetChart", "budget chart");
  if (/checklist|tasks?\b|to-?do/.test(t)) toggle("TaskChecklist", "task checklist");
  const tuts = t.match(/(\d+)\s*tutorial/); if (tuts) { next.tutorials = +tuts[1]; changes.push(`set tutorials to ${next.tutorials}`); }
  const days = t.match(/(\d+)\s*day/); if (days) { next.days = +days[1]; changes.push(`set days to ${next.days}`); }
  const bud = t.match(/\$\s*([\d,]+)/); if (bud) { next.budget = +bud[1].replace(/,/g, ""); changes.push(`set budget to $${next.budget}`); }
  const top = instruction.match(/topic\s*(?:to|:)\s*([A-Za-z0-9 \-]+)/i); if (top) { next.topic = top[1].trim(); changes.push(`set topic to ${next.topic}`); }
  const clamped = clampParams(next);
  const out = normalizeSpec({ ...spec, components: comps, tutorialTitles: spec.tutorialTitles }, clamped);
  if (clamped.topic !== params.topic) out.tutorialTitles = defaultTitles(clamped.topic).slice(0, clamped.tutorials);
  out.reply = changes.length
    ? `Done: I ${changes.join(", ")}.`
    : "I couldn't map that to a change offline. Try “add a budget chart”, “add a task checklist” or “make it 5 tutorials”. A live model understands free-form requests.";
  return { params: clamped, spec: out };
}
