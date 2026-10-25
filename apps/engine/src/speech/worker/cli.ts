#!/usr/bin/env node
// jasper-speech: runs one transcription in its own process (heavy work never runs in the engine process, D-07).
//
//   jasper-speech <spec.json> <out.json>        one transcription
//   jasper-speech probe <request.json> <out.json>   the execution-provider probe (spec 16 SG-001)
//
// The spec is a `SpeechJobSpec` (run.ts). Progress goes to stdout as NDJSON lines
// `{"type":"progress","fraction":0.42,"stage":"Transcribing 40%"}`, the providers really used as
// `{"type":"device","encoder":"webgpu","decoder":"cpu","attempt":1}`; the result is written to `out.json`
// (`SpeechJobOutput`). Exit codes: 0 done, 2 bad arguments, 3 failed (message on stderr and as
// `{"type":"error","message":…}`), 130 cancelled (SIGTERM/SIGINT).
import { readFileSync, writeFileSync } from 'node:fs';
import type { SpeechWorkerEvent } from '../../tools/worker-events.ts';
import { runProbe } from './probe.ts';
import { runSpeechJob, type SpeechJobSpec } from './run.ts';
import { CancelledError } from './whisper.ts';

const argv = process.argv.slice(2);
const emit = (o: SpeechWorkerEvent) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ac = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => ac.abort());

if (argv[0] === 'probe') {
	const [, reqPath, outPath] = argv;
	if (!reqPath || !outPath) {
		process.stderr.write('usage: jasper-speech probe <request.json> <out.json>\n');
		process.exit(2);
	}
	try {
		const out = await runProbe(JSON.parse(readFileSync(reqPath, 'utf8')));
		writeFileSync(outPath, JSON.stringify(out));
		emit({ type: 'done' });
		process.exit(0);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		emit({ type: 'error', message });
		process.stderr.write(`${message}\n`);
		process.exit(3);
	}
}

const [specPath, outPath] = argv;
if (!specPath || !outPath) {
	process.stderr.write('usage: jasper-speech <spec.json> <out.json>\n');
	process.exit(2);
}

try {
	const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SpeechJobSpec;
	if (!spec || typeof spec.modelDir !== 'string' || !spec.input || typeof spec.input !== 'object')
		throw new Error('Invalid job spec: modelDir and input are required');
	let last = -1;
	let lastStage = '';
	const out = await runSpeechJob(spec, {
		signal: ac.signal,
		onDevice: (d) => emit({ type: 'device', ...d }),
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
