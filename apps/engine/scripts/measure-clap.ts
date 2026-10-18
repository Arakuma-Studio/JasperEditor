// Developer measurement of Describe-it search on a labelled library (spec 12 P6-E14 "verdict bands are measured on a
// held-out labelled set from our packs"; wp-note "Phase 6 → WP-E9"). Not part of the app or the tests: it needs the
// installed 780 MB model and real sound files.
//
//   pnpm exec tsx apps/engine/scripts/measure-clap.ts --model <dir> [--ffmpeg <ffmpeg>] [--compare] <manifest.json>...
//
// The labels are the manifests' own titles and types (written by the packs' authors and our curation, never by the
// vocabulary). Every distinct title (numbers removed) is a query; the sounds with that title are its positives, the
// sounds that share a type with them are related, the others unrelated. Reported, for the engine's configuration
// (`captionOf`, `rankKeys`): per verdict band, the query-sound pairs in it, how many are same-title / same-type /
// unrelated, the precision (same title or type) and the cumulative recall of same-title pairs; and the ranking by the
// model alone (titles hidden, the "folder of SFX_0023.wav" case): top-1, top-5 and mean reciprocal rank of the first
// same-title sound. `--compare` adds the alternatives the configuration was chosen from.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAP_RATE, meanEmbedding, wholeSoundWindows } from '../src/sounds/semantic/frontend.ts';
import {
	audioStats,
	type Calibration,
	calibrationOf,
	captionOf,
	matchOf,
	queryBias,
	rankKeys,
	referenceOf,
	VERDICT_BANDS,
	verdictOf,
} from '../src/sounds/semantic/score.ts';
import { SOUND_VOCABULARY } from '../src/sounds/semantic/vocab.ts';
import { ClapModel } from '../src/sounds/semantic/worker/clap.ts';

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const files: string[] = [];
let compare = false;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a === '--compare') compare = true;
	else if (a === '--model' || a === '--ffmpeg') flags.set(a, argv[++i] ?? '');
	else files.push(a);
}
const modelDir = flags.get('--model');
const ffmpeg = flags.get('--ffmpeg') || 'ffmpeg';
if (!modelDir || !files.length) {
	process.stderr.write('usage: measure-clap.ts --model <dir> [--ffmpeg <path>] [--compare] <manifest.json>...\n');
	process.exit(2);
}

type Sound = { file: string; title: string; types: string[]; stem: string };
const sounds: Sound[] = [];
for (const m of files) {
	const j = JSON.parse(readFileSync(m, 'utf8')) as { sounds: { file: string; title: string; types?: string[] }[] };
	for (const s of j.sounds)
		sounds.push({
			file: join(dirname(m), s.file),
			title: s.title,
			types: s.types ?? [],
			stem: s.title.toLowerCase().replace(/[\d_]+/g, ' ').replace(/\s+/g, ' ').trim(),
		});
}

