import { expect, test } from "bun:test";

// Disposable merge-gate probe. This branch must never be merged.
test("DO NOT MERGE: required check blocks a failing test", () => {
  expect(1).toBe(2);
});
