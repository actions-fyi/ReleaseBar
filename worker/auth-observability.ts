import { slugOwner } from "../shared/dashboard.ts";
import type { AuthFunnelEvent, AuthFunnelSummary } from "../src/types.ts";
import { randomNonce } from "./crypto.ts";
import {
  appendAuthFunnelEvents,
  authFunnelCountInventory,
  listAuthFunnelEvents,
} from "./store/auth-funnel.ts";
import { storedInstallationInventory } from "./store/installations.ts";

const authFunnelListLimit = 80;
const adminInstallationListLimit = 80;
const adminAuthCounterListLimit = 80;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authEventDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, " ").slice(0, 160);
}

// Records the events with one batch. A failure is logged, not thrown: the funnel is not worth
// failing a sign-in for.
export async function recordAuthFunnelEvents(
  env: Env,
  inputs: Array<Omit<AuthFunnelEvent, "id" | "at">>,
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await appendAuthFunnelEvents(
      env,
      inputs.map((input) => ({
        id: randomNonce(),
        at: new Date().toISOString(),
        ...input,
        account: input.account ? slugOwner(input.account) : null,
        detail: authEventDetail(input.detail),
      })),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        area: "auth",
        event: "funnel_write_failed",
        error: errorMessage(error),
      }),
    );
  }
}

export function recordAuthFunnelEvent(
  env: Env,
  input: Omit<AuthFunnelEvent, "id" | "at">,
): Promise<void> {
  return recordAuthFunnelEvents(env, [input]);
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
