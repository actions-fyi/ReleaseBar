import { expect, test } from "vitest";
import { assetResponse } from "../worker/app-shell.ts";
import { canonicalDomain } from "../worker/runtime.ts";
import { socialSvg } from "../worker/social-card.ts";

const shell =
  '<title>ReleaseBar</title><link rel="canonical" href="https://releasebar.invalid/" /><meta name="releasebar:canonical-domain" content="" /><script type="module" src="/assets/index.js"></script>';

function shellEnv(domain?: string): Env {
  return {
    ...(domain === undefined ? {} : { RELEASEDECK_CANONICAL_DOMAIN: domain }),
    ASSETS: {
      fetch: async () => new Response(shell, { headers: { "content-type": "text/html" } }),
    },
  } as unknown as Env;
}

test("canonical domain comes from the Worker var, else the request host", () => {
  const url = new URL("https://preview.example.dev/openclaw");
  expect(canonicalDomain({} as Env, url)).toBe("preview.example.dev");
  expect(canonicalDomain({} as Env)).toBe("localhost");
  expect(
    canonicalDomain(
      { RELEASEDECK_CANONICAL_DOMAIN: " https://releasebar.example.com/ " } as Env,
      url,
    ),
  ).toBe("releasebar.example.com");
  expect(canonicalDomain({ RELEASEDECK_CANONICAL_DOMAIN: "" } as Env, url)).toBe(
    "preview.example.dev",
  );
});

test("app shell carries the configured canonical domain to the page", async () => {
  const response = await assetResponse(
    new Request("https://preview.example.dev/openclaw"),
    shellEnv("releasebar.example.com"),
  );
  const html = await response.text();
  expect(html).toMatch(/<title>[^<]*@openclaw · releasebar\.example\.com<\/title>/);
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/releasebar\.example\.com\/" \/>/);
  expect(html).toMatch(
    /<meta name="releasebar:canonical-domain" content="releasebar\.example\.com" \/>/,
  );
  expect(html).not.toMatch(/releasebar\.invalid/);
});

test("app shell falls back to the request host without a configured domain", async () => {
  const response = await assetResponse(new Request("https://preview.example.dev/"), shellEnv());
  const html = await response.text();
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/preview\.example\.dev\/" \/>/);
  expect(html).toMatch(
    /<meta name="releasebar:canonical-domain" content="preview\.example\.dev" \/>/,
  );
});

test("social cards print the canonical domain", async () => {
  const svg = await socialSvg({
    title: "@openclaw",
    avatarUrl: null,
    detail: "Open source release freshness",
    metric: "3 repos",
    domain: "releasebar.example.com",
  });
  expect(svg).toMatch(/>releasebar\.example\.com<\/text>/);
});
