import { describe, expect, it } from "vitest";
import { extractPlanFromBody } from "../src/creao.js";
import { HELP_REPLY, formatReply, weatherEmoji, type OutfitPlan } from "../src/format.js";
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
        "📍 Austin, TX",
        "🗓️ Sat Jun 14",
        "",
        "Brunch · 11:00 AM",
        "⛅ Partly cloudy · 94° / 76° · 20% rain",
        "👕 Top: Linen camp-collar shirt",
        "👖 Bottom: Light chino shorts",
        "👟 Shoes: Canvas sneakers",
        "👜 Extras: Sunglasses, Straw hat",
        "",
        "Hike · Afternoon",
        "👕 Top: Moisture-wicking tee",
        "👖 Bottom: Hiking shorts",
        "👟 Shoes: Trail runners",
        "👜 Extras: Cap",
        "",
        "Dinner downtown · Evening",
        "👕 Top: Short-sleeve knit polo",
        "👖 Bottom: Tapered trousers",
        "👟 Shoes: Leather loafers",
        "👜 Extras: Watch",
        "",
        "🎒 Bring: sunscreen, refillable water bottle",
      ].join("\n"),
    );
  });

  it("tolerates missing optional fields", () => {
    const [text, ...rest] = formatReply(missing as OutfitPlan);
    expect(rest).toHaveLength(0);
    expect(text).toBe(["Brunch", "👕 Top: White tee", "👟 Shoes: Sneakers", "", "7:00 PM"].join("\n"));
    expect(text).not.toMatch(/undefined|null|Bring:|📝|💡|📍|🗓️|Keep it simple/);
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
    expect(messages[0]).toMatch(/^📍 New York City, NY\n🗓️ Sat Oct 24\n\n.* · .*\n⛅ /);
    // Every outfit block stays intact within one message.
    for (const outfit of plan.outfits!) {
      expect(messages.some((m) => m.includes(`${outfit.activity} · ${outfit.time}\n`))).toBe(true);
    }
    // A split never happens inside a block: each later message starts with a block header or the footer.
    for (const m of messages.slice(1)) expect(m).toMatch(/^(\S.* · .*\n|🎒 Bring:)/);
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
    expect(text.split("\n")[4]).toBe("🌡️ Volcanic ash · 80°");
  });
});

describe("formatReply one outfit per day", () => {
  const day = (date: string, activity: string) => ({ date, activity, items: { top: "Sweater" } });
  it("labels each outfit with its day, shows a date range and sends one text per day", () => {
    const messages = formatReply({
      location: "New York City, NY",
      outfits: [day("2026-10-24", "Museums + dinner"), day("2026-10-25", "Brunch + park walk")],
      extras: ["Umbrella"],
    });
    expect(messages).toEqual([
      "📍 New York City, NY\n🗓️ Sat Oct 24 – Sun Oct 25\n\nSat Oct 24 · Museums + dinner\n👕 Top: Sweater",
      "Sun Oct 25 · Brunch + park walk\n👕 Top: Sweater\n\n🎒 Bring: umbrella",
    ]);
  });
  it("shows each day's own weather under that day's heading, and never the trip weather on multi-day plans", () => {
    const sunny = { conditions: "Sunny", temp_high: 70, temp_low: 55, precipitation_chance: 0 };
    const messages = formatReply({
      weather: { conditions: "Mixed", temp_high: 99 },
      outfits: [{ ...day("2026-10-24", "Museums"), weather: sunny }, day("2026-10-25", "Brunch")],
    });
    expect(messages).toEqual([
      "🗓️ Sat Oct 24 – Sun Oct 25\n\nSat Oct 24 · Museums\n☀️ Sunny · 70° / 55° · 0% rain\n👕 Top: Sweater",
      "Sun Oct 25 · Brunch\n👕 Top: Sweater",
    ]);
  });
  it("matches daily_weather entries to each day by date", () => {
    const messages = formatReply({
      weather: { conditions: "Clear", temp_high: 56 },
      daily_weather: [
        { date: "2026-10-25", conditions: "Overcast", temp_high: 59, temp_low: 48 },
        { date: "2026-10-24", conditions: "Clear sky", temp_high: 56, temp_low: 47 },
      ],
      outfits: [day("2026-10-24", "Museums"), day("2026-10-25", "Brunch")],
    });
    expect(messages[0]).toContain("Sat Oct 24 · Museums\n☀️ Clear sky · 56° / 47°\n");
    expect(messages[1]).toContain("Sun Oct 25 · Brunch\n☁️ Overcast · 59° / 48°\n");
  });
  it("drops a weekday the activity repeats when the date is already shown", () => {
    const text = formatReply({
      outfits: [day("2026-10-24", "Saturday: museums and dinner"), day("2026-10-25", "Brunch and a park walk (Sunday)")],
    }).join("\n\n");
    expect(text).toContain("Sat Oct 24 · Museums and dinner\n");
    expect(text).toContain("Sun Oct 25 · Brunch and a park walk\n");
  });
  it("uses the outfit's date when it disagrees with the plan date", () => {
    const [text] = formatReply({ date: "2026-10-24", outfits: [day("2026-10-25", "Brunch")] });
    expect(text).toMatch(/^🗓️ Sun Oct 25\n/);
  });
  it("keeps the single-date header when every outfit is on the same day", () => {
    const messages = formatReply({ date: "2026-10-24", outfits: [day("2026-10-24", "Brunch"), day("2026-10-24", "Dinner")] });
    const withWeather = formatReply({ date: "2026-10-24", weather: { conditions: "Clear", temp_high: 80 }, outfits: [day("2026-10-24", "Brunch"), day("2026-10-24", "Dinner")] });
    expect(messages).toEqual(["🗓️ Sat Oct 24\n\nBrunch\n👕 Top: Sweater\n\nDinner\n👕 Top: Sweater"]);
    expect(withWeather).toEqual(["🗓️ Sat Oct 24\n\nBrunch\n☀️ Clear · 80°\n👕 Top: Sweater\n\nDinner\n👕 Top: Sweater"]);
  });
});

