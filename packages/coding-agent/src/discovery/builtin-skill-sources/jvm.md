---
name: jvm
description: Java and Kotlin execution through `run` plus embedded JVM tooling for disassembly, formatting, jars, dependencies, and Javadoc — including main-class derivation and output guards.
---

# The embedded JVM toolchain

`run` compiles and executes Java and Kotlin on the embedded JVM. The five
specialized `jvm_*` tools disassemble, format, package, inspect dependencies,
and generate Javadoc. Compilation happens in a **scratch directory** — your
project is not a build directory and is not touched, except by the two tools
that explicitly write an artifact (`jvm_jar` with `action: "create"`, and
`jvm_javadoc`).

Execution accepts inline `code` or a standalone `.java` / `.kt` `path`.
Specialized compilation starts from inline `code`; only the two read-only
inspection modes take an existing artifact (`jvm_jar` with `action: "inspect"`,
and `jvm_deps` with `path`). There is no whole-project execution mode; use
`check` / `build` for multi-file projects (see `skill://runtime`).

## The tools

| Tool | Use it for |
| --- | --- |
| `run` with Java or Kotlin `language` | Compile and run inline source or a standalone file; get stdout. |
| `jvm_disassemble` | `javap -c` bytecode — see constant folding, string concat, boxing, lambda desugaring. |
| `jvm_format` | Google Java Format / ktfmt. Returns the formatted text; **does not** write it back. |
| `jvm_jar` | `action: "create"` builds a jar from source; `action: "inspect"` lists an existing one. |
| `jvm_deps` | `jdeps` — the packages and modules a class, jar or class directory actually depends on. |
| `jvm_javadoc` | Generate Javadoc HTML from Java source into a directory. Java only. |

```json
{
  "language": "java",
  "code": "public class Hello { public static void main(String[] a) { System.out.println(6 * 7); } }"
}
```

```json
{ "language": "kotlin", "code": "fun main() { println(6 * 7) }" }
```

## Main-class derivation — the usual failure

`run`, `jvm_disassemble`, `jvm_deps` and `jvm_jar` all pick an entrypoint the
same way, and getting it wrong is the most common reason a call fails with a
correct-looking program:

1. An explicit `mainClass` always wins (it must be a plain class name —
   letters, digits, `_`, `$`, `.`).
2. Kotlin is **always `MainKt`**. The guest is written as `Main.kt`, so a
   top-level `fun main()` compiles to `MainKt` regardless of what the code
   looks like. Declaring `class Foo` in Kotlin does not change this.
3. Java: the `public class X`, else the **first** `class X` in the source, else
   `Main`.

The consequences worth internalizing:

- Java source is written to `<DerivedClass>.java`, so the derived name **must**
  match the declared public class or `javac` rejects it. Declare exactly one
  public class and let derivation find it.
- If several classes are declared and none is public, the *first* one wins —
  which is often not the one holding `main`. Pass `mainClass` explicitly.
- Do not put a `package` declaration in inline source. The file is compiled flat
  in the scratch directory, so the derived bare class name will not match the
  package-qualified one the JVM then looks for.
- Kotlin: the standard library is on the classpath automatically. You do not
  need to add it.

## Java 17 is the floor

Java is compiled with `--release 17`, and the host's `JAVA_HOME` / `JDK_HOME`
are stripped from the toolchain's environment. Both halves exist for the same
reason: the compiler is the embedded one, but the `java` that runs the result
may be an older host JVM (CI images commonly pin 17), and newer bytecode on an
older JVM dies with `UnsupportedClassVersionError`.

So: write Java `run` source against Java 17 APIs. Records, sealed types, switch
expressions and text blocks are fine. Anything added after 17 is not, and
the failure will surface as a compile error rather than as a version complaint.

A compile error comes back exactly as the compiler reported it and the program
is not run — read the diagnostic, do not re-run hoping for a different result.

## Writing artifacts

`jvm_jar` (create) and `jvm_javadoc` are the only tools that write into your
project, and both are guarded:

- `output` must be a path **inside** the working directory. `.`, `..` and
  anything escaping the cwd are refused outright.
- An existing `output` is refused unless you pass `overwrite: true`. For
  `jvm_jar`, an existing *directory* at `output` is always refused.
- `jvm_javadoc` is the only tool that deletes, and `overwrite: true` only ever
  replaces something that already looks like a docs output (empty, or carrying
  `index.html` plus javadoc's own scaffolding). A source directory or a static
  site is safe — but always name a dedicated docs directory anyway
  (`javadoc-out` is the default) and never point it at source.

`jvm_format` deliberately does **not** write. It returns the formatted source;
apply it with `edit` or `write` if you want it persisted.

To browse generated docs, `serve` the output directory and stop the job through
`hub` — see `skill://stateful-debugger`.
