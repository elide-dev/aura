Validate the current project through the managed runtime's project build:
resolve dependencies and compile supported source sets without requesting
deliverable artifacts. This is a fast build-integrity gate after edits, not a
replacement for project-specific static analysis. In particular, the runtime
strips TypeScript types rather than running `tsc`; use the project's declared
typecheck/check command when TypeScript type correctness is the contract.
Optional `cwd` selects the project directory; `timeoutMs` bounds validation.
