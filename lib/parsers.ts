import yaml from "js-yaml";
import type { DependencyParser, FileKind, ParsedDependencies } from "./types";

class PackageJsonParser implements DependencyParser {
	getFileType(): FileKind {
		return "package.json";
	}
	getPackageManager() {
		return "npm" as const;
	}

	canParse(content: string, fileName?: string): boolean {
		if (fileName?.toLowerCase().includes("package.json")) return true;
		try {
			const parsed = JSON.parse(content);
			return (
				typeof parsed === "object" &&
				("dependencies" in parsed ||
					"devDependencies" in parsed ||
					"peerDependencies" in parsed ||
					("name" in parsed && "version" in parsed))
			);
		} catch {
			return false;
		}
	}

	parse(content: string): ParsedDependencies {
		try {
			const parsed = JSON.parse(content);
			const dependencies = parsed.dependencies || {};
			const devDependencies = parsed.devDependencies || {};
			return {
				kind: this.getFileType(),
				dependencies,
				devDependencies:
					Object.keys(devDependencies).length > 0 ? devDependencies : undefined,
				packageManager: this.getPackageManager(),
			};
		} catch (error) {
			throw new Error(
				`Failed to parse package.json: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}
}

class RequirementsParser implements DependencyParser {
	getFileType(): FileKind {
		return "requirements.txt";
	}
	getPackageManager() {
		return "pip" as const;
	}

	canParse(content: string, fileName?: string): boolean {
		if (fileName?.toLowerCase().includes("requirements")) return true;
		const lines = content
			.split("\n")
			.filter((line) => line.trim() && !line.trim().startsWith("#"));
		if (lines.length === 0 && content.trim()) lines.push(content.trim());
		const pipPattern =
			/^(?:[\w-]+(?:==|>=|~=)\d+[.\d]*|[\w-]+\[[\w,]+\]|-e\s+|git\+)/;
		return lines.some((line) => pipPattern.test(line.trim()));
	}

	parse(content: string): ParsedDependencies {
		const dependencies: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-"))
				continue;
			let name = trimmed,
				version = "latest";
			const specifiers = ["==", ">=", "<=", "~=", "!=", ">", "<"];
			for (const spec of specifiers) {
				if (trimmed.includes(spec)) {
					const parts = trimmed.split(spec);
					name = parts[0].trim();
					const versionPart = parts.slice(1).join(spec).trim();
					version =
						versionPart
							.split(",")[0]
							.replace(/[<>=!~]/g, "")
							.trim() || "latest";
					break;
				}
			}
			const extraMatch = name.match(/^([^[]+)\[([^\]]+)\]/);
			if (extraMatch) name = extraMatch[1].trim();
			name = name.split(";")[0].trim();
			if (name && !name.startsWith("git+") && !name.startsWith("http"))
				dependencies[name] = version;
		}
		return {
			kind: this.getFileType(),
			dependencies,
			packageManager: this.getPackageManager(),
		};
	}
}

class PubspecParser implements DependencyParser {
	getFileType(): FileKind {
		return "pubspec.yaml";
	}
	getPackageManager() {
		return "pub" as const;
	}

	canParse(content: string, fileName?: string): boolean {
		if (fileName?.toLowerCase().includes("pubspec")) return true;
		const hasYamlStructure =
			content.includes("dependencies:") ||
			content.includes("dev_dependencies:");
		const hasDartFields =
			content.includes("name:") ||
			content.includes("version:") ||
			content.includes("sdk: flutter");
		return hasYamlStructure && hasDartFields;
	}

	parse(content: string): ParsedDependencies {
		let doc: Record<string, unknown>;
		try {
			doc = yaml.load(content) as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Failed to parse pubspec.yaml: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}

		const extractDeps = (section: unknown): Record<string, string> => {
			if (!section || typeof section !== "object") return {};
			const deps: Record<string, string> = {};
			for (const [name, value] of Object.entries(
				section as Record<string, unknown>,
			)) {
				if (name === "flutter" || name === "flutter_test") continue;
				if (typeof value === "string") deps[name] = value;
				else if (value === null || value === undefined) deps[name] = "any";
				// skip git/path/sdk dependencies (objects)
			}
			return deps;
		};

		const dependencies = extractDeps(doc.dependencies);
		const devDependencies = extractDeps(doc.dev_dependencies);

		return {
			kind: this.getFileType(),
			dependencies,
			devDependencies:
				Object.keys(devDependencies).length > 0 ? devDependencies : undefined,
			packageManager: this.getPackageManager(),
		};
	}
}

const parsers: DependencyParser[] = [
	new PackageJsonParser(),
	new RequirementsParser(),
	new PubspecParser(),
];

export function detectFileType(
	content: string,
	fileName?: string,
): ParsedDependencies {
	for (const parser of parsers) {
		if (parser.canParse(content, fileName)) return parser.parse(content);
	}
	const trimmed = content.trim();
	if (trimmed.length === 0) throw new Error("File content is empty");
	if (trimmed.startsWith("{"))
		throw new Error("Invalid JSON format - file may be corrupted");
	if (/^[\w-]+(==|>=|<=|~=|!=|>|<)[\d.]+/.test(trimmed))
		return new RequirementsParser().parse(content);
	throw new Error(
		"Unable to detect file type. Supported formats: package.json, requirements.txt, pubspec.yaml",
	);
}

export function getAllDependencies(
	parsed: ParsedDependencies,
): Record<string, string> {
	return parsed.devDependencies
		? { ...parsed.dependencies, ...parsed.devDependencies }
		: parsed.dependencies;
}
