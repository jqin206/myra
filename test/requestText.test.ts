import { describe, expect, it } from "vitest";
import {
  buildRequestText,
  DRESS_INSTRUCTION,
  formatToday,
  ONE_TRIP_INSTRUCTION,
  PER_DAY_INSTRUCTION,
  isoDate,
  DATE_INSTRUCTION,
  LOCATION_INSTRUCTION,
  NOT_PLANS_INSTRUCTION,
  PLANNED_DAYS_INSTRUCTION,
} from "../src/requestText.js";

const now = new Date("2026-10-17T22:48:00Z");

describe("formatToday", () => {
  it("renders the date in the user's timezone", () => {
    expect(formatToday(now, "America/Los_Angeles")).toBe("Today is Saturday, October 17, 2026 (America/Los_Angeles).");
  });

  it("rolls over to the next day east of UTC", () => {
    expect(formatToday(new Date("2026-10-17T23:30:00Z"), "Asia/Tokyo")).toBe(
      "Today is Sunday, October 18, 2026 (Asia/Tokyo).",
    );
  });

  it("uses the correct year around New Year", () => {
    expect(formatToday(new Date("2027-01-01T05:00:00Z"), "America/Los_Angeles")).toBe(
      "Today is Thursday, December 31, 2026 (America/Los_Angeles).",
    );
  });
});

describe("buildRequestText", () => {
  it("omits the history section when there is none", () => {
    const text = buildRequestText({ now, timeZone: "America/Los_Angeles", history: [], current: "Austin this Saturday" });
    expect(text).toBe(
      `Today is Saturday, October 17, 2026 (America/Los_Angeles).\n\nCurrent message:\n"Austin this Saturday"\n\n${ONE_TRIP_INSTRUCTION}\n\n${NOT_PLANS_INSTRUCTION}\n\n${DATE_INSTRUCTION}\n\n${LOCATION_INSTRUCTION}\n\n${PER_DAY_INSTRUCTION}\n\n${DRESS_INSTRUCTION}`,
    );
  });

  it("includes history oldest first before the current message", () => {
    const text = buildRequestText({
      now,
      timeZone: "America/Los_Angeles",
      history: ["I run cold", "Austin this Saturday — brunch at 11"],
      current: "actually dinner is on a rooftop",
    });
    expect(text).toBe(
      [
        "Today is Saturday, October 17, 2026 (America/Los_Angeles).",
        "",
        "Earlier messages from this user (oldest first):",
        '- "I run cold"',
        '- "Austin this Saturday — brunch at 11"',
        "",
        "Current message:",
        '"actually dinner is on a rooftop"',
        "",
        ONE_TRIP_INSTRUCTION,
        "",
        NOT_PLANS_INSTRUCTION,
        "",
        DATE_INSTRUCTION,
        "",
        LOCATION_INSTRUCTION,
        "",
        PER_DAY_INSTRUCTION,
        "",
        DRESS_INSTRUCTION,
      ].join("\n"),
    );
  });

  it("keeps only the 10 most recent history messages", () => {
    const history = Array.from({ length: 14 }, (_, i) => `msg ${i + 1}`);
    const text = buildRequestText({ now, timeZone: "UTC", history, current: "now" });
    expect(text).not.toContain('"msg 4"');
    expect(text).toContain('- "msg 5"');
    expect(text).toContain('- "msg 14"');
    expect(text.match(/^- /gm)).toHaveLength(10);
  });

  it("collapses newlines so each message stays on one line", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: ["a\nb"], current: "line 1\n\nline 2" });
    expect(text).toContain('- "a b"');
    expect(text).toContain('"line 1 line 2"');
  });

  it("sends the planned days and the most recent trip, and asks Creao to revise by date", () => {
    const plannedDays = [
      { date: "2026-10-24", location: "Los Angeles, CA", weather: { temp_high: 80 }, outfit: { activity: "Lunch", items: { top: "Tee" } } },
      { date: "2026-10-30", location: "New York, NY", weather: null, outfit: { activity: "Shopping", items: { dress: "Wrap dress" } } },
    ];
    const text = buildRequestText({
      now,
      timeZone: "UTC",
      history: [],
      current: "make Oct 24 dressier",
      plannedDays,
      latestTripDates: ["2026-10-30"],
    });
    const json = JSON.parse(text.split("Outfits already planned for this user, by date (JSON):\n")[1]!.split("\n")[0]!);
    expect(json).toEqual([
      { date: "2026-10-24", location: "Los Angeles, CA", weather: { temp_high: 80 }, activity: "Lunch", items: { top: "Tee" } },
      { date: "2026-10-30", location: "New York, NY", weather: null, activity: "Shopping", items: { dress: "Wrap dress" } },
    ]);
    expect(text).toContain("Most recent trip: 2026-10-30.");
    expect(text).toContain(`"make Oct 24 dressier"\n\n${PLANNED_DAYS_INSTRUCTION}\n\n${NOT_PLANS_INSTRUCTION}\n\n${DATE_INSTRUCTION}\n\n${LOCATION_INSTRUCTION}\n\n${PER_DAY_INSTRUCTION}`);
    expect(text).not.toContain(ONE_TRIP_INSTRUCTION);
  });

  it("uses the one-trip instruction when nothing is planned", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: [], current: "hi", plannedDays: [] });
    expect(text).not.toContain("Outfits already planned");
    expect(text).toContain(ONE_TRIP_INSTRUCTION);
  });
});

