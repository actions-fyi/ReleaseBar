import { expect, test } from "vitest";
import { ownerActivityFromPath, ownerFromPath, repoFromPath } from "../src/routing.ts";
import { kvStore, worker } from "./dashboard-test-harness.ts";

test("page route parsers reject malformed percent encoding", () => {
  for (const invalid of ["%", "%GG", "%C0%AF", "%E0%A4%A"]) {
    expect(ownerFromPath(`/${invalid}`)).toBe(null);
    expect(repoFromPath(`/acme/${invalid}`)).toBe(null);
    expect(repoFromPath(`/-/${invalid}/project`)).toBe(null);
    expect(ownerActivityFromPath(`/${invalid}/activity`)).toBe(null);
    expect(ownerActivityFromPath(`/-/owners/${invalid}/activity`)).toBe(null);
  }
  expect(ownerFromPath("/%40Acme")).toBe("Acme");
  expect(repoFromPath("/acme/%70roject")?.fullName).toBe("acme/project");
  expect(ownerActivityFromPath("/%61cme/activity")?.owner).toBe("acme");
});

test("worker rejects malformed path encoding before storage or background work", async () => {
  const cache = kvStore();
  const env = {
    DASHBOARD_CACHE: {
      ...cache,
      get: async () => expect.unreachable("invalid paths must not read storage"),
    },
    ASSETS: { fetch: async () => expect.unreachable("invalid paths must not fetch assets") },
  };
  const context = { waitUntil: () => expect.unreachable("invalid paths must not schedule work") };
  const paths = [
    "/%",
    "/acme/%GG",
    "/-/acme/%E0%A4%A",
    "/%C0%AF/activity",
    "/api/%",
    "/api/%/activity",
    "/api/repos/acme/%",
    "/api/repos/%/project/activity",
    "/api/repos/acme/%/audience",
    "/api/users/%/trust",
    "/og/%.svg",
    "/og/%.png",
  ];
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request(`https://release.bar${path}`, { method }),
        env,
        context,
      );
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.json()).toStrictEqual({ error: "invalid path encoding" });
    }
  }
});
