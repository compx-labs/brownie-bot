import { describe, expect, it } from "vitest";

import {
  sanitizeErrorMessage,
  sanitizeErrorText,
} from "../src/util/errors.js";

const html504 = `504 <!DOCTYPE html>
<html>
<head>
    <title>504 Gateway Timeout</title>
</head>
<body>
    <h3>We could not establish a connection to nauvoo.belt.algo.xyz</h3>
    <div class="description">A timeout occured while waiting for nauvoo.belt.algo.xyz origin server to respond.</div>
</body>
</html>`;

describe("sanitizeErrorMessage", () => {
  it("classifies ZeroSignal CDN HTML gateway timeouts", () => {
    expect(sanitizeErrorMessage(new Error(html504))).toBe(
      "ZeroSignal gateway timeout (504); could not reach nauvoo.belt.algo.xyz",
    );
  });

  it("uses Error.status when the message body is HTML without a leading code", () => {
    const error = Object.assign(
      new Error(`<!DOCTYPE html><html><title>502 Bad Gateway</title></html>`),
      { status: 502 },
    );
    expect(sanitizeErrorMessage(error)).toBe("Upstream bad gateway (502)");
  });

  it("preserves ordinary short error messages", () => {
    expect(sanitizeErrorMessage(new Error("Invalid AI plan"))).toBe(
      "Invalid AI plan",
    );
  });

  it("returns Unknown error for empty or non-error values", () => {
    expect(sanitizeErrorMessage(new Error(""))).toBe("Unknown error");
    expect(sanitizeErrorMessage(null)).toBe("Unknown error");
  });

  it("truncates long non-HTML messages", () => {
    const long = `x`.repeat(400);
    const sanitized = sanitizeErrorMessage(new Error(long), { maxLength: 50 });
    expect(sanitized.length).toBe(50);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});

describe("sanitizeErrorText", () => {
  it("classifies Canix-flavored HTML failures", () => {
    expect(
      sanitizeErrorText(
        `Canix402 FETCH_FAILED: 504 <!DOCTYPE html><html>Gateway Timeout waiting for espinoza.belt.algo.xyz origin</html>`,
      ),
    ).toBe(
      "ZeroSignal gateway timeout (504); could not reach espinoza.belt.algo.xyz",
    );
  });

  it("labels Canix when the failure is HTML without a ZeroSignal origin", () => {
    expect(
      sanitizeErrorText(
        `Canix402 FETCH_FAILED: <!DOCTYPE html><html><title>502 Bad Gateway</title></html>`,
        { status: 502 },
      ),
    ).toBe("Canix bad gateway (502)");
  });

  it("collapses whitespace on plain multi-line text", () => {
    expect(sanitizeErrorText("line one\n\nline two")).toBe("line one line two");
  });
});
