Ask the runtime for its own build/run/test/install guidance for this project.
It reads the working directory in place — detecting the runtime's project
configuration and any package manifests it finds there — and returns a text
report covering the commands available, the project's declared name and
version, and its declared dependencies. Read-only: nothing is executed, built,
or written.

Use it before guessing how to build, test, or install a project on the runtime,
and when the project's own manifest is the authority on the answer. Optional
`cwd` (defaults to the session directory) and `timeoutMs`; there are no other
inputs, because the guidance is derived entirely from what the directory
contains.

The report names the runtime's own CLI commands (`run`, `build`, `test`,
`install`, …). Those are the runtime's shell verbs, not shell commands to run
directly — reach the ones with an innate equivalent through the innate tools
(`run`, `check`, `build`, the `jvm_*` suite), and treat the rest as
informational about the project's shape.

Note: the guidance comes from the runtime itself, so its availability and
wording depend on the installed runtime build. If the runtime cannot produce
advice, its own error is returned verbatim rather than being reinterpreted.
