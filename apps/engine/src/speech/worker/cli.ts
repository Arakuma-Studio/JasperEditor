#!/usr/bin/env node
// jasper-speech: runs one transcription in its own process (heavy work never runs in the engine process, D-07).
//
//   jasper-speech <spec.json> <out.json>        one transcription
//   jasper-speech score <spec.json> <out.json>  teacher-forced scoring of readings (spec 17 SC-032)
//   jasper-speech probe <request.json> <out.json>   the execution-provider probe (spec 16 SG-001)
//
// The spec is a `SpeechJobSpec` (run.ts), or a `ScoreJobSpec` (score.ts) for `score`. Progress goes to stdout as
// NDJSON lines `{"type":"progress","fraction":0.42,"stage":"Transcribing 40%"}`, the providers really used as
// `{"type":"device","encoder":"webgpu","decoder":"cpu","attempt":1}`; the result is written to `out.json`
// (`SpeechJobOutput` / `ScoreJobOutput`). Exit codes: 0 done, 2 bad arguments, 3 failed (message on stderr and as
// `{"type":"error","message":…}`), 4 refused — the input cannot be processed as given (`{"type":"error",
// "code":"SPEECH_…","message":…}`, never retried on another device), 130 cancelled (SIGTERM/SIGINT; `score` exits
// within 1 s even in the middle of an ONNX Runtime run, SC-036).
import { readFileSync, writeFileSync } from 'node:fs';
import type { SpeechWorkerEvent } from '../../tools/worker-events.ts';
import { runProbe } from './probe.ts';
import { runSpeechJob, type SpeechJobSpec } from './run.ts';
import { runScoreJob } from './score.ts';
import { CancelledError, SpeechRefusal } from './whisper.ts';

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

const scoring = argv[0] === 'score';
const [specPath, outPath] = scoring ? argv.slice(1) : argv;
if (!specPath || !outPath) {
	process.stderr.write(`usage: jasper-speech ${scoring ? 'score ' : ''}<spec.json> <out.json>\n`);
	process.exit(2);
}
if (scoring)
	// SC-036: a cancelled scoring job ends within 1 s, even while an encoder pass is running
	ac.signal.addEventListener('abort', () => setTimeout(() => process.exit(130), 1000).unref(), { once: true });

let last = -1;
let lastStage = '';
const runOpts = {
	signal: ac.signal,
	onDevice: (d: { encoder: string; decoder: string; attempt: number }) => emit({ type: 'device', ...d }),
	onProgress: (fraction: number, stage: string) => {
		const f = Math.round(fraction * 1000) / 1000;
		if (f === last && stage === lastStage) return;
		last = f;
		lastStage = stage;
		emit({ type: 'progress', fraction: f, stage });
	},
};

try {
	const raw = JSON.parse(readFileSync(specPath, 'utf8')) as unknown;
	let out: unknown;
	if (scoring) out = await runScoreJob(raw, runOpts);
	else {
		const spec = raw as SpeechJobSpec;
		if (!spec || typeof spec.modelDir !== 'string' || !spec.input || typeof spec.input !== 'object')
			throw new Error('Invalid job spec: modelDir and input are required');
		out = await runSpeechJob(spec, runOpts);
	}
	writeFileSync(outPath, JSON.stringify(out));
	emit({ type: 'done' });
	process.exit(0);
} catch (e) {
	if (e instanceof CancelledError || ac.signal.aborted) process.exit(130);
	const message = e instanceof Error ? e.message : String(e);
	if (e instanceof SpeechRefusal) {
		emit({ type: 'error', code: e.code, message });
		process.stderr.write(`${message}\n`);
		process.exit(4);
	}
	emit({ type: 'error', message });
	process.stderr.write(`${message}\n`);
	process.exit(3);
}
