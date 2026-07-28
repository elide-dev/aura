import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const CODING_AGENT_ROOT = join(REPOSITORY_ROOT, "packages", "coding-agent");
const EMBEDDED_SCHEMA_ENTRY = "protocol/elide/v1/embed.capnp";
const PROTOCOL_ROOT = "protocol/elide/v1";
const GENERATED_ROOT = join(CODING_AGENT_ROOT, "src", "runtime", "embedded", "generated");
const SCHEMA_CONSTANTS_PATH = join(CODING_AGENT_ROOT, "src", "runtime", "embedded", "schema.ts");
const IMPORT_PATTERN = /\bimport\s+"([^"\r\n]+)"/g;
const NUL = "\0";
const EXPECTED_CAPNP_ES_VERSION = "0.0.14";
const EXPECTED_TYPESCRIPT_VERSION = "5.9.3";

interface SyncOptions {
	whiplashRoot: string;
	check: boolean;
}

interface EmbeddedSchemaFile {
	path: string;
	sourcePath: string;
	content: string;
}

interface EmbeddedSchemaClosure {
	repositoryRoot: string;
	protocolRoot: string;
	files: EmbeddedSchemaFile[];
}

function parseOptions(args: readonly string[]): SyncOptions {
	let whiplashRoot: string | undefined;
	let check = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case "--check":
				check = true;
				break;
			case "--whiplash": {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw new Error("--whiplash requires a repository path");
				}
				whiplashRoot = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
	}
	if (whiplashRoot === undefined) {
		throw new Error("Usage: bun scripts/sync-embedded-runtime-protocol.ts --whiplash <path> [--check]");
	}
	return { whiplashRoot, check };
}

function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n?/g, "\n");
}

function repositoryRelativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function isWithin(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function importsIn(content: string): string[] {
	const imports: string[] = [];
	const uncommented = content
		.split(/\r?\n/)
		.map((line) => {
			const comment = line.indexOf("#");
			return comment === -1 ? line : line.slice(0, comment);
		})
		.join("\n");
	for (const match of uncommented.matchAll(IMPORT_PATTERN)) {
		const importPath = match[1];
		if (importPath !== undefined) imports.push(importPath);
	}
	return imports;
}

async function canonicalSchemaPath(path: string, context: string): Promise<string> {
	if (!(await Bun.file(path).exists())) {
		throw new Error(`Missing local import ${context}`);
	}
	try {
		return await realpath(path);
	} catch (cause) {
		throw new Error(`Unable to resolve local import ${context}`, { cause });
	}
}

async function collectEmbeddedSchemaClosure(root: string): Promise<EmbeddedSchemaClosure> {
	const repositoryRoot = resolve(root);
	const protocolRoot = resolve(repositoryRoot, PROTOCOL_ROOT);
	let canonicalProtocolRoot: string;
	try {
		canonicalProtocolRoot = await realpath(protocolRoot);
	} catch (cause) {
		throw new Error(`WHIPLASH protocol root does not exist: ${protocolRoot}`, { cause });
	}
	const entry = resolve(repositoryRoot, EMBEDDED_SCHEMA_ENTRY);
	const visited = new Set<string>();
	const files: EmbeddedSchemaFile[] = [];

	async function visit(logicalPath: string, context: string): Promise<void> {
		if (!isWithin(protocolRoot, logicalPath)) {
			throw new Error(`Embedded schema import escapes protocol root: ${context}`);
		}
		const canonicalPath = await canonicalSchemaPath(logicalPath, context);
		if (!isWithin(canonicalProtocolRoot, canonicalPath)) {
			throw new Error(`Embedded schema import escapes protocol root: ${context}`);
		}
		if (visited.has(canonicalPath)) return;

		const content = await Bun.file(canonicalPath).text();
		const path = repositoryRelativePath(repositoryRoot, logicalPath);
		visited.add(canonicalPath);
		files.push({ path, sourcePath: logicalPath, content });

		for (const importPath of importsIn(content)) {
			if (importPath.startsWith("/") || !importPath.endsWith(".capnp")) continue;
			await visit(resolve(dirname(logicalPath), importPath), `${importPath} from ${path}`);
		}
	}

	await visit(entry, EMBEDDED_SCHEMA_ENTRY);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return { repositoryRoot, protocolRoot, files };
}

function computeEmbeddedSchemaHash(files: readonly EmbeddedSchemaFile[]): string {
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of files) {
		hash.update(file.path);
		hash.update(NUL);
		hash.update(normalizeLineEndings(file.content));
		hash.update(NUL);
	}
	return hash.digest("hex");
}

