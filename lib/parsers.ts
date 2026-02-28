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
		const pipPatterns = [
			/^[\w-]+==\d+[.\d]*/,
			/^[\w-]+>=\d+[.\d]*/,
			/^[\w-]+~=\d+[.\d]*/,
			/^[\w-]+\[[\w,]+\]/,
			/^-e\s+/,
			/^git\+/,
		];
		return lines.some((line) =>
			pipPatterns.some((pattern) => pattern.test(line.trim())),
		);
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
		const dependencies: Record<string, string> = {};
		const devDependencies: Record<string, string> = {};
		const lines = content.split("\n");
		let currentSection: "dependencies" | "dev_dependencies" | null = null;
		let indentLevel = 0;
		let skipNextLine = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (skipNextLine) {
				if (trimmed.startsWith("sdk:")) {
					skipNextLine = false;
					continue;
				}
				skipNextLine = false;
			}
			const currentIndent = line.length - line.trimStart().length;

			if (trimmed === "dependencies:") {
				currentSection = "dependencies";
				indentLevel = currentIndent;
				continue;
			} else if (trimmed === "dev_dependencies:") {
				currentSection = "dev_dependencies";
				indentLevel = currentIndent;
				continue;
			} else if (
				trimmed &&
				!line.startsWith(" ".repeat(indentLevel + 2)) &&
				currentSection
			) {
				if (currentIndent <= indentLevel) {
					currentSection = null;
					continue;
				}
			}

			if (currentSection && trimmed && currentIndent > indentLevel) {
				const match = trimmed.match(/^([^:]+):\s*(.*)$/);
				if (match) {
					const [, name, versionPart] = match;
					const packageName = name.trim();
					if (packageName === "flutter" || packageName === "flutter_test") {
						if (
							i + 1 < lines.length &&
							lines[i + 1].trim().startsWith("sdk:")
						) {
							skipNextLine = true;
							continue;
						}
						if (!versionPart || versionPart === "") {
							skipNextLine = true;
							continue;
						}
					}
					if (packageName === "sdk" && versionPart === "flutter") continue;

					let version = versionPart.trim();
					if (!version || version === "") {
						if (i + 1 < lines.length) {
							const nextLine = lines[i + 1].trim();
							const nextIndent =
								lines[i + 1].length - lines[i + 1].trimStart().length;
							if (nextIndent > currentIndent) {
								skipNextLine = true;
								continue;
							}
							version = nextLine.startsWith("version:")
								? nextLine.replace("version:", "").trim()
								: "any";
						} else {
							version = "any";
						}
					}
					version = version.replace(/["']/g, "");
					if (currentSection === "dependencies")
						dependencies[packageName] = version;
					else devDependencies[packageName] = version;
				}
			}
		}
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
