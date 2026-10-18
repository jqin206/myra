import type { OutfitPlan } from "./format.js";

export interface RequestTextInput {
  now: Date;
  timeZone: string;
  history: string[];
  current: string;
  previousPlan?: OutfitPlan;
}

export const HISTORY_LIMIT = 10;
export const PER_DAY_INSTRUCTION =
  'Reply format: give exactly one outfit per day (not one per activity) that works across all of that day\'s activities, and set each outfit\'s "date" field to that day\'s date (YYYY-MM-DD).';
export const ONE_TRIP_INSTRUCTION =
  "Plan exactly one trip. If the current message describes a trip or itinerary, plan only that trip. If it only adds or changes preferences, apply them to the most recent trip only (the outfits above if they're listed, otherwise the latest itinerary among the earlier messages). Earlier messages are context for preferences; never combine several trips in one plan.";
export const DRESS_INSTRUCTION =
  'If an outfit is built around a dress or jumpsuit, put it in that outfit\'s "items.dress" field and leave "top" and "bottom" empty.';
export const REVISE_INSTRUCTION =
  "If the current message changes or adds preferences for these outfits, return the full revised plan for the same trip: keep the same dates, location, activities and weather, and change only the items the new preference affects. If the current message is a new trip or itinerary, ignore these outfits and plan from scratch.";

/** The parts of a plan Creao needs to revise it; rationale and assumptions are left out to keep the request short. */
function compactPlan(plan: OutfitPlan): object {
  return {
    date: plan.date,
    location: plan.location,
    daily_weather: plan.daily_weather ?? undefined,
    weather: plan.daily_weather ? undefined : plan.weather,
    outfits: (plan.outfits ?? []).map((o) => ({ date: o.date, activity: o.activity, time: o.time, items: o.items })),
    extras: plan.extras,
  };
}

export function formatToday(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(now);
  return `Today is ${date} (${timeZone}).`;
}

const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim()}"`;

export function buildRequestText({ now, timeZone, history, current, previousPlan }: RequestTextInput): string {
  const sections = [formatToday(now, timeZone)];
  const recent = history.slice(-HISTORY_LIMIT);
  if (recent.length) {
    sections.push(["Earlier messages from this user (oldest first):", ...recent.map((t) => `- ${quote(t)}`)].join("\n"));
  }
  if (previousPlan?.outfits?.length) {
    sections.push(`Outfits you last sent this user (JSON):\n${JSON.stringify(compactPlan(previousPlan))}`);
  }
  sections.push(`Current message:\n${quote(current)}`);
  sections.push(ONE_TRIP_INSTRUCTION);
  if (previousPlan?.outfits?.length) sections.push(REVISE_INSTRUCTION);
  sections.push(PER_DAY_INSTRUCTION, DRESS_INSTRUCTION);
  return sections.join("\n\n");
}
