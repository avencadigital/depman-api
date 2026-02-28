import type { PackageVersionInfo } from "./types";

interface CacheStats {
	totalEntries: number;
	validEntries: number;
	expiredEntries: number;
	errorEntries: number;
	successEntries: number;
	maxSize: number;
}

interface CacheEntry {
	data: PackageVersionInfo;
	timestamp: number;
	expiresAt: number;
}

export class CacheService {
	private static instance: CacheService;
	private cache: Map<string, CacheEntry> = new Map();
	private readonly DEFAULT_TTL = 5 * 60 * 1000;
	private readonly ERROR_TTL = 30 * 1000;
	private readonly MAX_CACHE_SIZE = 500;
	private readonly CLEANUP_INTERVAL = 60 * 1000;
	private cleanupTimer?: ReturnType<typeof setInterval>;

	private constructor() {
		this.startCleanupTimer();
	}

	static getInstance(): CacheService {
		if (!CacheService.instance) {
			CacheService.instance = new CacheService();
		}
		return CacheService.instance;
	}

	private generateKey(packageName: string, packageManager: string): string {
		return `${packageManager}:${packageName.toLowerCase()}`;
	}

	get(packageName: string, packageManager: string): PackageVersionInfo | null {
		const key = this.generateKey(packageName, packageManager);
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}
		return entry.data;
	}

	set(
		packageName: string,
		packageManager: string,
		data: PackageVersionInfo,
	): void {
		const key = this.generateKey(packageName, packageManager);
		const now = Date.now();
		const ttl = data.error ? this.ERROR_TTL : this.DEFAULT_TTL;
		this.cache.set(key, { data, timestamp: now, expiresAt: now + ttl });
		this.enforceSizeLimit();
	}

	clear(): void {
		this.cache.clear();
	}

	getStats(): CacheStats {
		const now = Date.now();
		let validEntries = 0,
			expiredEntries = 0,
			errorEntries = 0,
			successEntries = 0;
		for (const [, entry] of this.cache) {
			if (now > entry.expiresAt) {
				expiredEntries++;
			} else {
				validEntries++;
				entry.data.error ? errorEntries++ : successEntries++;
			}
		}
		return {
			totalEntries: this.cache.size,
			validEntries,
			expiredEntries,
			errorEntries,
			successEntries,
			maxSize: this.MAX_CACHE_SIZE,
		};
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (now > entry.expiresAt) this.cache.delete(key);
		}
	}

	private enforceSizeLimit(): void {
		if (this.cache.size <= this.MAX_CACHE_SIZE) return;
		const entries = Array.from(this.cache.entries()).sort(
			(a, b) => a[1].timestamp - b[1].timestamp,
		);
		const toRemove = this.cache.size - this.MAX_CACHE_SIZE;
		for (let i = 0; i < toRemove; i++) this.cache.delete(entries[i][0]);
	}

	private startCleanupTimer(): void {
		this.cleanupTimer = setInterval(
			() => this.cleanup(),
			this.CLEANUP_INTERVAL,
		);
		if (this.cleanupTimer.unref) this.cleanupTimer.unref();
	}
}