async function findPackageRoot(entryPath: string, packageName: string): Promise<string> {
	let candidate = dirname(await realpath(entryPath));
	for (;;) {
		const manifestPath = join(candidate, "package.json");
		if (await Bun.file(manifestPath).exists()) {
			const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
			if (
				typeof manifest === "object" &&
				manifest !== null &&
				"name" in manifest &&
				manifest.name === packageName
			) {
				return candidate;
			}
		}
		const parent = dirname(candidate);
		if (parent === candidate) throw new Error(`Unable to locate installed package root for ${packageName}`);
		candidate = parent;
	}
}

async function readInstalledVersion(packageRoot: string, packageName: string): Promise<string> {
	const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("name" in manifest) ||
		manifest.name !== packageName ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	) {
		throw new Error(`Invalid installed package metadata for ${packageName}`);
	}
	return manifest.version;
}

async function prepareCompilerWorkspace(compilerRoot: string): Promise<void> {
	const capnpEntry = Bun.resolveSync("capnp-es", CODING_AGENT_ROOT);
	const typescriptEntry = Bun.resolveSync("typescript", CODING_AGENT_ROOT);
	const capnpPackageRoot = await findPackageRoot(capnpEntry, "capnp-es");
	const typescriptPackageRoot = await findPackageRoot(typescriptEntry, "typescript");
	const capnpVersion = await readInstalledVersion(capnpPackageRoot, "capnp-es");
	const typescriptVersion = await readInstalledVersion(typescriptPackageRoot, "typescript");
	if (capnpVersion !== EXPECTED_CAPNP_ES_VERSION) {
		throw new Error(`Expected local capnp-es ${EXPECTED_CAPNP_ES_VERSION}, found ${capnpVersion}`);
	}
	if (typescriptVersion !== EXPECTED_TYPESCRIPT_VERSION) {
		throw new Error(`Expected local TypeScript ${EXPECTED_TYPESCRIPT_VERSION}, found ${typescriptVersion}`);
	}

	const nodeModules = join(compilerRoot, "node_modules");
	await mkdir(nodeModules, { recursive: true });
	await Promise.all([
		cp(capnpPackageRoot, join(nodeModules, "capnp-es"), { recursive: true, dereference: true }),
		cp(typescriptPackageRoot, join(nodeModules, "typescript"), { recursive: true, dereference: true }),
	]);
	const binRoot = join(nodeModules, ".bin");
	await mkdir(binRoot, { recursive: true });
	await symlink(join("..", "capnp-es", "dist", "compiler", "capnpc-js.mjs"), join(binRoot, "capnp-es"), "file");
}

async function collectFiles(root: string): Promise<string[]> {
	try {
		if (!(await stat(root)).isDirectory()) return [];
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(repositoryRelativePath(root, path));
		}
	}
	await visit(root);
	return files;
}

function stripSourceRoots(content: string, roots: readonly string[]): string {
	let stripped = normalizeLineEndings(content);
	for (const root of roots) {
		const variants = new Set([root, root.split(sep).join("/"), root.replaceAll("\\", "/")]);
		for (const variant of variants) {
			stripped = stripped.replaceAll(`${variant}/`, "").replaceAll(variant, ".");
		}
	}
	return stripped;
}

