import { describe, it, expect } from "vitest";
import { computeBackoffMs } from "../queue/deliveryQueue";

describe("computeBackoffMs", () => {
  it("grows exponentially with attempt number", () => {
    // Strip jitter's ~20% band by checking the base ordering holds well beyond it.
    const a1 = computeBackoffMs(1);
    const a4 = computeBackoffMs(4);
    const a7 = computeBackoffMs(7);
    expect(a4).toBeGreaterThan(a1);
    expect(a7).toBeGreaterThan(a4);
  });

  it("caps delay at one hour even for very high attempt numbers", () => {
    const delay = computeBackoffMs(30);
    expect(delay).toBeLessThanOrEqual(60 * 60 * 1000 * 1.2); // cap + max jitter
  });

  it("always returns a positive delay", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(computeBackoffMs(attempt)).toBeGreaterThan(0);
    }
  });
});
