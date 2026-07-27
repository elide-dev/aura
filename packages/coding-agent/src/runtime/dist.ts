/** Pinned Elide distribution (the runtime's engine). Bump version + all sha256s in lockstep. */

export const ELIDE_VERSION = "1.4.1+20260718";

/**
 * Oldest runtime version the innate tools support — the argv shapes they pin
 * (`--error-format=plain`, `--insights=`, `--profiler=`) landed in 1.4. Enforced
 * where a version is already known for free: `runtime/status` reports an older
 * binary as unavailable with guidance. Deliberately *not* enforced on the exec
 * path, which would cost an extra `--version` spawn on every single call.
 */
export const MINIMUM_RUNTIME_VERSION = "1.4";

export interface RuntimeDistEntry {
	file: string;
	sha256: string;
	archive: "txz" | "zip";
}

export const RUNTIME_DIST: Record<string, RuntimeDistEntry> = {
	"linux-x64": {
		file: "elide.linux-amd64.txz",
		sha256: "b1183f0c577acdb8f29950c2b0f0915b5dcd35568478866a0bd89b0273ada1bb",
		archive: "txz",
	},
	"linux-arm64": {
		file: "elide.linux-arm64.txz",
		sha256: "fd6765b32182e3d24e64d52f376fbbb224547ff0e51e25a66f2d5ed478f00403",
		archive: "txz",
	},
	"darwin-arm64": {
		file: "elide.macos-arm64.txz",
		sha256: "cef68ecf065d05900036c929a2128f659cd543232350c83a28433869c9aef39c",
		archive: "txz",
	},
	"win32-x64": {
		file: "elide.windows-amd64.zip",
		sha256: "656d9ff51bb229bfd28cbb8af263e67a0ac39c743e68b5d0c05ddfdc0c74f23d",
		archive: "zip",
	},
};

export function platformKey(): string {
	return `${process.platform}-${process.arch}`;
}

export function distDownloadUrl(
	entry: RuntimeDistEntry,
	baseUrl = `https://github.com/elide-dev/elide/releases/download/${encodeURIComponent(ELIDE_VERSION)}`,
): string {
	return `${baseUrl}/${entry.file}`;
}
