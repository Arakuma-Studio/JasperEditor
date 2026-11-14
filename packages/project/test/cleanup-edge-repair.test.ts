// Edge repair (docs/wp-notes/transcript-cleanup.md "Edge repair"): Clean Up repairs cut edges it did not make — cuts
// inside a word's decay or attack on a timeline cut by hand or by an earlier pass — by extending the clip and its
// linked picture into the media, as `edge` findings. The fixture holds the reporter's source's own voice analysis
// planes and stored words around three edges the hand-fixed revision (549) extended and the audit could not repair
// (`fixtures/cleanup-edge-repair-source.json`: "es …|" 242.90 → 242.95, "el|" 1191.67 → 1191.72, "|No había" 1155.68
// → 1155.65).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import { auditCutEdges } from '../src/cleanup/edge-audit.ts';
import { cleanupApplyCommands } from '../src/cleanup/review.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { checkInvariants } from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

type Window = {
	from: number;
	level: string;
	voicing: string;
	flatness: string;
	classes: string;
	words: Array<[string, number, number, number | null]>;
};
const FIX = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-edge-repair-source.json', import.meta.url), 'utf8'),
) as {
	ellipsis: Window;
	el: Window;
	no: Window;
	boton: Window;
	pue: Window;
	levels: CleanupVoice['levels'];
};
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const FPS = 60;

function voiceOf(w: Window): CleanupVoice {
	const level = bytes(w.level);
	return {
		level,
		voicing: bytes(w.voicing),
		flatness: bytes(w.flatness),
		classes: bytes(w.classes),
		frameCount: level.length,
		levels: FIX.levels,
	};
}

/**
 * A 60 fps timeline of the window's media cut at frame `cut` (window seconds × 60): the clip before it, then a later
 * part of the window (`[from, to)` seconds) — picture and sound linked, or the sound alone over one picture clip.
 */
function cutTimeline(
	w: Window,
	cut: number,
	later: [number, number],
	o: { side: 'in' | 'out'; linked?: boolean },
) {
	const voice = voiceOf(w);
	const H = new Harness({ preset: 'hd-1080p-60' });
	const seconds = voice.frameCount / 100;
	const mediaId = (
		H.ok([{ type: 'media.register', asset: videoAsset({ seconds, fps: { num: 60, den: 1 } }) }])
			.results[0] as {
			mediaId: string;
		}
	).mediaId;
	const place = (a: number, b: number, at: number) => ({
		type: 'clip.place',
		source: { mediaId },
		sourceRange: { in: { flicks: S(a) }, out: { flicks: S(b) } },
		at,
		tracks: { video: 'V1', audio: ['A1'] },
		mode: 'overwrite',
		...(o.linked === false ? { video: false } : {}),
	});
	// an out edge: the cut clip first; an in edge: an earlier part first, then the clip starting at the cut
	const first = o.side === 'out' ? place(0, cut / FPS, 0) : place(later[0], later[1], 0);
	const len = Math.round((later[1] - later[0]) * FPS);
	const second = o.side === 'out' ? place(later[0], later[1], cut) : place(cut / FPS, seconds - 0.01, len);
	H.ok([first, second]);
	if (o.linked === false)
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: 0 }, out: { flicks: S(seconds - 0.05) } },
				at: 0,
				tracks: { video: 'V1' },
				mode: 'overwrite',
				audio: false,
			},
		]);
	const words = w.words.map(([text, s0, e, c]) => ({
		text,
		start: S(Math.max(0, s0)),
		end: S(e),
		confidence: c ?? 0.95,
	}));
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
	const a1 = H.clips('A1');
	const clip = o.side === 'out' ? a1[0]! : a1[1]!;
	return { H, voice, clip };
}

describe('the cut-edge audit repairs the word it cuts', () => {
	it.each([
		// [window, side, edge (window s × 60), the hand-fixed edge (window s × 60), the other part]
		['ellipsis (“es …|”: the “…” token over the decay)', FIX.ellipsis, 'out', 36, 39, [0.9, 1.1]],
		['el (“el|”: two breath-class frames in its decay)', FIX.el, 'out', 28, 31, [0.9, 1.15]],
		['no (“|No había”: an early timestamp over the breath)', FIX.no, 'in', 65, 63, [0.0, 0.25]],
	] as const)('%s', (_name, w, side, cut, fixed, later) => {
		const { H, voice, clip } = cutTimeline(w, cut, [...later], { side });
		const row = auditCutEdges(H.doc, H.seq, () => voice).find((r) => r.clipId === clip.id && r.side === side);
		expect(row).toBeDefined();
		// the repaired edge (window frames) reaches the hand-fixed one, within two frames beyond it
		const fix =
			row!.fixFrame === null
				? Number.NaN
				: row!.fixFrame - clip.start + clip.sourceIn / (FLICKS_PER_SECOND / FPS);
		const reach = side === 'out' ? fix - fixed : fixed - fix;
		expect(reach).toBeGreaterThanOrEqual(0);
		expect(reach).toBeLessThanOrEqual(2);
		expect(row!.repair).toMatchObject({ kind: 'extend', safe: true });
	});
});

