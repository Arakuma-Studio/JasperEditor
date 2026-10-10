// Security review DATA-1 (docs/security-review.md): data integrity under random edits across the command families
// the parity workstreams added (masks, shapes, time remap, multicam recording, roto, camera tracking, 3D, captions,
// text animators, expressions; gaps: proxies, audio channel mapping, sequence format, Warp Stabilizer) mixed with the core edits that move, trim, split and delete what they hang off.
//
// For every random transaction sequence, through a real EditorSession:
//  - a refused transaction leaves the document reference unchanged, and no handler produces an invalid document
//    (no E_INVARIANT / E_INTERNAL refusals);
//  - the incremental autosave serialisation (`stringifyJson`, ui-perf) equals `JSON.stringify` after every step;
//  - saving and loading is lossless: `loadProject` of the JSON gives the same document, with no repairs and no issues
//    (a field the schema does not declare, or a repair that fires on a valid document, would silently lose data);
//  - undoing everything restores the exact initial document, and redoing everything the exact final one.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	loadProject,
	type MediaAsset,
	type ProjectDocument,
	stringifyJson,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/index.ts';

const FUZZ = process.env.FUZZ === '1';
const RUNS = FUZZ ? 400 : 40;

let fp = 0;
function asset(seconds: number, kind: 'video' | 'audio' = 'video'): Omit<MediaAsset, 'id'> {
	fp++;
	const streams: MediaAsset['probe']['streams'] = [];
	if (kind === 'video')
		streams.push({
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
		});
	streams.push({
		index: streams.length,
		type: 'audio',
		codec: 'aac',
		sampleRate: 48000,
		channels: 2,
		channelLayout: 'stereo',
	});
	return {
		kind,
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `cam-${fp}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: Math.round(seconds * 705_600_000),
			startTimecode: null,
			streams,
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-10-09T00:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

/** The edited (first) sequence of each test session. */
const MAIN = new WeakMap<EditorSession, string>();

function newSession(): EditorSession {
	const ids = createCounterIdSource(5);
	const doc = createEmptyProject({ ids, name: 'Integrity', preset: 'hd-1080p-30' });
	const s = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-09T00:00:00.000Z', registries: defaultRegistries() },
	});
	MAIN.set(s, Object.keys(doc.sequences)[0]!);
	return s;
}

function must(s: EditorSession, commands: unknown[]): unknown[] {
	const r = s.apply({ label: 'setup', origin: 'user', sequenceId: MAIN.get(s), commands: commands as never });
	if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.errors)}`);
	return r.results ?? [];
}

/** A project with every family present: two cameras in a multicam, a placed multicam clip, a camera, text, shape, captions. */
function setup(): EditorSession {
	const s = newSession();
	const reg = (sec: number) =>
		must(s, [{ type: 'media.register', asset: asset(sec) }])[0] as { mediaId: string; itemId: string };
	const a = reg(12);
	const b = reg(10);
	const c = reg(8);
	const mc = must(s, [{ type: 'multicam.create', itemIds: [a.itemId, b.itemId], method: 'in' }])[0] as {
		sequenceId: string;
	};
	must(s, [
		{ type: 'clip.place', source: { mediaId: c.mediaId }, at: 0, tracks: { video: 'V1' } },
		{ type: 'clip.place', source: { sequenceId: mc.sequenceId }, at: 260, tracks: { video: 'V1' } },
		{ type: 'clip.addSolid', at: 0, duration: 200, track: 'V2', color: [0, 0, 1, 1] },
		{ type: 'clip.addText', at: 30, duration: 150, track: 'V3', content: { text: 'integrity' } },
		{
			type: 'clip.addShape',
			at: 60,
			duration: 120,
			track: 'V4',
			shape: { type: 'rect', size: [200, 100], fill: [1, 0, 0, 1], cornerRadius: 8 },
		},
		{ type: 'clip.addCamera', at: 0, duration: 300 },
		{ type: 'caption.add', at: 10, duration: 40, text: 'first caption' },
	]);
	return s;
}

type Step = { k: number; a: number; b: number; c: number; flag: boolean };
const STEP: fc.Arbitrary<Step> = fc.record({
	k: fc.nat(31),
	a: fc.nat(1000),
	b: fc.integer({ min: 0, max: 400 }),
	c: fc.integer({ min: -60, max: 60 }),
	flag: fc.boolean(),
});

function clipsOf(doc: ProjectDocument, seqId: string) {
	const seq = doc.sequences[seqId]!;
	return { seqId, clips: Object.values(seq.clips).sort((x, y) => x.id.localeCompare(y.id)) };
}

const pick = <T>(list: readonly T[], i: number): T | undefined =>
	list.length ? list[i % list.length] : undefined;

