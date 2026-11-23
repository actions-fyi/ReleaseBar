import { assert, expect, test } from "vitest";
import type { RepoDetailPayload } from "../../../src/types.js";
import { kvStore, socialRenderAsset, testProject, worker } from "../dashboard-test-harness.js";

test("worker social cards include owner avatars and repository release metrics", async () => {
  const generatedAt = new Date().toISOString();
  const repoPayload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      description: "Release freshness for maintainers",
      version: "v2.0.0",
      commitsSinceRelease: 42,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "repo-detail:v4:acme/releasebar": JSON.stringify(repoPayload),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && ["/acme.png", "/openclaw.png"].includes(url.pathname)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };

  try {
    const repoResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.svg"),
      env,
      { waitUntil: () => undefined },
    );
    expect(repoResponse.status).toBe(200);
    const repoSvg = await repoResponse.text();
    expect(repoSvg).toMatch(/acme\/releasebar/);
    expect(repoSvg).toMatch(/v2\.0\.0 · 42 commits since release/);
    expect(repoSvg).toMatch(/data:image\/png;base64,AQID/);
    expect(repoSvg).not.toMatch(/https:\/\/github\.com\/acme\.png\?size=240/);

    const ownerResponse = await worker.fetch(
      new Request("https://release.bar/og/openclaw.svg"),
      env,
      { waitUntil: () => undefined },
    );
    const ownerSvg = await ownerResponse.text();
    expect(ownerSvg).toMatch(/@openclaw/);
    expect(ownerSvg).toMatch(/data:image\/png;base64,AQID/);
    expect(ownerSvg).not.toMatch(/https:\/\/github\.com\/openclaw\.png\?size=240/);

    const pngAssetPaths: string[] = [];
    const pngResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.png"),
      {
        ...env,
        ASSETS: {
          fetch: (request: Request) => socialRenderAsset(request, pngAssetPaths),
        },
      },
      { waitUntil: () => undefined },
    );
    expect(pngResponse.status).toBe(200);
    expect(pngResponse.headers.get("content-type")).toBe("image/png");
    const pngBytes = new Uint8Array(await pngResponse.arrayBuffer());
    expect(Array.from(pngBytes.slice(0, 8))).toStrictEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(pngBytes.byteLength > 1_000);
    expect(pngAssetPaths).toStrictEqual([
      "/resvg.wasm",
      "/jetbrains-mono-latin-400-normal.woff2",
      "/jetbrains-mono-latin-700-normal.woff2",
    ]);
    expect(pngAssetPaths[0]).not.toBe("/og-card.png");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const coldStore = kvStore();
  const coldCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/cold.png") {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/png" },
      });
    }
    coldCalls.push(url.pathname);
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer shared-token");
    if (url.pathname === "/repos/cold/repo") {
      return Response.json({
        owner: { login: "cold" },
        name: "repo",
        full_name: "cold/repo",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/cold/repo",
        description: "Cold social repository",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/repos/cold/repo/releases") {
      return Response.json([
        {
          tag_name: "v3.0.0",
          name: "v3",
          html_url: "https://github.com/cold/repo/releases/tag/v3.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-16T12:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/repos/cold/repo/compare/v3.0.0...main") {
      return Response.json({
        total_commits: 9,
        html_url: "https://github.com/cold/repo/compare/v3.0.0...main",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/og/cold%2Frepo.svg"),
      { DASHBOARD_CACHE: coldStore, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const coldSvg = await coldResponse.text();
    expect(coldSvg).toMatch(/v3\.0\.0 · 9 commits since release/);
    expect(coldSvg).toMatch(/data:image\/png;base64,BAUG/);
    expect(coldCalls).toStrictEqual([
      "/repos/cold/repo",
      "/repos/cold/repo/releases",
      "/repos/cold/repo/compare/v3.0.0...main",
    ]);
    expect(await coldStore.get("social-repo:v3:cold/repo")).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stalePayload: RepoDetailPayload = {
    ...repoPayload,
    fullName: "stale/repo",
    generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    project: testProject({
      owner: "stale",
      name: "repo",
      version: "v9.9.9",
      commitsSinceRelease: 7,
    }),
  };
  const queued: Promise<unknown>[] = [];
  let backgroundCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/stale.png") {
      return new Response("not an image", { headers: { "content-type": "text/plain" } });
    }
    backgroundCalls += 1;
    throw new Error("queued refresh only");
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/og/stale%2Frepo.svg"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:stale/repo": JSON.stringify(stalePayload),
        }),
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    const staleSvg = await staleResponse.text();
    expect(staleSvg).toMatch(/v9\.9\.9 · 7 commits since release/);
    expect(staleSvg).toMatch(/>SR<\/text>/);
    expect(queued.length).toBe(1);
    await Promise.all(queued);
    expect(backgroundCalls > 0).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
