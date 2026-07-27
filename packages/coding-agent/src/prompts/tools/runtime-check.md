Validate the current project on the managed runtime: resolve dependencies
and compile every source set without producing artifacts or executing user
code. Use this as a fast "does the project still hold together" gate after
edits. Optional `cwd` selects the project directory; `timeoutMs` bounds the
validation.