/** Commands for one abstract step against the current document (null: nothing to do). */
function concretize(
	st: Step,
	doc: ProjectDocument,
	main: string,
): { sequenceId: string; commands: unknown[] } | null {
	const { seqId, clips } = clipsOf(doc, main);
	const visual = clips.filter(
		(c) => ['video', 'solid', 'text', 'shape', 'multicam'].includes(c.kind) || 'multicam' in c,
	);
	const video = clips.filter((c) => c.kind === 'video');
	const anyClip = pick(visual, st.a);
	const masks = clips.flatMap((c) => ((c as { masks?: { id: string }[] }).masks ?? []).map((m) => m.id));
	const rotos = clips.flatMap((c) => ((c as { rotos?: { id: string }[] }).rotos ?? []).map((r) => r.id));
	const camera = clips.find((c) => c.kind === 'camera');
	const text = clips.find((c) => c.kind === 'text');
	const captions = clips.filter((c) => c.kind === 'captions');
	const mcClips = clips.filter((c) => 'multicam' in c && (c as { multicam?: unknown }).multicam);
	const items = Object.values(doc.items).filter((i) => i.kind === 'media');
	const one = (...commands: unknown[]) => ({ sequenceId: seqId, commands });
	switch (st.k) {
		case 0:
			return anyClip
				? one({ type: 'mask.add', clipId: anyClip.id, shape: st.flag ? 'ellipse' : 'rectangle' })
				: null;
		case 1:
			return masks.length ? one({ type: 'mask.remove', maskIds: [pick(masks, st.a)] }) : null;
		case 2:
			return masks.length ? one({ type: 'mask.update', maskId: pick(masks, st.a), inverted: st.flag }) : null;
		case 3:
			return video.length
				? one({ type: 'timeRemap.enable', clipIds: [pick(video, st.a)!.id], enabled: st.flag })
				: null;
		case 4:
			return video.length
				? one({ type: 'timeRemap.addKeyframe', clipId: pick(video, st.a)!.id, at: st.b % 120 })
				: null;
		case 5:
			return mcClips.length
				? one({ type: 'multicam.record', cuts: [{ at: 260 + (st.b % 60), angle: 1 + (st.a % 2) }], to: 330 })
				: null;
		case 6:
			return video.length
				? one({
						type: 'roto.add',
						clipId: pick(video, st.a)!.id,
						at: { frames: st.b % 30 },
						points: [{ x: 100 + (st.a % 500), y: 80, fg: st.flag }],
					})
				: null;
		case 7:
			return rotos.length ? one({ type: 'roto.remove', rotoIds: [pick(rotos, st.a)] }) : null;
		case 8:
			return video.length ? one({ type: 'cameraTracker.add', clipId: pick(video, st.a)!.id }) : null;
		case 9:
			return anyClip ? one({ type: 'clip.set3d', clipIds: [anyClip.id], enabled: st.flag }) : null;
		case 10:
			return camera ? one({ type: 'camera.orbit', clipId: camera.id, yaw: st.c, pitch: st.c / 3 }) : null;
		case 11:
			return one({ type: 'caption.add', at: st.b, duration: 1 + (st.a % 60), text: `cap ${st.a}` });
		case 12:
			return captions.length
				? one({ type: 'caption.delete', clipIds: [pick(captions, st.a)!.id], ripple: st.flag })
				: null;
		case 13:
			return text ? one({ type: 'textAnimator.add', clipId: text.id, properties: ['position'] }) : null;
		case 14:
			return anyClip
				? one({
						type: 'expression.set',
						target: ['clip', anyClip.id, 'transform', 'rotation'],
						text: `time * ${st.c}`,
					})
				: null;
		case 15:
			return anyClip
				? one({ type: 'expression.clear', target: ['clip', anyClip.id, 'transform', 'rotation'] })
				: null;
		case 16:
			return anyClip
				? one({ type: 'effect.add', target: { clipId: anyClip.id }, effectId: 'jasper.gaussian-blur' })
				: null;
		case 17:
			return anyClip
				? one({
						type: 'keyframe.add',
						target: ['clip', anyClip.id, 'opacity'],
						at: { frames: st.b % 90 },
						value: st.a % 100,
					})
				: null;
		case 18:
			return video.length
				? one({
						type: 'clip.setSpeed',
						clipIds: [pick(video, st.a)!.id],
						rate: st.flag ? 0.5 : 2,
						ripple: false,
					})
				: null;
		case 19:
			return anyClip
				? one({
						type: 'clip.move',
						clipIds: [anyClip.id],
						deltaFrames: st.c,
						mode: st.flag ? 'insert' : 'overwrite',
					})
				: null;
		case 20:
			return anyClip
				? one({
						type: 'clip.trim',
						clipId: anyClip.id,
						edge: st.flag ? 'in' : 'out',
						deltaFrames: st.c,
						mode: 'regular',
					})
				: null;
		case 21:
			return one({ type: 'clip.split', at: st.b, scope: 'all-unlocked' });
		case 22:
			return anyClip ? one({ type: 'clip.lift', clipIds: [anyClip.id] }) : null;
		case 23:
			return mcClips.length ? one({ type: 'multicam.flatten', clipIds: [pick(mcClips, st.a)!.id] }) : null;
		case 24:
			return items.length
				? one({ type: 'item.delete', itemIds: [pick(items, st.a)!.id], force: true })
				: null;
		// ---- workstream gaps: proxies, audio channel mapping, sequence format, Warp Stabilizer
		case 26: {
			const m = pick(
				Object.values(doc.media).filter((x) => x.kind === 'video'),
				st.a,
			);
			if (!m) return null;
			const a = asset(st.flag ? 12 : 10);
			return one({
				type: 'media.attachProxy',
				mediaId: m.id,
				proxy: {
					fingerprint: a.fingerprint,
					originalName: 'clip_Proxy.mp4',
					sizeBytes: a.sizeBytes,
					container: a.container,
					probe: { ...m.probe },
					locators: a.locators,
					origin: 'created',
					preset: 'proxy-720',
				},
			});
		}
		case 27: {
			const withProxy = Object.values(doc.media).filter((x) => (x as { proxy?: unknown }).proxy);
			return withProxy.length
				? one({ type: 'media.detachProxy', mediaIds: [pick(withProxy, st.a)!.id] })
				: null;
		}
		case 28: {
			const audio = clips.filter((c) => c.kind === 'audio');
			return audio.length
				? one({
						type: 'clip.setAudioChannels',
						clipIds: [pick(audio, st.a)!.id],
						channels: [{ streamIndex: 1, map: st.flag ? [1, 0] : [0, 0] }],
					})
				: null;
		}
		case 29:
			return one({
				type: 'sequence.updateSettings',
				settings: st.flag ? { pixelAspectRatio: { num: 10, den: 11 } } : { pixelAspectRatio: null },
			});
		case 30:
			return video.length
				? one({
						type: 'effect.add',
						target: { clipId: pick(video, st.a)!.id },
						effectId: 'jasper.warp-stabilizer',
					})
				: null;
		default:
			return anyClip
				? one({ type: 'param.set', target: ['clip', anyClip.id, 'opacity'], value: st.a % 101 })
				: null;
	}
}

