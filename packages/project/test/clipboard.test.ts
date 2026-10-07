// Clipboard (wp-clipboard, S01 §20 CLB-001…009, ID-005; S03:FX-011/012, EC-023/032, KF table): payload build,
// validation and encoding, and the paste commands: clip.paste (overwrite / insert, targeting, cross-project
// resolution, frame-rate conversion, every M2 field), clip.pasteAttributes / clip.removeAttributes, effect.paste,
// keyframe.paste and project.pasteItems.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	buildClipsPayload,
	buildEffectsPayload,
	buildItemsPayload,
	buildKeyframesPayload,
	type Clip,
	type ClipboardPayload,
	checkInvariants,
	clipboardText,
	createStaticMgRegistry,
	decodeClipboardHtml,
	defaultRegistries,
	EMPTY_PROBE,
	encodeClipboardHtml,
	flicksPerFrame,
	type MediaAsset,
	type MgTemplateInfo,
	parseClipboardPayload,
	RATES,
	resolveAgentAddresses,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const F30 = flicksPerFrame(RATES.r30);
const roundTrip = (p: ClipboardPayload) => JSON.parse(JSON.stringify(p)) as ClipboardPayload;

/** Every id-shaped string of a value (for "all pasted ids are new" checks). */
function idsIn(v: unknown, out = new Set<string>()): Set<string> {
	if (typeof v === 'string' && /^[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{16}$/.test(v)) out.add(v);
	else if (Array.isArray(v)) for (const x of v) idsIn(x, out);
	else if (v && typeof v === 'object') for (const x of Object.values(v)) idsIn(x, out);
	return out;
}

const ok = (h: Harness) =>
	expect(checkInvariants(h.doc, { effects: defaultRegistries().effects })).toEqual([]);

function placeVideo(h: Harness, at: number, opts: { seconds?: number; v?: string; audio?: boolean } = {}) {
	const m = h.registerVideo({ seconds: opts.seconds ?? 10, audio: opts.audio });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at,
			tracks: { video: opts.v ?? 'V1' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
		},
	]);
	return { mediaId: m, clipIds: (r.results[0] as { clipIds: string[] }).clipIds };
}

const lutAsset = (): Omit<MediaAsset, 'id'> => ({
	kind: 'lut',
	fingerprint: `q1:${'7'.repeat(64)}`,
	originalName: 'look.cube',
	sizeBytes: 100,
	container: 'cube',
	probe: EMPTY_PROBE,
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_lut' }],
	derivation: null,
	importedAt: '2026-10-01T00:00:00.000Z',
	lut: { format: 'cube', dimensions: 3, size: 2, title: null, domainMin: [0, 0, 0], domainMax: [1, 1, 1] },
});

/** A video with linked audio (fade-in transition, keyframed blur), an animated text and a keyframed shape. */
function richProject(seed = 1) {
	const h = new Harness({ seed });
	const { clipIds } = placeVideo(h, 10);
	const [v, a] = clipIds as [string, string];
	const r = h.ok([
		{ type: 'effect.add', target: { clipId: v }, effectId: 'jasper.gaussian-blur', ref: '$blur' },
		{ type: 'keyframe.add', target: ['effect', '$blur', 'radius'], at: { frames: 0 }, value: 0 },
		{ type: 'keyframe.add', target: ['effect', '$blur', 'radius'], at: { frames: 30 }, value: 20 },
		{ type: 'transition.add', clipId: v, edge: 'in', effectId: 'jasper.dip-to-black', duration: 10 },
		{
			type: 'clip.addText',
			at: 20,
			duration: 60,
			track: 'V2',
			content: { text: 'Hello ünïcode ✓' },
			textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'fade' } },
			ref: '$t',
		},
		{
			type: 'clip.addShape',
			at: 30,
			duration: 40,
			track: 'V3',
			shape: { type: 'rect', size: [200, 100], fill: [1, 0, 0, 1], cornerRadius: 8 },
			ref: '$s',
		},
		{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'size'], at: { frames: 0 }, value: [200, 100] },
		{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'size'], at: { frames: 20 }, value: [400, 100] },
		{ type: 'marker.add', frame: 5, name: 'seq marker' },
	]);
	return { h, v, a, text: r.refs.$t!, shape: r.refs.$s! };
}

// ---------------------------------------------------------------- payload (CLB-001, CLB-002, CLB-009)

