// Hand-built documents for the cue derivation tests (spec 12 §2.2, P2-R3).
import { z } from 'zod';
import {
	type Animatable,
	type Clip,
	createStaticMgRegistry,
	defaultRegistries,
	type Keyframe,
	type MgTemplateInfo,
	type MgTemplateRegistry,
	type ProjectDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const FPS = 30;
const FLICKS = 705_600_000;
export const F = FLICKS / FPS;

const LINEAR = { influence: 1 / 3, slope: 0 };
/** A valid keyframe id from a short tag (`kfid('p1')` → `kf_00000000000000P1`). */
export const kfid = (tag: string) =>
	`kf_${tag
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.padStart(16, '0')
		.slice(-16)}`;
/** A keyframe at content frame `frame` (30 fps). */
export function kf<T>(
	tag: string,
	frame: number,
	value: T,
	interpolation: Keyframe<T>['interpolation'] = 'linear',
): Keyframe<T> {
	return {
		id: kfid(tag),
		time: Math.round(frame * F),
		value,
		interpolation,
		easeIn: LINEAR,
		easeOut: LINEAR,
	};
}
export const animOf = <T>(value: T, keyframes: Keyframe<T>[]): Animatable<T> => ({ value, keyframes });

function mgInfo(id: string, introFrames: number, outroFrames: number): MgTemplateInfo {
	const paramsSchema = z.object({ title: z.string().default('Title') });
	return {
		id,
		version: 1,
		name: 'Lower Third',
		category: 'Titles',
		paramsSchema,
		defaults: paramsSchema.parse({}),
		introFrames,
		outroFrames,
		canvasDefault: 'sequence',
		renderer: 'anime',
	};
}

export function mgRegistry(): MgTemplateRegistry {
	return createStaticMgRegistry([mgInfo('lower-third', 15, 12)]);
}

/** Mutable copy of the harness document with a patched clip (keyframes are written directly). */
export function patchClip(h: Harness, id: string, f: (c: Clip & Record<string, unknown>) => void): void {
	const doc = structuredClone(h.doc) as ProjectDocument;
	const seq = doc.sequences[h.seqId]!;
	f(seq.clips[id] as Clip & Record<string, unknown>);
	h.doc = doc;
}

export function newHarness(): Harness {
	return new Harness({ ctx: { registries: defaultRegistries(mgRegistry()) } });
}

/** Places a video file (no audio) at `at` on a track; returns the clip id. */
export function placeVideo(
	h: Harness,
	at: number,
	frames: number,
	track = 'V1',
	name?: string,
	inFrames = 30,
): string {
	const media = h.registerVideo({ seconds: 60, audio: false });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: media },
			sourceRange: { in: { flicks: inFrames * F }, out: { flicks: (inFrames + frames) * F } },
			at,
			tracks: { video: track },
			audio: false,
			ref: '$c',
		},
	]);
	const id = r.refs.$c ?? r.created.find((c) => h.seq.clips[c])!;
	if (name) patchClip(h, id, (c) => (c.name = name));
	return id;
}

/**
 * The Phase 2 fixture (spec 12 P2 "Done when"): cuts, a push transition, a keyframed logo with an ease-out
 * overshoot, a typewriter title, a motion-graphic template and an `sfx:` marker. 30 fps, 1920×1080.
 */
export function phase2Fixture() {
	const h = newHarness();
	const a = placeVideo(h, 0, 90, 'V1', 'Shot A');
	const b = placeVideo(h, 90, 90, 'V1', 'Shot B');
	const c = placeVideo(h, 180, 150, 'V1', 'Shot C');
	const tr = h.ok([
		{
			type: 'transition.add',
			clipId: c,
			edge: 'in',
			effectId: 'jasper.push',
			duration: 20,
			alignment: 'center',
			params: { direction: 'westToEast' },
			ref: '$t',
		},
	]).refs.$t!;
	// Logo: a still on V2, keyframed in from the left with an overshoot past its rest position.
	const logoMedia = h.registerVideo({ kind: 'image', width: 400, height: 200 });
	const logo = h.ok([
		{ type: 'clip.place', source: { mediaId: logoMedia }, at: 30, tracks: { video: 'V2' }, ref: '$l' },
	]).refs.$l!;
	patchClip(h, logo, (cl) => {
		cl.name = 'Logo';
		cl.duration = 120;
		const t = cl.transform as { position: Animatable<[number, number]> };
		t.position = animOf<[number, number]>(
			[960, 540],
			[kf('kp1', 10, [200, 540]), kf('kp2', 22, [1010, 540]), kf('kp3', 27, [960, 540])],
		);
	});
	const title = h.ok([
		{
			type: 'clip.addText',
			at: 200,
			duration: 90,
			track: 'V3',
			content: { text: 'HELLO WORLD' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 45 } },
			ref: '$x',
		},
	]).refs.$x!;
	const lower = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 330,
			duration: 90,
			track: 'V1',
			template: { id: 'lower-third', version: 1 },
			ref: '$m',
		},
	]).refs.$m!;
	const marker = h.ok([{ type: 'marker.add', frame: 250, name: 'sfx: boom+swoosh', ref: '$k' }]).refs.$k!;
	return { h, a, b, c, tr, logo, title, lower, marker };
}
