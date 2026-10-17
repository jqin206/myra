export interface OutfitItems {
  top?: string | null;
  bottom?: string | null;
  outerwear?: string | null;
  footwear?: string | null;
  accessories?: string[] | string | null;
}

export interface Outfit {
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
  "Tell me where you'll be, when, and what you're doing — e.g. 'Austin this Saturday: brunch at 11, hike, dinner downtown.'";
export const INTERIM_REPLY = "Checking the forecast for you — one sec…";
export const ERROR_REPLY = "Sorry, I couldn't put outfits together just now. Mind sending that again in a minute?";
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
  const emoji = weatherEmoji(conditions);
  return `${emoji ? `${emoji} ` : ""}${parts.join(", ")}`;
}

function outfitBlock(o: Outfit): string | undefined {
  const head = [str(o.time), str(o.activity)].filter(Boolean).join(" · ");
  const items = o.items ?? {};
  const pieces = [items.top, items.bottom, items.outerwear, items.footwear].map(piece).filter(Boolean) as string[];
  const accessories = (Array.isArray(items.accessories) ? items.accessories : [items.accessories])
    .map(piece)
    .filter(Boolean) as string[];
  const itemLine = [
    pieces.length ? sentence(pieces.map((p) => p.replace(/[.]$/, "")).join(", ")) : undefined,
    accessories.length ? sentence(accessories.join(" + ")) : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const why = str(o.rationale);
  const lines = [head, itemLine, why ? `Why: ${why}` : undefined].filter(Boolean) as string[];
  return lines.length ? lines.join("\n") : undefined;
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
  return `(${list.map(assumptionClause).join("; ")} — let me know if anything's off.)`;
}

function footerBlock(plan: OutfitPlan, dateShown: boolean): string | undefined {
  const extras = (plan.extras ?? []).map(str).filter(Boolean) as string[];
  const lines = [
    extras.length ? `Bring: ${extras.map(lowerFirst).join(", ")}` : undefined,
    assumptionsLine(plan, dateShown),
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** Returns the reply as one or more iMessage texts. */
export function formatReply(plan: OutfitPlan, limit = SPLIT_AT): string[] {
  const outfits = (Array.isArray(plan.outfits) ? plan.outfits : [])
    .map((o) => (o && typeof o === "object" ? outfitBlock(o) : undefined))
    .filter((b): b is string => !!b);
  if (!outfits.length) return [str(plan.summary) ?? HELP_REPLY];

  const dateText = formatPlanDate(str(plan.date));
  const title = [dateText, str(plan.location)].filter(Boolean).join(" · ");
  const header = [title || undefined, weatherLine(plan.weather)].filter(Boolean).join("\n");
  const footer = footerBlock(plan, !!dateText);

  const segments = [...outfits];
  if (header) segments[0] = `${header}\n\n${segments[0]}`;
  if (footer) segments.push(footer);

  const messages: string[] = [];
  let current = "";
  for (const segment of segments) {
    const next = current ? `${current}\n\n${segment}` : segment;
    if (current && next.length > limit) {
      messages.push(current);
      current = segment;
    } else {
      current = next;
    }
  }
  if (current) messages.push(current);
  return messages;
}
