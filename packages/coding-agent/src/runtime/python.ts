import * as path from "node:path";

/**
 * Run a Python source file with the file-mode globals and import path that
 * CPython supplies. The bundled runtime currently executes file input like
 * eval input, so it does not define `__file__` or make the script directory the
 * first import root. Keep this shim at the adapter boundary until the runtime
 * itself provides those semantics.
 */
export function pythonFileBootstrap(filePath: string): string {
	const sourcePath = JSON.stringify(path.resolve(filePath));
	const sourceDir = JSON.stringify(path.dirname(path.resolve(filePath)));
	return [
		"import sys as __aura_sys",
		`__aura_file = ${sourcePath}`,
		`__aura_source_dir = ${sourceDir}`,
		"__aura_sys.argv[0] = __aura_file",
		"__aura_sys.path.insert(0, __aura_source_dir)",
		"with open(__aura_file, 'rb') as __aura_stream:",
		"    __aura_code = compile(__aura_stream.read(), __aura_file, 'exec')",
		"exec(__aura_code, {'__name__': '__main__', '__file__': __aura_file, '__package__': None, '__cached__': None})",
	].join("\n");
}
