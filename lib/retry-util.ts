export interface RetryOptions {
	maxAttempts?: number;
	initialDelay?: number;
	maxDelay?: number;
	backoffFactor?: number;
	useJitter?: boolean;
	shouldRetry?: (error: unknown, attempt: number) => boolean;
	onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
	maxAttempts: 3,
	initialDelay: 1000,
	maxDelay: 10000,
	backoffFactor: 2,
	useJitter: true,
	shouldRetry: () => true,
	onRetry: () => {},
};

function calculateDelay(
	attempt: number,
	initialDelay: number,
	backoffFactor: number,
	maxDelay: number,
	useJitter: boolean,
): number {
	let delay = initialDelay * backoffFactor ** (attempt - 1);
	delay = Math.min(delay, maxDelay);
	if (useJitter) delay += Math.random() * delay * 0.25;
	return Math.floor(delay);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableError(error: unknown): boolean {
	if (!error) return false;
	if (error instanceof Error) {
		if (error.name === "AbortError") return false;
		if (error.name === "TypeError" && error.message.includes("fetch"))
			return true;
	}
	const err = error as Record<string, unknown>;
	const retryableStatuses = [408, 429, 500, 502, 503, 504];
	if (typeof err.status === "number")
		return retryableStatuses.includes(err.status);
	const response = err.response as Record<string, unknown> | undefined;
	if (typeof response?.status === "number")
		return retryableStatuses.includes(response.status);
	return false;
}

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	let lastError: unknown;

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			const isLastAttempt = attempt === opts.maxAttempts;
			if (isLastAttempt || !opts.shouldRetry(error, attempt)) throw error;
			const delay = calculateDelay(
				attempt,
				opts.initialDelay,
				opts.backoffFactor,
				opts.maxDelay,
				opts.useJitter,
			);
			opts.onRetry(error, attempt, delay);
			await sleep(delay);
		}
	}
	throw lastError;
}

export const RetryPresets = {
	standard: {
		maxAttempts: 3,
		initialDelay: 1000,
		maxDelay: 10000,
		shouldRetry: isRetryableError,
	} as RetryOptions,
};