describe('DATA-1: integrity under random edits of the new command families', () => {
	it(`holds for ${RUNS} random sequences`, () => {
		let accepted = 0;
		const families = new Set<number>();
		fc.assert(
			fc.property(fc.array(STEP, { minLength: 1, maxLength: 14 }), (steps) => {
				const s = setup();
				const initial = s.getCommitted();
				const docs: ProjectDocument[] = [];
				let n = 0;
				for (const st of steps) {
					const before = s.getCommitted();
					const tx = concretize(st, before, MAIN.get(s)!);
					if (!tx) continue;
					const r = s.apply({ label: `step ${n++}`, origin: 'user', ...tx } as never);
					if (!r.ok) {
						expect(s.getCommitted()).toBe(before);
						const bad = r.errors.filter((e) => e.code === 'E_INVARIANT' || e.code === 'E_INTERNAL');
						if (bad.length)
							throw new Error(`invalid document from ${JSON.stringify(tx)}: ${JSON.stringify(bad)}`);
						continue;
					}
					accepted++;
					families.add(st.k);
					const doc = s.getCommitted();
					if (doc !== before) docs.push(doc);
					expect(stringifyJson(doc)).toBe(JSON.stringify(doc));
				}
				const final = s.getCommitted();
				const loaded = loadProject(JSON.parse(JSON.stringify(final)), {
					effects: defaultRegistries().effects,
				});
				expect(loaded.repairs).toEqual([]);
				expect(loaded.issues).toEqual([]);
				expect(JSON.parse(JSON.stringify(loaded.document))).toEqual(JSON.parse(JSON.stringify(final)));
				// Undo every step → the exact initial document; redo them all → the exact final one (each document between).
				for (let i = docs.length - 1; i >= 0; i--) {
					expect(s.getCommitted()).toBe(docs[i]);
					expect(s.undo().ok).toBe(true);
				}
				expect(s.getCommitted()).toBe(initial);
				for (const d of docs) {
					expect(s.redo().ok).toBe(true);
					expect(s.getCommitted()).toBe(d);
				}
				expect(s.getCommitted()).toBe(final);
				expect(s.redo().ok).toBe(false);
			}),
			{ numRuns: RUNS, seed: FUZZ ? undefined : 20261009 },
		);
		expect(accepted).toBeGreaterThan(RUNS);
		// The generator really reaches the families: every step kind is applied at least once across the runs, except
		// the two that need an earlier step of the same run (roto.remove, media.detachProxy), which long runs reach.
		const missing = Array.from({ length: 32 }, (_, k) => k).filter(
			(k) => !families.has(k) && k !== 7 && k !== 27,
		);
		expect(missing).toEqual([]);
	}, 600_000);
});
