import {
	MCP_RATE_LIMIT_MAX_REQUESTS,
	RATE_LIMIT_MAX_REQUESTS,
	RATE_LIMIT_MAX_TRACKED_KEYS,
	RATE_LIMIT_WINDOW_MS,
} from "./constants";

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

// Fixed-window limiter, per key (typically client IP). In-memory and
// per-instance: on a multi-instance deployment each instance enforces its
// own window, same limitation the CacheService already has.
export class RateLimiter {
	private hits = new Map<string, RateLimitEntry>();

	constructor(
		private readonly maxRequests: number = RATE_LIMIT_MAX_REQUESTS,
		private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
	) {}

	check(key: string): RateLimitResult {
		const now = Date.now();
		const entry = this.hits.get(key);

		if (!entry || now > entry.resetAt) {
			this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
			this.enforceSizeLimit();
			return { allowed: true, retryAfterSeconds: 0 };
		}

		if (entry.count >= this.maxRequests) {
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
			};
		}

		entry.count++;
		return { allowed: true, retryAfterSeconds: 0 };
	}

	private enforceSizeLimit(): void {
		if (this.hits.size <= RATE_LIMIT_MAX_TRACKED_KEYS) return;
		const now = Date.now();
		for (const [key, entry] of this.hits) {
			if (now > entry.resetAt) this.hits.delete(key);
		}
	}
}

export const rateLimiter = new RateLimiter();

// MCP clients send several JSON-RPC requests per tool call (initialize,
// tools/list, tools/call), and ChatGPT traffic arrives from shared egress
// IPs, so /mcp gets its own, larger budget instead of sharing the REST one.
export const mcpRateLimiter = new RateLimiter(MCP_RATE_LIMIT_MAX_REQUESTS);

export function getClientKey(headers: {
	get(name: string): string | null;
}): string {
	const forwardedFor = headers.get("x-forwarded-for");
	if (forwardedFor) return forwardedFor.split(",")[0].trim();
	return headers.get("x-real-ip") ?? "unknown";
}