describe('clipboard payload (CLB-001/002/009)', () => {
	it('round-trips through text/html with non-ASCII text, and rejects HTML without the marker', () => {
		const { h, text } = richProject();
		const p = buildClipsPayload(h.doc, h.seqId, [text]);
		const json = JSON.stringify(p);
		const html = encodeClipboardHtml(json, clipboardText(p));
		expect(clipboardText(p)).toBe('Hello ünïcode ✓');
		expect(decodeClipboardHtml(html)).toBe(json);
		expect(decodeClipboardHtml('<b>hello</b>')).toBeNull();
		expect(decodeClipboardHtml('<span data-jasper-clipboard="!!!"></span>')).toBeNull();
		// Emoji outside the BMP survive the base64 round trip.
		expect(decodeClipboardHtml(encodeClipboardHtml('{"x":"🎬"}', ''))).toBe('{"x":"🎬"}');
	});

	it('validates with zod: foreign data, other versions, oversize and malformed entities are refused', () => {
		const { h, text } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [text]));
		expect(parseClipboardPayload('not json')).toMatchObject({ ok: false, code: 'E_SCHEMA' });
		expect(parseClipboardPayload({ hello: 1 })).toMatchObject({
			ok: false,
			code: 'E_SCHEMA',
		});
		const v2 = parseClipboardPayload({ ...p, version: 2 });
		expect(v2).toMatchObject({ ok: false, code: 'E_SCHEMA' });
		expect(parseClipboardPayload(`${' '.repeat(20 * 1024 * 1024)}{}`)).toMatchObject({
			ok: false,
			code: 'E_LIMIT',
		});
		const bad = roundTrip(p);
		(bad.clips!.clips[0] as { duration: number }).duration = -4;
		expect(parseClipboardPayload(bad)).toMatchObject({ ok: false, code: 'E_SCHEMA' });
		expect(parseClipboardPayload({ ...p, clips: undefined })).toMatchObject({ ok: false, code: 'E_SCHEMA' });
	});

	it('the paste commands refuse invalid and oversized payloads atomically', () => {
		const { h, text } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [text]));
		const rev = h.revision;
		const big = { ...p, junk: 'x'.repeat(20 * 1024 * 1024) };
		expect(h.tx([{ type: 'clip.paste', payload: big, at: 0 }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_LIMIT' }],
		});
		expect(h.tx([{ type: 'clip.paste', payload: { ...p, version: 9 }, at: 0 }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_SCHEMA' }],
		});
		expect(h.tx([{ type: 'project.pasteItems', payload: p }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		expect(h.revision).toBe(rev);
	});
});

// ---------------------------------------------------------------- clip.paste (CLB-003/004/008, ID-005)

describe('clip.paste (CLB-003/004)', () => {
	it('pastes at the playhead in overwrite mode with new ids, relative layout, links and transitions', () => {
		const { h, v, text, shape } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [v, text, shape]));
		const before = idsIn(h.doc);
		const r = h.ok([{ type: 'clip.paste', payload: p, at: 200, tracks: { video: 'V2', audio: 'A1' } }]);
		const res = r.results[0] as {
			clipIds: string[];
			map: Record<string, string>;
			end: number;
			start: number;
		};
		expect(res.clipIds).toHaveLength(4);
		expect(res.start).toBe(200);
		expect(res.end).toBe(270); // the text ends last, at 80 → 80 - 10 + 200
		const pasted = res.clipIds.map((id) => h.seq.clips[id]!);
		// ID-005: every pasted entity id (clips, effects, keyframes, links, transitions) is new.
		const created = idsIn(pasted);
		for (const id of created)
			if (!id.startsWith('trk_') && !id.startsWith('med_') && !id.startsWith('fnt_'))
				expect(before.has(id), id).toBe(false);
		const label = (c: Clip) => {
			const vi = h.seq.videoTracks.findIndex((t) => t.id === c.trackId);
			return vi >= 0 ? `V${vi + 1}` : `A${h.seq.audioTracks.findIndex((t) => t.id === c.trackId) + 1}`;
		};
		expect(pasted.map((c) => [c.kind, label(c), c.start])).toEqual([
			['video', 'V2', 200],
			['audio', 'A1', 200],
			['text', 'V3', 210],
			['shape', 'V4', 220], // V4 did not exist: added (TRK-005)
		]);
		const [pv, pa] = pasted as [Clip, Clip];
		expect(pv.linkId).toBeTruthy();
		expect(pv.linkId).toBe(pa.linkId);
		expect(pv.linkId).not.toBe(h.seq.clips[v]!.linkId);
		const fade = Object.values(h.seq.transitions).find((t) => t.incomingClipId === pv.id);
		expect(fade).toMatchObject({ trackId: pv.trackId, duration: 10, outgoingClipId: null });
		ok(h);
	});

	it('overwrites what is under the pasted clips, and Paste Insert ripples instead (TRK-006)', () => {
		const h = new Harness();
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 100, track: 'V1', color: [0, 0, 1, 1], ref: '$bg' },
			{ type: 'clip.addSolid', at: 0, duration: 100, track: 'V2', color: [0, 1, 0, 1] },
			{ type: 'clip.addText', at: 0, duration: 20, track: 'V3', content: { text: 'x' }, ref: '$t' },
		]);
		const t = h.clips('V3')[0]!.id;
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [t]));
		const over = h.ok([{ type: 'clip.paste', payload: p, at: 40, tracks: { video: 'V1' } }]);
		expect(h.spans('V1')).toEqual([
			[0, 40],
			[40, 60],
			[60, 100],
		]);
		expect(h.spans('V2')).toEqual([[0, 100]]);
		expect((over.results[0] as { end: number }).end).toBe(60);
		h.ok([{ type: 'clip.paste', payload: p, at: 10, mode: 'insert', tracks: { video: 'V2' } }]);
		expect(h.spans('V2')).toEqual([
			[0, 10],
			[10, 30],
			[30, 120],
		]);
		// Sync-locked V1 shifted with the insert (split at 10).
		expect(h.spans('V1')).toEqual([
			[0, 10],
			[30, 60],
			[60, 80],
			[80, 120],
		]);
		ok(h);
	});

	it('refuses locked destinations and kind mismatches', () => {
		const { h, text } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [text]));
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		expect(h.tx([{ type: 'clip.paste', payload: p, at: 0, tracks: { video: 'V2' } }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_TRACK_LOCKED' }],
		});
		expect(h.tx([{ type: 'clip.paste', payload: p, at: 0, tracks: { video: 'A1' } }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_TRACK_KIND' }],
		});
	});

	it('keeps every M2 field: text animators, shape keyframes, anime template params and renderer stamp', () => {
		const schema = z.object({ title: z.string().default('Hi'), size: z.number().default(10) });
		const tpl: MgTemplateInfo = {
			id: 'reveal',
			version: 1,
			name: 'Reveal',
			category: 'Titles',
			paramsSchema: schema,
			defaults: schema.parse({}),
			introFrames: 5,
			outroFrames: 5,
			canvasDefault: 'sequence',
			renderer: 'anime',
		};
		const registries = defaultRegistries(createStaticMgRegistry([tpl]));
		const h = new Harness({ ctx: { registries } });
		const r = h.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 60,
				track: 'V1',
				template: { id: 'reveal', version: 1 },
				ref: '$m',
			},
			{ type: 'keyframe.add', target: ['clip', '$m', 'params', 'size'], at: { frames: 0 }, value: 10 },
			{ type: 'keyframe.add', target: ['clip', '$m', 'params', 'size'], at: { frames: 30 }, value: 40 },
			{
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: { text: 'Hello' },
				textAnimation: { in: { preset: 'pop', params: { unit: 'char' } }, out: { preset: 'fade' } },
				ref: '$t',
			},
		]);
		const m = r.refs.$m!;
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [m, r.refs.$t!]));
		const res = h.ok([{ type: 'clip.paste', payload: p, at: 100 }]).results[0] as {
			map: Record<string, string>;
		};
		const mg = h.seq.clips[res.map[m]!] as Extract<Clip, { kind: 'motion-graphic' }>;
		expect(mg.template).toEqual({ id: 'reveal', version: 1, renderer: 'anime' });
		expect(mg.paramKeyframes!.size!.map((k) => k.value)).toEqual([10, 40]);
		expect(mg.paramKeyframes!.size![0]!.id).not.toBe(
			(h.seq.clips[m] as typeof mg).paramKeyframes!.size![0]!.id,
		);
		const t = h.seq.clips[res.map[r.refs.$t!]!] as Extract<Clip, { kind: 'text' }>;
		expect(t.textAnimation).toEqual((h.seq.clips[r.refs.$t!] as typeof t).textAnimation);
		expect(t.textAnimation?.in?.preset).toBe('pop');
		const checked = checkInvariants(h.doc, {
			effects: registries.effects,
			mgTemplates: registries.mgTemplates,
		});
		expect(checked).toEqual([]);
	});

	it('remaps trackers: a pasted target follows the pasted copy of its plate (S09)', () => {
		const h = new Harness();
		const { clipIds } = placeVideo(h, 0, { audio: false });
		const plate = clipIds[0]!;
		const r = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 1, 0, 1], ref: '$t' },
			{
				type: 'tracker.add',
				clipId: plate,
				kind: 'planar',
				at: { frames: 0 },
				corners: [
					[100, 100],
					[300, 100],
					[300, 200],
					[100, 200],
				],
				ref: '$k',
			},
		]);
		const target = r.refs.$t!;
		const tracker = r.refs.$k!;
		h.ok([
			{
				type: 'tracker.setSamples',
				trackerId: tracker,
				samples: {
					start: 0,
					step: F30,
					stride: 8,
					data: Array.from({ length: 30 * 8 }, (_, i) => 100 + (i % 8) * 10),
					confidence: new Array(30).fill(1),
				},
				method: 'klt-homography@1',
			},
			{ type: 'tracker.apply', trackerId: tracker, targetClipId: target, mode: 'corner-pin' },
		]);
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [plate, target]));
		const res = h.ok([{ type: 'clip.paste', payload: p, at: 100 }]).results[0] as {
			map: Record<string, string>;
		};
		const newPlate = h.seq.clips[res.map[plate]!] as Clip & { trackers: { id: string }[] };
		const newTarget = h.seq.clips[res.map[target]!] as Clip & {
			trackedBy: { clipId: string; trackerId: string; effectInstanceId: string };
			effects: { id: string }[];
		};
		expect(newPlate.trackers[0]!.id).not.toBe(tracker);
		expect(newTarget.trackedBy.clipId).toBe(newPlate.id);
		expect(newTarget.trackedBy.trackerId).toBe(newPlate.trackers[0]!.id);
		expect(newTarget.effects.map((e) => e.id)).toContain(newTarget.trackedBy.effectInstanceId);
		// Pasting only the target keeps it on the original plate (same sequence).
		const only = roundTrip(buildClipsPayload(h.doc, h.seqId, [target]));
		const res2 = h.ok([{ type: 'clip.paste', payload: only, at: 200 }]).results[0] as { clipIds: string[] };
		expect((h.seq.clips[res2.clipIds[0]!] as typeof newTarget).trackedBy.clipId).toBe(plate);
		ok(h);
	});

	it('converts starts, durations, transitions and animator windows to the target frame rate', () => {
		const { h, v, text } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [v, text]));
		const h25 = new Harness({ preset: 'hd-1080p-25', seed: 9 });
		const res = h25.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as {
			map: Record<string, string>;
		};
		const pv = h25.seq.clips[res.map[v]!]!;
		const pt = h25.seq.clips[res.map[text]!]! as Extract<Clip, { kind: 'text' }>;
		expect([pv.start, pv.duration]).toEqual([0, 50]); // 60 frames at 30 fps = 2 s = 50 frames at 25
		expect([pt.start, pt.duration]).toEqual([8, 50]); // offset 10 → 8.33 → 8; end 70 → 58
		const src = h.seq.clips[text] as typeof pt;
		expect(pt.textAnimation!.in!.durationFrames).toBe(
			Math.round((src.textAnimation!.in!.durationFrames * 25) / 30),
		);
		expect(Object.values(h25.seq.transitions)[0]!.duration).toBe(8);
		expect(checkInvariants(h25.doc)).toEqual([]);
	});
});

