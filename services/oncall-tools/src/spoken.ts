// Small helpers for building spoken_summary strings that read naturally out loud (SPEC 2.4).

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

/** Spells small integers as words (0-20); larger numbers fall back to digits. */
export function spellNumber(n: number): string {
  if (Number.isInteger(n) && n >= 0 && n < WORDS.length) return WORDS[n]!;
  return String(n);
}

export function pluralize(n: number, noun: string, plural = `${noun}s`): string {
  return n === 1 ? noun : plural;
}

export function minutesAgo(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
}

/** e.g. spellNumber+pluralize combo: "3 restarts in the last 4 minutes" -> "three restarts in the last four minutes" */
export function countPhrase(n: number, noun: string, plural?: string): string {
  return `${spellNumber(n)} ${pluralize(n, noun, plural)}`;
}
