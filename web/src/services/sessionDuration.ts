export function formatSessionDuration(startISO: string | undefined, endISO: string | undefined): string {
  const start = Date.parse(startISO || "");
  const end = Date.parse(endISO || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "";
  }

  const seconds = Math.floor((end - start) / 1000);
  if (seconds <= 0) {
    return "";
  }
  if (seconds <= 100) {
    return `(${seconds}s)`;
  }
  return `(${Math.floor(seconds / 60)}m)`;
}
