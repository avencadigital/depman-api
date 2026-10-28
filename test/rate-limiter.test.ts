import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientKey, RateLimiter } from "@/lib/rate-limiter";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("getClientKey", () => {
	it("uses the first X-Forwarded-For entry by default", () => {
		const headers = new Headers({
			"x-forwarded-for": "203.0.113.1, 10.0.0.1",
			"cf-connecting-ip": "198.51.100.9",
		});
		expect(getClientKey(headers)).toBe("203.0.113.1");
	});

	it("falls back to X-Real-IP, then to a shared key", () => {
		expect(getClientKey(new Headers({ "x-real-ip": "203.0.113.2" }))).toBe(
			"203.0.113.2",
		);
		expect(getClientKey(new Headers())).toBe("unknown");
	});

	it("prefers the header named by CLIENT_IP_HEADER", () => {
		vi.stubEnv("CLIENT_IP_HEADER", "CF-Connecting-IP");
		const headers = new Headers({
			"x-forwarded-for": "203.0.113.1",
			"cf-connecting-ip": "198.51.100.9",
		});
		expect(getClientKey(headers)).toBe("198.51.100.9");
	});

	it("falls back to X-Forwarded-For when the configured header is missing", () => {
		vi.stubEnv("CLIENT_IP_HEADER", "cf-connecting-ip");
		expect(
			getClientKey(new Headers({ "x-forwarded-for": "203.0.113.1" })),
		).toBe("203.0.113.1");
	});
});

describe("RateLimiter", () => {
	it("allows maxRequests per window, then reports Retry-After", () => {
		vi.useFakeTimers();
		try {
			const limiter = new RateLimiter(2, 10_000);
			expect(limiter.check("a").allowed).toBe(true);
			expect(limiter.check("a").allowed).toBe(true);
			const blocked = limiter.check("a");
			expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 10 });
			expect(limiter.check("b").allowed).toBe(true);
			vi.advanceTimersByTime(10_001);
			expect(limiter.check("a").allowed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
