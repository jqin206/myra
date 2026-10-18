import type { Outfit, Weather } from "./format.js";

/** One saved day of outfits, so a later message that mentions this date can revise it. */
export interface PlannedDay {
  date: string;
  location?: string | null;
  weather?: Weather | null;
  outfit: Pick<Outfit, "activity" | "items">;
}

export interface RequestTextInput {
  now: Date;
  timeZone: string;
  history: string[];
  current: string;
  plannedDays?: PlannedDay[];
  latestTripDates?: string[];
  /** The user's previous message, when Myra replied to it by asking where they'll be. */
  askedLocationFor?: string;
}

export const HISTORY_LIMIT = 10;
export const PER_DAY_INSTRUCTION =
  'Reply format: give exactly one outfit per day (not one per activity) that works across all of that day\'s activities, and set each outfit\'s "date" field to that day\'s date (YYYY-MM-DD).';
export const ONE_TRIP_INSTRUCTION =
  "Plan exactly one trip. If the current message describes a trip or itinerary, plan only that trip. If it only adds or changes preferences, apply them to the most recent trip only (the outfits above if they're listed, otherwise the latest itinerary among the earlier messages). Earlier messages are context for preferences; never combine several trips in one plan.";
export const DRESS_INSTRUCTION =
  'If an outfit is built around a dress or jumpsuit, put it in that outfit\'s "items.dress" field and leave "top" and "bottom" empty.';
export const PLANNED_DAYS_INSTRUCTION =
  'Work out which dates the current message is about. If it mentions dates (or days such as "Saturday") that are already planned above, revise only those dates: start from the planned outfit, keep that date\'s location and weather unless the message changes them, and change what the message asks for. If it mentions dates that aren\'t planned above, treat it as a new itinerary and plan those dates. If it mentions no date and only adds or changes preferences, revise every date of the most recent trip. Return only the dates you planned or revised, not the other planned dates. Earlier messages are context for preferences.';

export const LOCATION_INSTRUCTION =
  'If the current message is about dates that aren\'t already planned and doesn\'t say where the user will be, don\'t guess a place or reuse an earlier trip\'s: reply with exactly {"outfits": [], "needs_location": true}.';

/** YYYY-MM-DD for `now` in the given timezone. */
export function isoDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(now);
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

export function buildRequestText({
  now,
  timeZone,
  history,
  current,
  plannedDays = [],
  latestTripDates = [],
  askedLocationFor,
}: RequestTextInput): string {
  const sections = [formatToday(now, timeZone)];
  const recent = history.slice(-HISTORY_LIMIT);
  if (recent.length) {
    sections.push(["Earlier messages from this user (oldest first):", ...recent.map((t) => `- ${quote(t)}`)].join("\n"));
  }
  if (plannedDays.length) {
    const days = plannedDays.map((d) => ({ date: d.date, location: d.location, weather: d.weather, ...d.outfit }));
    sections.push(`Outfits already planned for this user, by date (JSON):\n${JSON.stringify(days)}`);
    if (latestTripDates.length) sections.push(`Most recent trip: ${latestTripDates.join(", ")}.`);
  }
  if (askedLocationFor) {
    sections.push(
      `You asked this user where they'll be for their previous message: ${quote(askedLocationFor)}. If the current message names a place, plan that previous message there.`,
    );
  }
  sections.push(`Current message:\n${quote(current)}`);
  sections.push(plannedDays.length ? PLANNED_DAYS_INSTRUCTION : ONE_TRIP_INSTRUCTION);
  sections.push(LOCATION_INSTRUCTION, PER_DAY_INSTRUCTION, DRESS_INSTRUCTION);
  return sections.join("\n\n");
}
