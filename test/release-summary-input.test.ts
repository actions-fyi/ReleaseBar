import { assert, expect, test } from "vitest";
import { clipText, releaseTitlesInput } from "../../../worker/release-summary.js";
import {
  releaseSummaryLimitSettings,
  releaseSummaryLimits,
} from "../../../worker/summary-limits.js";

const defaults = releaseSummaryLimits({});

test("clipped text never ends inside a surrogate pair", () => {
  expect(clipText("ab😀cd", 3)).toBe("ab…");
  expect(clipText("abc", 3)).toBe("abc");
});

test("release summary titles stay within their cap whatever the commits hold", () => {
  const huge = "x".repeat(200_000);
  const titles = Array.from({ length: 500 }, (_, index) =>
    clipText(`commit ${index} ${huge}`, defaults.titleChars),
  );
  for (const inputChars of [defaults.inputChars, releaseSummaryLimitSettings.inputChars.min]) {
    const { text, titlesUsed } = releaseTitlesInput(titles, inputChars);
    assert.ok(text.length <= inputChars, `input is ${text.length} of ${inputChars} characters`);
    assert.ok(titlesUsed > 0 && titlesUsed < 500);
    // The newest titles are the ones kept.
    expect(text).toMatch(/commit 499 /);
    expect(text).not.toMatch(/commit 0 /);
    expect(text).toMatch(new RegExp(`the ${500 - titlesUsed} oldest left out`));
  }
});

test("release summary titles that fit are all sent, numbered oldest first", () => {
  expect(releaseTitlesInput(["Add panel", "Fix cache"], defaults.inputChars)).toStrictEqual({
    text: "Commit titles, oldest first:\n1. Add panel\n2. Fix cache",
    titlesUsed: 2,
  });
});

test("release summary limits come from Worker vars, within their bounds", () => {
  expect(defaults).toStrictEqual({ inputChars: 48_000, titleChars: 160 });
  expect(
    releaseSummaryLimits({
      RELEASE_SUMMARY_INPUT_CHARS: " 20000 ",
      RELEASE_SUMMARY_TITLE_CHARS: "80",
    }),
  ).toStrictEqual({ inputChars: 20_000, titleChars: 80 });
  // Out of bounds is clamped; anything but a whole number is ignored.
  expect(
    releaseSummaryLimits({
      RELEASE_SUMMARY_INPUT_CHARS: "999999999",
      RELEASE_SUMMARY_TITLE_CHARS: "1",
    }),
  ).toStrictEqual({ inputChars: 400_000, titleChars: 20 });
  expect(releaseSummaryLimits({ RELEASE_SUMMARY_INPUT_CHARS: "4.8e4" })).toStrictEqual(defaults);
});
