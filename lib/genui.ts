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

export type Speaker = { id: string; name: string; talk: string; fee: number; travel: number };
export const speakerCost = (s: Speaker) => s.fee + s.travel;
export const totalSpeakerCost = (list: Speaker[]) => list.reduce((a, s) => a + speakerCost(s), 0);

/** The UI specification the model fills in. Rendering is done by our own components. */
export type Spec = {
  components: CompName[];
  assumptions: string[];
  speakers: Speaker[];
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
export function buildSchedule(p: PlannerParams, resolution: Resolution, speakerNames: string[] = []): Schedule {
  const guests = speakerNames.slice(1).join(", ") || undefined;
  const open = (): Session => ({ kind: "open", title: "Open / Networking" });
  const days: Schedule = Array.from({ length: p.days }, () => SLOTS.map(open));
  const put = (d: number, i: number, s: Session, onlyIfOpen = false) => {
    if (!days[d] || i < 0 || i >= SLOTS.length) return;
    if (onlyIfOpen && days[d][i].kind !== "open") return;
    days[d][i] = s;
  };
  const tut = (n: number): Session => ({ kind: "tutorial", title: `Tutorial ${n}`, note: `${p.semesters} Semester` });

  put(0, 0, { kind: "opening", title: "Opening Session & Registration" });
  put(0, 1, { kind: "keynote", title: `${p.topic} Keynote`, note: speakerNames[0] ?? "Keynote speaker" });

  if (resolution === "merge-block") {
    const nums = Array.from({ length: p.tutorials }, (_, i) => i + 1);
    const half = Math.ceil(nums.length / 2);
    put(0, 2, { kind: "tutorial", title: `Tutorial Lab: T${nums.slice(0, half).join(" & T")}`, note: "2-hour merged block · part 1" });
    put(0, 3, { kind: "tutorial", title: `Tutorial Lab: T${(nums.slice(half).length ? nums.slice(half) : nums).join(" & T")}`, note: "2-hour merged block · part 2", continued: true });
    put(0, 4, { kind: "panel", title: "Speaker Q&A", note: `Open floor with ${speakerNames[0] ?? "the keynote speaker"}` });
    if (p.days >= 2) {
      put(1, 0, { kind: "showcase", title: "Student Project Showcase" });
      put(1, 1, { kind: "panel", title: `${p.topic} Industry Panel`, note: guests });
      put(1, 3, { kind: "closing", title: "Closing & Certificates" });
    }
  } else if (resolution === "move-to-day-2" && p.days >= 2) {
    const onDay1 = Math.min(3, p.tutorials);
    for (let i = 0; i < onDay1; i++) put(0, 2 + i, tut(i + 1));
    for (let i = onDay1; i < p.tutorials; i++) put(1, i - onDay1, tut(i + 1));
    const next = p.tutorials - onDay1;
    put(1, next, { kind: "panel", title: `${p.topic} Industry Panel`, note: guests }, true);
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
    speakers: [{ id: "sp1", name: "Dr. Alan Turing", talk: `${p.topic} in HCI`, fee, travel: Math.min(100, Math.floor(p.budget * 0.1), p.budget - fee) }],
    tutorialTitles: defaultTitles(p.topic).slice(0, p.tutorials),
    tasks: [
      "Send speaker invitation",
      "Book rooms for each time slot",
      `Open tutorial registration for ${p.semesters} semester students`,
      "Publish the schedule to students",
    ],
  };
}

/** What the model returns: speakers have no ids yet. */
export type SpecInput = Omit<Partial<Spec>, "speakers"> & { speakers?: (Omit<Speaker, "id"> & { id?: string })[] };

const money = (v: unknown) => Math.max(0, Math.round(Number(v)) || 0);

/** Enforce the rules the model must never break, whatever it returned. */
export function normalizeSpec(s: SpecInput, p: PlannerParams, opts: { enforceBudget?: boolean } = {}): Spec {
  const base = localGenerate(p);
  const comps = (s.components ?? base.components).filter((c, i, a) => (COMPONENTS as readonly string[]).includes(c) && a.indexOf(c) === i);
  if (!comps.includes("ScheduleTable")) comps.push("ScheduleTable");
  const raw = s.speakers?.length ? s.speakers : base.speakers;
  const seen = new Set<string>();
  let speakers: Speaker[] = raw.slice(0, 6).map((x, i) => {
    let id = x.id || `sp${i + 1}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    return { id, name: (x.name || "Speaker").toString().slice(0, 60), talk: (x.talk ?? "").toString().slice(0, 80), fee: money(x.fee), travel: money(x.travel) };
  });
  const total = totalSpeakerCost(speakers);
  if (opts.enforceBudget && total > p.budget && total > 0) {
    const f = p.budget / total;
    speakers = speakers.map((x) => ({ ...x, fee: Math.floor(x.fee * f), travel: Math.floor(x.travel * f) }));
  }
  return {
    components: comps as CompName[],
    assumptions: (s.assumptions?.length ? s.assumptions : base.assumptions).slice(0, 5),
    speakers,
    tutorialTitles: Array.from({ length: p.tutorials }, (_, i) => s.tutorialTitles?.[i] || base.tutorialTitles[i] || `Tutorial ${i + 1}`),
    tasks: (s.tasks?.length ? s.tasks : base.tasks).slice(0, 6),
    reply: s.reply,
  };
}

/**
 * Deterministic edit parser. Turns phrases such as "set days to 3", "budget to 1500",
 * "make it 5 tutorials", "semester 5th & 6th", "add a speaker Dr. Ada with $300" into real changes.
 * Used offline AND as a guardrail on top of the live model, so a request is never silently ignored.
 */
export function extractEdits(instruction: string, params: PlannerParams, spec: Spec): { params: PlannerParams; spec: Spec; changes: string[] } {
  const text = instruction.trim();
  const t = text.toLowerCase();
  const next: PlannerParams = { ...params };
  const speakers: Speaker[] = spec.speakers.map((x) => ({ ...x }));
  const changes: string[] = [];
  const num = (v: string) => parseInt(v.replace(/,/g, ""), 10);

  // speakers
  let mentionsSpeakerMoney = false;
  const add = text.match(/\badd\s+(?:a\s+|another\s+|one\s+)?(?:new\s+)?(?:guest\s+)?speaker\s+(.+)/i);
  if (add) {
    let rest = add[1];
    let fee = 200;
    const m = rest.match(/\$\s*([\d,]+)|([\d,]+)\s*(?:usd|dollars)/i);
    if (m) { fee = num(m[1] ?? m[2]); rest = rest.replace(m[0], " "); mentionsSpeakerMoney = true; }
    const name = rest.replace(/^\s*(?:called|named)\s+/i, "").replace(/\b(with|for|at|fee|budget)\b/gi, " ").replace(/[,;]+/g, " ").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim() || "Guest Speaker";
    if (!speakers.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      speakers.push({ id: `sp${Date.now() % 100000}${speakers.length}`, name, talk: `${next.topic} talk`, fee: money(fee), travel: 0 });
      changes.push(`added speaker ${name} ($${money(fee)})`);
    }
  }
  const rem = text.match(/\b(?:remove|delete|drop)\s+(?:the\s+)?speaker\s+(.+)/i);
  if (rem) {
    const target = rem[1].replace(/[.;]+$/, "").trim().toLowerCase();
    const idx = speakers.findIndex((x) => x.name.toLowerCase().includes(target) || target.includes(x.name.toLowerCase()));
    if (idx >= 0 && speakers.length > 1) { changes.push(`removed speaker ${speakers[idx].name}`); speakers.splice(idx, 1); }
  }

  // settings
  const tut = t.match(/(\d+)\s*-?\s*tutorials?\b/) || t.match(/tutorials?\s*(?:to|=|:|are|be|of)?\s*(\d+)/);
  if (tut) next.tutorials = num(tut[1]);
  const days = t.match(/(\d+)\s*-?\s*days?\b/) || t.match(/\bdays?\s*(?:to|=|:|are|be|of)\s*(\d+)/);
  if (days) next.days = num(days[1]);
  const bud =
    t.match(/budget\s*(?:to|=|:|of|is|at)?\s*\$?\s*([\d,]{3,})/) ||
    t.match(/\$\s*([\d,]+)\s*(?:budget|total)/) ||
    (!mentionsSpeakerMoney && !/speaker/.test(t) ? t.match(/\$\s*([\d,]+)/) : null);
  if (bud) next.budget = num(bud[1]);
  if (/semesters?/.test(t)) {
    let list = semestersToList(text);
    if (!list.length) {
      const tail = t.slice(t.search(/semesters?/));
      list = Array.from(new Set(Array.from(tail.matchAll(/\b([1-8])\b/g)).map((m) => +m[1]))).sort((a, b) => a - b);
    }
    if (list.length) next.semesters = listToSemesters(list);
  }
  const top = text.match(/topic\s*(?:to|=|:|is)\s*([A-Za-z0-9 \-]+)/i);
  if (top) next.topic = top[1].trim();

  const clamped = clampParams(next);
  (["days", "tutorials", "budget", "semesters", "topic"] as const).forEach((k) => {
    if (clamped[k] !== params[k]) changes.push(`set ${k} to ${k === "budget" ? "$" + clamped[k] : clamped[k]}`);
  });
  return { params: clamped, spec: { ...spec, speakers }, changes };
}

/** Offline stand-in for the model's "edit the workspace" step. */
export function localRefine(instruction: string, params: PlannerParams, spec: Spec): { params: PlannerParams; spec: Spec } {
  const t = instruction.toLowerCase();
  const remove = /\b(remove|hide|drop|delete|without)\b/.test(t) && !/\bspeaker\b/.test(t);
  const comps = [...spec.components];
  const changes: string[] = [];
  const toggle = (c: CompName, label: string) => {
    const has = comps.includes(c);
    if (remove && has) { comps.splice(comps.indexOf(c), 1); changes.push(`removed the ${label}`); }
    else if (!remove && !has) { comps.push(c); changes.push(`added a ${label}`); }
  };
  if (/chart|breakdown|spend/.test(t)) toggle("BudgetChart", "budget chart");
  if (/checklist|tasks?\b|to-?do/.test(t)) toggle("TaskChecklist", "task checklist");
  const edits = extractEdits(instruction, params, spec);
  changes.push(...edits.changes);
  const out = normalizeSpec({ ...edits.spec, components: comps }, edits.params);
  if (edits.params.topic !== params.topic) out.tutorialTitles = defaultTitles(edits.params.topic).slice(0, edits.params.tutorials);
  out.reply = changes.length
    ? `Done: I ${changes.join(", ")}.`
    : "I couldn't apply that. Try “set days to 3”, “set budget to $1500”, “add a speaker Dr. Ada with $300” or “add a budget chart”.";
  return { params: edits.params, spec: out };
}

/** After the live model answers an edit request, make sure explicit instructions were really applied. */
export function finalizeRefine(instruction: string, before: { params: PlannerParams; spec: Spec }, model: { params: Partial<PlannerParams>; spec: SpecInput }): { params: PlannerParams; spec: Spec } {
  const modelParams = clampParams(model.params);
  const modelSpec = normalizeSpec(model.spec, modelParams);
  const det = extractEdits(instruction, modelParams, modelSpec);
  const spec = normalizeSpec({ ...det.spec, reply: model.spec.reply }, det.params);
  if (det.params.topic !== before.params.topic && !model.spec.tutorialTitles?.length) spec.tutorialTitles = defaultTitles(det.params.topic).slice(0, det.params.tutorials);
  const sig = (x: { params: PlannerParams; spec: Spec }) =>
    JSON.stringify([x.params, x.spec.components, x.spec.speakers.map((v) => [v.name, v.talk, v.fee, v.travel])]);
  if (sig(before) === sig({ params: det.params, spec })) {
    spec.reply = "I couldn't apply that. Try “set days to 3”, “set budget to $1500”, “add a speaker Dr. Ada with $300” or “add a budget chart”.";
  } else if (!spec.reply) {
    spec.reply = det.changes.length ? `Done: I ${det.changes.join(", ")}.` : "Workspace updated.";
  }
  return { params: det.params, spec };
}

