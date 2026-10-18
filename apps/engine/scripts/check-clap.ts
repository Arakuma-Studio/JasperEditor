// Developer check of the Describe-it search front end against the reference implementation (spec 12 P6-E14, WP-E9),
// run on a machine that has the export's `parity-vectors.json` (scripts/models/export-clap.py) and, optionally, an
// installed model directory. Not part of the app or the tests (it needs the 780 MB model and Python's outputs).
//
//   pnpm exec tsx apps/engine/scripts/check-clap.ts <parity-vectors.json> <dir with vocab.json, merges.txt> [--model <dir>]
//
// Prints the largest log-mel difference (dB), the tokenizer mismatches and, with --model, the cosine between the
// engine's embeddings (TypeScript front end + ONNX Runtime for Node) and PyTorch's. Exits 1 when a check fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clapLogMel } from '../src/sounds/semantic/frontend.ts';
import { ClapTokenizer } from '../src/sounds/semantic/tokenizer.ts';
import { ClapModel } from '../src/sounds/semantic/worker/clap.ts';

type Vectors = {
	mel: { name: string; samples: number[]; features: number[][] }[];
	tokens: { text: string; ids: number[] }[];
	audioEmbeds?: number[][];
	textEmbeds?: number[][];
};

const [vecPath, tokDir, flag, modelDir] = process.argv.slice(2);
if (!vecPath || !tokDir) {
	process.stderr.write('usage: check-clap.ts <parity-vectors.json> <tokenizer dir> [--model <dir>]\n');
	process.exit(2);
}
const v = JSON.parse(readFileSync(vecPath, 'utf8')) as Vectors;
let ok = true;
let worst = 0;
for (const m of v.mel) {
	const got = clapLogMel(Float32Array.from(m.samples));
	let d = 0;
	m.features.forEach((row, t) =>
		row.forEach((x, k) => {
			d = Math.max(d, Math.abs(got[t * row.length + k]! - x));
		}),
	);
	worst = Math.max(worst, d);
	console.log(`mel ${m.name}: max |Δ| = ${d.toExponential(3)} dB`);
}
if (worst > 1e-3) ok = false;
const tok = new ClapTokenizer(
	readFileSync(join(tokDir, 'vocab.json'), 'utf8'),
	readFileSync(join(tokDir, 'merges.txt'), 'utf8'),
);
let bad = 0;
for (const t of v.tokens) {
	const got = tok.encode(t.text);
	if (JSON.stringify(got) !== JSON.stringify(t.ids)) {
		bad++;
		console.log(`tokens differ for ${JSON.stringify(t.text)}: ${JSON.stringify(got)} vs ${JSON.stringify(t.ids)}`);
	}
}
console.log(`tokenizer: ${v.tokens.length - bad} of ${v.tokens.length} identical`);
if (bad) ok = false;
if (flag === '--model' && modelDir && v.audioEmbeds && v.textEmbeds) {
	const model = new ClapModel(modelDir, 8);
	const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
		let s = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < a.length; i++) {
			s += a[i]! * b[i]!;
			na += a[i]! * a[i]!;
			nb += b[i]! * b[i]!;
		}
		return s / Math.sqrt(na * nb);
	};
	const t0 = performance.now();
	const audio = await model.embedAudio(v.mel.map((m) => Float32Array.from(m.samples)));
	const t1 = performance.now();
	const texts = await model.embedTexts(v.tokens.map((t) => t.text));
	const t2 = performance.now();
	const ca = audio.map((a, i) => cos(a, v.audioEmbeds![i]!));
	const ct = texts.map((a, i) => cos(a, v.textEmbeds![i]!));
	console.log(`audio cosine vs PyTorch: min ${Math.min(...ca).toFixed(7)} (${audio.length} sounds, ${(t1 - t0).toFixed(0)} ms incl. load)`);
	console.log(`text cosine vs PyTorch: min ${Math.min(...ct).toFixed(7)} (${texts.length} texts, ${(t2 - t1).toFixed(0)} ms incl. load)`);
	const t3 = performance.now();
	await model.embedAudio(v.mel.map((m) => Float32Array.from(m.samples)));
	console.log(`audio warm: ${((performance.now() - t3) / v.mel.length).toFixed(0)} ms per 10 s window (8 threads)`);
	if (Math.min(...ca, ...ct) < 0.999) ok = false;
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
