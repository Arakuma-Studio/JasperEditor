// Edge micro-fades of cleanup joins (spec 14 TC-024) in the offline mixer every export path uses: the samples at a
// join follow the equal-power curve over the fade's 4 ms (sub-frame, sample-accurate), the same inside a nested
// sequence; a transition on an edge wins over its micro-fade. Persisted-state repair (TC-030): unreadable
// `Sequence.cleanup` and `AudioClip.edgeFades` are reported by INV-CLEANUP and repaired conservatively, idempotently.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type ClipReader,
	checkInvariants,
	createCounterIdSource,
	type ProjectDocument,
	type RenderAudioClip,
	type RenderSnapshot,
	renderMixToBuffers,
	repairDocument,
	resolveAudioTransitions,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function snapOf(h: Harness, seqId = h.seqId): RenderSnapshot {
	return buildRenderSnapshot(h.doc, seqId, {
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
}

const constant = (clip: RenderAudioClip, at: { length: number }): ClipReader => {
	const ch = clip.channels.map.length || 2;
	let left = at.length;
	return {
		channels: ch,
		read(out, frames) {
			const n = Math.min(frames, left);
			for (let c = 0; c < ch; c++) out[c]!.fill(0.5, 0, n);
			left -= n;
			return n;
		},
		close() {},
	};
};

/** 30 fps, 48 kHz: 1600 samples per frame. A 20 s audio clip on A1 cut at [60, 90) with 4 ms fades. */
function cut(fadeMs = 4) {
	const h = new Harness();
	const m = h.registerVideo({ kind: 'audio', seconds: 20 });
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	const a1 = h.clips('A1')[0]!.id;
	h.ok([{ type: 'cleanup.apply', clipIds: [a1], ranges: [{ start: 60, end: 90 }], fadeMs }]);
	return h;
}

async function around(h: Harness, seqId: string, joinFrame: number) {
	const out = await renderMixToBuffers({
		snapshot: snapOf(h, seqId),
		openClip: constant,
		startSample: (joinFrame - 1) * 1600,
		length: 3200,
	});
	return out[0]!;
}

function expectEqualPowerJoin(x: Float32Array) {
	const steady = x[0]!;
	expect(steady).toBeGreaterThan(0.1);
	const J = 1600; // the join sample
	const n = 192; // 4 ms at 48 kHz
	for (let k = 1; k <= n; k++) {
		// fade out: sample J − k is k samples before the end
		expect(x[J - k]! / steady).toBeCloseTo(Math.sin((Math.PI / 2) * (k / n)), 2);
		// fade in: sample J + k − 1 is k − 1 samples after the start
		expect(x[J + k - 1]! / steady).toBeCloseTo(Math.sin((Math.PI / 2) * ((k - 1) / n)), 2);
	}
	expect(x[J - n - 10]! / steady).toBeCloseTo(1, 6);
	expect(x[J + n + 10]! / steady).toBeCloseTo(1, 6);
}

describe('edge micro-fades in the mix', () => {
	it('follow the equal-power curve sample by sample on both sides of a join', async () => {
		const h = cut();
		expectEqualPowerJoin(await around(h, h.seqId, 60));
		// without fades the join is a hard cut
		const h0 = cut(0);
		const hard = await around(h0, h0.seqId, 60);
		expect(hard[1599]! / hard[0]!).toBeCloseTo(1, 6);
		expect(hard[1600]! / hard[0]!).toBeCloseTo(1, 6);
	});

	it('render the same inside a nested sequence', async () => {
		const h = cut();
		const ids = h.clips('A1').map((c) => c.id);
		const r = h.ok([{ type: 'clip.nest', clipIds: ids, name: 'Voice' }]);
		const nestId = (r.results[0] as { sequenceId: string }).sequenceId;
		expect(nestId).not.toBe(h.seqId);
		const outer = await around(h, h.seqId, 60);
		expectEqualPowerJoin(outer);
	});

	it('an audio transition on an edge replaces its micro-fade', () => {
		const h = cut();
		const [left, right] = h.clips('A1');
		const t = resolveAudioTransitions(h.doc, h.seq);
		expect(t.clips.get(left!.id)!.fades).toHaveLength(1);
		// a one-sided fade-in transition on the right clip
		const seq = structuredClone(h.seq);
		seq.transitions.trn_x = {
			id: 'trn_x',
			trackId: right!.trackId,
			effectId: 'jasper.constant-power',
			effectVersion: 1,
			outgoingClipId: null,
			incomingClipId: right!.id,
			duration: 6,
			alignment: 'start-at-cut',
			params: {},
		} as never;
		const t2 = resolveAudioTransitions(h.doc, seq);
		const fades = t2.clips.get(right!.id)!.fades;
		expect(fades).toHaveLength(1);
		expect(fades[0]!.edge).toBeUndefined();
		expect(fades[0]!.frames).toBe(6);
	});
});

describe('INV-CLEANUP and repair', () => {
	it('reports unreadable cleanup state and edge fades, keeps the readable parts, idempotently', () => {
		const h = cut();
		const doc = structuredClone(h.doc) as ProjectDocument;
		const seq = doc.sequences[h.seqId] as unknown as Record<string, unknown>;
		seq.cleanup = {
			settings: { presetId: 'builtin.natural', overrides: { gaps: { maxGapS: 0.3, bogus: 1 }, edges: { outDb: 'x' } } },
			script: { name: 'S', text: 'hola' },
			rejected: ['ok~1~pause~1~2~00000000', 'bad fp', 'ok~1~pause~1~2~00000000'],
			lists: { es: { fillers: ['eh', 7] }, 'not a lang': { fillers: ['x'] } },
			extra: true,
		};
		const clips = Object.values(doc.sequences[h.seqId]!.clips);
		(clips[0] as unknown as Record<string, unknown>).edgeFades = { outMs: 400, inMs: 3 };
		(clips[1] as unknown as Record<string, unknown>).edgeFades = 'nope';
		const issues = checkInvariants(doc);
		expect(issues.filter((i) => i.invariant === 'INV-CLEANUP').length).toBe(3);
		const { document, report } = repairDocument(doc, createCounterIdSource(900));
		expect(checkInvariants(document)).toEqual([]);
		const s = document.sequences[h.seqId] as unknown as { cleanup: unknown };
		expect(s.cleanup).toEqual({
			settings: { presetId: 'builtin.natural', overrides: { gaps: { maxGapS: 0.3 } } },
			script: { name: 'S', text: 'hola' },
			rejected: ['ok~1~pause~1~2~00000000'],
			lists: { es: { fillers: ['eh'] } },
		});
		const fixed = Object.values(document.sequences[h.seqId]!.clips).map(
			(c) => (c as unknown as { edgeFades?: unknown }).edgeFades,
		);
		expect(fixed).toEqual([{ inMs: 3 }, undefined]);
		expect(report.map((r) => r.action)).toEqual(
			expect.arrayContaining(['repair-cleanup', 'repair-edge-fades']),
		);
		const again = repairDocument(document, createCounterIdSource(901));
		expect(again.report.filter((r) => r.action.includes('cleanup') || r.action.includes('edge'))).toEqual([]);
	});

	it('edge fades only on audio clips', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1', audio: ['A1'] } }]);
		const doc = structuredClone(h.doc) as ProjectDocument;
		const v = Object.values(doc.sequences[h.seqId]!.clips).find((c) => c.kind === 'video')!;
		(v as unknown as Record<string, unknown>).edgeFades = { inMs: 4 };
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-CLEANUP')).toBe(true);
		const { document } = repairDocument(doc, createCounterIdSource(5));
		expect(checkInvariants(document)).toEqual([]);
	});
});
