// Incremental JSON serialisation (ui-perf): `stringifyJson` against `JSON.stringify` on the scale project
// (200 sequences, ~5 000 clips, ≈ 8 MB), cold (first save after an edit) and after a one-clip edit (the autosave of
// a typical edit).  pnpm exec tsx packages/project/bench/json-cache.ts
import { performance } from 'node:perf_hooks';
import {
	applyTransaction,
	createCounterIdSource,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
	stringifyJson,
} from '../src/index.ts';
import { buildScaleProject } from './scale-project.ts';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = (fn: () => unknown, runs = 7) => {
	const out: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		fn();
		out.push(performance.now() - t0);
	}
	return median(out);
};
let doc: ProjectDocument = buildScaleProject({ sequences: Number(process.env.SCALE_SEQUENCES ?? 200) });
const ids = createCounterIdSource(900_000);
const seqId = Object.keys(doc.sequences)[3]!;
const clipId = Object.keys(doc.sequences[seqId]!.clips)[0]!;
let n = 0;
const edit = () => {
	const r = applyTransaction(
		doc,
		{
			label: 'Opacity',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'param.set', target: ['clip', clipId, 'opacity'], value: 10 + (n++ % 80) }],
		} as never,
		{ ids, now: () => '2026-10-09T00:00:00.000Z', revision: n, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error('edit failed');
	doc = r.document;
};
edit(); // the document is frozen from now on (Immer)
const env = () => makeEnvelope(doc, { revision: n, savedAt: '2026-10-09T00:00:00.000Z', platform: 'bench' });
const bytes = JSON.stringify(env()).length;
const native = time(() => JSON.stringify(env()));
const cold = (() => {
	const t0 = performance.now();
	const s = stringifyJson(env());
	const ms = performance.now() - t0;
	if (s !== JSON.stringify(env())) throw new Error('stringifyJson differs from JSON.stringify');
	return ms;
})();
const warm = time(() => {
	edit();
	const t0 = performance.now();
	stringifyJson(env());
	return performance.now() - t0;
});
const warmOnly: number[] = [];
for (let i = 0; i < 7; i++) {
	edit();
	const t0 = performance.now();
	const s = stringifyJson(env());
	warmOnly.push(performance.now() - t0);
	if (i === 0 && s !== JSON.stringify(env())) throw new Error('stringifyJson differs after an edit');
}
void warm;
console.log(
	`document ${(bytes / 1e6).toFixed(1)} MB: JSON.stringify ${native.toFixed(1)} ms; stringifyJson cold ${cold.toFixed(1)} ms, after a one-clip edit ${median(warmOnly).toFixed(1)} ms (median of 7)`,
);
