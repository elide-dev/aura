Generate Javadoc HTML API docs from Java source into `output` (a directory
relative to the cwd, default `javadoc-out`). The docs are generated in a
scratch directory and the tree is then copied to `output`. This is one of the
two runtime tools that write into your project: an existing `output` is
refused unless you pass `overwrite: true`, and with `overwrite: true` the
directory is replaced wholesale. Open `<output>/index.html` to browse the
result.
