// A JasperEditor project exercising what the interchange formats carry, built through real commands, and a
// comparable summary of a sequence (clip timing, sources, Motion/Opacity, audio levels, effects, transitions, …).
import {
	type Clip,
	checkInvariants,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import { Harness, videoAsset } from '../../../project/test/helpers.ts';

export { Harness };

/** Sequence preset ids by rate (all 1920×1080). */
export const PRESET_FOR: Record<string, string> = {
	'24000/1001': 'hd-1080p-23.976',
	'24/1': 'hd-1080p-24',
	'25/1': 'hd-1080p-25',
	'30000/1001': 'hd-1080p-29.97',
	'30/1': 'hd-1080p-30',
	'50/1': 'hd-1080p-50',
	'60000/1001': 'hd-1080p-59.94',
	'60/1': 'hd-1080p-60',
};

export function withPath(a: ReturnType<typeof videoAsset>, path: string): ReturnType<typeof videoAsset> {
	return {
		...a,
		originalName: path.split('/').pop()!,
		locators: [...a.locators, { type: 'path', path, relativeToProject: null }],
	};
}

export type Rich = { h: Harness; ids: Record<string, string> };

/**
 * V1: A (linked to A1, keyframed Motion, Gaussian Blur) → cross dissolve → B (opacity 50, multiply);
 * V2: C at 2× speed, a red solid; V3: a text clip; A1/A2: audio with keyframed volume and pan; markers.
 */
export function richProject(opts: { preset?: string; fps?: { num: number; den: number } } = {}): Rich {
	const h = new Harness({ preset: opts.preset ?? 'hd-1080p-30' });
	const fps = opts.fps ?? { num: 30, den: 1 };
	const reg = (name: string, seconds: number, audio = true) =>
		(
			h.ok([
				{
					type: 'media.register',
					asset: withPath(videoAsset({ seconds, fps, audio }), `/footage/${name}.mov`),
					name,
				},
			]).results[0] as { mediaId: string }
		).mediaId;
	const a = reg('A_take1', 20);
	const b = reg('B roll', 20);
	const c = reg('C-fast', 30, false);
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 10,
			tracks: { video: 'V1' },
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 90 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 70,
			tracks: { video: 'V1' },
			sourceRange: { in: { sourceFrames: 15 }, out: { sourceFrames: 75 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: c },
			at: 0,
			tracks: { video: 'V2' },
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 40 } },
		},
	]);
	const [va, aa] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	const [vb, ab] = (r.results[1] as { clipIds: string[] }).clipIds as [string, string];
	const [vc] = (r.results[2] as { clipIds: string[] }).clipIds as [string];
	const r2 = h.ok([
		{
			type: 'keyframe.add',
			target: ['clip', va, 'transform', 'position'],
			at: { frames: 0 },
			value: [960, 540],
		},
		{
			type: 'keyframe.add',
			target: ['clip', va, 'transform', 'position'],
			at: { frames: 30 },
			value: [1200, 400],
		},
		{ type: 'param.set', target: ['clip', va, 'transform', 'scale'], value: 150 },
		{ type: 'param.set', target: ['clip', va, 'transform', 'rotation'], value: 12.5 },
		{ type: 'effect.add', target: { clipId: va }, effectId: 'jasper.gaussian-blur', ref: '$blur' },
		{ type: 'param.set', target: ['effect', '$blur', 'radius'], value: 8 },
		{ type: 'param.set', target: ['clip', vb, 'opacity'], value: 50 },
		{ type: 'clip.update', clipId: vb, patch: { blendMode: 'multiply' } },
		{
			type: 'transition.add',
			clipId: vb,
			edge: 'in',
			effectId: 'jasper.cross-dissolve',
			duration: 10,
			alignment: 'center',
		},
		{ type: 'clip.setSpeed', clipIds: [vc], rate: 2, ripple: false },
		{ type: 'keyframe.add', target: ['clip', aa, 'volumeDb'], at: { frames: 0 }, value: -12 },
		{ type: 'keyframe.add', target: ['clip', aa, 'volumeDb'], at: { frames: 20 }, value: 0 },
		{ type: 'param.set', target: ['clip', ab, 'pan'], value: -40 },
		{ type: 'clip.addSolid', at: 40, duration: 20, track: 'V2', color: [1, 0, 0, 1], ref: '$solid' },
		{ type: 'clip.addText', at: 20, duration: 40, track: 'V3', content: { text: 'Title ✓' }, ref: '$text' },
		{ type: 'marker.add', frame: 5, name: 'Start', comment: 'first', color: 'rose' },
		{ type: 'marker.add', frame: 100, name: 'Chapter', duration: 10, markerType: 'chapter', color: 'green' },
		{ type: 'marker.add', clipId: vb, flicks: { sourceFrames: 20 }, name: 'clip note', color: 'yellow' },
	]);
	const ok = checkInvariants(h.doc, { effects: defaultRegistries().effects });
	if (ok.length) throw new Error(`rich project invalid: ${JSON.stringify(ok)}`);
	return { h, ids: { a, b, c, va, aa, vb, ab, vc, solid: r2.refs.$solid!, text: r2.refs.$text! } };
}

