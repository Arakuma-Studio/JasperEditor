// A large, deterministic project for the scale benchmark (bench/scale.ts) and for tests that need a realistic big
// document: N sequences of footage, titles, solids, stills and shapes with GPU effects, Lumetri, keyframes,
// transitions and markers — built through the real command system (`applyTransaction`), so it is exactly what an
// editor or an agent produces. Default size: 200 sequences, ~5,000 clips (effectcraft's `--ops` project is the model:
// 200 comps / 5,000 layers).
import {
	applyTransaction,
	type CommandContext,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
} from '../src/index.ts';

export type ScaleOptions = {
	/** Sequences (default 200). */
	sequences?: number;
	/** Clips per sequence, counting linked audio (default 25 → 5,000 clips). Multiple of 5, ≥ 10. */
	clipsPerSequence?: number;
};

const FPS = 30;
const FLICKS = 705_600_000;
/** GPU effects cycled over the footage, one per clip, with a keyframed numeric parameter. */
const FX: [string, string, number, number][] = [
	['jasper.gaussian-blur', 'radius', 0, 20],
	['jasper.s.glow', 'brightness', 0.5, 1.5],
	['jasper.s.blur', 'blurAmount', 0, 1],
	['jasper.s.vignette', 'radius', 0.5, 1],
	['jasper.brightness-contrast', 'brightness', -20, 20],
];

