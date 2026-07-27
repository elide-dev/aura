/**
 * Pure helpers for the JVM flows behind `runtime/jvm`. Kept out of the endpoint
 * so the naming rules a model depends on (which class gets compiled and run)
 * are unit-testable without a binary.
 */

import type { JvmLanguage } from "./protocol";

/**
 * Java bytecode floor for every `javac` the endpoint drives. The runtime's
 * `java` resolves JAVA_HOME → PATH `java` → its own embedded JVM, while its
 * `javac` always compiles with the embedded JDK — so on a host whose PATH
 * `java` is older (CI images commonly pin 17) the compile-then-run flow dies
 * with `UnsupportedClassVersionError`. Pinning `--release` makes the output run
 * on any JVM that resolution can land on; stripping JAVA_HOME/JDK_HOME from the
 * spawn env (see `jvmSpawnEnv`) is the other half of the same belt.
 */
export const JVM_BYTECODE_RELEASE = "17";

/**
 * Derive the class to compile and run for a JVM program. Java: the
 * `public class X`, else the first `class X`, else `Main`. A top-level Kotlin
 * `main` compiles to `<File>Kt`, and the Kotlin guest is always written as
 * `Main.kt`, so Kotlin is always `MainKt`. An explicit override always wins.
 */
export function deriveJvmMainClass(language: JvmLanguage, code: string, override?: string): string {
	if (override) return override;
	if (language === "kotlin") return "MainKt";
	const pub = code.match(/public\s+(?:final\s+)?class\s+(\w+)/);
	const any = code.match(/\bclass\s+(\w+)/);
	return pub?.[1] ?? any?.[1] ?? "Main";
}

/** Workdir-relative file name for an inline JVM guest source. */
export function jvmSourceFile(language: JvmLanguage, className: string): string {
	return language === "java" ? `${className}.java` : "Main.kt";
}

/** Where compiled classes land: Java compiles in place, Kotlin into `out`. */
export function jvmClasspath(language: JvmLanguage): string {
	return language === "java" ? "." : "out";
}
