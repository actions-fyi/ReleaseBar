// The privacy policy: `/privacy`. The text is the static page public/privacy.html, the same for
// every deployment; who runs the deployment is not, and comes from its variables
// (docs/self-hosting.md): PRIVACY_CONTROLLER, PRIVACY_CONTACT and PRIVACY_AUTHORITY.

import { escapeHtml } from "./app-shell.ts";
import { canonicalDomain } from "./runtime.ts";
import { fetchAsset } from "./store/assets.ts";

export const privacyPath = "/privacy";
const privacyAssetPath = "/privacy.html";

export function isPrivacyPath(pathname: string): boolean {
  return pathname === privacyPath || pathname === privacyAssetPath;
}

// A plain email address: matches "privacy@example.com", rejects "see https://example.com/contact".
// https://regex101.com/?regex=%5E%5B%5E%5Cs%40%5D%2B%40%5B%5E%5Cs%40%5D%2B%5C.%5B%5E%5Cs%40%5D%2B%24&testString=privacy%40example.com
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function contactHtml(contact: string): string {
  const escaped = escapeHtml(contact);
  return emailAddress.test(contact) ? `<a href="mailto:${escaped}">${escaped}</a>` : escaped;
}

const incompleteNotice =
  '<p class="notice">The operator of this deployment has not yet named who is responsible for it or how to reach them. Until then this page describes what the software stores, and is not a complete privacy policy.</p>';

export async function privacyResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const asset = new URL(url);
  asset.pathname = privacyAssetPath;
  const response = await fetchAsset(env, new Request(asset, request));
  if (!response.ok) return response;
  const controller = env.PRIVACY_CONTROLLER?.trim() ?? "";
  const contact = env.PRIVACY_CONTACT?.trim() ?? "";
  const authority = env.PRIVACY_AUTHORITY?.trim() ?? "";
  const html = (await response.text())
    .replaceAll("{{domain}}", escapeHtml(canonicalDomain(env, url)))
    .replace("{{notice}}", controller && contact ? "" : incompleteNotice)
    .replace("{{controller}}", controller ? escapeHtml(controller) : "Not named yet.")
    .replace("{{contact}}", contact ? contactHtml(contact) : "not named yet.")
    .replace("{{authority}}", authority ? `, such as ${escapeHtml(authority)}` : "");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
