import { describe, expect, it } from "vitest";
import { isGreetingOnly, isSkip, onboardingAnswer } from "../src/onboarding.js";
import { buildRequestText, PROFILE_HEADING } from "../src/requestText.js";

describe("isGreetingOnly", () => {
  it("is true for greetings and questions about Myra", () => {
    for (const t of ["Hi", "hello!", "Hi, is this Myra?", "Hey, what can you do?", "Good morning", "hiii"]) expect(isGreetingOnly(t)).toBe(true);
  });
  it("is false when the message has plans", () => {
    for (const t of ["Hi! Austin this Saturday", "brunch and a hike", "Hey, can you help me pack for NYC?"]) expect(isGreetingOnly(t)).toBe(false);
  });
});

describe("onboarding answers", () => {
  it("treats skip-like replies as no answer", () => {
    expect(isSkip("Skip")).toBe(true);
    expect(isSkip("skip.")).toBe(true);
    expect(onboardingAnswer(" pass ")).toBeNull();
    expect(onboardingAnswer("  Classic,\n preppy ")).toBe("Classic, preppy");
    expect(onboardingAnswer("x".repeat(400))).toHaveLength(300);
  });
});

describe("profile in the request", () => {
  const now = new Date("2026-10-17T19:00:00Z");
  it("lists the onboarding answers it has, before the current message", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: [], current: "Austin Saturday", profile: { clothing: "Menswear", style: null } });
    expect(text).toContain(`${PROFILE_HEADING}\n- Clothes to suggest: "Menswear"`);
    expect(text).not.toContain("Style:");
    expect(text.indexOf(PROFILE_HEADING)).toBeLessThan(text.indexOf("Current message:"));
  });
  it("leaves the profile out when there are no answers", () => {
    expect(buildRequestText({ now, timeZone: "UTC", history: [], current: "x", profile: { clothing: null, style: null } })).not.toContain(PROFILE_HEADING);
  });
});
