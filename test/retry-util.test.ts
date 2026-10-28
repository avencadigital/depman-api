import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError, retryWithBackoff } from "@/lib/retry-util";

function httpError(status: number) {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("isRetryableError", () => {
	it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i", (status) => {
		expect(isRetryableError(httpError(status))).toBe(true);
	});

	it.each([400, 401, 403, 404, 422])("does not retry HTTP %i", (status) => {
		expect(isRetryableError(httpError(status))).toBe(false);
	});

	it("retries timeouts and network failures", () => {
		const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
		expect(isRetryableError(abort)).toBe(true);
		expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
	});

	it("does not retry other errors", () => {
		expect(isRetryableError(new Error("boom"))).toBe(false);
		expect(isRetryableError(undefined)).toBe(false);
	});
});

describe("retryWithBackoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the first successful result", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(httpError(503))
			.mockResolvedValueOnce("ok");
		const promise = retryWithBackoff(fn, {
			initialDelay: 100,
			useJitter: false,
			shouldRetry: isRetryableError,
		});
		await vi.advanceTimersByTimeAsync(100);
		await expect(promise).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("waits with exponential backoff capped at maxDelay", async () => {
		const delays: number[] = [];
		const fn = vi.fn().mockRejectedValue(httpError(503));
		const promise = retryWithBackoff(fn, {
			maxAttempts: 4,
			initialDelay: 100,
			backoffFactor: 2,
			maxDelay: 300,
			useJitter: false,
			onRetry: (_error, _attempt, delay) => delays.push(delay),
		});
		const assertion = expect(promise).rejects.toMatchObject({ status: 503 });
		await vi.runAllTimersAsync();
		await assertion;
		expect(delays).toEqual([100, 200, 300]);
		expect(fn).toHaveBeenCalledTimes(4);
	});

	it("does not retry when shouldRetry says no", async () => {
		const fn = vi.fn().mockRejectedValue(httpError(404));
		await expect(
			retryWithBackoff(fn, { shouldRetry: isRetryableError }),
		).rejects.toMatchObject({ status: 404 });
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
