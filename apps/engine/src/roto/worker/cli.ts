#!/usr/bin/env node
// jasper-roto: runs one roto job (Roto Brush segmentation / propagation or face tracking) in its own process — heavy
// work never runs in the engine process (D-07).
//
//   jasper-roto <spec.json> <out.json>
//
// The spec is a `RotoJobSpec` (run.ts). Progress goes to stdout as NDJSON lines
// `{"type":"progress","fraction":0.42,"stage":"Frame 12/40"}` and `{"type":"frame","frame":12,"area":0.18,…}`; the
// result is written to `out.json` (`RotoJobOutput`). Exit codes: 0 done, 2 bad arguments, 3 failed (message on
// stderr and as `{"type":"error","message":…}`), 130 cancelled (SIGTERM/SIGINT).
import { readFileSync, writeFileSync } from 'node:fs';
import { CancelledError, type RotoJobSpec, runRotoJob } from './run.ts';

const [specPath, outPath] = process.argv.slice(2);
if (!specPath || !outPath) {
	process.stderr.write('usage: jasper-roto <spec.json> <out.json>\n');
	process.exit(2);
}
const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ac = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => ac.abort());

try {
	const spec = JSON.parse(readFileSync(specPath, 'utf8')) as RotoJobSpec;
	if (!spec || typeof spec.store !== 'string' || typeof spec.file !== 'string' || !spec.roto)
		throw new Error('Invalid job spec: store, file and roto are required');
	let last = -1;
	const out = await runRotoJob(spec, {
		signal: ac.signal,
		onProgress: (fraction, stage) => {
			const f = Math.round(fraction * 1000) / 1000;
			if (f === last) return;
			last = f;
			emit({ type: 'progress', fraction: f, stage });
		},
		onFrame: (frame, area, done, total) => emit({ type: 'frame', frame, area, done, total }),
	});
	writeFileSync(outPath, JSON.stringify(out));
	emit({ type: 'done' });
	process.exit(0);
} catch (e) {
	if (e instanceof CancelledError || ac.signal.aborted) process.exit(130);
	const message = e instanceof Error ? e.message : String(e);
	emit({ type: 'error', message });
	process.stderr.write(`${message}\n`);
	process.exit(3);
}
