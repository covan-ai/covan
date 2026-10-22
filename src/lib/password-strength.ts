/**
 * How a new password reads, for the meter under the field (A30): four
 * segments and a sentence. Length carries it — "longer beats stranger" — with
 * a nudge down for a password made of one kind of character only.
 */
export function passwordStrength(
  password: string,
  minimum = 12,
): {
  segments: 0 | 1 | 2 | 3 | 4;
  words: string;
} {
  const n = password.length;
  if (n === 0) return { segments: 0, words: `At least ${minimum} characters.` };
  if (n < minimum) return { segments: 1, words: `Too short. At least ${minimum} characters.` };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (n >= 16) return { segments: 4, words: `Strong. ${n} characters.` };
  if (kinds <= 1) return { segments: 2, words: `Fair. ${n} characters; longer beats stranger.` };
  return { segments: 3, words: `Good. ${n} characters; longer beats stranger.` };
}