// ---------------------------------------------------------------- cross-project resolution (CLB-008)

describe('reference resolution across projects (CLB-008)', () => {
	it('reuses media with the same fingerprint, adds missing assets with new ids and a project item', () => {
		const { h, v } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [v]));
		const src = p.media[0]!;
		// Target 1 already has the file (same fingerprint, other id): reused, nothing added.
		const t1 = new Harness({ seed: 21 });
		const existing = t1.ok([{ type: 'media.register', asset: { ...src, id: undefined } }]).results[0] as {
			mediaId: string;
		};
		const items = Object.keys(t1.doc.items).length;
		const r1 = t1.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as {
			clipIds: string[];
			createdMedia: string[];
			reusedMedia: string[];
		};
		expect(r1.createdMedia).toEqual([]);
		expect(r1.reusedMedia).toEqual([existing.mediaId]);
		expect((t1.seq.clips[r1.clipIds[0]!] as { mediaId: string }).mediaId).toBe(existing.mediaId);
		expect(Object.keys(t1.doc.items)).toHaveLength(items);
		// Target 2 does not: the record is added under a new id (locators kept) with an item named like the source.
		const t2 = new Harness({ seed: 22 });
		const r2 = t2.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as {
			clipIds: string[];
			createdMedia: string[];
		};
		expect(r2.createdMedia).toHaveLength(1);
		const added = t2.doc.media[r2.createdMedia[0]!]!;
		expect(added.id).not.toBe(src.id);
		expect(added.fingerprint).toBe(src.fingerprint);
		expect(added.locators).toEqual(src.locators);
		const item = Object.values(t2.doc.items).find((i) => i.kind === 'media' && i.mediaId === added.id);
		expect(item?.name).toBe(p.mediaItems![src.id]!.name);
		expect(checkInvariants(t2.doc)).toEqual([]);
	});

	it('copies synthetics, transcripts and fonts with new ids (fonts with the same family are reused)', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'T' }, ref: '$t' },
		]);
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [r.refs.$s!, r.refs.$t!]));
		// Same project: the synthetic and the font are reused.
		const same = h.ok([{ type: 'clip.paste', payload: p, at: 100 }]).results[0] as {
			map: Record<string, string>;
		};
		expect((h.seq.clips[same.map[r.refs.$s!]!] as { syntheticId: string }).syntheticId).toBe(
			(h.seq.clips[r.refs.$s!] as { syntheticId: string }).syntheticId,
		);
		// Another project: a new color matte; the default font already exists there, so it is reused.
		const t = new Harness({ seed: 33 });
		t.ok([{ type: 'clip.addText', at: 0, duration: 5, track: 'V3', content: { text: 'own' } }]);
		const fonts = Object.keys(t.doc.fonts);
		const res = t.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as {
			map: Record<string, string>;
		};
		const solid = t.seq.clips[res.map[r.refs.$s!]!] as { syntheticId: string };
		expect(Object.keys(h.doc.synthetics)).not.toContain(solid.syntheticId);
		expect(t.doc.synthetics[solid.syntheticId]).toMatchObject({ kind: 'color-matte', color: [1, 0, 0, 1] });
		expect(Object.keys(t.doc.fonts)).toEqual(fonts);
		const text = t.seq.clips[res.map[r.refs.$t!]!] as Extract<Clip, { kind: 'text' }>;
		expect(text.content.style.fontId).toBe(fonts[0]);
		expect(checkInvariants(t.doc)).toEqual([]);
	});

	it('resolves LUT media in effect params, composition bundles and derivation sources', () => {
		const h = new Harness();
		const lut = (h.ok([{ type: 'media.register', asset: lutAsset() }]).results[0] as { mediaId: string })
			.mediaId;
		const { clipIds, mediaId } = placeVideo(h, 0, { audio: false });
		const v = clipIds[0]!;
		h.ok([
			{
				type: 'effect.add',
				target: { clipId: v },
				effectId: 'jasper.lumetri',
				params: { look: { mediaId: lut } },
			},
		]);
		// A processed version of the video replaces its source in the clip (derivation chain).
		const derived = videoAsset({ seconds: 10, audio: false });
		const d = h.ok([
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'process', steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }] },
				asset: { ...derived, recipeVersion: 1, recipeHash: 'h1' },
				replaceInClips: [v],
			},
		]);
		expect(d.ok).toBe(true);
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [v]));
		expect(p.media.map((m) => m.kind)).toEqual(['video', 'video', 'lut']);
		const t = new Harness({ seed: 44 });
		const res = t.ok([{ type: 'clip.paste', payload: p, at: 0 }]).results[0] as {
			clipIds: string[];
			createdMedia: string[];
		};
		expect(res.createdMedia).toHaveLength(3);
		const clip = t.seq.clips[res.clipIds[0]!] as Extract<Clip, { kind: 'video' }>;
		const look = clip.effects[0]!.params.look!.value as { mediaId: string };
		expect(t.doc.media[look.mediaId]?.kind).toBe('lut');
		const used = t.doc.media[clip.mediaId]!;
		expect(used.derivation?.fromMediaId && t.doc.media[used.derivation.fromMediaId]).toBeTruthy();
		// The derivation source travels without its own item; the clip's media and the LUT get one.
		const itemMedia = Object.values(t.doc.items)
			.filter((i) => i.kind === 'media')
			.map((i) => (i as { mediaId: string }).mediaId);
		expect(itemMedia.sort()).toEqual([clip.mediaId, look.mediaId].sort());
		expect(checkInvariants(t.doc, { effects: defaultRegistries().effects })).toEqual([]);
	});
});

