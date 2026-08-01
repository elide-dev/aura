Resolve dependencies and compile supported source sets without producing
artifacts. Use as a fast build-integrity check after edits; use `build` when
artifacts are required.

This is not project-specific static analysis or a TypeScript typecheck: the
runtime strips TypeScript types instead of running `tsc`. Run the project's
declared typecheck/check command when TypeScript correctness is the contract.
