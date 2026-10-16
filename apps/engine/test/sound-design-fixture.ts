// The Phase 2 sound-design fixture (cuts, a push, a keyframed logo, a typewriter, a lower third, an `sfx:` marker),
// built with the engine's own template registry; shared by the cue route and the plan job tests.
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Animatable,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type Keyframe,
	type MediaAsset,
	makeEnvelope,
	type ProjectDocument,
} from '@jasper/project';

export const F = 705_600_000 / 30;
const LINEAR = { influence: 1 / 3, slope: 0 };
let fp = 0;

export function asset(kind: 'video' | 'image', seconds = 60): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind,
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `shot-${fp}.${kind === 'image' ? 'png' : 'mp4'}`,
		sizeBytes: 1000,
		container: kind === 'image' ? 'png' : 'mov,mp4',
		probe: {
			durationFlicks: kind === 'image' ? null : Math.round(seconds * 705_600_000),
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: kind === 'image' ? 'png' : 'h264',
					width: kind === 'image' ? 400 : 1920,
					height: kind === 'image' ? 200 : 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-10-15T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

/** The Phase 2 fixture with the engine's own template registry: cuts, a push, a keyframed logo, a typewriter, a lower third, an `sfx:` marker. */
export function fixture() {
	const ids = createCounterIdSource(41);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Cues', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	let revision = 0;
	const tx = (commands: unknown[]) => {
		const { document, result } = applyTransaction(
			doc,
			{ label: 't', origin: 'user', sequenceId: seqId, commands: commands as never },
			{
				ids,
				now: () => '2026-10-15T10:00:00.000Z',
				revision,
				registries: defaultRegistries(mgRegistry),
			},
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		doc = document;
		revision = result.revision;
		return result.refs;
	};
	const shot = (at: number, frames: number, name: string) => {
		const r = tx([
			{ type: 'media.register', asset: asset('video'), ref: '$m' },
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				sourceRange: { in: { flicks: 30 * F }, out: { flicks: (30 + frames) * F } },
				at,
				tracks: { video: 'V1' },
				audio: false,
				ref: '$c',
			},
			{ type: 'clip.update', clipId: '$c', patch: { name } },
		]);
		return r.$c!;
	};
	const a = shot(0, 90, 'Shot A');
	shot(90, 90, 'Shot B');
	const c = shot(180, 150, 'Shot C');
	tx([
		{
			type: 'transition.add',
			clipId: c,
			edge: 'in',
			effectId: 'jasper.push',
			duration: 20,
			alignment: 'center',
			params: { direction: 'westToEast' },
		},
	]);
	const logo = tx([
		{ type: 'media.register', asset: asset('image'), ref: '$m' },
		{ type: 'clip.place', source: { mediaId: '$m' }, at: 30, tracks: { video: 'V2' }, ref: '$l' },
	]).$l!;
	tx([
		{
			type: 'clip.addText',
			at: 200,
			duration: 90,
			track: 'V3',
			content: { text: 'HELLO WORLD' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 45 } },
		},
		{
			type: 'clip.addMotionGraphic',
			at: 330,
			duration: 90,
			track: 'V1',
			template: { id: 'lower-third', version: 1 },
		},
		{ type: 'marker.add', frame: 250, name: 'sfx: boom+swoosh' },
	]);
	// The logo flies in from the left and overshoots its rest position (keyframes written directly).
	doc = structuredClone(doc);
	const cl = doc.sequences[seqId]!.clips[logo]! as unknown as {
		name: string;
		duration: number;
		transform: { position: Animatable<[number, number]> };
	};
	cl.name = 'Logo';
	cl.duration = 120;
	const k = (id: string, frame: number, value: [number, number]): Keyframe<[number, number]> => ({
		id,
		time: Math.round(frame * F),
		value,
		interpolation: 'linear',
		easeIn: LINEAR,
		easeOut: LINEAR,
	});
	cl.transform.position = {
		value: [960, 540],
		keyframes: [
			k('kf_00000000000000P1', 10, [200, 540]),
			k('kf_00000000000000P2', 22, [1010, 540]),
			k('kf_00000000000000P3', 27, [960, 540]),
		],
	};
	return { doc, seqId, revision, a, logo, tx: (cmds: unknown[]) => tx(cmds), get: () => doc };
}

export const envelopeOf = (doc: ProjectDocument, revision: number) =>
	makeEnvelope(doc, { revision, savedAt: '2026-10-15T10:00:00.000Z', platform: 'test' });
