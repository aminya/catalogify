import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("src/index.ts");
async function fixture(manager: "bun" | "pnpm" = "bun") {
	const root = await mkdtemp(join(tmpdir(), "catalogify-"));
	await mkdir(join(root, "packages/a"), { recursive: true });
	await mkdir(join(root, "packages/b"), { recursive: true });
	const write = async (file: string, value: unknown) =>
		writeFile(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
	await write("package.json", {
		private: true,
		packageManager: `${manager}@1.0.0`,
		workspaces: ["packages/*"],
	});
	if (manager === "pnpm")
		await writeFile(
			join(root, "pnpm-workspace.yaml"),
			"# workspace\npackages:\n  - 'packages/*'\ncatalog:\n  existing: ^1.0.0\n",
		);
	await write("packages/a/package.json", {
		dependencies: {
			compatible: "^1.0.0",
			different: "^1.0.0",
			exact: "1.0.0",
			special: "workspace:*",
		},
	});
	await write("packages/b/package.json", {
		devDependencies: {
			compatible: "^1.2.0",
			different: "^2.0.0",
			exact: "^1.1.0",
			special: "workspace:*",
		},
	});
	return root;
}
async function run(root: string, ...args: string[]) {
	const proc = Bun.spawn(["bun", cli, ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	return {
		code: await proc.exited,
		stdout: await new Response(proc.stdout).text(),
		stderr: await new Response(proc.stderr).text(),
	};
}
async function json(root: string, path: string) {
	return JSON.parse(await readFile(join(root, path), "utf8"));
}

test("compatible ranges are cataloged and incompatible or non-registry specs are untouched", async () => {
	const root = await fixture();
	try {
		const result = await run(root);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("Skipped different");
		expect(result.stderr).toContain("Skipped exact");
		const rootPackage = await json(root, "package.json");
		expect(rootPackage.catalog.compatible).toBe("^1.2.0");
		expect(
			(await json(root, "packages/a/package.json")).dependencies.compatible,
		).toBe("catalog:");
		expect(
			(await json(root, "packages/b/package.json")).devDependencies.different,
		).toBe("^2.0.0");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("major and all modes and dry run", async () => {
	const root = await fixture();
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ version: "9.0.0" }),
	});
	const previousRegistry = process.env.npm_config_registry;
	process.env.npm_config_registry = server.url.href;
	try {
		expect((await run(root, "--dedupe", "major", "--dry-run")).code).toBe(0);
		expect((await json(root, "package.json")).catalog).toBeUndefined();
		expect((await run(root, "--dedupe", "major")).code).toBe(0);
		expect((await json(root, "package.json")).catalog.exact).toBe("^1.1.0");
		expect((await run(root, "--dedupe", "all")).code).toBe(0);
		expect((await json(root, "package.json")).catalog.different).toBe("9.0.0");
	} finally {
		server.stop();
		if (previousRegistry === undefined) delete process.env.npm_config_registry;
		else process.env.npm_config_registry = previousRegistry;
		await rm(root, { recursive: true, force: true });
	}
});

test("pnpm preserves existing workspace YAML and npm is rejected", async () => {
	const root = await fixture("pnpm");
	try {
		expect((await run(root)).code).toBe(0);
		const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
		expect(yaml).toContain("# workspace");
		expect(yaml).toContain("existing: ^1.0.0");
		expect(yaml).toContain("compatible: ^1.2.0");
		expect((await run(root, "--pm", "npm")).stderr).toContain(
			"npm does not support",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("registry lookup failure leaves the dependency unchanged", async () => {
	const root = await fixture();
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response("missing", { status: 404 }),
	});
	const previousRegistry = process.env.npm_config_registry;
	process.env.npm_config_registry = server.url.href;
	try {
		const result = await run(root, "--dedupe", "all");
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("could not fetch latest version");
		expect(
			(await json(root, "packages/a/package.json")).dependencies.different,
		).toBe("^1.0.0");
		expect((await json(root, "package.json")).catalog).toBeUndefined();
	} finally {
		server.stop();
		if (previousRegistry === undefined) delete process.env.npm_config_registry;
		else process.env.npm_config_registry = previousRegistry;
		await rm(root, { recursive: true, force: true });
	}
});
