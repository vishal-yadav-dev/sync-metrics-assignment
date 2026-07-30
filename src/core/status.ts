// THE allow-list. Nothing outside this file may know status words.
const COLLECTED_STATUSES = new Set(["paid", "succeeded", "completed"]);

// Allow-list, not exclusion: unknown or new status words return false (fail-closed).
export function isCollected(statusRaw: string | null): boolean {
  return statusRaw != null && COLLECTED_STATUSES.has(statusRaw.toLowerCase());
}

// For SQL filters, so the words are never written a second time in a query string.
export function collectedStatuses(): string[] {
  return [...COLLECTED_STATUSES];
}
