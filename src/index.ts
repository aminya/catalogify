#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import glob from "fast-glob";
import { applyEdits, modify } from "jsonc-parser";
import semver from "semver";
import { isMap, parseDocument } from "yaml";

type ObjectValue = Record<string, unknown>;
type Manifest = { path: string; text: string; data: ObjectValue };
type Occurrence = { manifest: Manifest; section: string; spec: string };
type Mode = "semver" | "major" | "all";
type Manager = "bun" | "pnpm" | "npm";
const sections = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

function object(value: unknown): ObjectValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}
function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
async function readManifest(path: string): Promise<Manifest> {
	const text = await readFile(path, "utf8");
	const data: unknown = JSON.parse(text);
	const result = object(data);
	if (!result) throw new Error(`Invalid package.json object: ${path}`);
	return { path, text, data: result };
}
function edit(manifest: Manifest, path: string[], value: string): void {
	const indent = /\n([ \t]+)\S/.exec(manifest.text)?.[1] ?? "  ";
	manifest.text = applyEdits(
		manifest.text,
		modify(manifest.text, path, value, {
			formattingOptions: {
				insertSpaces: indent !== "\t",
				tabSize: indent === "\t" ? 1 : indent.length,
				eol: manifest.text.includes("\r\n") ? "\r\n" : "\n",
			},
		}),
	);
}
async function detect(root: string, manifest: Manifest): Promise<Manager> {
	const declared =
		typeof manifest.data.packageManager === "string"
			? manifest.data.packageManager.split("@")[0]
			: undefined;
	if (declared === "bun" || declared === "pnpm" || declared === "npm")
		return declared;
	const found = (
		await Promise.all(
			[
				["bun", "bun.lock"],
				["bun", "bun.lockb"],
				["pnpm", "pnpm-lock.yaml"],
				["npm", "package-lock.json"],
				["npm", "npm-shrinkwrap.json"],
			].map(async ([name, file]) =>
				name && file && (await exists(join(root, file))) ? name : undefined,
			),
		)
	).filter((name): name is string => !!name);
	const unique = [...new Set(found)];
	if (unique.length !== 1)
		throw new Error(
			"Cannot determine package manager unambiguously; pass --pm bun or --pm pnpm.",
		);
	if (unique[0] === "bun" || unique[0] === "pnpm" || unique[0] === "npm")
		return unique[0];
	throw new Error("Unsupported package manager.");
}
function select(specs: string[], mode: Mode): string | undefined {
	if (
		specs.some((spec) => !semver.validRange(spec) || !semver.minVersion(spec))
	)
		return undefined;
	const sorted = [...specs].sort((a, b) =>
		semver.compare(semver.minVersion(b)!, semver.minVersion(a)!),
	);
	if (mode === "all") return sorted[0];
	if (mode === "major") {
		const majors = new Set(specs.map((spec) => semver.minVersion(spec)?.major));
		return majors.size === 1 ? sorted[0] : undefined;
	}
	// Distribute OR clauses before joining ranges; minVersion detects an empty intersection.
	let clauses = [""];
	for (const spec of specs) {
		clauses = clauses.flatMap((clause) =>
			spec.split("||").map((part) => `${clause} ${part}`.trim()),
		);
	}
	const intersection = clauses
		.filter((clause) => semver.validRange(clause) && semver.minVersion(clause))
		.join(" || ");
	if (!intersection) return undefined;
	return (
		sorted.find((spec) => specs.every((other) => semver.subset(spec, other))) ??
		intersection
	);
}
async function latestVersion(name: string): Promise<string> {
	const registry =
		process.env.npm_config_registry ?? "https://registry.npmjs.org/";
	const url = new URL(
		`${encodeURIComponent(name)}/latest`,
		registry.endsWith("/") ? registry : `${registry}/`,
	);
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	if (!response.ok) throw new Error(`registry returned ${response.status}`);
	const metadata: unknown = await response.json();
	const version = object(metadata)?.version;
	if (typeof version !== "string" || !semver.valid(version))
		throw new Error("registry returned an invalid version");
	return version;
}
async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			pm: { type: "string" },
			dedupe: { type: "string", default: "semver" },
			help: { type: "boolean", short: "h" },
			"dry-run": { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Usage: catalogify [workspace-directory] [--pm bun|pnpm|npm] [--dedupe semver|major|all] [--dry-run]",
		);
		return;
	}
	const mode = values.dedupe;
	if (mode !== "semver" && mode !== "major" && mode !== "all")
		throw new Error("Invalid --dedupe; use semver, major, or all.");
	if (positionals.length > 1)
		throw new Error("Provide at most one workspace directory.");
	const root = resolve(positionals[0] ?? process.cwd());
	const rootManifest = await readManifest(join(root, "package.json"));
	const manager = values.pm ?? (await detect(root, rootManifest));
	if (manager !== "bun" && manager !== "pnpm" && manager !== "npm")
		throw new Error("Invalid --pm; use bun, pnpm, or npm.");
	if (manager === "npm")
		throw new Error(
			"npm does not support catalog: dependencies. Use Bun or pnpm for catalog workspaces.",
		);
	const yamlPath = join(root, "pnpm-workspace.yaml");
	const yamlText = manager === "pnpm" ? await readFile(yamlPath, "utf8") : "";
	const doc = parseDocument(yamlText);
	if (doc.errors.length)
		throw new Error(`Invalid pnpm-workspace.yaml: ${doc.errors[0]?.message}`);
	const yamlData = object(doc.toJS()) ?? {};
	const workspaces = rootManifest.data.workspaces;
	const patterns =
		manager === "pnpm"
			? strings(yamlData.packages)
			: strings(
					Array.isArray(workspaces) ? workspaces : object(workspaces)?.packages,
				);
	if (!patterns.length) throw new Error("No workspace package patterns found.");
	const paths = await glob(
		patterns.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`),
		{ cwd: root, absolute: true, ignore: ["**/node_modules/**"], unique: true },
	);
	const manifests = [
		rootManifest,
		...(await Promise.all(
			paths
				.filter((path) => resolve(path) !== rootManifest.path)
				.map(readManifest),
		)),
	];
	const existing =
		manager === "pnpm"
			? object(yamlData.catalog)
			: (object(rootManifest.data.catalog) ??
				object(object(workspaces)?.catalog));
	const existingCatalog = existing ?? {};
	const occurrences = new Map<string, Occurrence[]>();
	for (const manifest of manifests)
		for (const section of sections) {
			const deps = object(manifest.data[section]);
			if (!deps) continue;
			for (const [name, spec] of Object.entries(deps)) {
				if (typeof spec !== "string") continue;
				const list = occurrences.get(name) ?? [];
				list.push({ manifest, section, spec });
				occurrences.set(name, list);
			}
		}
	const changes = new Map<string, string>();
	for (const [name, entries] of occurrences) {
		if (new Set(entries.map((entry) => entry.manifest.path)).size < 2) continue;
		const oldCatalog = existingCatalog[name];
		const specs = entries.map((entry) =>
			entry.spec === "catalog:" && typeof oldCatalog === "string"
				? oldCatalog
				: entry.spec,
		);
		if (typeof oldCatalog === "string") specs.push(oldCatalog);
		let selected = select(specs, mode);
		if (selected && mode === "all") {
			try {
				selected = await latestVersion(name);
			} catch (error) {
				console.warn(
					`Skipped ${name}: could not fetch latest version (${error instanceof Error ? error.message : String(error)})`,
				);
				continue;
			}
		}
		if (!selected) {
			console.warn(
				`Skipped ${name}: incompatible or unsupported versions (${[...new Set(specs)].join(", ")})`,
			);
			continue;
		}
		changes.set(name, selected);
		for (const entry of entries)
			if (entry.spec !== "catalog:")
				edit(entry.manifest, [entry.section, name], "catalog:");
	}
	if (manager === "bun") {
		const catalogPath =
			object(rootManifest.data.catalog) || !object(workspaces)?.catalog
				? ["catalog"]
				: ["workspaces", "catalog"];
		for (const [name, version] of changes)
			edit(rootManifest, [...catalogPath, name], version);
	} else if (changes.size) {
		if (doc.has("include"))
			throw new Error(
				"pnpm workspace includes may delegate catalog ownership; update the owning file manually.",
			);
		if (doc.has("catalog") && !isMap(doc.get("catalog", true)))
			throw new Error("pnpm catalog must be a mapping.");
		if (!doc.has("catalog")) doc.set("catalog", {});
		for (const [name, version] of changes)
			doc.setIn(["catalog", name], version);
	}
	if (!values["dry-run"]) {
		await Promise.all(
			manifests
				.filter((manifest) => manifest.text !== undefined)
				.map(async (manifest) => {
					const original = await readFile(manifest.path, "utf8");
					if (original !== manifest.text)
						await writeFile(manifest.path, manifest.text);
				}),
		);
		if (manager === "pnpm" && changes.size)
			await writeFile(yamlPath, String(doc));
	}
	console.log(
		`${values["dry-run"] ? "Would catalog" : "Cataloged"} ${changes.size} shared dependencies using ${manager}.`,
	);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