const stripIds = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(stripIds);
	if (v && typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (
				k === 'id' ||
				k === 'trackId' ||
				k === 'linkId' ||
				k === 'groupId' ||
				k === 'mediaId' ||
				k === 'syntheticId' ||
				k === 'sequenceId' ||
				k === 'fontId' ||
				k === 'transcriptId'
			)
				continue;
			o[k] = stripIds(x);
		}
		return o;
	}
	return v;
};

/** A comparable summary of a sequence: per track, its clips in order (ids stripped), transitions and markers. */
export function summarize(
	doc: ProjectDocument,
	seqId: string,
	opts: { keep?: (keyof Clip | string)[] } = {},
): unknown {
	const s = doc.sequences[seqId] as Sequence;
	const clipsOf = (trackId: string) =>
		(Object.values(s.clips) as Clip[]).filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
	const pos = new Map<string, string>();
	const tracks = (list: Sequence['videoTracks'], tag: string) =>
		list.map((t, i) =>
			clipsOf(t.id).map((c, k) => {
				pos.set(c.id, `${tag}${i + 1}:${k}`);
				const any = c as Clip & Record<string, unknown>;
				const media =
					typeof any.mediaId === 'string' ? (doc.media[any.mediaId] as MediaAsset | undefined) : undefined;
				const base: Record<string, unknown> = {
					kind: c.kind,
					start: c.start,
					duration: c.duration,
					sourceIn: c.sourceIn,
					speed: c.speed.rate,
					reverse: c.speed.reverse,
					...(media ? { media: media.originalName } : {}),
				};
				for (const k of opts.keep ?? []) if (k in any) base[k] = stripIds(any[k]);
				return base;
			}),
		);
	const out = {
		video: tracks(s.videoTracks, 'V'),
		audio: tracks(s.audioTracks, 'A'),
		transitions: Object.values(s.transitions)
			.map((t) => ({
				effectId: t.effectId,
				duration: t.duration,
				alignment: t.alignment,
				from: t.outgoingClipId ? pos.get(t.outgoingClipId) : null,
				to: t.incomingClipId ? pos.get(t.incomingClipId) : null,
			}))
			.sort((a, b) => String(a.to ?? a.from).localeCompare(String(b.to ?? b.from))),
		links: Object.values(s.links)
			.map((l) =>
				l.members
					.map((m) => pos.get(m))
					.sort()
					.join('+'),
			)
			.sort(),
	};
	return out;
}

export function addCaptions(h: Harness): void {
	h.ok([
		{ type: 'caption.add', at: 0, duration: 30, text: 'Hello there' },
		{ type: 'caption.add', at: 40, duration: 30, text: 'Second line\nwith a break' },
	]);
}
