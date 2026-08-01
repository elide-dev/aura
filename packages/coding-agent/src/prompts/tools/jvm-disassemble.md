Compile Java/Kotlin source, then disassemble its bytecode with `javap -c`.
Entrypoint defaults to the Java public class or Kotlin `MainKt`; `mainClass`
overrides it. Compilation failure returns compiler diagnostics and no listing.