function asset(i: number, kind: 'video' | 'image'): Omit<MediaAsset, 'id'> {
	return {
		kind,
		fingerprint: `q1:${(i + 1).toString(16).padStart(64, '0')}`,
		originalName: `${kind}-${i}.${kind === 'image' ? 'png' : 'mp4'}`,
		sizeBytes: 50_000_000,
		container: kind === 'image' ? 'png_pipe' : 'mov,mp4',
		probe: {
			durationFlicks: kind === 'image' ? null : 60 * FLICKS,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: kind === 'image' ? 'png' : 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: FPS, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				...(kind === 'video'
					? [
							{
								index: 1,
								type: 'audio' as const,
								codec: 'aac',
								sampleRate: 48000,
								channels: 2,
								channelLayout: 'stereo',
							},
						]
					: []),
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_scale_${i}` }],
		derivation: null,
		importedAt: '2026-10-01T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

function must(r: ReturnType<typeof applyTransaction>, what: string): ReturnType<typeof applyTransaction> {
	if (!r.result.ok)
		throw new Error(`scale project: ${what} failed: ${JSON.stringify(r.result.errors).slice(0, 800)}`);
	return r;
}

/** Builds the project. Deterministic: same options → byte-identical JSON. */
export function buildScaleProject(opts: ScaleOptions = {}): ProjectDocument {
	const sequences = opts.sequences ?? 200;
	const perSeq = opts.clipsPerSequence ?? 25;
	if (perSeq < 10 || perSeq % 5 !== 0)
		throw new RangeError('clipsPerSequence must be a multiple of 5, at least 10');
	const ids = createCounterIdSource(1);
	let doc = createEmptyProject({ ids, name: 'Scale', preset: 'hd-1080p-30' });
	let revision = 0;
	const ctx = (): CommandContext => ({
		ids,
		now: () => '2026-10-01T10:00:00.000Z',
		revision,
		registries: defaultRegistries(),
	});
	const tx = (commands: unknown[], label: string, sequenceId?: string) => {
		const r = must(
			applyTransaction(
				doc,
				{ label, origin: 'user', ...(sequenceId ? { sequenceId } : {}), commands } as Parameters<
					typeof applyTransaction
				>[1],
				ctx(),
			),
			label,
		);
		doc = r.document;
		revision = (r.result as { revision: number }).revision;
		return r.result as Extract<ReturnType<typeof applyTransaction>['result'], { ok: true }>;
	};
	// Media: 24 movies (video + stereo audio) and 6 stills.
	const media = tx(
		[
			...Array.from({ length: 24 }, (_, i) => ({
				type: 'media.register',
				asset: asset(i, 'video'),
				ref: `$v${i}`,
			})),
			...Array.from({ length: 6 }, (_, i) => ({
				type: 'media.register',
				asset: asset(24 + i, 'image'),
				ref: `$i${i}`,
			})),
		],
		'media',
	).refs;
	const firstSeq = Object.keys(doc.sequences)[0]!;
	const seqIds = [firstSeq];
	if (sequences > 1)
		seqIds.push(
			...Object.values(
				tx(
					Array.from({ length: sequences - 1 }, (_, i) => ({
						type: 'sequence.create',
						name: `Sequence ${i + 2}`,
						ref: `$s${i}`,
					})),
					'sequences',
				).refs,
			),
		);
	// Per sequence, `perSeq` clips in groups of five: a movie (video + linked audio), a title, a solid or a still, and
	// a shape.
	const groups = perSeq / 5;
	seqIds.forEach((seqId, s) => {
		const cmds: unknown[] = [{ type: 'track.add', kind: 'video', count: 2 }];
		for (let g = 0; g < groups; g++) {
			const at = g * 90;
			const n = s * groups + g;
			cmds.push(
				{
					type: 'clip.place',
					source: { mediaId: media[`$v${n % 24}`] },
					at,
					sourceRange: { in: { sourceFrames: (n % 10) * 30 }, out: { sourceFrames: (n % 10) * 30 + 90 } },
					ref: `$m${g}`,
				},
				{
					type: 'clip.addText',
					at: at + 10,
					duration: 70,
					track: 'V2',
					content: { text: `Title ${s}.${g} — ünïcode ✓` },
					ref: `$t${g}`,
				},
				g % 2
					? {
							type: 'clip.place',
							source: { mediaId: media[`$i${n % 6}`] },
							at: at + 5,
							tracks: { video: 'V3' },
							ref: `$x${g}`,
						}
					: {
							type: 'clip.addSolid',
							at: at + 5,
							duration: 80,
							track: 'V3',
							color: [0.1, 0.2, 0.6, 1],
							ref: `$x${g}`,
						},
				{
					type: 'clip.addShape',
					at: at + 20,
					duration: 50,
					track: 'V4',
					shape: { type: g % 2 ? 'ellipse' : 'rect', size: [300, 200], fill: [1, 0.8, 0.2, 1] },
					ref: `$y${g}`,
				},
			);
			const [fx, param, from, to] = FX[n % FX.length]!;
			cmds.push(
				{ type: 'effect.add', target: { clipId: `$m${g}` }, effectId: fx, ref: `$f${g}` },
				{ type: 'keyframe.add', target: ['effect', `$f${g}`, param], at: { frames: at }, value: from },
				{ type: 'keyframe.add', target: ['effect', `$f${g}`, param], at: { frames: at + 60 }, value: to },
				{
					type: 'param.setAnimated',
					target: ['clip', `$t${g}`, 'opacity'],
					animated: true,
					at: { frames: at + 10 },
				},
				{ type: 'param.set', target: ['clip', `$t${g}`, 'opacity'], value: 0, at: { frames: at + 10 } },
				{ type: 'param.set', target: ['clip', `$t${g}`, 'opacity'], value: 100, at: { frames: at + 25 } },
				{ type: 'param.set', target: ['clip', `$t${g}`, 'opacity'], value: 0, at: { frames: at + 79 } },
			);
			if (g % 2 === 0)
				cmds.push({ type: 'effect.add', target: { clipId: `$x${g}` }, effectId: 'jasper.lumetri' });
			if (g > 0 && !process.env.NOTR)
				cmds.push({
					type: 'transition.add',
					clipId: `$m${g}`,
					edge: 'in',
					effectId: 'jasper.cross-dissolve',
					duration: 10,
				});
			if (g % 4 === 0) cmds.push({ type: 'marker.add', frame: at, name: `Marker ${g}` });
		}
		tx(cmds, `sequence ${s}`, seqId);
	});
	return doc;
}

/** Clip count over every sequence. */
export function countClips(doc: ProjectDocument): number {
	let n = 0;
	for (const s of Object.values(doc.sequences)) n += Object.keys(s.clips).length;
	return n;
}
