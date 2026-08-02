Observe a JavaScript or TypeScript{{#if python}}, or Python{{/if}} program with instrumentation.
`code`/`path` selects the program; `insight`/`insightPath` selects a JavaScript Insight script.

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
	at?: {
		sourcePath?: string;
		sourceURI?: string;
		line?: number;
		column?: number;
	};
}

type InsightHandler =
	| ((source: InsightSource) => void)
	| ((context: InsightContext, frame: InsightFrame) => void)
	| (() => void);

interface InsightAPI {
	readonly id: string;
	readonly version: string;
	on(event: "source", handler: (source: InsightSource) => void): void;
	on(
		event: "enter" | "return",
		handler: (context: InsightContext, frame: InsightFrame) => void,
		config: InsightConfig,
	): void;
	on(event: "close", handler: () => void): void;
	off(event: "source" | "enter" | "return" | "close", handler: InsightHandler): void;
}

declare const insight: InsightAPI;
declare function print(...values: unknown[]): void;
```

These are reference types; `insight` source remains plain JavaScript. Source loads and function enter/return observations accompany program output. One-shot runs emit no `close` event, so NEVER rely on `close` for output.
