import { isAnimeTemplate, mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import {
	anim,
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	defaultShape,
	defaultTransform,
	FLICKS_PER_SECOND,
	type RenderSnapshot,
	shapeIntrinsicBox,
	TEXT_ANIMATION_SPECS,
} from '@jasper/project';

const PARITY_DOC_FRAMES = 40;
export const PARITY_SCENE = {
	width: 1280,
	height: 720,
	fps: 30,
	durationInFrames: PARITY_DOC_FRAMES,
} as const;

/**
 * Template assets of the parity scene (social-comment §7.8): the URLs of the font faces and emoji images the anime
 * templates declare (`requiredAssets`; social-comment@1 draws TikTok Sans and an emoji). The test passes data URLs
 * built in Node; without them the templates' assets are not resolved (the bundle's default props only).
 */
export type ParityAssets = {
	font(face: { family: string; weight: number; style: 'normal' | 'italic' }): string | null;
	emoji(pack: string, grapheme: string): string | null;
};

export function parityDoc(assets?: ParityAssets): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'Parity', preset: 'hd-720p-30' });
	const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) };
	const specs = TEXT_ANIMATION_SPECS;
	const templates = mgRegistry.definitions().filter(isAnimeTemplate);
	const tracks = specs.length + templates.length + 1;
	const commands: Command[] = [{ type: 'track.add', kind: 'video', count: tracks }];
	specs.forEach((spec, i) => {
		const col = i % 3;
		const row = Math.floor(i / 3);
		commands.push({
			type: 'clip.addText',
			at: 0,
			duration: PARITY_DOC_FRAMES,
			track: `V${i + 1}`,
			content: { text: `${spec.label} ✓ déjà`, style: { sizePx: 44 } },
			transform: { position: [220 + col * 420, 90 + row * 110] },
			ref: `$t${i}`,
		});
	});
	for (const [i, t] of templates.entries())
		commands.push({
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: PARITY_DOC_FRAMES,
			track: `V${specs.length + i + 1}`,
			template: { id: t.id, version: t.version },
		});
	const { document, result } = applyTransaction(base, { label: 'parity', origin: 'user', commands }, ctx);
	if (!result.ok) throw new Error(`parity doc: ${JSON.stringify(result.errors)}`);
	const doc = structuredClone(document);
	const seq = Object.values(doc.sequences)[0]!;
	const ease = { influence: 1 / 3, slope: 0 };
	const kf = <T>(id: string, frame: number, value: T) => ({
		id,
		time: Math.round((frame * FLICKS_PER_SECOND) / 30),
		value,
		interpolation: 'linear' as const,
		easeIn: ease,
		easeOut: ease,
	});
	const last = PARITY_DOC_FRAMES - 1;
	specs.forEach((spec, i) => {
		const clip = seq.clips[result.refs[`$t${i}`]!];
		if (clip?.kind !== 'text') throw new Error('Parity text clip is missing');
		clip.transform.rotation.keyframes = [
			kf(`kf_000000000PARR${i}A`, 0, -6),
			kf(`kf_000000000PARR${i}B`, last, 6),
		];
		clip.opacity.keyframes = [kf(`kf_000000000PARO${i}A`, 0, 40), kf(`kf_000000000PARO${i}B`, last, 100)];
		const side = (phase: 'in' | 'out', frames: number) =>
			spec.phases.includes(phase)
				? { preset: spec.id, version: spec.version, durationFrames: frames, params: { ...spec.defaults } }
				: null;
		clip.textAnimation = { in: side('in', 14), out: side('out', 10) };
	});
	const shape = defaultShape('rect', { size: [160, 160] });
	shape.cornerRadius = anim(24);
	shape.size = {
		value: [160, 160],
		keyframes: [
			kf<[number, number]>('kf_00000000000PARIT1', 0, [80, 80]),
			kf<[number, number]>('kf_00000000000PARIT2', last, [260, 200]),
		],
	};
	const frame = { width: 1280, height: 720 };
	seq.clips.clp_0000000000PARITY = {
		id: 'clp_0000000000PARITY',
		trackId: seq.videoTracks[tracks - 1]!.id,
		start: 0,
		duration: PARITY_DOC_FRAMES,
		sourceIn: 0,
		speed: { rate: 1, reverse: false, maintainPitch: false },
		name: 'Shape',
		label: 'magenta',
		enabled: true,
		linkId: null,
		groupId: null,
		markers: [],
		opacity: anim(100),
		blendMode: 'normal',
		effects: [],
		kind: 'shape',
		shape,
		transform: defaultTransform(shapeIntrinsicBox(shape), frame, 'none'),
	};
	return buildRenderSnapshot(doc, seq.id, {
		resolveMedia: () => null,
		resolveFont: () => null,
		...(assets ? { templateAssets: templateAssetOptions(mgRegistry, assets) } : {}),
	});
}
