import { describe, expect, test } from "bun:test";
import { deriveJvmMainClass, JVM_BYTECODE_RELEASE, jvmSourceFile } from "../src/runtime/jvm";
import type { RuntimeRpcError } from "../src/runtime/protocol";

describe("deriveJvmMainClass", () => {
	test("an explicit override always wins", () => {
		expect(deriveJvmMainClass("java", "public class Ignored {}", "com.example.Real")).toBe("com.example.Real");
		expect(deriveJvmMainClass("kotlin", "fun main() {}", "OtherKt")).toBe("OtherKt");
	});

	test("Kotlin always compiles to MainKt (the guest is written as Main.kt)", () => {
		expect(deriveJvmMainClass("kotlin", "fun main() { println(1) }")).toBe("MainKt");
		expect(deriveJvmMainClass("kotlin", "class Widget {}")).toBe("MainKt");
	});

	test("Java prefers the public class", () => {
		expect(deriveJvmMainClass("java", "class Helper {}\npublic class Entry { }")).toBe("Entry");
	});

	test("Java accepts a public final class", () => {
		expect(deriveJvmMainClass("java", "public final class Entry {}")).toBe("Entry");
	});

	test("Java falls back to the first class when none is public", () => {
		expect(deriveJvmMainClass("java", "class First {}\nclass Second {}")).toBe("First");
	});

	test("Java falls back to Main when no class declaration is found", () => {
		expect(deriveJvmMainClass("java", "// nothing here")).toBe("Main");
		expect(deriveJvmMainClass("java", "")).toBe("Main");
	});

	test("an empty override is treated as absent", () => {
		expect(deriveJvmMainClass("java", "public class Entry {}", "")).toBe("Entry");
	});

	test("a package-qualified or nested class override is accepted", () => {
		expect(deriveJvmMainClass("java", "", "com.example.Outer$Inner")).toBe("com.example.Outer$Inner");
	});

	test("an override that is not a class name is refused — it would become a toolchain flag", () => {
		// The override lands in the `java`/`javap` argv, so a leading dash must never survive.
		for (const bad of ["-Xshare:off", "--version", "Main; rm -rf /", "Main Other", "/etc/passwd", "a\nb"]) {
			let code: string | undefined;
			try {
				deriveJvmMainClass("java", "", bad);
			} catch (e) {
				code = (e as RuntimeRpcError).code;
			}
			expect(code, `expected ${bad} to be refused`).toBe("invalid-params");
		}
	});

	test("the refusal names the offending value", () => {
		expect(() => deriveJvmMainClass("kotlin", "", "-Xflag")).toThrow(/-Xflag/);
	});
});

describe("jvmSourceFile", () => {
	test("Java sources are named after the class; Kotlin is always Main.kt", () => {
		expect(jvmSourceFile("java", "Entry")).toBe("Entry.java");
		expect(jvmSourceFile("kotlin", "MainKt")).toBe("Main.kt");
	});
});

describe("JVM_BYTECODE_RELEASE", () => {
	test("the bytecode floor is 17", () => {
		expect(JVM_BYTECODE_RELEASE).toBe("17");
	});
});
