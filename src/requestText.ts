export interface RequestTextInput {
  now: Date;
  timeZone: string;
  history: string[];
  current: string;
}

export const HISTORY_LIMIT = 10;
export const PER_DAY_INSTRUCTION =
  'Reply format: give exactly one outfit per day (not one per activity) that works across all of that day\'s activities, and set each outfit\'s "date" field to that day\'s date (YYYY-MM-DD).';

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

export function buildRequestText({ now, timeZone, history, current }: RequestTextInput): string {
  const sections = [formatToday(now, timeZone)];
  const recent = history.slice(-HISTORY_LIMIT);
  if (recent.length) {
    sections.push(["Earlier messages from this user (oldest first):", ...recent.map((t) => `- ${quote(t)}`)].join("\n"));
  }
  sections.push(`Current message:\n${quote(current)}`);
  sections.push(PER_DAY_INSTRUCTION);
  return sections.join("\n\n");
}
