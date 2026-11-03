// Vitest setup file of happy-dom projects (`setupFiles` after `fast-check-setup.ts`): gives every test file the
// browser's `localStorage` and `sessionStorage`, fresh per file, as happy-dom's own window has them.
//
// Node 25+ ships Web Storage on `globalThis` (`localStorage` is `undefined` without `--localstorage-file`, with an
// ExperimentalWarning; `sessionStorage` is Node's in-memory one). Vitest's happy-dom environment copies window keys
// onto the global only when the global lacks them (or they are in its own fixed list, which has `Storage` but not
// the two instances), so under Node 26 the tests saw Node's values instead of happy-dom's: `localStorage.getItem`
// threw and code that guards `typeof localStorage` silently stopped persisting. This puts happy-dom's `Storage` back,
// which is what the same tests got on Node 20–24.
if (typeof document !== 'undefined' && typeof Storage === 'function') {
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		if ((globalThis as Record<string, unknown>)[name] instanceof Storage) continue;
		Object.defineProperty(globalThis, name, { value: new Storage(), configurable: true, writable: true });
	}
}
