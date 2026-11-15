export type StickyValidation =
  | { ok: true; value: string }
  | { ok: false; code: string };
export function validateStickyText(input: string): StickyValidation {
  if (input.length === 0) return { ok: false, code: "sticky_empty" };
  if (/^\s*$/u.test(input))
    return { ok: false, code: "sticky_whitespace_only" };
  if (/\p{Surrogate}/u.test(input))
    return { ok: false, code: "sticky_invalid_unicode" };
  const value = input.replace(/\r\n?/g, "\n");
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127
      );
    })
  )
    return { ok: false, code: "sticky_forbidden_control" };
  if ([...value].length > 2000) return { ok: false, code: "sticky_too_long" };
  return { ok: true, value };
}
