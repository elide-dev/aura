Analyze JVM dependencies with `jdeps`: which packages and modules a class,
jar, or class directory actually depends on. Either pass `path` to an
existing `.class`/`.jar`/class directory (relative to the cwd, read-only), or
pass `language` + `code` to compile source in a scratch directory first and
analyze the result.
