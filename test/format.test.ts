import { describe, expect, it } from "vitest";
import { extractPlanFromBody } from "../src/creao.js";
import { HELP_REPLY, formatReply, isDateAssumption, weatherEmoji, type OutfitPlan } from "../src/format.js";
import example from "./fixtures/creao-example.json" with { type: "json" };
import missing from "./fixtures/creao-missing-optionals.json" with { type: "json" };
import wrapped from "./fixtures/creao-wrapped.json" with { type: "json" };
import empty from "./fixtures/creao-empty-outfits.json" with { type: "json" };
import live from "./fixtures/creao-live-artifact-multiday.json" with { type: "json" };

describe("formatReply", () => {
  it("formats the Creao example output", () => {
    const [text, ...rest] = formatReply(example as OutfitPlan);
    expect(rest).toHaveLength(0);
    expect(text).toBe(
      [
        "Sat Jun 14 · Austin, TX",
        "⛅ Partly cloudy, 94° / 76°, 20% rain",
        "",
        "11:00 AM · Brunch",
        "Linen camp-collar shirt, Light chino shorts, Canvas sneakers. Sunglasses + Straw hat.",
        "Why: Breathable linen keeps you cool on a patio at 90°.",
        "",
        "Afternoon · Hike",
        "Moisture-wicking tee, Hiking shorts, Trail runners. Cap.",
        "Why: Quick-dry layers for the hottest part of the day.",
        "",
        "Evening · Dinner downtown",
        "Short-sleeve knit polo, Tapered trousers, Leather loafers. Watch.",
        "Why: Still warm after sunset, so stay light but polished.",
        "",
        "Bring: sunscreen, refillable water bottle",
        "(I assumed brunch is at 11am — let me know if anything's off.)",
      ].join("\n"),
    );
  });

  it("tolerates missing optional fields", () => {
    const [text, ...rest] = formatReply(missing as OutfitPlan);
    expect(rest).toHaveLength(0);
    expect(text).toBe(["Brunch", "White tee, Sneakers.", "", "7:00 PM", "Why: Keep it simple."].join("\n"));
    expect(text).not.toMatch(/undefined|null|Bring:|\(/);
  });

  it("formats the wrapped {result: …} variant identically", () => {
    const plan = extractPlanFromBody(wrapped);
    expect(plan).toBeDefined();
    expect(formatReply(plan!)).toEqual(formatReply(example as OutfitPlan));
  });

  it("sends Myra's help text (not Creao's summary) when outfits is empty", () => {
    expect(formatReply(empty as OutfitPlan)).toEqual([HELP_REPLY]);
    expect(HELP_REPLY).toBe(
      "Hi, I'm Myra! Send me your itinerary for your next trip or your plans for the next few days, and I'll help you generate an outfit!",
    );
  });

  it("falls back to the help text with no outfits and no summary", () => {
    expect(formatReply({})).toEqual([HELP_REPLY]);
    expect(formatReply({ outfits: [] })).toEqual([HELP_REPLY]);
    expect(formatReply({ outfits: null, summary: "  " })).toEqual([HELP_REPLY]);
  });

  it("splits long replies after an outfit block", () => {
    const plan = live as OutfitPlan;
    const messages = formatReply(plan);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages.slice(0, -1)) expect(m.length).toBeLessThanOrEqual(1200);
    expect(messages[0]).toMatch(/^Sat Oct 24 · New York City, NY\n⛅ /);
    // Every outfit block stays intact within one message.
    for (const outfit of plan.outfits!) {
      expect(messages.some((m) => m.includes(`${outfit.time} · ${outfit.activity}\n`))).toBe(true);
    }
    // A split never happens inside a block: each later message starts with a block header or the footer.
    for (const m of messages.slice(1)) expect(m).toMatch(/^(\S.* · .*\n|Bring:|\()/);
  });

  it("keeps date assumptions that mention a different date than the header (multi-day)", () => {
    const text = formatReply(live as OutfitPlan).join("\n\n");
    expect(text).toContain("as Sat 2026-10-24 and Sun 2026-10-25");
    expect(text).toContain("I resolved 'NYC' to New York City, NY");
  });
});

describe("isDateAssumption", () => {
  it("detects assumptions that only restate the shown date", () => {
    expect(isDateAssumption("Interpreted 'this Saturday' as 2025-06-14", "2025-06-14")).toBe(true);
    expect(isDateAssumption("Resolved 'this Saturday' to 2026-10-17, the stated current date", "2026-10-17")).toBe(true);
    expect(
      isDateAssumption("Resolved 'tomorrow' to Sunday, 2026-10-18 from the stated current date of Saturday, 2026-10-17", "2026-10-18"),
    ).toBe(true);
    expect(isDateAssumption("Assumed brunch is at 11am", "2025-06-14")).toBe(false);
    expect(isDateAssumption("Interpreted 'next weekend' as 2026-10-24 and 2026-10-25", "2026-10-24")).toBe(false);
  });
});

describe("weatherEmoji", () => {
  it.each([
    ["Sunny", "☀️"],
    ["Clear", "☀️"],
    ["Mostly sunny", "☀️"],
    ["Partly cloudy", "⛅"],
    ["Overcast", "☁️"],
    ["Cloudy", "☁️"],
    ["Light rain", "🌧️"],
    ["Showers", "🌧️"],
    ["Snow", "❄️"],
    ["Windy", "💨"],
    ["Thunderstorms", "⛈️"],
    ["Volcanic ash", ""],
  ])("%s → %s", (conditions, emoji) => {
    expect(weatherEmoji(conditions)).toBe(emoji);
  });

  it("omits the emoji when conditions are unrecognized", () => {
    const [text] = formatReply({ ...(example as OutfitPlan), weather: { conditions: "Volcanic ash", temp_high: 80 } });
    expect(text.split("\n")[1]).toBe("Volcanic ash, 80°");
  });
});

describe("formatReply one outfit per day", () => {
  const day = (date: string, activity: string) => ({ date, activity, items: { top: "Sweater" } });
  it("labels each outfit with its day and shows a date range when the plan spans days", () => {
    const [text] = formatReply({ location: "New York City, NY", outfits: [day("2026-10-24", "Museums + dinner"), day("2026-10-25", "Brunch + park walk")] });
    expect(text).toMatch(/^Sat Oct 24 – Sun Oct 25 · New York City, NY/);
    expect(text).toContain("Sat Oct 24 · Museums + dinner");
    expect(text).toContain("Sun Oct 25 · Brunch + park walk");
  });
  it("uses the outfit's date when it disagrees with the plan date", () => {
    const [text] = formatReply({ date: "2026-10-24", outfits: [day("2026-10-25", "Brunch")] });
    expect(text).toMatch(/^Sun Oct 25\n/);
  });
  it("keeps the single-date header when every outfit is on the same day", () => {
    const [text] = formatReply({ date: "2026-10-24", outfits: [day("2026-10-24", "Brunch")] });
    expect(text).toMatch(/^Sat Oct 24\n/);
    expect(text).toContain("\nBrunch\n");
  });
});

