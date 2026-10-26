// The golden recording of the Fast preset (spec 14 TC-070): its events (head chatter, an abandoned take, a false start,
// a filler between pauses, off-script chatter, an in-line restart, a standalone marker, breaths, long pauses, a cough),
// its script and a 30 fps sequence holding it. Shared by the golden, review and command tests and the UI tests.

import type { SynthEvent, SynthRecording } from './cleanup-synth.ts';
import { Harness, videoAsset } from './helpers.ts';

export const GOLDEN_SCRIPT = [
	'Hoy vamos a crear un juego de carreras en tres días.',
	'Primero diseñé la carretera con curvas muy cerradas.',
	'Después programé los coches con físicas sencillas.',
	'Al final añadí música y efectos de sonido.',
].join('\n');

export const GOLDEN_EVENTS: SynthEvent[] = [
	{ say: 'vale ya está grabando esto', keep: false },
	{ pauseS: 2.0 },
	{ say: 'Hoy vamos a crear un juego', keep: false },
	{ pauseS: 0.9 },
	{ breathS: 0.3 },
	{ say: 'Hoy vamos a crear un juego de carreras en tres días.', keep: true },
	{ pauseS: 1.5 },
	{ say: 'Primero,', keep: false },
	{ pauseS: 0.8 },
	{ say: 'primero diseñé la carretera', keep: true },
	{ pauseS: 0.35 },
	{ say: 'eh', keep: false },
	{ pauseS: 0.35 },
	{ say: 'con curvas muy cerradas.', keep: true },
	{ pauseS: 1.5 },
	{ coughS: 0.25 },
	{ pauseS: 1.5 },
	{ say: 'madre mía qué calor hace aquí hoy', keep: false },
	{ pauseS: 1.2 },
	{ breathS: 0.35 },
	{ say: 'Después programé los coches,', keep: false, gapS: 0.05 },
	{ say: 'después programé los coches con físicas sencillas.', keep: true },
	{ pauseS: 1.0 },
	{ say: 'Al final añadí música y efectos de sonido.', keep: true },
	{ pauseS: 0.8 },
	{ say: 'bueno', keep: false },
	{ pauseS: 1.5 },
];

/** A 30 fps sequence with the recording on A1, its transcript and its script attached. */
export function goldenSequence(rec: SynthRecording, opts: { script?: boolean } = {}) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: rec.durationS, kind: 'audio' }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	H.ok([
		{
			type: 'transcript.create',
			mediaId,
			language: 'es',
			origin: 'manual',
			words: rec.words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
		},
	]);
	if (opts.script !== false)
		H.ok([{ type: 'cleanup.configure', script: { name: 'Guion', text: GOLDEN_SCRIPT } }]);
	return { H, mediaId };
}
