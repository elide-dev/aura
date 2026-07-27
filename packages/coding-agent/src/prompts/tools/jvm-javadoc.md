Generate Javadoc HTML API docs from Java source into `output` (a directory
inside the cwd, default `javadoc-out`; `.`, `..` and paths outside the cwd are
refused). The docs are generated in a scratch directory and the tree is then
copied to `output`. This is one of the two runtime tools that write into your
project, and the only one that deletes: an existing `output` is refused unless
you pass `overwrite: true`, and `overwrite: true` only ever replaces a
previous docs output (an empty directory, or one containing `index.html`) —
never a directory holding anything else. Always name a dedicated docs
directory, never a source directory. Open `<output>/index.html` to browse the
result.
