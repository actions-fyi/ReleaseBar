// Scopes the Durable Object bindings to the deployment's jurisdiction. Every other module of
// worker/store/ takes the env a handler has passed through `withLockJurisdiction`.

type DurableObjectBinding = {
  [Name in keyof Env]-?: Env[Name] extends Pick<DurableObjectNamespace, "idFromName">
    ? Name
    : never;
}[keyof Env];

// Every Durable Object binding of wrangler.jsonc: the type fails when one is missing here.
const durableObjectBindingNames: Record<DurableObjectBinding, true> = {
  BUILD_COORDINATOR: true,
  OWNER_METADATA: true,
  RATE_LIMITER: true,
  REFRESH_TARGET_INDEX: true,
  SUMMARY_QUOTA: true,
  WEBHOOK_ADMISSION: true,
  WEBHOOK_PROCESSOR: true,
};
export const durableObjectBindings = Object.keys(
  durableObjectBindingNames,
) as DurableObjectBinding[];

const jurisdictionEnvs = new WeakMap<Env, { jurisdiction: string; scoped: Env }>();

// Scopes every Durable Object binding to the jurisdiction in RELEASEBAR_DO_JURISDICTION (such as
// "eu"), so every Durable Object is created and stored only there. Unset, the bindings are used
// as they are. Each handler passes its env through here before anything uses a binding, and so
// does each Durable Object whose work reaches another object: an object's own env is the raw one.
export function withLockJurisdiction(env: Env): Env {
  const jurisdiction = env.RELEASEBAR_DO_JURISDICTION?.trim();
  if (!jurisdiction) return env;
  const known = jurisdictionEnvs.get(env);
  if (known?.jurisdiction === jurisdiction) return known.scoped;
  const scoped: Env = { ...env };
  for (const binding of durableObjectBindings) {
    const namespace: DurableObjectNamespace = env[binding];
    if (typeof namespace.jurisdiction !== "function") {
      throw new Error(`RELEASEBAR_DO_JURISDICTION is set, but ${binding} has no jurisdictions`);
    }
    Object.assign(scoped, {
      [binding]: namespace.jurisdiction(jurisdiction as DurableObjectJurisdiction),
    });
  }
  jurisdictionEnvs.set(env, { jurisdiction, scoped });
  return scoped;
}
