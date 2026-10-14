import type { BunRequest } from "bun";
import { jsonError } from "../utils/response";
import { clientKey } from "./client-ip";

/**
 * The buckets a request can be counted against.
 *
 * A budget is only a budget if nothing else spends it. Keyed on the address
 * alone, every limit in the app shared one counter — so five `/api/*` reads
 * left the next signed-out form POST from that address over the auth budget,
 * and one cheap unauthenticated GET per attempt was enough to lock a whole
 * NAT out of signing in. The bucket name is half the key, so each budget is now
 * spent only by the requests it describes.
 *
 * Deliberately coarse. `auth` is reserved for the signed-out forms the CMS
 * renders (`/forms`, `/handoff`, and any future one) but no route spends it
 * today; keeping it one bucket means an attacker who can spread guesses over
 * several endpoints does not get several times the budget, and the limits
 * differ only in size, not in what they are protecting. `export` is its
 * own, much smaller bucket: one call reads the whole published site and the
 * media library, and `cms:pull` is a deliberate command, not a paging client.
 */
export type RateLimitBucket = "auth" | "api-read" | "api-write" | "export";

const requestLog = new Map<string, number[]>();

export function rateLimit(
  req: BunRequest,
  bucket: RateLimitBucket,
  maxRequests = 10,
  windowMs = 5000,
): Response | null {
  // A bucket name never contains ":", so no address can collide with another
  // bucket's entry — including an IPv6 address, which is all colons.
  const key = `${bucket}:${clientKey(req)}`;
  const now = Date.now();

  const timestamps = requestLog.get(key) || [];
  const recentRequests = timestamps.filter((t) => now - t < windowMs);

  if (recentRequests.length >= maxRequests) {
    // Seconds until the oldest request in the window ages out — the earliest
    // moment a retry can succeed. Clients that honour Retry-After back off
    // exactly that far instead of hammering, and crawlers stop counting the
    // 429 against the site.
    const oldest = recentRequests[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));

    return jsonError(
      429,
      "rate_limited",
      "Too many requests. Please slow down and try again shortly.",
      { headers: { "Retry-After": String(retryAfter) } },
    );
  }

  recentRequests.push(now);
  requestLog.set(key, recentRequests);

  return null;
}

export function cleanupRateLimitLog(maxAgeMs = 60000): void {
  const now = Date.now();
  for (const [key, timestamps] of requestLog.entries()) {
    const recent = timestamps.filter((t) => now - t < maxAgeMs);
    if (recent.length === 0) {
      requestLog.delete(key);
    } else {
      requestLog.set(key, recent);
    }
  }
}

export function clearRateLimitLog(): void {
  requestLog.clear();
}

setInterval(() => {
  cleanupRateLimitLog();
}, 300000);
