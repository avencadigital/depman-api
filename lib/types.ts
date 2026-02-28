export const PACKAGE_STATUS = {
	UP_TO_DATE: "up-to-date",
	OUTDATED: "outdated",
	ERROR: "error",
} as const;

export type PackageStatus =
	(typeof PACKAGE_STATUS)[keyof typeof PACKAGE_STATUS];

export interface VersionDiff {
	majorsBehind: number;
	minorsBehind: number;
	patchesBehind: number;
	hasBreakingChanges: boolean;
	urgency: "none" | "low" | "medium" | "high" | "critical";
}

export interface PackageMetadata {
	license?: string;
	repository?: string;
	deprecated?: string | boolean;
	lastPublished?: string;
	keywords?: string[];
}

export interface PackageInfo {
	name: string;
	currentVersion: string;
	latestVersion: string;
	status: PackageStatus;
	packageManager: "npm" | "pip" | "pub";
	description?: string;
	homepage?: string;
	error?: string;
	versionDiff?: VersionDiff;
	metadata?: PackageMetadata;
}

export interface PackageAnalysisSummary {
	total: number;
	upToDate: number;
	outdated: number;
	errors: number;
}

export interface PackageAnalysisResponse {
	packages: PackageInfo[];
	summary: PackageAnalysisSummary;
}

export interface PackageVersionInfo {
	name: string;
	latestVersion: string;
	description?: string;
	homepage?: string;
	error?: string;
	license?: string;
	repository?: string;
	deprecated?: string | boolean;
	lastPublished?: string;
	downloads?: number;
	keywords?: string[];
}

export type FileKind = "package.json" | "requirements.txt" | "pubspec.yaml";
export type PackageManager = "npm" | "pip" | "pub";

export interface ParsedDependencies {
	kind: FileKind;
	dependencies: Record<string, string>;
	devDependencies?: Record<string, string>;
	packageManager: PackageManager;
}

export interface DependencyParser {
	canParse(content: string, fileName?: string): boolean;
	parse(content: string): ParsedDependencies;
	getFileType(): FileKind;
	getPackageManager(): PackageManager;
}
