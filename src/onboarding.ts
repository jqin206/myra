export const CLOTHING_QUESTION =
  "First, a couple of quick questions so I can style you better. What kind of clothes should I suggest: womenswear, menswear, or a mix?";
export const STYLE_QUESTION = "How would you describe your style? (e.g. minimalist, streetwear, classic, boho)";
export const ONBOARDED_REPLY =
  "Thanks, you're all set! Send me your itinerary for your next trip or your plans for the next few days, and I'll put together your outfits.";

/** Onboarding steps stored in `users.onboarding`; NULL means the user hasn't started. */
export type OnboardingStep = "clothing" | "style" | "done";

const GREETING =
  /\b(hi+|hello|hey+|hiya|howdy|yo|sup|greetings|good|morning|afternoon|evening|there|is|this|it|myra|who|what|are|you|can|do|does|how|work|works|thanks|thank|ok|okay|please|so|and|the|a|i)\b/g;

/** A first message with nothing to plan ("Hi, is this Myra?"), so there's nothing to hold until onboarding ends. */
export function isGreetingOnly(text: string): boolean {
  return text.toLowerCase().replace(GREETING, " ").replace(/[^a-z0-9]+/g, " ").trim() === "";
}

export function isSkip(text: string): boolean {
  return /^\s*(skip|pass|no thanks|n\/a|none)\s*[.!]*\s*$/i.test(text);
}

const MAX_ANSWER = 300;

/** The answer as stored, or null when the user skipped the question. */
export function onboardingAnswer(text: string): string | null {
  return isSkip(text) ? null : text.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER);
}
