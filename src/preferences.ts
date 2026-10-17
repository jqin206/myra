export type TempUnit = "celsius" | "fahrenheit";

const CELSIUS = /\b(celsius|centigrade|metric)\b|°\s?c\b|\bdegrees c\b/i;
const FAHRENHEIT = /\b(fahrenheit|imperial)\b|°\s?f\b|\bdegrees f\b/i;

/** A temperature unit the user asked for, e.g. "use Celsius" or "temps in °F please". */
export function detectTempUnit(text: string): TempUnit | undefined {
  const c = CELSIUS.test(text);
  const f = FAHRENHEIT.test(text);
  if (c === f) return undefined;
  return c ? "celsius" : "fahrenheit";
}

/** True when the message is only a unit preference, with no plans to dress for. */
export function isPreferenceOnly(text: string): boolean {
  if (!detectTempUnit(text)) return false;
  const rest = text
    .toLowerCase()
    .replace(/°\s?[cf]\b/g, " ")
    .replace(/\b(please|pls|use|switch|change|set|to|in|into|show|give|me|my|temps?|temperatures?|units?|degrees|celsius|centigrade|metric|fahrenheit|imperial|instead|from|now|on|always|i|prefer|want|would|like|can|you|c|f|the|of|thanks|thank|ok|okay)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return rest === "";
}
