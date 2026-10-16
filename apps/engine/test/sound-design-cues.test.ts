// POST /api/sound-design/cues (spec 12 §2.8, P2-R6; wp-note "WP2.3 cue route & MCP tools"): cue suggestions derived
// on the engine with its motion-graphic template registry, for an inline envelope or a stored project, with frames,
// timecodes, reasons, per-source stats and the stored cue each suggestion matches. Hostile bodies give typed errors.
import { type SoundCueSuggestion, SoundCuesResponseSchema } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Animatable,
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	cueInputFromDerived,
	type DerivedCue,
	defaultRegistries,
	type Keyframe,
	loadProject,
	type MediaAsset,
	makeEnvelope,
	PROJECT_CUE_SOURCES,
	type ProjectDocument,
	soundDesignSettingsOf,
} from '@jasper/project';
import { describeFuzz, jsonTarget } from '@jasper/testkit/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The editor's Suggest Cues… planner (pure; no React): both surfaces must derive the same cues (spec 12 §2.8).
import { planSuggestion } from '../../web/src/sound/cues/suggest.ts';
import { closeApps, JSON_H, makeApp, type TestApp } from './helpers.ts';

const F = 705_600_000 / 30;
const LINEAR = { influence: 1 / 3, slope: 0 };
let fp = 0;

