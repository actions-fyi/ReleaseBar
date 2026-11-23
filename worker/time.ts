// The time of an ISO date string in milliseconds; 0 for a missing or invalid one.
export function safeIso(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
