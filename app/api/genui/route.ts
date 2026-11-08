/**
 * app/api/genui/route.ts
 *
 * The model's job: turn the user's intent into a UI SPECIFICATION
 * (which catalog components to show + the content for them).
 * Our code's job: rendering, clash detection and scheduling (guardrails).
 *
 * Setup (all packages are already in package.json; just run `npm install`):
 *   FREE:  .env.local → GOOGLE_GENERATIVE_AI_API_KEY=...  (aistudio.google.com/apikey)
 *   Paid:  ANTHROPIC_API_KEY (already installed)
 * With no key the route falls back to an offline simulation, so the demo never breaks.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { COMPONENTS, clampParams, localGenerate, localRefine, normalizeSpec } from "../../../lib/genui";

export const maxDuration = 30;

const SpecSchema = z.object({
  components: z.array(z.enum(COMPONENTS)).describe("Ordered list of catalog components to render."),
  assumptions: z.array(z.string()).max(5).describe("Short, honest assumptions or gaps the user should know about."),
  speaker: z.object({
    name: z.string(),
    bio: z.string().describe("One line."),
    fee: z.number().describe("Honorarium in USD."),
    travel: z.number().describe("Travel & hospitality in USD."),
  }),
  tutorialTitles: z.array(z.string()).describe("One title per requested tutorial, in order."),
  tasks: z.array(z.string()).max(6).describe("Next-step checklist items for the organiser."),
  reply: z.string().optional().describe("One sentence telling the user what you changed."),
});

const WorkspaceSchema = z.object({
  params: z.object({ days: z.number(), budget: z.number(), topic: z.string(), tutorials: z.number(), semesters: z.string() }),
  spec: SpecSchema,
});

const SYSTEM = `You are the planning engine of an IBA Karachi conference planner.
You do not write UI code. You produce a UI specification that picks components from this catalog: ${COMPONENTS.join(", ")}.
Rules:
- Always include SpeakerCard, TutorialList and ScheduleTable unless the user explicitly asks to remove one (ScheduleTable can never be removed).
- Use the mock speaker "Dr. Alan Turing" unless asked otherwise. Fee + travel must not exceed the budget.
- Provide exactly one tutorial title per requested tutorial, relevant to the topic and the target semester.
- List real assumptions only. Never invent confidence scores or statistics.
- Schedules are built by code from IBA slots; do not describe times.`;

async function pickModel(): Promise<any | null> {
  try {
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      // Free tier: key from https://aistudio.google.com/apikey
      const { google } = await import("@ai-sdk/google");
      return google(process.env.GENUI_MODEL || "gemini-2.5-flash");
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { anthropic } = await import("@ai-sdk/anthropic");
      return anthropic(process.env.GENUI_MODEL || "claude-sonnet-4-5");
    }
  } catch {
    /* package not installed → fall back */
  }
  return null;
}

const json = (data: unknown) => Response.json(data);

export async function POST(req: Request) {
  const body = await req.json();
  const params = clampParams(body.params ?? {});
  const model = await pickModel();

  try {
    if (body.action === "generate") {
      if (!model) return json({ params, spec: localGenerate(params, body.keep), source: "local" });
      const { object } = await generateObject({
        model,
        schema: SpecSchema,
        system: SYSTEM,
        prompt: `Brief: ${JSON.stringify(params)}\nResolved scheduling choice: ${body.resolution ?? "none"}\nKeep these components if present: ${JSON.stringify(body.keep ?? [])}`,
      });
      const spec = normalizeSpec(object, params);
      if (body.keep?.length) spec.components = normalizeSpec({ components: body.keep }, params).components;
      return json({ params, spec, source: "ai" });
    }

    if (body.action === "refine") {
      const current = body.spec ?? localGenerate(params);
      if (!model) return json({ ...localRefine(String(body.instruction ?? ""), params, current), source: "local" });
      const { object } = await generateObject({
        model,
        schema: WorkspaceSchema,
        system: SYSTEM + "\nYou are editing an existing workspace. Change only what the user asked for and keep everything else identical. Put what you changed in spec.reply.",
        prompt: `Current params: ${JSON.stringify(params)}\nCurrent spec: ${JSON.stringify(current)}\nUser instruction: ${body.instruction}`,
      });
      const next = clampParams(object.params);
      return json({ params: next, spec: normalizeSpec(object.spec, next), source: "ai" });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    // Model/network failure → degrade gracefully instead of breaking the demo.
    const note = err instanceof Error ? err.message : "model error";
    if (body.action === "refine") return json({ ...localRefine(String(body.instruction ?? ""), params, body.spec ?? localGenerate(params)), source: "local", note });
    return json({ params, spec: localGenerate(params, body.keep), source: "local", note });
  }
}
