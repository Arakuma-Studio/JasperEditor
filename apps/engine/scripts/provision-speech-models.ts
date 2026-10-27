// Provisions speech models for the browser e2e suite (`pnpm e2e`, scripts/e2e-prepare.mjs): downloads each listed
// model of the engine's pinned catalogue into a cache directory through the engine's own installer — the pinned
// revision, every file checked against its SHA-256 (`SpeechModelStore.install`, resumable) — and fails (exit 1) when
// a model cannot be installed, so a spec that needs it never passes without it. A model already installed and intact
// is a no-op. The e2e server (e2e/serve.mjs) links the cache's models into its throwaway appdir.
//
//   tsx apps/engine/scripts/provision-speech-models.ts --dir <cache> <model-id>…
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog } from '../src/processing/models.ts';
import { SpeechModelStore } from '../src/speech/models.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--dir');
const dir = at >= 0 ? argv[at + 1] : undefined;
const ids = argv.filter((a, i) => a !== '--dir' && i !== at + 1);
if (!dir || !ids.length) {
	console.error('usage: provision-speech-models.ts --dir <cache> <model-id>…');
	process.exit(2);
}
mkdirSync(resolve(dir), { recursive: true });
const store = new SpeechModelStore(resolve(dir), loadCatalog({}).speech);
let failed = false;
for (const id of ids) {
	const entry = store.entry(id);
	if (!entry) {
		console.error(`[e2e] unknown speech model ${id} (not in the engine's pinned catalogue)`);
		failed = true;
		continue;
	}
	try {
		let last = -1;
		const r = await store.install(id, {
			onProgress: (done, total) => {
				const pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 100;
				if (pct !== last) {
					last = pct;
					process.stdout.write(`[e2e] ${id}: ${pct} %\n`);
				}
			},
		});
		if (!(await store.installed(entry))) throw new Error('the files do not verify after the install');
		console.log(`[e2e] ${id}: ${r.alreadyInstalled ? 'already installed' : 'installed'} in ${r.dir}`);
	} catch (e) {
		console.error(`[e2e] ${id} could not be installed: ${e instanceof Error ? e.message : String(e)}`);
		failed = true;
	}
}
process.exit(failed ? 1 : 0);
