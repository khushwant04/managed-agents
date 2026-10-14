/** Encode one path segment; `@` stays literal so targets read `name@alias`. */
export function encodeSegment(value: string | number): string {
  return encodeURIComponent(String(value)).replace(/%40/g, '@');
}