describe('a repair adds only the word up to −38 dBFS, never the next syllable', () => {
	const fixOf = (w: Window, cut: number, later: [number, number]) => {
		const { H, voice, clip } = cutTimeline(w, cut, later, { side: 'out' });
		const row = auditCutEdges(H.doc, H.seq, () => voice).find(
			(r) => r.clipId === clip.id && r.side === 'out',
		)!;
		const frame =
			row.fixFrame === null ? null : row.fixFrame - clip.start + clip.sourceIn / (FLICKS_PER_SECOND / FPS);
		return { row, frame };
	};

	it('ends where the decay reaches −38 dBFS, not in the deeper silence beyond (“botón.|” at 376.45)', () => {
		// the decay of "botón." falls under −38 dBFS two frames after the cut; the snapper's clean boundary lay 6 frames out
		const { row, frame } = fixOf(FIX.boton, 33, [0.9, 1.15]);
		expect(row.repair).toMatchObject({ kind: 'extend', safe: true });
		expect(frame).toBe(35);
	});

	it('never extends into the next word’s onset after a dip; offers the trim back to the dip (“que | pue-” at 2714.03)', () => {
		const { row, frame } = fixOf(FIX.pue, 44, [1.0, 1.25]);
		expect(row.repair).toMatchObject({ kind: 'trim', safe: false, review: 'onset' });
		// back to 2713.967, where the hand-fixed revision 549 cut "pue-"
		expect(frame).toBe(40);
	});
});

describe('Clean Up repairs cut edges it did not make', () => {
	it('extends the clip and its picture into the media as an accepted edge finding; rejected, nothing changes', () => {
		const { H, voice, clip } = cutTimeline(FIX.el, 28, [0.9, 1.15], { side: 'out' });
		const v1 = H.clips('V1')[0]!;
		const run = (decisions = {}) => {
			const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => voice, decisions });
			if (!a.ok) throw new Error(a.message);
			return a;
		};
		const a = run();
		const f = a.findings.find((x) => x.kind === 'edge' && x.reason.params.clipId === clip.id)!;
		expect(f).toMatchObject({ suggested: 'remove', reason: { params: { side: 'out', frames: 3 } } });
		expect(a.plan.extend).toContainEqual({ clipId: clip.id, side: 'out', frames: 3, findingId: f.id });
		const before = H.doc;
		const snap = JSON.parse(JSON.stringify(before));
		const next = H.clips('A1')[1]!;
		H.ok(cleanupApplyCommands(H.seqId, a, {}, new Set()));
		// the sound and its picture grow by the same frames from the same media: still in sync; the rest moves
		const [a0, a2] = H.clips('A1');
		const [v0, v2] = H.clips('V1');
		expect([a0!.duration, v0!.duration]).toEqual([28 + 3, v1.duration + 3]);
		expect([a2!.start, v2!.start]).toEqual([next.start + 3, next.start + 3]);
		expect(a0!.sourceIn).toBe(v0!.sourceIn);
		expect(checkInvariants(H.doc)).toEqual([]);
		// undo: the previous document is untouched
		expect(before).toEqual(snap);
		// rejected (by id or by kind): no extension, nothing to apply
		const off = run({ reject: [f.fingerprint] });
		expect(off.plan.extend?.some((e) => e.clipId === clip.id && e.side === 'out')).toBeFalsy();
		const none = run({ rejectKinds: ['edge'] });
		expect(none.plan.extend).toBeUndefined();
		expect(
			cleanupApplyCommands(H.seqId, none, { rejectKinds: ['edge'] }, new Set(), {
				rememberRejections: false,
			}),
		).toEqual([]);
	});

	it('leaves the repair for review when the picture cannot follow (sound cut under another picture clip)', () => {
		const { H, voice, clip } = cutTimeline(FIX.el, 28, [0.9, 1.15], { side: 'out', linked: false });
		const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => voice });
		if (!a.ok) throw new Error(a.message);
		const f = a.findings.find((x) => x.kind === 'edge' && x.reason.params.clipId === clip.id);
		expect(f).toMatchObject({ suggested: 'review', reason: { params: { review: 'picture' } } });
		expect(a.plan.extend?.some((e) => e.clipId === clip.id)).toBeFalsy();
	});
});
