/**
 * Title normalisation for the S9 step-4 fallback: lowercase, fold diacritics,
 * strip punctuation, drop leading articles.
 *
 * Deliberately aggressive, because it is only ever used for an *exact* match
 * against a TMDB search result with a year within +/-1. A tight comparison of
 * two aggressively normalised titles is still a tight match overall.
 */
const LEADING_ARTICLES =
  /^(the|a|an|der|die|das|ein|eine|le|la|les|un|une|el|los|las|il|lo|gli)\s+/;

export function normaliseTitle(raw: string): string {
  return (
    raw
      .normalize('NFD')
      // strip combining marks: "Amelie" with an accent folds to plain ascii
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      // typographic variants, before punctuation is stripped wholesale
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(LEADING_ARTICLES, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Two titles match if they normalise identically. */
export function titlesMatch(a: string, b: string): boolean {
  const na = normaliseTitle(a);
  return na.length > 0 && na === normaliseTitle(b);
}

/** S9: accept a year within +/-1, or accept when either side has no year. */
export function yearsMatch(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= 1;
}
