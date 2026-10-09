// Projects for the editor UI performance scenarios (workstream ui-perf, docs/performance.md §5), built through the
// real command system so they are exactly what an editor or an agent produces:
//   timeline:<n>  one sequence of <n> colour mattes on four video tracks (clip i at ⌊i/4⌋·40, 30 frames on V(i mod 4)+1,
//                 the layout of e2e/perf-core.spec.ts), plus a fifth, empty video track;
//   keyframes:<n> one sequence with a title clip carrying five effects and <n> keyframes per animated parameter;
//   items:<n>     <n> media items (offline footage and stills) in the project, ten bins, one empty sequence;
//   scale         the golden-fuzz scale project (200 sequences, ~5 000 clips; packages/project/bench/scale-project.ts).
// `pnpm exec tsx scripts/perf/ui-fixtures.ts <spec> <out.json>` writes the project envelope (what PUT /api/projects
// takes); `uiFixture(spec)` returns it.
import { writeFileSync } from 'node:fs';
import { buildScaleProject } from '../../packages/project/bench/scale-project.ts';
import {
	applyTransaction,
	type CommandContext,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
} from '../../packages/project/src/index.ts';

const FLICKS = 705_600_000;

function builder(name: string) {
	const ids = createCounterIdSource(1);
	let doc = createEmptyProject({ ids, name, preset: 'hd-1080p-30' });
	let revision = 0;
	const ctx = (): CommandContext => ({
		ids,
		now: () => '2026-10-08T10:00:00.000Z',
		revision,
		registries: defaultRegistries(),
	});
	const tx = (commands: unknown[], label = 'fixture') => {
		const sequenceId = Object.keys(doc.sequences)[0];
		const r = applyTransaction(
			doc,
			{ label, origin: 'user', ...(sequenceId ? { sequenceId } : {}), commands } as Parameters<
				typeof applyTransaction
			>[1],
			ctx(),
		);
		if (!r.result.ok) throw new Error(`${label}: ${JSON.stringify(r.result.errors).slice(0, 600)}`);
		doc = r.document;
		revision = r.result.revision;
		return r.result;
	};
	return { tx, doc: () => doc };
}

