# .stage — development appdir

`pnpm dev:engine` runs the engine with `JASPER_APPDIR=./.stage`. Only this README and the
`.gitkeep` skeleton are committed; everything the engine writes here (projects, media index,
caches, logs, renders, tmp) is gitignored. Delete the contents freely to reset local state.