function asset(kind: 'video' | 'image', seconds = 60): Omit<MediaAsset, 'id'> {
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
function fixture() {
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

const envelopeOf = (doc: ProjectDocument, revision: number) =>
	makeEnvelope(doc, { revision, savedAt: '2026-10-15T10:00:00.000Z', platform: 'test' });

let app: TestApp;
beforeAll(async () => {
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

async function post(body: unknown) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/sound-design/cues',
		headers: JSON_H,
		payload: JSON.stringify(body),
	});
	return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

const byFrom = (cues: SoundCueSuggestion[], from: string) => cues.filter((c) => c.from === from);

describe('POST /api/sound-design/cues', () => {
	it('derives every event of the Phase 2 fixture (inline envelope) with frames, timecodes, reasons and stats', async () => {
		const f = fixture();
		const r = await post({ envelope: envelopeOf(f.doc, f.revision), sequenceId: f.seqId });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const res = SoundCuesResponseSchema.parse(r.body);
		expect(res).toMatchObject({
			projectId: null,
			sequenceId: f.seqId,
			revision: f.revision,
			frameRate: { num: 30, den: 1 },
			density: 'balanced',
			respectDialogue: true,
			storedCues: 0,
		});
		expect(res.warnings).toEqual([]);
		const cuts = byFrom(res.cues, 'edits');
		expect(cuts.map((c) => c.frame)).toEqual([90, 330]);
		expect(cuts[0]!.reason).toBe("Cut on V1: 'Shot A' → 'Shot B'");
		expect(cuts[0]!.timecode).toBe('00:00:03:00');
		expect(cuts[0]!.seconds).toBe(3);
		const push = byFrom(res.cues, 'transitions')[0]!;
		expect(push).toMatchObject({
			frame: 180,
			kind: 'transition',
			window: { start: 170, end: 190 },
			panSweep: { from: -60, to: 60 },
		});
		expect(push.types[0]).toBe('whoosh');
		const motion = byFrom(res.cues, 'keyframes');
		expect(motion.map((c) => [c.kind, c.frame])).toEqual(
			expect.arrayContaining([
				['move', 46],
				['land', 52],
			]),
		);
		expect(motion.find((c) => c.kind === 'move')!.anchor).toMatchObject({
			type: 'keyframe',
			property: 'transform.position',
			keyframeId: 'kf_00000000000000P2',
		});
		const keys = byFrom(res.cues, 'text');
		expect(keys.length).toBeGreaterThanOrEqual(5);
		expect(keys.every((c) => c.kind === 'appear' && c.group === keys[0]!.group)).toBe(true);
		expect(keys[0]!.frame).toBe(200);
		// The engine's registry measures the lower third's rendered motion: it settles at content frame 20 (0.67 s; the
		// declared intro end is 30) and starts leaving 12 frames before its end (declared 15).
		const mg = byFrom(res.cues, 'mg');
		expect(mg.map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 350, 0.8],
			['exit', 408, 0.6],
		]);
		expect(mg[0]!.reason).toBe("Lower Third settles after 0.67 s on V1 'Lower Third'");
		expect(res.stats.bySource.mg!.found).toBe(2);
		const marker = byFrom(res.cues, 'markers')[0]!;
		expect(marker).toMatchObject({ frame: 250, kind: 'manual', weight: 'hero', source: 'marker' });
		expect(marker.types).toEqual(['boom', 'whoosh']);
		for (const c of res.cues) {
			expect(c.reason.length).toBeGreaterThan(5);
			expect(c.storedCueId).toBeNull();
		}
		expect(res.stats.kept).toBe(res.cues.length);
		expect(res.curves).toBeUndefined();
	});

	it('reads a stored project by id, marks suggestions already stored, honours options', async () => {
		const f = fixture();
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: JSON.stringify({ name: 'Cue route', preset: 'hd-1080p-30' }),
		});
		const projectId = (JSON.parse(created.body) as { projectId: string }).projectId;
		// Store two of the suggestions as cues (one by anchor; the push), then save the project.
		const first = SoundCuesResponseSchema.parse(
			(await post({ envelope: envelopeOf(f.doc, f.revision), sequenceId: f.seqId })).body,
		);
		const push = byFrom(first.cues, 'transitions')[0]!;
		const cut = byFrom(first.cues, 'edits')[0]!;
		f.tx([
			{
				type: 'soundCue.add',
				cues: [push, cut].map((c) => cueInputFromDerived(c as unknown as DerivedCue)),
			},
		]);
		const doc = { ...f.get(), projectId } as ProjectDocument;
		const put = await app.inject({
			method: 'PUT',
			url: `/api/projects/${projectId}`,
			headers: { ...JSON_H, 'if-match': '0' },
			payload: JSON.stringify(envelopeOf(doc, 1)),
		});
		expect(put.statusCode, put.body).toBeLessThan(300);
		const r = await post({ projectId, opts: { curves: true } });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const res = SoundCuesResponseSchema.parse(r.body);
		expect(res.projectId).toBe(projectId);
		expect(typeof res.revision).toBe('number');
		expect(res.storedCues).toBe(2);
		const stored = res.cues.filter((c) => c.storedCueId);
		expect(stored.map((c) => c.frame).sort((x, y) => x - y)).toEqual([90, 180]);
		expect(new Set(stored.map((c) => c.storedCueId)).size).toBe(2);
		// Motion curves of the logo (per-frame speed, the Cue Seam's), rounded.
		const curve = res.curves!.find((c) => c.clipId === f.logo)!;
		expect(curve.speed.length).toBeGreaterThan(10);
		expect(Math.max(...curve.speed)).toBeGreaterThan(0.1);
		// Options: only transitions and markers, sparse, a range
		const only = SoundCuesResponseSchema.parse(
			(await post({ projectId, opts: { sources: ['transitions', 'markers'], density: 'sparse' } })).body,
		);
		expect(only.density).toBe('sparse');
		expect(new Set(only.cues.map((c) => c.from))).toEqual(new Set(['transitions', 'markers']));
		expect(only.stats.bySource.edits!.found).toBe(0);
		const ranged = SoundCuesResponseSchema.parse(
			(await post({ projectId, opts: { range: { start: 100, end: 260 } } })).body,
		);
		expect(ranged.cues.length).toBeGreaterThan(0);
		expect(ranged.cues.every((c) => c.frame >= 100 && c.frame < 260)).toBe(true);
		// the sequence's own density setting is the default
		f.tx([{ type: 'soundDesign.setSettings', density: 'rich' }]);
		const rich = SoundCuesResponseSchema.parse(
			(await post({ envelope: envelopeOf(f.get(), 9), sequenceId: f.seqId })).body,
		);
		expect(rich.density).toBe('rich');
	});

	it('refuses bad bodies with typed errors (never 500)', async () => {
		const f = fixture();
		const env = envelopeOf(f.doc, f.revision);
		const cases: [unknown, number, string][] = [
			[{}, 400, 'VALIDATION_FAILED'],
			[{ envelope: env, projectId: 'p1' }, 400, 'VALIDATION_FAILED'],
			[{ projectId: '../x' }, 400, 'VALIDATION_FAILED'],
			[{ projectId: 'prj_missing' }, 404, 'PROJECT_NOT_FOUND'],
			[{ envelope: env, sequenceId: 'seq_nope' }, 404, 'SEQUENCE_NOT_FOUND'],
			[{ envelope: env, opts: { density: 'loud' } }, 400, 'VALIDATION_FAILED'],
			[{ envelope: env, opts: { range: { start: 50, end: 10 } } }, 400, 'VALIDATION_FAILED'],
			[{ envelope: env, opts: { maxCues: 1e9 } }, 400, 'VALIDATION_FAILED'],
			[{ envelope: env, opts: { sources: ['edits', 'telepathy'] } }, 400, 'VALIDATION_FAILED'],
			[{ envelope: env, opts: { surprise: true } }, 400, 'VALIDATION_FAILED'],
			[{ envelope: { ...env, document: { sequences: 'x' } } }, 400, 'VALIDATION_FAILED'],
		];
		for (const [body, status, code] of cases) {
			const r = await post(body);
			expect([r.status, r.body.code], JSON.stringify(body).slice(0, 120)).toEqual([status, code]);
		}
		// maxCues caps the result
		const capped = SoundCuesResponseSchema.parse((await post({ envelope: env, opts: { maxCues: 3 } })).body);
		expect(capped.cues.length).toBeLessThanOrEqual(3);
	});

	it('needs the token in token mode (401 without it)', async () => {
		const secured = await makeApp({ dev: false, token: 's3cret' });
		const f = fixture();
		const payload = JSON.stringify({ envelope: envelopeOf(f.doc, f.revision) });
		const url = '/api/sound-design/cues';
		const without = await secured.inject({ method: 'POST', url, headers: JSON_H, payload });
		expect(without.statusCode).toBe(401);
		const wrong = await secured.inject({
			method: 'POST',
			url,
			headers: { ...JSON_H, authorization: 'Bearer nope' },
			payload,
		});
		expect(wrong.statusCode).toBe(401);
		const ok = await secured.inject({
			method: 'POST',
			url,
			headers: { ...JSON_H, authorization: 'Bearer s3cret' },
			payload,
		});
		expect(ok.statusCode, ok.body).toBe(200);
	});
});