function mediaAsset(i: number, kind: 'video' | 'image') {
	return {
		kind,
		fingerprint: `q1:${(i + 1).toString(16).padStart(64, '0')}`,
		originalName: `${kind === 'image' ? 'still' : 'shot'}-${String(i).padStart(4, '0')}.${kind === 'image' ? 'png' : 'mp4'}`,
		sizeBytes: 50_000_000 + i,
		container: kind === 'image' ? 'png_pipe' : 'mov,mp4',
		probe: {
			durationFlicks: kind === 'image' ? null : (20 + (i % 40)) * FLICKS,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: kind === 'image' ? 'png' : 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				...(kind === 'video'
					? [
							{
								index: 1,
								type: 'audio',
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
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_uiperf_${i}` }],
		derivation: null,
		importedAt: '2026-10-08T10:00:00.000Z',
	};
}

/** One sequence of `n` colour mattes (the perf-core layout). */
export function timelineProject(n: number): ProjectDocument {
	const b = builder(`UI perf ${n} clips`);
	b.tx([{ type: 'track.add', kind: 'video', count: 1 }], 'tracks');
	const CHUNK = 500;
	for (let from = 0; from < n; from += CHUNK)
		b.tx(
			Array.from({ length: Math.min(CHUNK, n - from) }, (_, k) => {
				const i = from + k;
				return {
					type: 'clip.addSolid',
					at: Math.floor(i / 4) * 40,
					duration: 30,
					track: `V${(i % 4) + 1}`,
					color: [((i % 7) + 1) / 8, 0.3, 0.6, 1],
				};
			}),
			'clips',
		);
	return b.doc();
}

/** A title with five effects whose animated parameters carry `n` keyframes each (Effect Controls at scale). */
export function keyframesProject(n: number): ProjectDocument {
	const b = builder(`UI perf ${n} keyframes`);
	const duration = Math.max(300, n * 3);
	b.tx(
		[
			{ type: 'clip.addSolid', at: 0, duration, track: 'V1', color: [0.2, 0.3, 0.6, 1], ref: '$c' },
			{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.gaussian-blur', ref: '$f1' },
			{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.brightness-contrast', ref: '$f2' },
			{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.s.glow', ref: '$f3' },
			{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.s.vignette', ref: '$f4' },
			{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.s.blur', ref: '$f5' },
		],
		'clip',
	);
	const clipId = Object.keys(b.doc().sequences[Object.keys(b.doc().sequences)[0]!]!.clips)[0]!;
	const fx = (
		b.doc().sequences[Object.keys(b.doc().sequences)[0]!]!.clips[clipId] as { effects: { id: string }[] }
	).effects;
	const params: [number, string, number, number][] = [
		[0, 'radius', 0, 20],
		[1, 'brightness', -20, 20],
		[1, 'contrast', -20, 20],
		[2, 'brightness', 0.5, 1.5],
		[3, 'radius', 0.5, 1],
		[4, 'blurAmount', 0, 1],
	];
	const cmds: unknown[] = [];
	for (const [k, param, lo, hi] of params)
		for (let i = 0; i < n; i++)
			cmds.push({
				type: 'keyframe.add',
				target: ['effect', fx[k]!.id, param],
				at: { frames: Math.round((i * (duration - 1)) / Math.max(1, n - 1)) },
				value: i % 2 ? hi : lo,
			});
	for (const t of ['opacity', ['transform', 'scale'], ['transform', 'rotation']] as const)
		for (let i = 0; i < n; i++)
			cmds.push({
				type: 'param.set',
				target: ['clip', clipId, ...(typeof t === 'string' ? [t] : t)],
				at: { frames: Math.round((i * (duration - 1)) / Math.max(1, n - 1)) },
				value: t === 'opacity' ? (i % 2 ? 100 : 40) : t[1] === 'scale' ? 80 + (i % 5) * 10 : (i % 9) * 5,
			});
	// Animated first (a keyframe at frame 0 for each clip parameter), then every keyframe.
	b.tx(
		[
			{ type: 'param.setAnimated', target: ['clip', clipId, 'opacity'], animated: true, at: { frames: 0 } },
			{
				type: 'param.setAnimated',
				target: ['clip', clipId, 'transform', 'scale'],
				animated: true,
				at: { frames: 0 },
			},
			{
				type: 'param.setAnimated',
				target: ['clip', clipId, 'transform', 'rotation'],
				animated: true,
				at: { frames: 0 },
			},
		],
		'animate',
	);
	b.tx(cmds, 'keyframes');
	return b.doc();
}

/** `n` media items (offline footage and stills, so nothing is fetched), ten bins, one empty sequence. */
export function itemsProject(n: number): ProjectDocument {
	const b = builder(`UI perf ${n} items`);
	b.tx(
		Array.from({ length: n }, (_, i) => ({
			type: 'media.register',
			asset: mediaAsset(i, i % 5 === 4 ? 'image' : 'video'),
		})),
		'media',
	);
	b.tx(
		Array.from({ length: 10 }, (_, i) => ({ type: 'bin.create', name: `Bin ${i + 1}` })),
		'bins',
	);
	return b.doc();
}

export function uiFixture(spec: string): ProjectDocument {
	const [kind, arg] = spec.split(':');
	const n = Number(arg);
	switch (kind) {
		case 'timeline':
			return timelineProject(n || 1000);
		case 'keyframes':
			return keyframesProject(n || 200);
		case 'items':
			return itemsProject(n || 2000);
		case 'scale':
			return buildScaleProject({ sequences: n || 200 });
		default:
			throw new Error(`unknown fixture ${spec}`);
	}
}

export function uiFixtureEnvelope(spec: string) {
	return makeEnvelope(uiFixture(spec), {
		revision: 1,
		savedAt: '2026-10-08T10:00:00.000Z',
		platform: 'perf',
	});
}

if (process.argv[1] && /ui-fixtures\.ts$/.test(process.argv[1])) {
	const [spec, out] = process.argv.slice(2);
	if (!spec || !out) {
		console.error(
			'usage: tsx scripts/perf/ui-fixtures.ts <timeline:N|keyframes:N|items:N|scale[:N]> <out.json>',
		);
		process.exit(2);
	}
	writeFileSync(out, JSON.stringify(uiFixtureEnvelope(spec)));
}
