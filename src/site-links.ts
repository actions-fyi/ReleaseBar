// The deployment's legal links, which the Worker writes into meta tags of the app shell
// (worker/privacy.ts).

export type SiteLinks = {
  // The deployment's own policy, or the built-in page at /privacy.
  privacyUrl: string;
  // Null when the deployment names no imprint.
  imprintUrl: string | null;
  // The deployment has no policy of its own and names no operator: not for public use.
  development: boolean;
};

function metaContent(name: string): string {
  return (
    document.querySelector(`meta[name="releasebar:${name}"]`)?.getAttribute("content")?.trim() ?? ""
  );
}

export function siteLinks(): SiteLinks {
  return {
    privacyUrl: metaContent("privacy-url") || "/privacy",
    imprintUrl: metaContent("imprint-url") || null,
    development: metaContent("development") === "true",
  };
}

// Whether the link leaves the site, and so opens in a new tab.
export function externalLink(url: string): boolean {
  return !url.startsWith("/");
}
