// Stray fragments and A / V slivers (docs/wp-notes/transcript-cleanup.md "Stray fragments and A / V slivers"), from a
// user's by-ear review of a real cut: short kept pieces between cuts that held no script word ("mmm", a laugh, a
// syllable of another take) stayed as their own clips, and audio slivers whose picture an agent had hidden played
// under the next shot. Clean Up of an already cut sequence (each piece its own linked V1 / A1 clip), 30 fps.
import { describe, expect, it } from 'vitest';
import type { CleanupVoice, CleanupWordIn } from '../src/cleanup/detector.ts';
import { cleanupApplyCommands } from '../src/cleanup/review.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import type { Sequence } from '../src/schema/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const q = (db: number) => Math.round((db + 120) * 2);
const SCRIPT = 'Hola a todos. Esto es un juego de carreras.';

/** Words "text@start-end" (source seconds). */
const words = (s: string): CleanupWordIn[] =>
	s
		.trim()
		.split(/\s+/)
		.map((x) => {
			const m = /^(.*)@([\d.]+)-([\d.]+)$/.exec(x)!;
			return { text: m[1]!, start: S(Number(m[2])), end: S(Number(m[3])), confidence: 0.95 };
		});

/** Floor −60, speech −10 dBFS; speech at −16 over `voiced` spans (source seconds), silence elsewhere. */
function voiceOf(seconds: number, voiced: ReadonlyArray<readonly [number, number]>): CleanupVoice {
	const n = Math.round(seconds * 100);
	const v = {
		classes: new Uint8Array(n),
		level: new Uint8Array(n).fill(q(-60)),
		voicing: new Uint8Array(n).fill(20),
		flatness: new Uint8Array(n).fill(100),
		frameCount: n,
		levels: { floorDb: -60, speechDb: -10, speechThresholdDb: -45, breathFloorDb: -55 },
	};
	for (const [a, b] of voiced)
		for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) {
			v.level[k] = q(-16);
			v.classes[k] = 2;
			v.voicing[k] = 200;
		}
	return v as CleanupVoice;
}

/** A cut sequence: each `[sourceIn, sourceOut]` (s) placed after the previous one as a linked V1 / A1 pair. */
function cutOf(pieces: ReadonlyArray<readonly [number, number]>, w: CleanupWordIn[]) {
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: 20 }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	let at = 0;
	for (const [a, b] of pieces) {
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: S(a) }, out: { flicks: S(b) } },
				at,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		at += Math.round((b - a) * 30);
	}
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words: w }]);
	return { H, mediaId };
}

const clipsOn = (seq: Sequence, kind: 'video' | 'audio') =>
	Object.values(seq.clips)
		.filter((c) => c.kind === kind)
		.sort((a, b) => a.start - b.start);

/** Every audio clip plays under its own linked picture at the same moment of the source. */
function expectNoOrphans(seq: Sequence) {
	for (const a of clipsOn(seq, 'audio')) {
		const v = (seq.links[a.linkId ?? '']?.members ?? [])
			.map((id) => seq.clips[id])
			.find((c) => c?.kind === 'video');
		expect(v, `audio ${a.start}+${a.duration} without its picture`).toBeDefined();
		expect([v!.start, v!.duration, v!.sourceIn]).toEqual([a.start, a.duration, a.sourceIn]);
	}
}

describe('short kept pieces between cuts', () => {
	// three shots, voice from edge to edge (no pause to cut): "Hola a todos." | a 0.4 s stray | "Esto es un juego"
	const shots = [
		[1.2, 2.2],
		[5.0, 5.4],
		[8.2, 9.2],
	] as const;
	const voice = voiceOf(20, shots);
	const said = (stray: string) =>
		words(`Hola@1.2-1.5 a@1.5-1.6 todos.@1.6-2.2 ${stray} Esto@8.2-8.5 es@8.5-8.6 un@8.6-8.7 juego@8.7-9.2`);

	it('a whole short clip off the script is a fragment; accepted, it goes with its picture', () => {
		// a laugh the recogniser wrote as "ja"
		const { H } = cutOf(shots, said('ja@5.05-5.35'));
		const plan = (accept: string[] = []) => {
			const a = analyzeSequenceCleanup({
				doc: H.doc,
				seq: H.seq,
				voice: () => voice,
				settings: FAST_SETTINGS,
				script: SCRIPT,
				decisions: { accept },
			});
			if (!a.ok) throw new Error(a.message);
			return a;
		};
		const a = plan();
		const f = a.findings.find((x) => x.kind === 'fragment');
		expect(f).toMatchObject({ suggested: 'review', reason: { params: { text: 'ja', why: 'off-script' } } });
		expect(a.plan.ranges).toEqual([]);
		const b = plan([f!.id]);
		// the clip's 12 frames go (30–42), nothing else
		expect(b.plan.ranges.map((r) => [r.start, r.end])).toEqual([[30, 42]]);
		H.ok(cleanupApplyCommands(H.seq.id, b, { accept: [f!.id] }, new Set()));
		expect(clipsOn(H.seq, 'video').map((c) => c.duration)).toEqual([30, 30]);
		expectNoOrphans(H.seq);
	});

	it('a scripted short phrase between cuts stays', () => {
		const { H } = cutOf(
			shots,
			words('Hola@1.2-1.5 a@1.5-1.6 todos.@1.6-2.2 Esto@5.05-5.2 es@5.2-5.35 un@8.2-8.5 juego@8.5-9.2'),
		);
		const a = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
			script: SCRIPT,
		});
		if (!a.ok) throw new Error(a.message);
		expect(a.findings.filter((x) => x.kind === 'fragment')).toEqual([]);
	});

	it("audio left under another shot after its picture was hidden goes with that shot's overhang", () => {
		// "…todos. | (4 frames of voice) | Esto es…": the sliver's picture was deleted and the shot before stretched over it
		const { H } = cutOf(
			[
				[1.2, 2.2],
				[5.0, 5.0 + 4 / 30],
				[8.2, 9.2],
			],
			said(''),
		);
		const [firstV, sliverV] = clipsOn(H.seq, 'video');
		const sliverA = clipsOn(H.seq, 'audio')[1]!;
		H.ok([{ type: 'clip.unlink', clipIds: [sliverA.id] }]);
		H.ok([{ type: 'clip.lift', clipIds: [sliverV!.id] }]);
		H.ok([{ type: 'clip.trim', clipId: firstV!.id, edge: 'out', deltaFrames: 4, linked: false }]);
		const a = analyzeSequenceCleanup({
			doc: H.doc,
			seq: H.seq,
			voice: () => voice,
			settings: FAST_SETTINGS,
			script: SCRIPT,
		});
		if (!a.ok) throw new Error(a.message);
		expect(a.findings.find((x) => x.kind === 'fragment')).toMatchObject({
			suggested: 'remove',
			reason: { params: { why: 'voice' } },
		});
		expect(a.plan.ranges.map((r) => [r.start, r.end])).toEqual([[30, 34]]);
		H.ok(cleanupApplyCommands(H.seq.id, a, {}, new Set()));
		expectNoOrphans(H.seq);
		expect(clipsOn(H.seq, 'video').map((c) => [c.start, c.duration])).toEqual([
			[0, 30],
			[30, 30],
		]);
	});
});
