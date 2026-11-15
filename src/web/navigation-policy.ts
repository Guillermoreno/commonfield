export type WheelSample = {
  at: number;
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
};

export type GestureKind = "pan" | "zoom";

export function classifyWheelGesture(
  samples: readonly WheelSample[],
): GestureKind | null {
  const first = samples[0];
  if (!first) return null;
  if (first.ctrlKey || first.deltaMode !== 0) return "zoom";
  const bounded = samples
    .slice(0, 3)
    .filter((sample) => sample.at - first.at <= 40);
  if (bounded.some((sample) => Math.abs(sample.deltaX) >= 1)) return "pan";
  if (
    bounded.length >= 2 &&
    bounded[1]!.at - first.at <= 24 &&
    bounded.slice(0, 2).every((sample) => Math.abs(sample.deltaY) <= 50)
  )
    return "pan";
  if (bounded.length === 1 && Math.abs(first.deltaY) <= 50) return null;
  return "zoom";
}

export function continueWheelGesture(
  previous: { kind: GestureKind; lastAt: number } | null,
  at: number,
): { kind: GestureKind | null; fresh: boolean } {
  if (!previous || at - previous.lastAt >= 140)
    return { kind: null, fresh: true };
  return { kind: previous.kind, fresh: false };
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
const finiteCoordinate = (value: number) =>
  Number.isFinite(value)
    ? Math.round(clamp(value, -1_000_000, 1_000_000) * 100) / 100
    : 0;

export function sanitizeView(
  view: { x: number; y: number; zoom: number },
  lastValidZoom: number,
) {
  const zoom =
    Number.isFinite(view.zoom) && view.zoom >= 0.1 && view.zoom <= 4
      ? Math.round(view.zoom * 100) / 100
      : Math.round(clamp(lastValidZoom, 0.1, 4) * 100) / 100;
  return { x: finiteCoordinate(view.x), y: finiteCoordinate(view.y), zoom };
}

export function sortNotesForKeyboard<
  T extends { id: string; x: number; y: number },
>(notes: readonly T[]): T[] {
  return [...notes].sort(
    (left, right) =>
      left.y - right.y || left.x - right.x || left.id.localeCompare(right.id),
  );
}
