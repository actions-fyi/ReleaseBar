import assert from "node:assert/strict";
import test from "node:test";
import { releaseSummaryInputChars } from "../../../worker/config.js";
import { clipText, commitBody, releaseDeltaInput } from "../../../worker/release-summary.js";

test("commit bodies drop the title and closing trailers", () => {
  assert.equal(
    commitBody("Fix cache\n\nKeys now include the model.\n\nSigned-off-by: A <a@example.com>"),
    "Keys now include the model.",
  );
  assert.equal(commitBody("Fix cache"), "");
});

test("clipped text never ends inside a surrogate pair", () => {
  assert.equal(clipText("ab😀cd", 3), "ab…");
  assert.equal(clipText("abc", 3), "abc");
});

test("release summary input stays within its cap whatever the commits hold", () => {
  const huge = "x".repeat(200_000);
  const commits = Array.from({ length: 500 }, (_, index) => ({
    title: clipText(`commit ${index} ${huge}`, 160),
    body: commitBody(`t\n\n${huge}`),
  }));
  const { text, commitsUsed } = releaseDeltaInput(commits);
  assert.ok(text.length <= releaseSummaryInputChars, `input is ${text.length} characters`);
  assert.ok(commitsUsed > 0 && commitsUsed < 500);
  // The newest commits are the ones kept.
  assert.match(text, /commit 499 /);
  assert.doesNotMatch(text, /commit 0 /);
  assert.match(text, /the \d+ oldest left out/);
});