async function generateBindings(closure: EmbeddedSchemaClosure, temporaryRoot: string): Promise<Map<string, string>> {
	const compilerRoot = join(temporaryRoot, "compiler");
	const rawOutputRoot = join(temporaryRoot, "raw-generated");
	await prepareCompilerWorkspace(compilerRoot);
	await mkdir(rawOutputRoot, { recursive: true });

	const command = [
		"bunx",
		"--bun",
		"capnp-es",
		...closure.files.map((file) => file.sourcePath),
		`-I${join(closure.repositoryRoot, "third_party")}`,
		`-ots:${rawOutputRoot}`,
		`--src-prefix=${closure.protocolRoot}`,
	];
	const child = Bun.spawn(command, {
		cwd: compilerRoot,
		env: Bun.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`capnp-es generation failed with exit code ${exitCode}`);

	const canonicalRepositoryRoot = await realpath(closure.repositoryRoot);
	const sourceRoots = [closure.repositoryRoot, canonicalRepositoryRoot];
	const generatedFiles = await collectFiles(rawOutputRoot);
	const expectedFiles = closure.files.map((file) => file.path.slice(`${PROTOCOL_ROOT}/`.length).replace(/\.capnp$/, ".ts"));
	if (generatedFiles.some((path) => !path.endsWith(".ts"))) {
		throw new Error(`capnp-es generated an unexpected non-TypeScript file: ${generatedFiles.join(", ")}`);
	}
	if (generatedFiles.join("\n") !== expectedFiles.join("\n")) {
		throw new Error(
			`capnp-es output set did not match the canonical schema closure\nexpected: ${expectedFiles.join(", ")}\nactual: ${generatedFiles.join(", ")}`,
		);
	}

	const output = new Map<string, string>();
	for (const path of generatedFiles) {
		const source = await readFile(join(rawOutputRoot, path), "utf8");
		const normalized = stripSourceRoots(source, sourceRoots);
		for (const sourceRoot of sourceRoots) {
			if (normalized.includes(sourceRoot) || normalized.includes(sourceRoot.replaceAll("\\", "/"))) {
				throw new Error(`Generated binding still contains an absolute WHIPLASH path: ${path}`);
			}
		}
		output.set(path, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
	}
	return output;
}

function schemaConstants(hash: string): string {
	return `export const EMBEDDED_RUNTIME_ABI_VERSION = 1;\nexport const EMBEDDED_RUNTIME_SCHEMA_SHA256 = "${hash}";\n`;
}

async function writeGeneratedFiles(files: ReadonlyMap<string, string>, schema: string): Promise<void> {
	await rm(GENERATED_ROOT, { recursive: true, force: true });
	await mkdir(GENERATED_ROOT, { recursive: true });
	for (const [path, content] of files) {
		const destination = join(GENERATED_ROOT, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, content, "utf8");
	}
	await mkdir(dirname(SCHEMA_CONSTANTS_PATH), { recursive: true });
	await writeFile(SCHEMA_CONSTANTS_PATH, schema, "utf8");
}

async function checkGeneratedFiles(files: ReadonlyMap<string, string>, schema: string): Promise<void> {
	const checkedInFiles = await collectFiles(GENERATED_ROOT);
	const generatedFiles = [...files.keys()];
	const drift: string[] = [];
	if (checkedInFiles.join("\n") !== generatedFiles.join("\n")) {
		drift.push(`file set differs (checked in: ${checkedInFiles.join(", ") || "none"}; generated: ${generatedFiles.join(", ")})`);
	}
	for (const [path, content] of files) {
		const checkedInPath = join(GENERATED_ROOT, path);
		if (!(await Bun.file(checkedInPath).exists())) continue;
		if ((await readFile(checkedInPath, "utf8")) !== content) drift.push(`${path} differs`);
	}
	if (!(await Bun.file(SCHEMA_CONSTANTS_PATH).exists())) {
		drift.push("schema.ts is missing");
	} else if ((await readFile(SCHEMA_CONSTANTS_PATH, "utf8")) !== schema) {
		drift.push("schema.ts differs");
	}
	if (drift.length > 0) {
		throw new Error(`Embedded runtime protocol drift detected:\n- ${drift.join("\n- ")}`);
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const closure = await collectEmbeddedSchemaClosure(options.whiplashRoot);
	const hash = computeEmbeddedSchemaHash(closure.files);
	const temporaryRoot = await mkdtemp(join(tmpdir(), "aura-embedded-protocol-"));
	try {
		const generated = await generateBindings(closure, temporaryRoot);
		const schema = schemaConstants(hash);
		if (options.check) await checkGeneratedFiles(generated, schema);
		else await writeGeneratedFiles(generated, schema);
		await Bun.write(
			Bun.stdout,
			`${options.check ? "Verified" : "Generated"} embedded runtime protocol (${generated.size} files, sha256 ${hash})\n`,
		);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	await Bun.write(Bun.stderr, `${message}\n`);
	process.exitCode = 1;
}
