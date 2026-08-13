Observe a JavaScript or TypeScript{{#if python}}, or Python{{/if}} program with instrumentation.
`code`/`path` selects the program; `insight`/`insightPath` optionally selects a JavaScript Insight script.
With no script, a default trace runs: source loads, each function's first call with its location, and hot-function milestones (x10, x100, …). Supply a script only when you need something the default trace does not show.

The Insight source runs as a plain script with injected `insight` and `print` globals. Call `insight.on(...)` at top level. NEVER use `import`, `export`, or wrap hooks in an object.

```typescript
type InsightFrame = Record<string, unknown>;
interface InsightSource {
	name: string;
	characters: string | null;
	language: string;
	mimeType: string | null;
	uri: string;
}
interface InsightContext {
	name: string;
	source: InsightSource;
	characters: string;
	line: number;
	startLine: number;
	endLine: number;
	column: number;
	startColumn: number;
	endColumn: number;
	returnValue(frame: InsightFrame): unknown;
	returnNow(value: unknown): never;
}
interface InsightConfig {
	expressions?: boolean;
	statements?: boolean;
	roots?: boolean;
	reads?: boolean;
	writes?: boolean;
	rootNameFilter?: string;
	sourceFilter?: (source: InsightSource) => boolean;
	at?: { sourcePath?: string; sourceURI?: string; line?: number; column?: number };
}
interface InsightAPI {
	on(event: "source", handler: (source: InsightSource) => void): void;
	on(
		event: "enter" | "return",
		handler: (context: InsightContext, frame: InsightFrame) => void,
		config: InsightConfig,
	): void;
}
declare const insight: InsightAPI;
declare function print(...values: unknown[]): void;
```

Source loads and function enter/return observations accompany program output. There is no end-of-run event, so print as you observe.
