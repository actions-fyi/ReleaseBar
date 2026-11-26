import { expect, test } from "vitest";
import policy from "../public/privacy.html?raw";
import { serveAssets, worker } from "./dashboard-test-harness.ts";

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

test("/privacy says so when the deployment names no operator", async () => {
  servePolicy();
  for (const path of ["/privacy", "/privacy.html"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`),
      { PRIVACY_CONTACT: "https://example.com/contact" },
      context,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<p class="notice">');
    expect(html).toContain('<p class="operator">Not named yet.</p>');
    // A contact that is no email address is text, not a link.
    expect(html).toContain("Privacy requests: https://example.com/contact");
    expect(html).toContain("complain to a data protection authority.");
    expect(html).not.toMatch(/\{\{|\}\}/);
  }
});
