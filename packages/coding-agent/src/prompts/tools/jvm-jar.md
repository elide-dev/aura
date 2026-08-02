Create or inspect a JAR.

- `create`: compile `language` + `code` in scratch space and write `output`.
  The main class is derived unless supplied. Output must stay inside the cwd;
  existing files require `overwrite: true`, and directories are refused.
- `inspect`: list an existing in-project `jar`; read-only.
