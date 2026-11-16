// Renders a mono f32le file through the Pitch Shifter (@jasper/audio-fx) for scripts/pitch-compare/compare.py:
//
//   pnpm exec tsx scripts/pitch-compare/render.ts <in.f32> <outdir> <sampleRate> <config>…
//
// <config> = <engine>:<quality>:<semitones>:<formants 0|1>, e.g. signalsmith:best:-1.5:1. Each output
// (<outdir>/<config with : → _>.f32) has the input's length, aligned at 0 (latency dropped, input padded with
// silence). Prints one JSON line per config: CPU seconds (user + system of this process) and the realtime factor.
// The Rubber Band module comes from JASPER_RUBBERBAND_WASM or packages/audio-fx/wasm/rubberband.wasm.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessor, rubberBandStatus, setRubberBandModule } from '../../packages/audio-fx/src/index.ts';

const [input, outdir, srArg, ...configs] = process.argv.slice(2);
if (!input || !outdir || !srArg || configs.length === 0) {
	console.error('usage: render.ts <in.f32> <outdir> <sampleRate> <engine:quality:semitones:formants>…');
	process.exit(2);
}
const sr = Number(srArg);
const wasm =
	process.env.JASPER_RUBBERBAND_WASM ??
	fileURLToPath(new URL('../../packages/audio-fx/wasm/rubberband.wasm', import.meta.url));
try {
	setRubberBandModule(new WebAssembly.Module(readFileSync(wasm)));
} catch (e) {
	console.error(`rubber band module unavailable (${String(e)}): rubberband-r3 renders with Signalsmith`);
}
const raw = readFileSync(input);
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
for (const cfg of configs) {
	const [engine, quality, st, formants] = cfg.split(':');
	const p = createProcessor('jasper.audio.pitch-shifter', sr, 1)!;
	const semis = Number(st);
	p.setParam('engine', engine!);
	p.setParam('quality', quality!);
	p.setParam('semitones', Math.trunc(semis));
	p.setParam('cents', Math.round((semis - Math.trunc(semis)) * 100));
	p.setParam('preserveFormants', formants === '1');
	p.reset();
	const lat = p.latency();
	const buf = new Float32Array(x.length + lat);
	buf.set(x);
	const t0 = process.cpuUsage();
	for (let i = 0; i < buf.length; i += 128) p.process([buf], i, Math.min(buf.length, i + 128));
	const cpu = process.cpuUsage(t0);
	const sec = (cpu.user + cpu.system) / 1e6;
	const out = buf.slice(lat, lat + x.length);
	writeFileSync(join(outdir, `${cfg.replaceAll(':', '_')}.f32`), Buffer.from(out.buffer));
	console.log(
		JSON.stringify({
			config: cfg,
			latency: lat,
			cpuSeconds: sec,
			realtimeFactor: x.length / sr / sec,
			rubberBand: rubberBandStatus().available,
		}),
	);
}
