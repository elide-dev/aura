Assemble project artifacts on the managed runtime's build system. `targets`
takes ':'-prefixed build targets with interleaved per-target options, passed
through verbatim (e.g. [":deps", "--fresh", ":compile"]); omit it to run the
default build. Optional `cwd` and `timeoutMs` as in `check`. Use `check` for
validation-only runs; use this when artifacts are the goal.
