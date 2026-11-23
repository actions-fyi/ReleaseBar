import assert from "node:assert/strict";
import test from "node:test";
import { assetResponse } from "../../../worker/app-shell.js";
import { canonicalDomain } from "../../../worker/runtime.js";
import { socialSvg } from "../../../worker/social-card.js";

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
  assert.equal(canonicalDomain({} as Env, url), "preview.example.dev");
  assert.equal(canonicalDomain({} as Env), "localhost");
  assert.equal(
    canonicalDomain(
      { RELEASEDECK_CANONICAL_DOMAIN: " https://releasebar.example.com/ " } as Env,
      url,
    ),
    "releasebar.example.com",
  );
  assert.equal(
    canonicalDomain({ RELEASEDECK_CANONICAL_DOMAIN: "" } as Env, url),
    "preview.example.dev",
  );
});

test("app shell carries the configured canonical domain to the page", async () => {
  const response = await assetResponse(
    new Request("https://preview.example.dev/openclaw"),
    shellEnv("releasebar.example.com"),
  );
  const html = await response.text();
  assert.match(html, /<title>[^<]*@openclaw · releasebar\.example\.com<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/releasebar\.example\.com\/" \/>/);
  assert.match(
    html,
    /<meta name="releasebar:canonical-domain" content="releasebar\.example\.com" \/>/,
  );
  assert.doesNotMatch(html, /releasebar\.invalid/);
});

test("app shell falls back to the request host without a configured domain", async () => {
  const response = await assetResponse(new Request("https://preview.example.dev/"), shellEnv());
  const html = await response.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/preview\.example\.dev\/" \/>/);
  assert.match(
    html,
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
  assert.match(svg, />releasebar\.example\.com<\/text>/);
});
