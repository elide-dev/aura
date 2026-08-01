Read project configuration and manifests to return the runtime's
build/run/test/install guidance. Read-only: executes, builds, and writes nothing.
Use before guessing when project manifests define the answer.

Returned CLI verbs describe the runtime; invoke only verbs exposed by innate
tools (`run`, `check`, `build`, `jvm_*`). Treat the rest as informational.

Guidance availability and wording depend on the installed runtime build;
failures return the runtime error verbatim.
