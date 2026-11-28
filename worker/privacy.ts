// The privacy policy: `/privacy`. The text is the static page public/privacy.html, the same for
// every deployment; who runs the deployment is not, and comes from its variables
// (docs/self-hosting.md): PRIVACY_CONTROLLER, PRIVACY_CONTACT and PRIVACY_AUTHORITY.
//
// The page's legal sections are one per region: the section of the region the request comes from
// is open and first, the others stay on the page, closed. Rights follow where someone lives, and
// the request's country is only a guess at that.
//
// A deployment with a policy of its own names it with PRIVACY_POLICY_URL: the footer links there
// and `/privacy` redirects to it. IMPRINT_URL adds a link to the operator's imprint. A deployment
// with neither a policy of its own nor a named operator is a development deployment, and the site
// says so on every page.

import { escapeHtml } from "./app-shell.ts";
import { redirectResponse } from "./http.ts";
import { canonicalDomain } from "./runtime.ts";
import { fetchAsset } from "./store/assets.ts";

export const privacyPath = "/privacy";
const privacyAssetPath = "/privacy.html";

export function isPrivacyPath(pathname: string): boolean {
  return pathname === privacyPath || pathname === privacyAssetPath;
}

// What the app shell tells the page about the deployment's legal links.
export type SiteLinks = {
  // The policy of the deployment's own, or `/privacy`.
  privacyUrl: string;
  imprintUrl: string | null;
  // No policy of its own and no named operator: not for public use.
  development: boolean;
};

// The value as an http(s) address. Null for anything else, such as a "javascript:" address.
function webAddress(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

function operatorNamed(env: Env): boolean {
  return Boolean(env.PRIVACY_CONTROLLER?.trim() && env.PRIVACY_CONTACT?.trim());
}

export function siteLinks(env: Env): SiteLinks {
  const ownPolicy = webAddress(env.PRIVACY_POLICY_URL);
  return {
    privacyUrl: ownPolicy ?? privacyPath,
    imprintUrl: webAddress(env.IMPRINT_URL),
    development: !ownPolicy && !operatorNamed(env),
  };
}

// A plain email address: matches "privacy@example.com", rejects "see https://example.com/contact".
// https://regex101.com/?regex=%5E%5B%5E%5Cs%40%5D%2B%40%5B%5E%5Cs%40%5D%2B%5C.%5B%5E%5Cs%40%5D%2B%24&testString=privacy%40example.com
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function contactHtml(contact: string): string {
  const escaped = escapeHtml(contact);
  return emailAddress.test(contact) ? `<a href="mailto:${escaped}">${escaped}</a>` : escaped;
}

export const developmentNotice =
  "Development deployment, not for public use: its operator has not published a privacy policy yet.";

const incompleteNotice = `<p class="notice">${developmentNotice} This page describes what the software stores, and is not a complete policy until the operator names who is responsible and how to reach them.</p>`;

// The regions the page has a legal section for.
export type PrivacyRegion = "eu" | "us" | "other";
const privacyRegions: PrivacyRegion[] = ["eu", "us", "other"];

// The countries of the EEA outside the EU, the United Kingdom and Switzerland: their law follows
// the GDPR, and Cloudflare's `isEUCountry` does not cover them.
const gdprCountriesOutsideEu = new Set(["IS", "LI", "NO", "GB", "CH"]);

const regionNotes: Record<PrivacyRegion, string> = {
  eu: "Your request appears to come from the EU, the EEA, the United Kingdom or Switzerland, so that section is shown first.",
  us: "Your request appears to come from the United States, so that section is shown first.",
  other: "The general section is shown first.",
};

// The region of the country Cloudflare reports for the request. "other" for every other country,
// and for a request without one, as in local development.
export function privacyRegion(request: Request): PrivacyRegion {
  const cf = (request as Request<unknown, IncomingRequestCfProperties>).cf;
  const country = typeof cf?.country === "string" ? cf.country.toUpperCase() : "";
  if (cf?.isEUCountry === "1" || gdprCountriesOutsideEu.has(country)) return "eu";
  return country === "US" ? "us" : "other";
}

export async function privacyResponse(request: Request, env: Env): Promise<Response> {
  const links = siteLinks(env);
  if (links.privacyUrl !== privacyPath) return redirectResponse(links.privacyUrl);
  const url = new URL(request.url);
  const asset = new URL(url);
  asset.pathname = privacyAssetPath;
  const response = await fetchAsset(env, new Request(asset, request));
  if (!response.ok) return response;
  const controller = env.PRIVACY_CONTROLLER?.trim() ?? "";
  const contact = env.PRIVACY_CONTACT?.trim() ?? "";
  const authority = env.PRIVACY_AUTHORITY?.trim() ?? "";
  const region = privacyRegion(request);
  let html = (await response.text())
    .replaceAll("{{domain}}", escapeHtml(canonicalDomain(env, url)))
    .replace("{{notice}}", links.development ? incompleteNotice : "")
    .replace("{{controller}}", controller ? escapeHtml(controller) : "Not named yet.")
    .replace("{{contact}}", contact ? contactHtml(contact) : "not named yet.")
    .replace("{{authority}}", authority ? `, such as ${escapeHtml(authority)}` : "")
    .replace("{{region}}", region)
    .replace("{{region-note}}", regionNotes[region]);
  for (const candidate of privacyRegions) {
    html = html.replace(`{{open-${candidate}}}`, candidate === region ? "open" : "");
  }
  // The page differs by the visitor's country: no shared cache may keep it.
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=300",
    },
  });
}
