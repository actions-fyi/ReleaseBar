import assert from "node:assert/strict";
import test from "node:test";
import { nextPatchTag, releaseDraftUrl } from "../../../src/release-draft.js";

const project = {
  owner: "acme",
  name: "widget",
  defaultBranch: "main",
  latestCommitSha: "abc123",
  version: "v1.4.2",
  compareUrl: "https://github.com/acme/widget/compare/v1.4.2...main",
  commitsSinceRelease: 3,
};
const summary = { state: "ready" as const, text: "Fixes sync." };

type DraftProject = Parameters<typeof releaseDraftUrl>[0];

function draft(overrides: Partial<DraftProject> = {}, text = summary.text): URL {
  const url = releaseDraftUrl({ ...project, ...overrides }, { ...summary, text });
  assert.ok(url);
  return new URL(url);
}

test("release draft suggests the next patch tag and keeps a v prefix", () => {
  assert.equal(nextPatchTag("v1.4.2"), "v1.4.3");
  assert.equal(nextPatchTag("1.4.9"), "1.4.10");
  const url = draft();
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/acme/widget/releases/new");
  assert.equal(url.searchParams.get("tag"), "v1.4.3");
  assert.equal(url.searchParams.get("title"), "v1.4.3");
  assert.equal(draft({ version: "1.4.2" }).searchParams.get("tag"), "1.4.3");
});

test("release draft omits tag and title for non-semver tags", () => {
  ["v1.4.2-beta.1", "2026.11", "release-7", ""].forEach((version) => {
    const url = draft({ version });
    assert.equal(url.searchParams.has("tag"), false);
    assert.equal(url.searchParams.has("title"), false);
  });
});

test("release draft targets the latest commit and falls back to the default branch", () => {
  assert.equal(draft().searchParams.get("target"), "abc123");
  assert.equal(draft({ latestCommitSha: null }).searchParams.get("target"), "main");
});

test("release draft body appends the changelog link only when there is one", () => {
  assert.equal(
    draft().searchParams.get("body"),
    "Fixes sync.\n\n**Full Changelog**: https://github.com/acme/widget/compare/v1.4.2...main",
  );
  assert.equal(draft({ compareUrl: null }).searchParams.get("body"), "Fixes sync.");
});

test("release draft encodes summary text", () => {
  const text = "Adds A & B.\nCloses #12; 100% + more?";
  const url = draft({ compareUrl: null }, text);
  assert.equal(url.searchParams.get("body"), text);
  assert.match(url.search, /body=Adds\+A\+%26\+B\.%0ACloses\+%2312/);
  assert.equal(url.hash, "");
});

test("release draft needs a ready summary and unreleased commits", () => {
  assert.equal(releaseDraftUrl(project, undefined), null);
  assert.equal(releaseDraftUrl(project, { state: "warming", text: null }), null);
  assert.equal(releaseDraftUrl(project, { state: "ready", text: "" }), null);
  assert.equal(releaseDraftUrl({ ...project, commitsSinceRelease: 0 }, summary), null);
  assert.equal(releaseDraftUrl({ ...project, commitsSinceRelease: null }, summary), null);
});
