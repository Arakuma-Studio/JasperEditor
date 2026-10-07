#!/usr/bin/env node
// jasper-speech: runs one transcription in its own process (heavy work never runs in the engine process, D-07).
//
//   jasper-speech <spec.json> <out.json>
//
// The spec is a `SpeechJobSpec` (run.ts). Progress goes to stdout as NDJSON lines
// `{"type":"progress","fraction":0.42,"stage":"Transcribing 40%"}`; the result is written to `out.json`
// (`SpeechJobOutput`). Exit codes: 0 done, 2 bad arguments, 3 failed (message on stderr and as
// `{"type":"error","message":…}`), 130 cancelled (SIGTERM/SIGINT).
import { readFileSync, writeFileSync } from 'node:fs';
import { runSpeechJob, type SpeechJobSpec } from './run.ts';
import { CancelledError } from './whisper.ts';

const [specPath, outPath] = process.argv.slice(2);
if (!specPath || !outPath) {
	process.stderr.write('usage: jasper-speech <spec.json> <out.json>\n');
	process.exit(2);
}
const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ac = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => ac.abort());

try {
	const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SpeechJobSpec;
	let last = -1;
	let lastStage = '';
	const out = await runSpeechJob(spec, {
		signal: ac.signal,
		onProgress: (fraction, stage) => {
			const f = Math.round(fraction * 1000) / 1000;
			if (f === last && stage === lastStage) return;
			last = f;
			lastStage = stage;
			emit({ type: 'progress', fraction: f, stage });
		},
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