function decode(file: string, seconds: number, start = 0): Float32Array {
	const r = spawnSync(
		ffmpeg,
		['-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file, '-ac', '1', '-ar', String(CLAP_RATE), '-f', 'f32le', 'pipe:1'],
		{ maxBuffer: 1 << 30 },
	);
	if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}`);
	const b = r.stdout;
	const out = new Float32Array(b.byteLength / 4);
	for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
	return out;
}

function duration(file: string): number {
	const r = spawnSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
	return Number(String(r.stdout).trim()) || 0;
}

const model = new ClapModel(modelDir, 8);
const t0 = performance.now();
const audio: Float32Array[] = [];
for (const s of sounds) {
	const windows = wholeSoundWindows(duration(s.file));
	audio.push(meanEmbedding(await model.embedAudio(windows.map((w) => decode(s.file, w.endSec - w.startSec, w.startSec)))));
}
const t1 = performance.now();
const stems = [...new Set(sounds.map((s) => s.stem))];
console.log(`sounds ${sounds.length}, title queries ${stems.length}, vocabulary ${SOUND_VOCABULARY.length}`);
console.log(`embedding: ${((t1 - t0) / sounds.length).toFixed(0)} ms per sound (8 threads, incl. decode and model load)`);
console.log(`bands (z): strong ≥ ${VERDICT_BANDS.strong}, plausible ≥ ${VERDICT_BANDS.plausible}, weak ≥ ${VERDICT_BANDS.weak}`);

const bands = ['strong', 'plausible', 'weak', 'none'] as const;
type Key = 'engine' | 'z' | 'cosine';

async function measure(name: string, cal: Calibration, caption: (q: string) => string, keys: readonly Key[]) {
	const stats = audio.map((a) => audioStats(a, cal));
	const ref = referenceOf(
		audio.map((a, i) => ({ a, stats: stats[i]! })),
		cal,
	);
	const queries = await model.embedTexts(stems.map(caption));
	const pairs = Object.fromEntries(bands.map((b) => [b, { same: 0, rel: 0, neg: 0 }])) as Record<
		(typeof bands)[number],
		{ same: number; rel: number; neg: number }
	>;
	let positives = 0;
	const rank = Object.fromEntries(keys.map((k) => [k, { top1: 0, top5: 0, mrr: 0 }])) as Record<
		Key,
		{ top1: number; top5: number; mrr: number }
	>;
	stems.forEach((stem, qi) => {
		const q = queries[qi]!;
		const bias = queryBias(q, ref);
		const ms = audio.map((a, i) => matchOf(a, stats[i]!, q, bias, ref));
		const engine = rankKeys(ms);
		const isPos = (i: number) => sounds[i]!.stem === stem;
		const types = new Set(sounds.filter((s) => s.stem === stem).flatMap((s) => s.types));
		const isRel = (i: number) => sounds[i]!.types.some((t) => types.has(t));
		ms.forEach((m, i) => {
			const b = verdictOf(m.z);
			if (isPos(i)) {
				pairs[b].same++;
				positives++;
			} else if (isRel(i)) pairs[b].rel++;
			else pairs[b].neg++;
		});
		for (const k of keys) {
			const order = ms
				.map((m, i) => ({ i, v: k === 'engine' ? engine[i]! : k === 'z' ? m.z : m.cosine }))
				.sort((a, b) => b.v - a.v || a.i - b.i);
			const first = order.findIndex((o) => isPos(o.i));
			if (first === 0) rank[k].top1++;
			if (first < 5) rank[k].top5++;
			rank[k].mrr += 1 / (first + 1);
		}
	});
	console.log(`${name}:`);
	let cum = 0;
	for (const b of bands) {
		const p = pairs[b];
		cum += p.same;
		const all = p.same + p.rel + p.neg;
		console.log(
			`  ${b.padEnd(9)} pairs ${String(all).padStart(6)}: same title ${String(p.same).padStart(4)}, same type ${String(p.rel).padStart(5)}, unrelated ${String(p.neg).padStart(6)}; precision ${(((p.same + p.rel) / Math.max(1, all)) * 100).toFixed(1)} %; cumulative same-title recall ${((cum / positives) * 100).toFixed(1)} %`,
		);
	}
	const n = stems.length;
	for (const k of keys)
		console.log(
			`  ranked by ${k === 'engine' ? 'z + query z (engine)' : k} (titles hidden): top-1 ${((rank[k].top1 / n) * 100).toFixed(1)} %, top-5 ${((rank[k].top5 / n) * 100).toFixed(1)} %, MRR ${(rank[k].mrr / n).toFixed(3)}`,
		);
}

const calCaption = calibrationOf(await model.embedTexts(SOUND_VOCABULARY.map(captionOf)));
await measure('engine (captions for vocabulary and queries)', calCaption, captionOf, compare ? ['engine', 'z', 'cosine'] : ['engine']);
if (compare) {
	const calRaw = calibrationOf(await model.embedTexts([...SOUND_VOCABULARY]));
	await measure('raw vocabulary, raw queries', calRaw, (q) => q, ['engine', 'z', 'cosine']);
	await measure('raw vocabulary, "the sound of" queries', calRaw, (q) => `the sound of ${q}`, ['engine', 'z', 'cosine']);
	await measure('raw vocabulary, "a recording of" queries', calRaw, (q) => `a recording of ${q}`, ['engine', 'z', 'cosine']);
	await measure('raw vocabulary, caption queries', calRaw, captionOf, ['engine', 'z', 'cosine']);
}