describe('the same cues as the editor (Suggest Cues…) for the same document and options', () => {
	/** What a stored cue keeps of a suggestion (confidence as the route rounds it). */
	const view = (c: Record<string, unknown>) => {
		const x = { ...c };
		x.confidence = Math.round((c.confidence as number) * 1000) / 1000;
		return x;
	};
	/** The fixture plus a graphic moved by an expression only (no keyframes) and In/Out points. */
	function withExpression() {
		const f = fixture();
		const r = f.tx([
			{ type: 'media.register', asset: asset('image'), ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 120, tracks: { video: 'V4' }, ref: '$e' },
		]);
		f.tx([
			{ type: 'clip.update', clipId: r.$e!, patch: { name: 'Driven' } },
			{
				type: 'expression.set',
				target: ['clip', r.$e!, 'transform', 'position'],
				text: '[200 + 1200 * Math.min(1, Math.max(0, (time - 4.5) / 0.3)), 540]',
			},
			{ type: 'sequence.setInOut', in: 60, out: 300 },
		]);
		return f;
	}

	it('expression-driven motion, the sequence density, dialogue, ranges and sources agree', async () => {
		const f = withExpression();
		f.tx([{ type: 'soundDesign.setSettings', density: 'rich' }]);
		const env = envelopeOf(f.get(), 7);
		// The editor holds the loaded document (registries included), as the dialog reads `session.getCommitted()`.
		const doc = loadProject(env, { mgTemplates: mgRegistry }).document;
		const seq = doc.sequences[f.seqId]!;
		const all = new Set(PROJECT_CUE_SOURCES);
		const cases: {
			web: Omit<Parameters<typeof planSuggestion>[2], 'replace'>;
			route: Record<string, unknown>;
		}[] = [
			// The dialog's defaults: every source, whole sequence, the sequence's density, respect dialogue.
			{
				web: {
					sources: all,
					range: 'sequence',
					density: soundDesignSettingsOf(seq).density,
					respectDialogue: true,
				},
				route: {},
			},
			{
				web: { sources: all, range: 'inout', density: 'sparse', respectDialogue: false },
				route: { range: { start: 60, end: 300 }, density: 'sparse', respectDialogue: false },
			},
			{
				web: {
					sources: new Set(['keyframes', 'transitions'] as const),
					range: 'sequence',
					density: 'balanced',
					respectDialogue: true,
				},
				route: { sources: ['keyframes', 'transitions'], density: 'balanced' },
			},
		];
		for (const c of cases) {
			const r = await post({
				envelope: env,
				sequenceId: f.seqId,
				...(Object.keys(c.route).length ? { opts: c.route } : {}),
			});
			expect(r.status, JSON.stringify(r.body)).toBe(200);
			const res = SoundCuesResponseSchema.parse(r.body);
			const plan = planSuggestion(doc, f.seqId, { ...c.web, replace: true });
			expect(plan.adds.map(view), JSON.stringify(c.route)).toEqual(
				res.cues.map((x) => view(cueInputFromDerived(x as unknown as DerivedCue))),
			);
		}
		// The expression-driven graphic is in both: a move (and its stop) on V4 'Driven'.
		const r = SoundCuesResponseSchema.parse((await post({ envelope: env, sequenceId: f.seqId })).body);
		expect(r.cues.some((c) => c.reason.includes("'Driven'"))).toBe(true);
	});
});

// Mutated envelopes and options (structure, values, truncations, arbitrary JSON): a typed answer, never a 5xx.
const seedFixture = fixture();
const seedEnvelope = envelopeOf(seedFixture.doc, seedFixture.revision);
describeFuzz(
	'POST /api/sound-design/cues',
	[
		jsonTarget(
			'cue derivation request',
			[
				{ envelope: seedEnvelope, sequenceId: seedFixture.seqId },
				{ envelope: seedEnvelope, opts: { density: 'rich', curves: true, range: { start: 10, end: 300 } } },
				{ envelope: seedEnvelope, opts: { sources: ['keyframes', 'text'], maxCues: 4, minGapFrames: 3 } },
			],
			async (body) => {
				const r = await post(body);
				if (r.status >= 500) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
				if (r.status === 200) SoundCuesResponseSchema.parse(r.body);
			},
			undefined,
			{ iterations: 40, properties: 10, slowMs: 20_000 },
		),
	],
	600_000,
);
