import { describe, expect, it } from "vitest";
import { buildRequestText, formatToday, PER_DAY_INSTRUCTION } from "../src/requestText.js";

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
      `Today is Saturday, October 17, 2026 (America/Los_Angeles).\n\nCurrent message:\n"Austin this Saturday"\n\n${PER_DAY_INSTRUCTION}`,
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
        PER_DAY_INSTRUCTION,
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
});
