#!/usr/bin/env node
// UI-6 i18n catalogue tool (workstream gaps, docs/wp-notes/gaps.md §UI-6).
//   node scripts/i18n.mjs            writes apps/web/src/i18n/en.json (every UI string the transform wraps, plus the
//                                    model's names the UI shows: effects, parameters, transitions, command labels)
//   node scripts/i18n.mjs --check    fails when es.json misses a string of en.json (the Spanish catalogue is complete)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUiText, scan } from '../apps/web/i18n/transform.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['apps/web/src', 'packages/ui/src'];
const keys = new Set();
const walk = (d) => {
	for (const f of readdirSync(d)) {
		const p = join(d, f);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(tsx|ts)$/.test(f) && !/\.test\.|\.d\.ts$|\.tokens\.ts$/.test(f) && !/[\\/]i18n[\\/]/.test(p))
			scan(readFileSync(p, 'utf8'), p, { found: (k) => keys.add(k) });
	}
};
for (const d of dirs) walk(join(root, d));
const uiCount = keys.size;
// Names that come from the model and are shown through `t()`.
const extra = JSON.parse(readFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), 'utf8'));
for (const k of extra) if (isUiText(k)) keys.add(k);
const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
const enPath = join(root, 'apps/web/src/i18n/en.json');
const esPath = join(root, 'apps/web/src/i18n/es.json');
if (process.argv.includes('--check')) {
	const es = JSON.parse(readFileSync(esPath, 'utf8'));
	const missing = sorted.filter((k) => typeof es[k] !== 'string' || !es[k].trim());
	const bad = sorted.filter((k) => {
		const v = es[k];
		if (typeof v !== 'string') return false;
		const want = [...k.matchAll(/\{(\d+)\}/g)]
			.map((m) => m[1])
			.sort()
			.join();
		const got = [...v.matchAll(/\{(\d+)\}/g)]
			.map((m) => m[1])
			.sort()
			.join();
		return want !== got;
	});
	if (missing.length || bad.length) {
		console.error(`es.json: ${missing.length} missing, ${bad.length} with other placeholders`);
		for (const k of [...missing, ...bad].slice(0, 40)) console.error(`  ${JSON.stringify(k)}`);
		process.exit(1);
	}
	console.log(`es.json covers all ${sorted.length} strings`);
} else {
	writeFileSync(enPath, `${JSON.stringify(sorted, null, 2)}\n`);
	console.log(`${relative(root, enPath)}: ${sorted.length} strings (${uiCount} from the UI sources)`);
}
