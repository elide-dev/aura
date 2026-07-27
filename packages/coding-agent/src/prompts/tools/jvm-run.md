Compile and run a Java or Kotlin program on the embedded JVM and return its
output. Source is compiled in a scratch directory (`javac --release 17`, or
`kotlinc` into `out/`) and then run — nothing is written into your project.
The Kotlin stdlib is on the classpath. The entrypoint defaults to the
`public class` (Java) or `MainKt` (Kotlin); pass `mainClass` when it is
neither. A compile error comes back as the compiler reported it, and the
program is not run.
