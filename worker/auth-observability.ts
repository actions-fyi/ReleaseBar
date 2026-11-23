import { slugOwner } from "../shared/dashboard.ts";
import type { AuthFunnelEvent, AuthFunnelSummary } from "../src/types.ts";
import { randomNonce } from "./crypto.ts";
import {
  appendAuthFunnelEvent,
  authFunnelCountInventory,
  listAuthFunnelEvents,
} from "./store/auth-funnel.ts";
import {
  listStoredInstallations,
  storedInstallationInventory,
  type StoredInstallationRecord,
  storedInstallationSchema,
} from "./store/installations.ts";

const authFunnelListLimit = 80;
const adminInstallationListLimit = 80;
const adminAuthCounterListLimit = 80;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { listStoredInstallations, type StoredInstallationRecord, storedInstallationSchema };

function authEventDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, " ").slice(0, 160);
}

export async function recordAuthFunnelEvent(
  env: Env,
  input: Omit<AuthFunnelEvent, "id" | "at">,
): Promise<void> {
  try {
    const item: AuthFunnelEvent = {
      id: randomNonce(),
      at: new Date().toISOString(),
      ...input,
      account: input.account ? slugOwner(input.account) : null,
      detail: authEventDetail(input.detail),
    };
    await appendAuthFunnelEvent(env, item);
  } catch (error) {
    console.warn(
      JSON.stringify({ area: "auth", event: "funnel_write_failed", error: errorMessage(error) }),
    );
  }
}

export async function authFunnelSummary(env: Env): Promise<AuthFunnelSummary> {
  const [installationInventory, events, countInventory] = await Promise.all([
    storedInstallationInventory(env, adminInstallationListLimit),
    listAuthFunnelEvents(env, authFunnelListLimit),
    authFunnelCountInventory(env, adminAuthCounterListLimit),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    installationCount: installationInventory.total,
    installations: installationInventory.installations,
    events,
    counterCount: countInventory.total,
    counts: countInventory.counts,
  };
}
