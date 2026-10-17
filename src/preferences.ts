export type TempUnit = "celsius" | "fahrenheit";

const UNIT = "(celsius|centigrade|metric|fahrenheit|imperial|c|f)";
// The unit the user is asking for: "use Celsius", "temps in °F", "switch from F to C" (last one wins).
const REQUESTED = new RegExp(`\\b(?:to|into|use|using|prefer|in)\\s+(?:degrees\\s+)?(?:°\\s?)?${UNIT}\\b`, "gi");
const ANY_UNIT = /\b(celsius|centigrade|metric|fahrenheit|imperial)\b|°\s?([cf])\b|\bdegrees ([cf])\b/gi;

const unitOf = (word: string): TempUnit => (/^(celsius|centigrade|metric|c)$/i.test(word) ? "celsius" : "fahrenheit");

const FILLER =
  /\b(please|pls|use|switch|change|set|to|in|into|show|give|me|my|temps?|temperatures?|units?|degrees|celsius|centigrade|metric|fahrenheit|imperial|instead|from|now|on|always|i|prefer|want|would|like|can|you|c|f|the|of|thanks|thank|ok|okay)\b/g;

function onlyPreferenceWords(text: string): boolean {
  const rest = text.toLowerCase().replace(/°\s?[cf]\b/g, " ").replace(FILLER, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return rest === "";
}

/**
 * A temperature unit the user asked for. Plain mentions ("it'll be 30°C there")
 * don't count; only requests like "use Celsius" or a message that is just a unit.
 */
export function detectTempUnit(text: string): TempUnit | undefined {
  const requested = [...text.matchAll(REQUESTED)].at(-1)?.[1];
  if (requested) return unitOf(requested);
  if (!onlyPreferenceWords(text)) return undefined;
  const kinds = new Set([...text.matchAll(ANY_UNIT)].map((m) => unitOf(m[1] ?? m[2] ?? m[3] ?? "")));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** True when the message is only a unit preference, with no plans to dress for. */
export function isPreferenceOnly(text: string): boolean {
  return detectTempUnit(text) !== undefined && onlyPreferenceWords(text);
}
