Create a JAR from Java/Kotlin source or inspect an existing JAR.

- `create` requires `language` + `code` + `output`; compile in scratch space,
  write to in-project `output`, and derive the manifest main class unless
  `mainClass` is supplied. Reject `.`, `..`,
  paths outside the cwd, existing directories, and existing files unless
  `overwrite: true`.
- `inspect` requires `jar`; list entries from an existing in-project JAR;
  read-only.
