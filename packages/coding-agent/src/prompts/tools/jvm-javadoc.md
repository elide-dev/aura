Generate Javadoc HTML from Java source into a dedicated in-project directory
(`javadoc-out` default). Reject `.`, `..`, paths outside the cwd, and existing
output unless `overwrite: true`.

Overwrite only empty directories or recognized Javadoc output (`index.html`
plus Javadoc scaffolding); never other directories. Use a dedicated docs
directory, never source or static-site directories. Open `<output>/index.html`
to browse the result.
