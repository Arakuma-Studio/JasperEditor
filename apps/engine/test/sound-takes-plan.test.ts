// The sound-design plan over takes (spec 12 P6-E9: "Rotation, swap, variation cycling and REPEAT treat the takes of
// one file as its first variation pool"): the Phase 2 fixture's typewriter key cues are filled from the takes of one
// typing recording (the engine's ranking pool lists them after their recording), each cue a take, never the same take
// twice in a row, its alternatives sibling takes; the recording itself (multi-hit) is never picked. Deterministic.
import { type SoundEntry, type SoundTake, withOfferedTakes } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { parseTakeId } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { collectPlanCues, resolveStyle, selectPlanSounds } from '../src/sound-design/plan.ts';
import { fixture } from './sound-design-fixture.ts';

let sn = 0x700;
function entry(title: string, types: string[], over: Partial<SoundEntry> = {}): SoundEntry {
	sn++;
	return {
		id: `snd_${sn.toString(16).padStart(16, '0')}`,
		fingerprint: `q1:${sn.toString(16).padStart(64, '0')}`,
		title,
		types,
		tags: [],
		source: { type: 'starter', file: `${title}.wav` },
		license: 'CC0-1.0',
		author: 'Test',
		attribution: null,
		format: { durationSec: 0.6, sampleRate: 48000, channels: 2, container: 'wav' },
		descriptors: {
			durationSec: 0.6,
			peakSec: 0.02,
			onsetSec: 0.01,
			riseMs: 2,
			decayMs: 120,
			decays: true,
			tailSec: 0.4,
			centroidHz: 1500,
			rolloff85Hz: 5000,
			below150Share: 0.2,
			above6kShare: 0.05,
			flatness: 0.2,
			octaveBandsDb: [-20, -18, -16, -18, -20, -24, -30],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -20,
			maxMomentaryLufs: -14,
			truePeakDb: -2,
			stereoWidth: 0.2,
			headQuietSec: 0.01,
			loopable: false,
		},
		judge: { ok: true, score: 0.9, reasons: [], type: types[0] ?? 'hit' },
		indexedAt: '2026-10-18T00:00:00.000Z',
		analysisVersion: 2002,
		...over,
	} as SoundEntry;
}

/** A typing run of `n` key presses (multi-hit, too long) with `n` clean takes and one cut one. */
function typingRun(n: number): SoundEntry {
	const rec = entry('Keyboard typing run', ['key'], {
		format: { durationSec: 20, sampleRate: 48000, channels: 2, container: 'flac' },
		judge: { ok: false, score: 0.2, reasons: ['too-long', 'multi-hit'], type: 'key' },
	});
	const take = (index: number, flags: SoundTake['flags'] = []): SoundTake => ({
		index,
		startSec: index * 0.4,
		endSec: index * 0.4 + 0.15,
		headDb: -40,
		tailDb: -42,
		flags,
		strokes: 2,
		descriptors: {
			...rec.descriptors,
			durationSec: 0.15,
			peakSec: 0.006,
			tailSec: 0.12,
			headQuietSec: 0.004,
		},
		judge: { ok: true, score: 1, reasons: [], type: 'key' },
	});
	rec.takes = [...Array.from({ length: n }, (_, i) => take(i + 1)), take(n + 1, ['tail-cut'])];
	return rec;
}

function planWith(pool: SoundEntry[], seed = 7) {
	const f = fixture();
	const doc = f.get();
	const request = { projectId: doc.projectId, sequenceId: f.seqId, style: { seed } } as never;
	const seq = doc.sequences[f.seqId]!;
	const style = resolveStyle(request, seq);
	const collected = collectPlanCues(doc, seq, request, style, { mgTemplates: mgRegistry });
	return selectPlanSounds(doc, seq, collected.cues, pool, style);
}

describe('the plan rotates over a recording’s takes', () => {
	const rec = typingRun(8);
	const pool = withOfferedTakes(
		[
			rec,
			entry('Key a', ['key']),
			entry('Key b', ['key']),
			entry('Punch hit', ['hit']),
			entry('Air whoosh', ['whoosh']),
			entry('Soft thump', ['thump']),
			entry('Low boom', ['boom']),
		].sort((a, b) => (a.id < b.id ? -1 : 1)),
	);

	it('fills the typewriter keys with takes of the typing run, never the same take twice in a row', () => {
		const sel = planWith(pool);
		const keys = sel.picks.filter((p) => p.cue.types[0] === 'key');
		expect(keys.length).toBeGreaterThan(3);
		const ids = keys.map((p) => p.sounds[0]!.entry.id);
		for (const id of ids) expect(parseTakeId(id)?.parentId).toBe(rec.id);
		for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
		// the cut take is never offered, the recording never picked
		for (const p of keys)
			for (const s of p.sounds) {
				expect(s.entry.id).not.toBe(`${rec.id}~t9`);
				expect(s.entry.id).not.toBe(rec.id);
			}
		// alternatives are sibling takes (vary the take)
		const alts = keys[0]!.sounds.slice(1).map((s) => parseTakeId(s.entry.id)?.parentId);
		expect(alts.length).toBeGreaterThan(0);
		expect(alts.every((p) => p === rec.id)).toBe(true);
		// deterministic
		expect(planWith(pool).picks.map((p) => p.sounds[0]!.entry.id)).toEqual(
			sel.picks.map((p) => p.sounds[0]!.entry.id),
		);
	});
});
