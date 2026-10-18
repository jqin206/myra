export interface OutfitItems {
  top?: string | null;
  bottom?: string | null;
  outerwear?: string | null;
  footwear?: string | null;
  accessories?: string[] | string | null;
}

export interface Outfit {
  date?: string | null;
  activity?: string | null;
  time?: string | null;
  items?: OutfitItems | null;
  rationale?: string | null;
}

export interface Weather {
  temp_high?: number | null;
  temp_low?: number | null;
  temp_unit?: string | null;
  conditions?: string | null;
  precipitation_chance?: number | null;
  wind?: string | null;
}

export interface OutfitPlan {
  date?: string | null;
  location?: string | null;
  weather?: Weather | null;
  outfit_count?: number | null;
  outfits?: Outfit[] | null;
  extras?: string[] | null;
  assumptions?: string[] | null;
  summary?: string | null;
}

export const TEXT_ONLY_REPLY = "I can only read text right now — just type out your plans!";
export const HELP_REPLY =
  "Hi, I'm Myra! Send me your itinerary for your next trip or your plans for the next few days, and I'll help you generate an outfit!";
export const INTERIM_REPLY = "Analyzing your input...";
export const TIMEOUT_REPLY = "Sorry, your request timed out. Please try again";
export const ERROR_REPLY = "Sorry, I couldn't put outfits together just now. Mind sending that again in a minute?";
export const tempUnitSavedReply = (unit: "celsius" | "fahrenheit") =>
  `Got it — I'll use ${unit === "celsius" ? "Celsius" : "Fahrenheit"} from now on.`;
