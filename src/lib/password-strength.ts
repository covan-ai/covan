/** The caller's translator, passed in so this stays a pure function. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * How a new password reads, for the meter under the field (A30): four
 * segments and a sentence. Length carries it — "longer beats stranger" — with
 * a nudge down for a password made of one kind of character only.
 */
export function passwordStrength(
  password: string,
  t: Translate,
  minimum = 12,
): {
  segments: 0 | 1 | 2 | 3 | 4;
  words: string;
} {
  const n = password.length;
  if (n === 0) {
    return {
      segments: 0,
      words: t("At least {{count}} character.", {
        count: minimum,
        defaultValue_other: "At least {{count}} characters.",
      }),
    };
  }
  if (n < minimum) {
    return {
      segments: 1,
      words: t("Too short. At least {{count}} character.", {
        count: minimum,
        defaultValue_other: "Too short. At least {{count}} characters.",
      }),
    };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (n >= 16) {
    return {
      segments: 4,
      words: t("Strong. {{count}} character.", {
        count: n,
        defaultValue_other: "Strong. {{count}} characters.",
      }),
    };
  }
  if (kinds <= 1) {
    return {
      segments: 2,
      words: t("Fair. {{count}} character; longer beats stranger.", {
        count: n,
        defaultValue_other: "Fair. {{count}} characters; longer beats stranger.",
      }),
    };
  }
  return {
    segments: 3,
    words: t("Good. {{count}} character; longer beats stranger.", {
      count: n,
      defaultValue_other: "Good. {{count}} characters; longer beats stranger.",
    }),
  };
}
