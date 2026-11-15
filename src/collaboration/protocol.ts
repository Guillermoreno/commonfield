import { createHash } from "node:crypto";
export function isNewerVersion(candidate: number, current: number): boolean {
  return candidate > current;
}
export function operationBinding(input: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
}