export const SPLIT_AT = 1200;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const piece = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !/^(none|n\/a|not needed|none needed|no \w+ needed)\.?$/i.test(s) ? s : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function weatherEmoji(conditions: string | undefined): string {
  if (!conditions) return "";
  const c = conditions.toLowerCase();
  if (/snow|sleet|flurr|blizzard/.test(c)) return "❄️";
  if (/thunder|storm/.test(c)) return "⛈️";
  if (/rain|shower|drizzle/.test(c)) return "🌧️";
  if (/partly|partial|mostly cloudy|scattered|broken clouds|few clouds/.test(c)) return "⛅";
  if (/cloud|overcast|fog|mist|haz/.test(c)) return "☁️";
  if (/wind|breez|gust/.test(c)) return "💨";
  if (/sun|clear|fair/.test(c)) return "☀️";
  return "";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatPlanDate(date: string | undefined): string | undefined {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function weatherLine(w: Weather | null | undefined): string | undefined {
  if (!w) return undefined;
  const conditions = str(w.conditions);
  const high = num(w.temp_high);
  const low = num(w.temp_low);
  const precip = num(w.precipitation_chance);
  const parts: string[] = [];
  if (conditions) parts.push(conditions);
  if (high !== undefined && low !== undefined) parts.push(`${Math.round(high)}° / ${Math.round(low)}°`);
  else if (high !== undefined) parts.push(`${Math.round(high)}°`);
  else if (low !== undefined) parts.push(`${Math.round(low)}°`);
  if (precip !== undefined) parts.push(`${Math.round(precip)}% rain`);
  if (!parts.length) return undefined;
  return `${weatherEmoji(conditions) || "🌡️"} ${parts.join(" · ")}`;
}

const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
/** Drops a weekday the activity repeats ("Saturday: museums", "Museums (Saturday)") when the date is shown. */
function stripDay(activity: string): string {
  const out = activity
    .replace(new RegExp(`^${DAY}\\s*[:\\-–—]\\s*`, "i"), "")
    .replace(new RegExp(`\\s*\\(${DAY}\\)$`, "i"), "")
    .trim();
  return out ? out[0]!.toUpperCase() + out.slice(1) : activity;
}

const ITEM_LABELS: [keyof OutfitItems, string][] = [
  ["top", "👕 Top"],
  ["bottom", "👖 Bottom"],
  ["outerwear", "🧥 Layer"],
  ["footwear", "👟 Shoes"],
];

function outfitBlock(o: Outfit, showDate: boolean): string | undefined {
  const activity = str(o.activity);
  const head = [
    showDate ? formatPlanDate(str(o.date)) : undefined,
    activity && showDate ? stripDay(activity) : activity,
    str(o.time),
  ]
    .filter(Boolean)
    .join(" · ");
  const items = o.items ?? {};
  const lines = ITEM_LABELS.map(([key, label]) => {
    const p = piece(items[key]);
    return p ? `${label}: ${p.replace(/[.]$/, "")}` : undefined;
  });
  const accessories = (Array.isArray(items.accessories) ? items.accessories : [items.accessories])
    .map(piece)
    .filter(Boolean) as string[];
  if (accessories.length) lines.push(`👜 Extras: ${accessories.map((a) => a.replace(/[.]$/, "")).join(", ")}`);
  const why = str(o.rationale);
  if (why) lines.push(`💡 ${why}`);
  const body = lines.filter(Boolean) as string[];
  if (!head && !body.length) return undefined;
  return [head ? head : undefined, ...body].filter(Boolean).join("\n");
}

const RESOLVED_DATE =
  /\b(resolv|interpret|took|treat|read)\w*\b.*\b(today|tonight|tomorrow|weekend|date|this|next|coming|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

/** True when an assumption only restates the date already shown in the header. */
export function isDateAssumption(text: string, planDate: string | undefined): boolean {
  // "…from the stated current date of Saturday, 2026-10-17" names the reference date, not the plan date.
  const stripped = text.replace(/\bfrom (the (stated )?current date( of)? )?(\w+,? )?\d{4}-\d{2}-\d{2}/gi, "");
  const isoDates: string[] = stripped.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (isoDates.some((d) => d !== planDate)) return false;
  return (planDate !== undefined && isoDates.includes(planDate)) || RESOLVED_DATE.test(text);
}

function assumptionClause(text: string): string {
  const t = text.trim().replace(/[.]$/, "");
  const assumed = t.match(/^assum(?:ed|ing|ption:?)\s+(?:that\s+)?(.*)$/i);
  if (assumed) return `I assumed ${assumed[1]}`;
  const firstWord = t.split(/\s+/)[0] ?? "";
  if (/^[A-Z][a-z]+ed$/.test(firstWord)) return `I ${lowerFirst(t)}`;
  return t;
}

function assumptionsLine(plan: OutfitPlan, dateShown: boolean): string | undefined {
  const date = str(plan.date);
  const list = (plan.assumptions ?? [])
    .map(str)
    .filter((a): a is string => !!a)
    .filter((a) => !(dateShown && isDateAssumption(a, date)));
  if (!list.length) return undefined;
  return `📝 ${list.map(assumptionClause).join("; ")} — let me know if anything's off.`;
}

function footerBlock(plan: OutfitPlan, dateShown: boolean): string | undefined {
  const extras = (plan.extras ?? []).map(str).filter(Boolean) as string[];
  const lines = [
    extras.length ? `🎒 Bring: ${extras.map(lowerFirst).join(", ")}` : undefined,
    assumptionsLine(plan, dateShown),
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** Returns the reply as iMessage texts: one per day, the header on the first and the footer on the last. */
export function formatReply(plan: OutfitPlan, limit = SPLIT_AT): string[] {
  const list = (Array.isArray(plan.outfits) ? plan.outfits : []).filter((o): o is Outfit => !!o && typeof o === "object");
  // Creao's summary for non-itinerary messages points at its own UI, so those always get our help text.
  const days = [...new Set(list.map((o) => str(o.date)).filter((d): d is string => !!d))].sort();
  const multiDay = days.length > 1;
  const byDay: string[][] = [];
  let lastDay: string | undefined;
  for (const o of list) {
    const block = outfitBlock(o, multiDay);
    if (!block) continue;
    const day = str(o.date) ?? lastDay;
    if (!byDay.length || day !== lastDay) byDay.push([]);
    byDay.at(-1)!.push(block);
    lastDay = day;
  }
  if (!byDay.length) return [HELP_REPLY];

  // An outfit's own date wins over the plan-level date when they disagree.
  const shownDate = multiDay ? undefined : (days[0] ?? str(plan.date));
  const dateText = multiDay ? `${formatPlanDate(days[0])} – ${formatPlanDate(days.at(-1))}` : formatPlanDate(shownDate);
  const location = str(plan.location);
  const header = [
    location ? `📍 ${location}` : undefined,
    dateText ? `🗓️ ${dateText}` : undefined,
    weatherLine(plan.weather),
  ]
    .filter(Boolean)
    .join("\n");
  const footer = footerBlock({ ...plan, date: shownDate ?? plan.date }, !!dateText);

  if (header) byDay[0]![0] = `${header}\n\n${byDay[0]![0]}`;
  // Each day gets its own text; a day too long for one text is split between outfits.
  const messages: string[] = [];
  for (const blocks of byDay) {
    let current = "";
    for (const block of blocks) {
      const next = current ? `${current}\n\n${block}` : block;
      if (current && next.length > limit) {
        messages.push(current);
        current = block;
      } else {
        current = next;
      }
    }
    messages.push(current);
  }
  if (footer) {
    const last = `${messages.at(-1)}\n\n${footer}`;
    if (last.length <= limit) messages[messages.length - 1] = last;
    else messages.push(footer);
  }
  return messages;
}
