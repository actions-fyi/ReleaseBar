import type { DashboardProfile, Owner } from "../src/types.ts";
import { dashboardSubtitle } from "./app-shell.ts";
import type { DashboardRequest, RequestToken } from "./config.ts";
import { hydrationOptionsFromUrl } from "./dashboard-cache.ts";

export function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    profile,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
    includeReleaseData,
    ...hydrationOptionsFromUrl(url),
    ...(token
      ? {
          token: token.token,
          quotaSource: token.quotaSource,
          quotaAccount: token.quotaAccount,
        }
      : {}),
  };
}

export function webhookHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
