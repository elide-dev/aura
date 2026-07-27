Compile Java or Kotlin and disassemble the resulting bytecode with
`javap -c`. Use it to see how source lowers to JVM instructions — constant
folding, string concatenation, boxing, lambda desugaring. Same entrypoint
rules as `jvm_run`: the `public class`, or `MainKt` for Kotlin, unless
`mainClass` names another class. On a compile error you get the compiler's
diagnostics instead of a listing.
