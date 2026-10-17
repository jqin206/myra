import { describe, expect, it } from "vitest";
import { detectTempUnit, isPreferenceOnly } from "../src/preferences.js";

describe("temperature preference", () => {
  it.each([
    ["use celsius please", "celsius", true],
    ["Can you show temps in °C?", "celsius", true],
    ["switch to Fahrenheit", "fahrenheit", true],
    ["metric", "celsius", true],
    ["Paris this weekend, temps in celsius", "celsius", false],
    ["Austin this Saturday — brunch at 11", undefined, false],
    ["celsius or fahrenheit?", undefined, false],
    ["Facebook offsite Friday", undefined, false],
  ] as const)("%s", (text, unit, only) => {
    expect(detectTempUnit(text)).toBe(unit);
    expect(isPreferenceOnly(text)).toBe(only);
  });
});
