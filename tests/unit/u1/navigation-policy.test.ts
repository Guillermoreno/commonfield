import { describe, expect, it } from "vitest";
import {
  classifyWheelGesture,
  continueWheelGesture,
  sanitizeView,
  sortNotesForKeyboard,
} from "../../../src/web/navigation-policy.js";

describe("automatic wheel gesture policy", () => {
  it("classifies pinch and line/page deltas immediately", () => {
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: 2 },
      ]),
    ).toBe("zoom");
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: false, deltaMode: 1, deltaX: 0, deltaY: 1 },
      ]),
    ).toBe("zoom");
  });

  it("classifies bounded pixel sequences and falls back deterministically", () => {
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: false, deltaMode: 0, deltaX: 2, deltaY: 1 },
      ]),
    ).toBe("pan");
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 12 },
        { at: 20, ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 10 },
      ]),
    ).toBe("pan");
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 12 },
      ]),
    ).toBeNull();
    expect(
      classifyWheelGesture([
        { at: 0, ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 80 },
      ]),
    ).toBe("zoom");
  });

  it("keeps a classification inside 140ms and resets after inactivity", () => {
    expect(continueWheelGesture({ kind: "pan", lastAt: 10 }, 149)).toEqual({
      kind: "pan",
      fresh: false,
    });
    expect(continueWheelGesture({ kind: "pan", lastAt: 10 }, 150)).toEqual({
      kind: null,
      fresh: true,
    });
  });
});

describe("bounded keyboard navigation policy", () => {
  it("clamps pan and restores the last valid two-decimal zoom", () => {
    expect(
      sanitizeView({ x: 2_000_000, y: -2_000_000, zoom: Number.NaN }, 1.25),
    ).toEqual({ x: 1_000_000, y: -1_000_000, zoom: 1.25 });
    expect(sanitizeView({ x: 1.234, y: 4.567, zoom: 4.5 }, 2)).toEqual({
      x: 1.23,
      y: 4.57,
      zoom: 2,
    });
  });

  it("orders notes by world y, x, then opaque id without mutating input", () => {
    const notes = [
      { id: "z", x: 0, y: 2 },
      { id: "b", x: 2, y: 1 },
      { id: "a", x: 2, y: 1 },
    ];
    expect(sortNotesForKeyboard(notes).map((note) => note.id)).toEqual([
      "a",
      "b",
      "z",
    ]);
    expect(notes.map((note) => note.id)).toEqual(["z", "b", "a"]);
  });
});
