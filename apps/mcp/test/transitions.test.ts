// Transition tools (S10:TUI-060) without an engine: the list_transitions summaries, the clip expansion of
// apply_default_transitions, effect id names and the get_timeline "Transitions:" block.
import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type MediaAsset,
	type Sequence,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { timelineTable, transitionLines } from '../src/format.ts';
import {
	expandForMedia,
	listTransitions,
	resolveTransitionDefaults,
	TRANSITION_GUIDE,
	transitionEffectId,
	transitionSummary,
} from '../src/tools/transitions.ts';

let fp = 0;
/** A probed 10 s 1080p30 video with stereo audio. */
function videoAsset(): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind: 'video',
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `clip-${fp}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-09-30T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

/**
 * Two linked video+audio clips cut at frame 100 (clip a: media frames 30–130, clip b: 60–160), a 20-frame
 * cross dissolve at the cut, a 10-frame dip to black at b's tail and a 15-frame audio fade in at a's head.
 */
function sample() {
	const ids = createSeededIdSource(11);
	let doc = createEmptyProject({ ids, name: 'Transitions', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => '2026-09-30T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', label: 't', origin: 'user', commands } as never,
			ctx,
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		return r.result;
	};
	const media = tx([
		{ type: 'media.register', asset: videoAsset() },
		{ type: 'media.register', asset: videoAsset() },
	]).results as { mediaId: string }[];
	const placed = tx([
		{
			type: 'clip.place',
			source: { mediaId: media[0]!.mediaId },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: media[1]!.mediaId },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
		},
	]).results as { clipIds: string[] }[];
	const [va, aa] = placed[0]!.clipIds as [string, string];
	const [vb, ab] = placed[1]!.clipIds as [string, string];
	const added = tx([
		{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.cross-dissolve', duration: 20 },
		{ type: 'transition.add', clipId: vb, edge: 'out', effectId: 'jasper.dip-to-black', duration: 10 },
		{ type: 'transition.add', clipId: aa, edge: 'in', effectId: 'jasper.constant-gain', duration: 15 },
	]).results as { transitionId: string }[];
	const [dissolve, dip, fade] = added.map((r) => r.transitionId) as [string, string, string];
	const seq = Object.values(doc.sequences)[0]! as Sequence;
	return { doc, seq, va, aa, vb, ab, dissolve, dip, fade };
}

describe('list_transitions summaries', () => {
	it('describes a two-sided transition: cut, span, handles and what the span uses', () => {
		const { doc, seq, va, vb, dissolve } = sample();
		expect(transitionSummary(doc, seq, seq.transitions[dissolve]!)).toEqual({
			id: dissolve,
			effectId: 'jasper.cross-dissolve',
			type: 'cross-dissolve',
			label: 'Cross Dissolve',
			medium: 'video',
			track: 'V1',
			trackId: seq.videoTracks[0]!.id,
			cut: 100,
			cutTimecode: '00:00:03:10',
			span: { start: 90, end: 110, startTimecode: '00:00:03:00', endTimecode: '00:00:03:20' },
			duration: 20,
			alignment: 'center',
			oneSided: false,
			outgoingClipId: va,
			incomingClipId: vb,
			// a: 300 media frames − in 30 − 100 used = 170 after its out-point; b starts at media frame 60.
			handles: { outgoingTail: 170, incomingHead: 60 },
			uses: { outgoingTail: 10, incomingHead: 10 },
		});
	});

	it('describes fades as one-sided with a fixed alignment and one clip handle', () => {
		const { doc, seq, vb, dip, fade, aa } = sample();
		expect(transitionSummary(doc, seq, seq.transitions[dip]!)).toMatchObject({
			type: 'dip-to-black',
			label: 'Dip to Black',
			cut: 200,
			span: { start: 190, end: 200 },
			alignment: 'end-at-cut',
			oneSided: true,
			outgoingClipId: vb,
			incomingClipId: null,
			handles: { outgoingTail: 140 },
		});
		const f = transitionSummary(doc, seq, seq.transitions[fade]!);
		expect(f).toMatchObject({
			medium: 'audio',
			track: 'A1',
			cut: 0,
			span: { start: 0, end: 15 },
			alignment: 'start-at-cut',
			oneSided: true,
			incomingClipId: aa,
			handles: { incomingHead: 30 },
		});
		expect(f.uses).toBeUndefined();
	});

	it('lists in track order then time, filtered by range', () => {
		const { doc, seq, dissolve, dip, fade } = sample();
		expect(listTransitions(doc, seq).map((t) => t.id)).toEqual([dissolve, dip, fade]);
		expect(listTransitions(doc, seq, { from: 0, to: 50 }).map((t) => t.id)).toEqual([fade]);
		expect(listTransitions(doc, seq, { from: 105, to: 195 }).map((t) => t.id)).toEqual([dissolve, dip]);
		expect(listTransitions(doc, seq, { from: 200 })).toEqual([]);
	});

	it('marks transitions whose clips are gone or whose effect is unknown', () => {
		const { doc, seq, dissolve } = sample();
		const t = { ...seq.transitions[dissolve]!, outgoingClipId: 'clp_gone', incomingClipId: null };
		expect(transitionSummary(doc, seq, t)).toMatchObject({ cut: null, handles: {} });
		const u = { ...seq.transitions[dissolve]!, effectId: 'acme.swirl' };
		expect(transitionSummary(doc, seq, u)).toMatchObject({ label: 'acme.swirl', supported: false });
	});
});

describe('apply_default_transitions helpers', () => {
	it('adds linked partners of the requested media', () => {
		const { doc, va, aa, vb, ab } = sample();
		expect(expandForMedia(doc, [va, vb], ['video'])).toEqual([va, vb]);
		expect(expandForMedia(doc, [va, vb], ['video', 'audio'])).toEqual([va, vb, aa, ab]);
		expect(expandForMedia(doc, [aa], ['video'])).toEqual([aa, va]);
		expect(expandForMedia(doc, ['clp_unknown'], ['video', 'audio'])).toEqual(['clp_unknown']);
	});

	it('accepts short type names and effect ids', () => {
		expect(transitionEffectId('dip-to-black')).toBe('jasper.dip-to-black');
		expect(transitionEffectId(' jasper.constant-gain ')).toBe('jasper.constant-gain');
		expect(TRANSITION_GUIDE).toMatch(/start-at-cut/);
		expect(TRANSITION_GUIDE).toMatch(/W_TRANSITION_SHORTENED/);
	});
});

describe('get_timeline transitions block', () => {
	it('lists transitions per track with span, alignment and length', () => {
		const { doc, seq, dissolve, dip, fade } = sample();
		const text = timelineTable(doc, seq);
		expect(text).toMatch(/\nTransitions:\n/);
		expect(text).toContain(
			`  V1 ${dissolve} Cross Dissolve 00:00:03:00–00:00:03:20 (90–110) center, 20 frames`,
		);
		expect(text).toContain(`  V1 ${dip} Dip to Black 00:00:06:10–00:00:06:20 (190–200) fade out, 10 frames`);
		expect(text).toContain(`  A1 ${fade} Constant Gain 00:00:00:00–00:00:00:15 (0–15) fade in, 15 frames`);
		expect(transitionLines(seq, 120, 180)).toEqual([]);
		expect(timelineTable(doc, seq, { from: 120, to: 180 })).not.toMatch(/Transitions:/);
	});
});

describe('apply_default_transitions defaults (S10:TUI-034)', () => {
	it('call arguments, else the open editor’s preferences, else the built-ins', () => {
		expect(resolveTransitionDefaults({}, null)).toEqual({
			videoEffectId: 'jasper.cross-dissolve',
			audioEffectId: 'jasper.constant-power',
			alignment: 'center',
			source: 'built-in',
		});
		const editor = { video: 'jasper.dip-to-black', audio: 'jasper.constant-gain', alignment: 'end-at-cut' };
		expect(resolveTransitionDefaults({}, editor)).toEqual({
			videoEffectId: 'jasper.dip-to-black',
			audioEffectId: 'jasper.constant-gain',
			alignment: 'end-at-cut',
			source: 'editor preferences',
		});
		expect(
			resolveTransitionDefaults({ videoType: 'cross-dissolve', alignment: 'center' }, editor),
		).toMatchObject({
			videoEffectId: 'jasper.cross-dissolve',
			audioEffectId: 'jasper.constant-gain',
			alignment: 'center',
		});
		expect(
			resolveTransitionDefaults(
				{ videoType: 'dip-to-black', audioType: 'constant-gain', alignment: 'start-at-cut' },
				null,
			).source,
		).toBe('call');
		// Invalid editor values (wrong medium, unknown alignment) are ignored.
		expect(
			resolveTransitionDefaults({}, { video: 'jasper.constant-power', audio: 'x', alignment: 'middle' }),
		).toMatchObject({ videoEffectId: 'jasper.cross-dissolve', alignment: 'center', source: 'built-in' });
		expect(TRANSITION_GUIDE).toMatch(/set_transition_defaults/);
	});
});
