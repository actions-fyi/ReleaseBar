import type { AuthFunnelSummary, GitHubAccessSummary, SchedulerAdminPayload } from "./types.ts";

export type AdminDashboardPayload = SchedulerAdminPayload & {
  githubAccess: GitHubAccessSummary;
  auth: AuthFunnelSummary;
};