describe("isoDate", () => {
  it("uses the date in the given timezone", () => {
    expect(isoDate(now, "America/Los_Angeles")).toBe("2026-10-17");
    expect(isoDate(new Date("2026-10-17T23:30:00Z"), "Asia/Tokyo")).toBe("2026-10-18");
  });
});

describe("messages that aren't plans", () => {
  it("tells Creao to answer greetings with no outfits, before the location rule", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: [], current: "Hi, is this Myra?" });
    expect(text).toContain(NOT_PLANS_INSTRUCTION);
    expect(NOT_PLANS_INSTRUCTION).toContain('{"outfits": []}');
    expect(text.indexOf(NOT_PLANS_INSTRUCTION)).toBeLessThan(text.indexOf(LOCATION_INSTRUCTION));
  });
});

describe("location question", () => {
  const now = new Date("2026-10-17T19:00:00Z");
  it("always tells Creao to ask for a place it doesn't have", () => {
    expect(buildRequestText({ now, timeZone: "UTC", history: [], current: "dinner Friday" })).toContain(LOCATION_INSTRUCTION);
  });

  it("points Creao at the message the location answers", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: ["dinner Friday"], current: "Austin", askedLocationFor: "dinner Friday" });
    expect(text).toContain(`You asked this user where they'll be for their previous message: "dinner Friday".`);
    expect(text.indexOf("You asked this user")).toBeLessThan(text.indexOf("Current message:"));
    expect(buildRequestText({ now, timeZone: "UTC", history: [], current: "Austin" })).not.toContain("You asked this user");
  });
});

describe("date question", () => {
  const now = new Date("2026-10-17T19:00:00Z");
  it("always tells Creao to ask for dates it doesn't have", () => {
    expect(buildRequestText({ now, timeZone: "UTC", history: [], current: "Austin — brunch and a hike" })).toContain(DATE_INSTRUCTION);
    expect(DATE_INSTRUCTION).toContain('{"outfits": [], "needs_date": true}');
  });

  it("points Creao at the message the date answers", () => {
    const text = buildRequestText({ now, timeZone: "UTC", history: ["Austin — brunch"], current: "Saturday", askedDateFor: "Austin — brunch" });
    expect(text).toContain(`You asked this user when their previous message is planned for: "Austin — brunch".`);
    expect(text.indexOf("You asked this user")).toBeLessThan(text.indexOf("Current message:"));
    expect(buildRequestText({ now, timeZone: "UTC", history: [], current: "Saturday" })).not.toContain("You asked this user");
  });
});
