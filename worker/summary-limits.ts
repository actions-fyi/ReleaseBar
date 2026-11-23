// Caps on the commit titles a release summary sends the model. Anyone can have any public
// repository summarized, so the input is capped whatever its commits hold. Each cap is a Worker
// var, set by `npm run deploy` from a RELEASEBAR_* build variable; unset, it has its default.
// Counts are UTF-16 units, as JavaScript measures strings.
//
// The bounds keep a setting from removing a cap. `npm run deploy` rejects a value outside them,
// and the Worker clamps one set on it directly, and ignores a value that isn't a whole number.
// This module imports nothing, so the deploy script can use it without the Worker.

export type ReleaseSummaryLimit = {
  readonly variable: string;
  readonly buildVariable: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

const INPUT_CHARS_DEFAULT = 48_000;
const INPUT_CHARS_MIN = 1_000;
const INPUT_CHARS_MAX = 400_000;
const TITLE_CHARS_DEFAULT = 160;
const TITLE_CHARS_MIN = 20;
const TITLE_CHARS_MAX = 1_000;

export const releaseSummaryLimitSettings = {
  // The whole title list, newest titles kept first.
  inputChars: {
    variable: "RELEASE_SUMMARY_INPUT_CHARS",
    buildVariable: "RELEASEBAR_SUMMARY_INPUT_CHARS",
    defaultValue: INPUT_CHARS_DEFAULT,
    min: INPUT_CHARS_MIN,
    max: INPUT_CHARS_MAX,
  },
  titleChars: {
    variable: "RELEASE_SUMMARY_TITLE_CHARS",
    buildVariable: "RELEASEBAR_SUMMARY_TITLE_CHARS",
    defaultValue: TITLE_CHARS_DEFAULT,
    min: TITLE_CHARS_MIN,
    max: TITLE_CHARS_MAX,
  },
} as const satisfies Record<string, ReleaseSummaryLimit>;

export type ReleaseSummaryLimits = Record<keyof typeof releaseSummaryLimitSettings, number>;

// Caps on how many summaries call the model, set and bounded the same way. Only a signed-in
// user's request starts a summary; these keep one account, or all of them together, from
// spending without limit.
export const summaryRateLimitSettings = {
  // Per GitHub user, in each clock hour (UTC).
  userHourly: {
    variable: "SUMMARY_USER_HOURLY_LIMIT",
    buildVariable: "RELEASEBAR_SUMMARY_USER_HOURLY_LIMIT",
    defaultValue: 30,
    min: 1,
    max: 1_000,
  },
  // All users together, in each UTC day.
  globalDaily: {
    variable: "SUMMARY_GLOBAL_DAILY_LIMIT",
    buildVariable: "RELEASEBAR_SUMMARY_GLOBAL_DAILY_LIMIT",
    defaultValue: 1_000,
    min: 1,
    max: 100_000,
  },
} as const satisfies Record<string, ReleaseSummaryLimit>;

export type SummaryRateLimits = Record<keyof typeof summaryRateLimitSettings, number>;

export const summaryLimitSettings: readonly ReleaseSummaryLimit[] = [
  ...Object.values(releaseSummaryLimitSettings),
  ...Object.values(summaryRateLimitSettings),
];

// A whole number of digits only: matches "48000", rejects "48,000", "4.8e4" and "-1".
// https://regex101.com/?regex=%5E%5Cd%2B%24&testString=48000
const wholeNumberPattern = /^\d+$/;

export function parseWholeNumber(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  return wholeNumberPattern.test(trimmed) ? Number(trimmed) : null;
}

// Any object with the limit variables on it: the Worker env or a plain record.
type LimitVars = object;

function limitValue(
  vars: LimitVars,
  { variable, defaultValue, min, max }: ReleaseSummaryLimit,
): number {
  const raw = (vars as Readonly<Record<string, unknown>>)[variable];
  const value = parseWholeNumber(typeof raw === "string" ? raw : undefined) ?? defaultValue;
  return Math.min(max, Math.max(min, value));
}

export function releaseSummaryLimits(vars: LimitVars): ReleaseSummaryLimits {
  return {
    inputChars: limitValue(vars, releaseSummaryLimitSettings.inputChars),
    titleChars: limitValue(vars, releaseSummaryLimitSettings.titleChars),
  };
}

export function summaryRateLimits(vars: LimitVars): SummaryRateLimits {
  return {
    userHourly: limitValue(vars, summaryRateLimitSettings.userHourly),
    globalDaily: limitValue(vars, summaryRateLimitSettings.globalDaily),
  };
}
