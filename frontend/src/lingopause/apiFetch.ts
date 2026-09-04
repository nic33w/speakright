// apiFetch.ts
// fetch with a deadline, for LingoPause.
//
// Every request here can hang: ingest waits on YouTube, lesson audio waits on
// Azure, and a stopped or wedged backend never answers at all. Plain `fetch` has
// no timeout, so any of those leaves the UI sitting on "Reading the video…"
// forever with nothing to act on — which is exactly the failure that motivated
// this. A deadline turns silence into a message.
//
// Local to LingoPause on purpose: giving every mode a request timeout is a
// worthwhile change, but a much wider one than this file.

export class ApiTimeout extends Error {
  constructor(ms: number) {
    super(`The server didn't respond within ${Math.round(ms / 1000)}s.`);
    this.name = "ApiTimeout";
  }
}

// Ingest and lesson audio are genuinely slow (yt-dlp metadata + caption fetch;
// Azure synthesis per language run), so the default is generous. It exists to
// catch "never coming back", not to police latency.
export const DEFAULT_TIMEOUT_MS = 90_000;

export async function apiFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiTimeout(timeoutMs);
    }
    // A connection refused / DNS failure reaches here as a bare TypeError, whose
    // message ("Failed to fetch") tells the learner nothing actionable.
    throw new Error(
      "Couldn't reach the backend — check it's running on the expected port.",
    );
  } finally {
    window.clearTimeout(timer);
  }
}

/** Message for a caught error, preferring the server's own `detail`. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
