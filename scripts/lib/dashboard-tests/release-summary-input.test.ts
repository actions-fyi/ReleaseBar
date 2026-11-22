import assert from "node:assert/strict";
import test from "node:test";
import { clipText, commitBody, releaseDeltaInput } from "../../../worker/release-summary.js";
import {
  releaseSummaryLimitSettings,
  releaseSummaryLimits,
} from "../../../worker/summary-limits.js";

const defaults = releaseSummaryLimits({});

test("commit bodies drop the title and closing trailers", () => {
  assert.equal(
    commitBody(
      "Fix cache\n\nKeys now include the model.\n\nSigned-off-by: A <a@example.com>",
      defaults.bodyChars,
    ),
    "Keys now include the model.",
  );
  assert.equal(commitBody("Fix cache", defaults.bodyChars), "");
  assert.equal(commitBody("Fix cache\n\nA body.", 0), "");
});

test("clipped text never ends inside a surrogate pair", () => {
  assert.equal(clipText("ab😀cd", 3), "ab…");
  assert.equal(clipText("abc", 3), "abc");
});

test("release summary input stays within its cap whatever the commits hold", () => {
  const huge = "x".repeat(200_000);
  const commits = Array.from({ length: 500 }, (_, index) => ({
    title: clipText(`commit ${index} ${huge}`, defaults.titleChars),
    body: commitBody(`t\n\n${huge}`, defaults.bodyChars),
  }));
  for (const inputChars of [defaults.inputChars, releaseSummaryLimitSettings.inputChars.min]) {
    const { text, commitsUsed } = releaseDeltaInput(commits, inputChars);
    assert.ok(text.length <= inputChars, `input is ${text.length} of ${inputChars} characters`);
    assert.ok(commitsUsed > 0 && commitsUsed < 500);
    // The newest commits are the ones kept.
    assert.match(text, /commit 499 /);
    assert.doesNotMatch(text, /commit 0 /);
    assert.match(text, /the \d+ oldest left out/);
  }
});

test("release summary limits come from Worker vars, within their bounds", () => {
  assert.deepEqual(defaults, { inputChars: 48_000, titleChars: 160, bodyChars: 1_000 });
  assert.deepEqual(
    releaseSummaryLimits({
      RELEASE_SUMMARY_INPUT_CHARS: " 20000 ",
      RELEASE_SUMMARY_TITLE_CHARS: "80",
      RELEASE_SUMMARY_BODY_CHARS: "0",
    }),
    { inputChars: 20_000, titleChars: 80, bodyChars: 0 },
  );
  // Out of bounds is clamped; anything but a whole number is ignored.
  assert.deepEqual(
    releaseSummaryLimits({
      RELEASE_SUMMARY_INPUT_CHARS: "999999999",
      RELEASE_SUMMARY_TITLE_CHARS: "1",
      RELEASE_SUMMARY_BODY_CHARS: "-5",
    }),
    { inputChars: 400_000, titleChars: 20, bodyChars: 1_000 },
  );
  assert.deepEqual(releaseSummaryLimits({ RELEASE_SUMMARY_INPUT_CHARS: "4.8e4" }), defaults);
});
