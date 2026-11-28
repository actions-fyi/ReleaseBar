import { expect, test } from "vitest";
import policy from "../public/privacy.html?raw";
import { assetResponse } from "../worker/app-shell.ts";
import { serveAssets, testEnv, worker } from "./dashboard-test-harness.ts";

const context = { waitUntil: () => undefined };

function servePolicy(): string[] {
  const paths: string[] = [];
  serveAssets((request) => {
    paths.push(new URL(request.url).pathname);
    return new Response(policy, { headers: { "content-type": "text/html" } });
  });
  return paths;
}

test("/privacy serves the policy with the deployment's operator", async () => {
  const paths = servePolicy();
  const response = await worker.fetch(
    new Request("https://release.bar/privacy"),
    {
      RELEASEDECK_CANONICAL_DOMAIN: "release.bar",
      PRIVACY_CONTROLLER: "Example <Org> GmbH\nMain Street 1, 10115 Berlin",
      PRIVACY_CONTACT: "privacy@example.com",
      PRIVACY_AUTHORITY: "the Berlin Commissioner for Data Protection",
    },
    context,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(paths).toStrictEqual(["/privacy.html"]);
  const html = await response.text();
  expect(html).toContain("<title>Privacy policy · release.bar</title>");
  expect(html).toContain("Example &lt;Org&gt; GmbH\nMain Street 1, 10115 Berlin");
  expect(html).toContain('<a href="mailto:privacy@example.com">privacy@example.com</a>');
  expect(html).toContain("authority, such as the Berlin Commissioner for Data Protection.");
  expect(html).not.toContain('class="notice"');
  // Every placeholder of the page is filled.
  expect(html).not.toMatch(/\{\{|\}\}/);
});

test("/privacy says that a deployment without a named operator is not for public use", async () => {
  servePolicy();
  for (const path of ["/privacy", "/privacy.html"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`),
      { PRIVACY_CONTACT: "https://example.com/contact" },
      context,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<p class="notice">Development deployment, not for public use');
    expect(html).toContain('<p class="operator">Not named yet.</p>');
    // A contact that is no email address is text, not a link.
    expect(html).toContain("Privacy requests: https://example.com/contact");
    expect(html).toContain("data protection authority.");
    expect(html).not.toMatch(/\{\{|\}\}/);
  }
});

test("/privacy redirects to the policy of the deployment's own", async () => {
  const paths = servePolicy();
  const response = await worker.fetch(
    new Request("https://release.bar/privacy"),
    { PRIVACY_POLICY_URL: "https://example.com/legal/privacy" },
    context,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://example.com/legal/privacy");
  expect(paths).toStrictEqual([]);

  // An address that is not http(s) is no policy: the built-in page is served.
  const builtIn = await worker.fetch(
    new Request("https://release.bar/privacy"),
    { PRIVACY_POLICY_URL: "javascript:alert(1)" },
    context,
  );
  expect(builtIn.status).toBe(200);
});

const shell =
  '<title>ReleaseBar</title><meta name="releasebar:privacy-url" content="/privacy" /><meta name="releasebar:imprint-url" content="" /><meta name="releasebar:development" content="" />';

async function shellMetas(vars: Partial<Env>): Promise<Record<string, string>> {
  serveAssets(async () => new Response(shell, { headers: { "content-type": "text/html" } }));
  const response = await assetResponse(new Request("https://release.bar/openclaw"), testEnv(vars));
  const html = await response.text();
  return Object.fromEntries(
    ["privacy-url", "imprint-url", "development"].map((name) => [
      name,
      html.split(`<meta name="releasebar:${name}" content="`)[1]?.split('"')[0] ?? "missing",
    ]),
  );
}

test("the app shell tells the page the deployment's legal links", async () => {
  // Nothing configured: the built-in page, and a development deployment.
  expect(await shellMetas({})).toStrictEqual({
    "privacy-url": "/privacy",
    "imprint-url": "",
    development: "true",
  });
  // A named operator: the built-in page is the policy.
  expect(
    await shellMetas({
      PRIVACY_CONTROLLER: "Example GmbH",
      PRIVACY_CONTACT: "privacy@example.com",
      IMPRINT_URL: "https://example.com/imprint",
    }),
  ).toStrictEqual({
    "privacy-url": "/privacy",
    "imprint-url": "https://example.com/imprint",
    development: "",
  });
  // A policy of its own, in place of the built-in page.
  expect(
    await shellMetas({
      PRIVACY_POLICY_URL: "https://example.com/privacy?lang=en&v=2",
      IMPRINT_URL: "not an address",
    }),
  ).toStrictEqual({
    "privacy-url": "https://example.com/privacy?lang=en&amp;v=2",
    "imprint-url": "",
    development: "",
  });
  // The operator needs both a name and a contact.
  expect((await shellMetas({ PRIVACY_CONTROLLER: "Example GmbH" })).development).toBe("true");
});

function requestFrom(cf: Record<string, unknown> | null): Request {
  const request = new Request("https://release.bar/privacy");
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

test("/privacy opens the legal section of the visitor's region and keeps the others", async () => {
  servePolicy();
  const cases: Array<[cf: Record<string, unknown> | null, region: string]> = [
    [{ country: "DE", isEUCountry: "1" }, "eu"],
    // Outside the EU, under the GDPR or a law that follows it.
    [{ country: "NO" }, "eu"],
    [{ country: "GB" }, "eu"],
    [{ country: "CH" }, "eu"],
    [{ country: "US", regionCode: "CA" }, "us"],
    [{ country: "JP" }, "other"],
    // No country, as in local development.
    [{}, "other"],
    [null, "other"],
  ];
  for (const [cf, region] of cases) {
    const response = await worker.fetch(requestFrom(cf), {}, context);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const html = await response.text();
    expect(html).toContain(`<div class="regions" data-region="${region}">`);
    // Every region's section is on the page; only the visitor's is open.
    const open = ["eu", "us", "other"].filter((candidate) =>
      new RegExp(`<details id="rights-${candidate}" open\\s*>`).test(html),
    );
    expect(open).toStrictEqual([region]);
    expect(html.match(/<details id="rights-/g)?.length).toBe(3);
    expect(html).not.toMatch(/\{\{|\}\}/);
  }
  const fromUs = await (await worker.fetch(requestFrom({ country: "US" }), {}, context)).text();
  expect(fromUs).toContain("Your request appears to come from the United States");
});
