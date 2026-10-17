import { describe, expect, it } from "vitest";
import { errorCode } from "../src/log.js";

describe("errorCode", () => {
  it("includes the Photon problem code from an ApiError body", () => {
    expect(errorCode({ status: 409, body: { code: "SPACE_NOT_SENDABLE" } })).toBe("http_409_SPACE_NOT_SENDABLE");
  });
  it("falls back to the HTTP status, error code or name", () => {
    expect(errorCode({ status: 503, body: "oops" })).toBe("http_503");
    expect(errorCode({ code: "ECONNRESET" })).toBe("ECONNRESET");
    expect(errorCode(new TypeError("x"))).toBe("TypeError");
    expect(errorCode("x")).toBe("unknown");
  });
});