// ---------------------------------------------------------------- attributes (CLB-005/006, FX-011/012)

describe('clip.pasteAttributes / clip.removeAttributes / effect.paste', () => {
	function twoClips() {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 100, duration: 60, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
			{ type: 'clip.addSolid', at: 200, duration: 15, track: 'V1', color: [0, 0, 1, 1], ref: '$c' },
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 50 },
			{ type: 'clip.update', clipId: '$a', patch: { blendMode: 'screen' } },
			{ type: 'keyframe.add', target: ['clip', '$a', 'transform', 'scale'], at: { frames: 0 }, value: 100 },
			{ type: 'keyframe.add', target: ['clip', '$a', 'transform', 'scale'], at: { frames: 29 }, value: 200 },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
		]);
		return { h, a: r.refs.$a!, b: r.refs.$b!, c: r.refs.$c!, fx: r.refs.$fx! };
	}

	it('applies the chosen attributes to every target in one transaction, keeping key offsets', () => {
		const { h, a, b, c, fx } = twoClips();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [a]));
		const r = h.ok([
			{
				type: 'clip.pasteAttributes',
				payload: p,
				clipIds: [b, c],
				attributes: { motion: true, opacity: true, effects: [fx] },
			},
		]);
		expect((r.results[0] as { clipIds: string[] }).clipIds).toEqual([b, c]);
		const B = h.seq.clips[b] as Extract<Clip, { kind: 'solid' }>;
		expect(B.opacity.value).toBe(50);
		expect(B.blendMode).toBe('screen');
		expect(B.transform.scale.keyframes.map((k) => (k.time - B.sourceIn) / F30)).toEqual([0, 29]);
		expect(B.transform.scale.keyframes[0]!.id).not.toBe(
			(h.seq.clips[a] as typeof B).transform.scale.keyframes[0]!.id,
		);
		expect(B.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
		expect(B.effects[0]!.id).not.toBe(fx);
		ok(h);
	});

	it('Scale Attribute Times stretches keys to the target duration', () => {
		const { h, a, b } = twoClips();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [a]));
		h.ok([
			{
				type: 'clip.pasteAttributes',
				payload: p,
				clipIds: [b],
				attributes: { motion: true },
				scaleTimes: true,
			},
		]);
		const B = h.seq.clips[b] as Extract<Clip, { kind: 'solid' }>;
		// keyframes-blend: first frame → first frame, last frame → last frame (offsets span duration − 1 frames).
		expect(B.transform.scale.keyframes.map((k) => (k.time - B.sourceIn) / F30)).toEqual([0, 59]);
	});

	it('pastes text animators, text style and shape style (M2) and refuses attributes that apply to nothing', () => {
		const { h, text, shape } = richProject();
		const r = h.ok([
			{ type: 'clip.addText', at: 300, duration: 40, track: 'V2', content: { text: 'plain' }, ref: '$p' },
			{ type: 'clip.update', clipId: text, patch: { content: { style: { sizePx: 140 } } } },
			{
				type: 'clip.addShape',
				at: 300,
				duration: 40,
				track: 'V3',
				shape: { type: 'rect', size: [50, 50], fill: null },
				ref: '$q',
			},
			{ type: 'param.set', target: ['clip', shape, 'shape', 'stroke', 'width'], value: 6 },
		]);
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [text, shape]));
		h.ok([
			{
				type: 'clip.pasteAttributes',
				payload: p,
				clipIds: [r.refs.$p!, r.refs.$q!],
				attributes: { textAnimationIn: true, textAnimationOut: true, textStyle: true, shapeStyle: true },
			},
		]);
		const P = h.seq.clips[r.refs.$p!] as Extract<Clip, { kind: 'text' }>;
		expect(P.textAnimation?.in?.preset).toBe('slide-up');
		expect(P.textAnimation?.out?.preset).toBe('fade');
		expect(P.content.style.sizePx).toBe(140);
		expect(P.content.text).toBe('plain');
		const Q = h.seq.clips[r.refs.$q!] as Extract<Clip, { kind: 'shape' }>;
		expect(Q.shape.fill?.value).toEqual([1, 0, 0, 1]);
		expect(Q.shape.stroke?.width.value).toBe(6);
		expect(Q.shape.size.value).toEqual([50, 50]);
		ok(h);
		const audioOnly = roundTrip(buildClipsPayload(h.doc, h.seqId, [text]));
		const { a } = { a: Object.values(h.seq.clips).find((c) => c.kind === 'audio')!.id };
		expect(
			h.tx([
				{ type: 'clip.pasteAttributes', payload: audioOnly, clipIds: [a], attributes: { motion: true } },
			]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
	});

	it('Remove Attributes resets intrinsics and removes effects by registry id', () => {
		const { h, a } = twoClips();
		h.ok([
			{
				type: 'clip.removeAttributes',
				clipIds: [a],
				attributes: { motion: true, opacity: true, effects: ['jasper.gaussian-blur'] },
			},
		]);
		const A = h.seq.clips[a] as Extract<Clip, { kind: 'solid' }>;
		expect(A.transform.scale).toEqual({ value: 100, keyframes: [] });
		expect([A.opacity.value, A.blendMode]).toEqual([100, 'normal']);
		expect(A.effects.map((e) => e.effectId)).toEqual(['jasper.black-white']);
		expect(
			h.tx([{ type: 'clip.removeAttributes', clipIds: [a], attributes: { volume: true } }]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
	});

	it('effect.paste appends copied effects (and copied intrinsics) to every selected clip (EC-032)', () => {
		const { h, a, b, c, fx } = twoClips();
		const p = roundTrip(buildEffectsPayload(h.doc, a, { effectIds: [fx] }));
		h.ok([{ type: 'effect.paste', payload: p, clipIds: [b, c] }]);
		for (const id of [b, c])
			expect((h.seq.clips[id] as { effects: { effectId: string }[] }).effects.map((e) => e.effectId)).toEqual(
				['jasper.gaussian-blur'],
			);
		const all = roundTrip(buildEffectsPayload(h.doc, a, { intrinsic: true }));
		h.ok([{ type: 'effect.paste', payload: all, clipIds: [c], index: 0 }]);
		const C = h.seq.clips[c] as Extract<Clip, { kind: 'solid' }>;
		expect(C.effects.map((e) => e.effectId)).toEqual([
			'jasper.gaussian-blur',
			'jasper.black-white',
			'jasper.gaussian-blur',
		]);
		expect(C.opacity.value).toBe(50);
		// Video effects never land on audio clips.
		const { h: h2, a: audio } = richProject(5);
		const vfx = roundTrip(buildEffectsPayload(h.doc, a));
		expect(h2.tx([{ type: 'effect.paste', payload: vfx, clipIds: [audio] }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		ok(h);
	});
});

// ---------------------------------------------------------------- keyframe.paste (EC-023)

describe('keyframe.paste (CLB-006, S03:EC-023)', () => {
	it('pastes keys at the playhead keeping relative timing, onto the same property path', () => {
		const { h, v, text } = richProject();
		const keys = (h.seq.clips[v] as Extract<Clip, { kind: 'video' }>).effects[0]!.params.radius!.keyframes;
		const p = roundTrip(
			buildKeyframesPayload(
				h.doc,
				v,
				keys.map((k) => k.id),
			),
		);
		expect(p.keyframes!.tracks[0]!.address).toEqual({
			effectId: 'jasper.gaussian-blur',
			occurrence: 0,
			param: 'radius',
		});
		// Same clip at the clip's frame 40: offsets 0 and 30 frames are kept.
		const r = h.ok([{ type: 'keyframe.paste', payload: p, clipId: v, at: { frames: 40 } }]);
		const after = (h.seq.clips[v] as Extract<Clip, { kind: 'video' }>).effects[0]!.params.radius!.keyframes;
		expect(after.map((k) => Math.round((k.time - h.seq.clips[v]!.sourceIn) / F30))).toEqual([0, 30, 40, 70]);
		expect((r.results[0] as { keyframeIds: string[] }).keyframeIds).toHaveLength(2);
		// A clip without a blur effect has no matching path: refused, unless a selected property of the kind is given.
		expect(h.tx([{ type: 'keyframe.paste', payload: p, clipId: text, at: { frames: 0 } }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		h.ok([
			{
				type: 'keyframe.paste',
				payload: p,
				clipId: text,
				at: { frames: 5 },
				target: ['clip', text, 'opacity'],
			},
		]);
		const op = (h.seq.clips[text] as Extract<Clip, { kind: 'text' }>).opacity;
		expect(op.keyframes.map((k) => [Math.round(k.time / F30), k.value])).toEqual([
			[5, 0],
			[35, 20],
		]);
		ok(h);
	});

	it('refuses a selected property of another value kind, and pastes shape size keys (M2)', () => {
		const { h, shape, text } = richProject();
		const keys = (h.seq.clips[shape] as Extract<Clip, { kind: 'shape' }>).shape.size.keyframes;
		const p = roundTrip(
			buildKeyframesPayload(
				h.doc,
				shape,
				keys.map((k) => k.id),
			),
		);
		expect(p.keyframes!.paramType).toBe('vec2');
		expect(
			h.tx([
				{
					type: 'keyframe.paste',
					payload: p,
					clipId: text,
					at: { frames: 0 },
					target: ['clip', text, 'opacity'],
				},
			]),
		).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		const r = h.ok([
			{ type: 'clip.addShape', at: 300, duration: 40, track: 'V3', shape: { type: 'ellipse' }, ref: '$e' },
		]);
		h.ok([{ type: 'keyframe.paste', payload: p, clipId: r.refs.$e!, at: { sequenceFrame: 310 } }]);
		const E = h.seq.clips[r.refs.$e!] as Extract<Clip, { kind: 'shape' }>;
		expect(E.shape.size.keyframes.map((k) => [Math.round(k.time / F30), k.value])).toEqual([
			[10, [200, 100]],
			[30, [400, 100]],
		]);
		ok(h);
	});
});

// ---------------------------------------------------------------- project.pasteItems (CLB-007)

describe('project.pasteItems (CLB-007)', () => {
	function withBin() {
		const { h, ...rest } = richProject();
		const media = Object.values(h.doc.items).find((i) => i.kind === 'media')!;
		const seqItem = Object.values(h.doc.items).find((i) => i.kind === 'sequence')!;
		const r = h.ok([
			{ type: 'bin.create', name: 'Selects', ref: '$bin' },
			{ type: 'item.move', itemIds: [media.id], toBinId: '$bin' },
		]);
		return { h, bin: r.refs.$bin!, media, seqItem, ...rest };
	}

	it('deep-copies sequences with new ids and remapped references, into the chosen bin', () => {
		const { h, seqItem } = withBin();
		const p = roundTrip(buildItemsPayload(h.doc, [seqItem.id]));
		expect(p.items!.sequences).toHaveLength(1);
		const before = idsIn(h.doc.sequences);
		const r = h.ok([{ type: 'project.pasteItems', payload: p }]);
		const res = r.results[0] as { itemIds: string[]; sequenceIds: string[] };
		const copy = h.doc.sequences[res.sequenceIds[0]!]!;
		const orig = h.doc.sequences[(seqItem as { sequenceId: string }).sequenceId]!;
		expect(Object.keys(copy.clips)).toHaveLength(Object.keys(orig.clips).length);
		expect(Object.keys(copy.transitions)).toHaveLength(1);
		expect(copy.markers).toHaveLength(1);
		for (const id of idsIn(copy)) if (!/^(med|fnt|syn)_/.test(id)) expect(before.has(id), id).toBe(false);
		const trackIds = new Set([...copy.videoTracks, ...copy.audioTracks].map((t) => t.id));
		for (const c of Object.values(copy.clips)) expect(trackIds.has(c.trackId)).toBe(true);
		expect(Object.values(copy.links)[0]!.members.every((m) => copy.clips[m])).toBe(true);
		expect(h.doc.items[res.itemIds[0]!]).toMatchObject({ kind: 'sequence', name: seqItem.name });
		expect(h.doc.rootItems).toContain(res.itemIds[0]);
		ok(h);
	});

	it('pastes bins with their children into another project (media resolved, items added once)', () => {
		const { h, bin } = withBin();
		const p = roundTrip(buildItemsPayload(h.doc, [bin]));
		const t = new Harness({ seed: 55 });
		const r = t.ok([
			{ type: 'bin.create', name: 'Target', ref: '$tb' },
			{ type: 'project.pasteItems', payload: p, binId: '$tb' },
		]);
		const res = r.results[1] as { itemIds: string[]; createdMedia: string[] };
		const newBin = t.doc.items[res.itemIds[0]!] as { kind: string; name: string; children: string[] };
		expect(newBin).toMatchObject({ kind: 'bin', name: 'Selects' });
		expect(newBin.children).toHaveLength(1);
		expect((t.doc.items[r.refs.$tb!] as { children: string[] }).children).toEqual([res.itemIds[0]]);
		expect(res.createdMedia).toHaveLength(1);
		expect(Object.values(t.doc.items).filter((i) => i.kind === 'media')).toHaveLength(1);
		expect(checkInvariants(t.doc)).toEqual([]);
	});
});

// Clipboard data is opaque to agent addressing and transaction reference substitution.
describe('clipboard data isolation', () => {
	it('payload data is never treated as addresses, temp refs or selections', () => {
		const { h, text } = richProject();
		const p = roundTrip(buildClipsPayload(h.doc, h.seqId, [text]));
		(p.clips!.clips[0] as { name: string }).name = '$selection';
		(p.clips!.clips[0] as Record<string, unknown>).note = { clipAt: { track: 'V9', at: 0 } };
		const cmd = { type: 'clip.paste', payload: p, at: 500 };
		const resolved = resolveAgentAddresses(h.doc, [cmd]);
		expect(resolved.ok && resolved.commands[0]).toEqual(cmd);
		const r = h.ok([cmd], { ctx: { selection: { clips: [], primaryClip: null } } });
		const id = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		expect(h.seq.clips[id]!.name).toBe('$selection');
	});
});
