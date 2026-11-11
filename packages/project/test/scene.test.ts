// Scene files (docs/wp-notes/scene-file.md): validation errors point into the file, `planScene` turns a scene into
// ordinary commands for one transaction, applying twice plans nothing, a 40 px move is one command, removals only
// touch clips the scene created, `exportScene` round-trips (export → apply is a no-op; apply → export → apply on a
// fresh project matches the original), and `scene.bind` is an undoable, validated command with a lenient read.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	defaultRegistries,
	EMPTY_PROBE,
	exportScene,
	findScenePage,
	findSceneSequence,
	formatSceneIssues,
	type ProjectDocument,
	planScene,
	repairDocument,
	resolveScene,
	SCENE_EXTENSION_KEY,
	type ScenePage,
	sceneBindingsOf,
	validateSceneFile,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const PAGE = '/pages/pano.html';
/** An import of PAGE (an HTML composition page, schema v13) at 1080×1350 / 30 fps with `query`. */
function registerPage(h: Harness, query: string, width = 1080): string {
	const hash = `${query}${width}`.padEnd(64, 'a').slice(0, 64);
	const r = h.ok([
		{
			type: 'media.register',
			asset: {
				kind: 'mg-bundle',
				fingerprint: `q1:${hash}`,
				originalName: `pano.html${query ? `?${query}` : ''}`,
				sizeBytes: 1000,
				container: 'html-page',
				probe: EMPTY_PROBE,
				locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${hash.slice(0, 24)}` }],
				derivation: null,
				importedAt: '2026-11-11T00:00:00.000Z',
				mgBundle: {
					remotionVersion: '4.0.499',
					bundleHash: hash,
					builtAt: '2026-11-11T00:00:00.000Z',
					source: { type: 'html-page', path: PAGE, name: 'pano.html' },
					compositions: [
						{
							id: 'pano',
							width,
							height: 1350,
							fps: 30,
							durationInFrames: 180,
							defaultProps: {},
							propsSchema: null,
							schemaSource: 'inferred',
						},
					],
					html: { entry: 'pano.html', query },
				},
			},
		},
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}
/** The test's `mediaFor` for HTML pages (the CLI resolves paths first; here they are absolute already). */
const pageOf = (h: Harness, s: string, kind: string, page?: ScenePage) =>
	kind === 'bundle' && page ? findScenePage(h.doc, s, page) : null;
/** export-scene's media names: the page file for HTML pages, the media id otherwise. */
const srcOf = (doc: ProjectDocument) => (id: string) => doc.media[id]?.mgBundle?.source.path ?? id;

const registries = defaultRegistries();

function issuesOf(h: Harness, raw: unknown, media: Record<string, string> = {}): string {
	const v = validateSceneFile(raw);
	if (!v.ok) return formatSceneIssues(v.issues);
	const r = resolveScene(v.scene, {
		doc: h.doc,
		registries,
		mediaFor: (s, kind, page) => media[s] ?? pageOf(h, s, kind, page),
	});
	if (!r.ok) return formatSceneIssues(r.issues);
	const p = planScene(h.doc, r.scene, { registries, newId: (x) => h.ids.next(x) });
	return p.ok ? '' : formatSceneIssues(p.issues);
}

/** Plans `raw` against the harness document (throws on any issue). */
function plan(h: Harness, raw: unknown, media: Record<string, string> = {}) {
	const v = validateSceneFile(raw);
	if (!v.ok) throw new Error(formatSceneIssues(v.issues));
	const r = resolveScene(v.scene, {
		doc: h.doc,
		registries,
		mediaFor: (s, kind, page) => media[s] ?? (h.doc.media[s] ? s : pageOf(h, s, kind, page)),
	});
	if (!r.ok) throw new Error(formatSceneIssues(r.issues));
	const p = planScene(h.doc, r.scene, { registries, newId: (x) => h.ids.next(x) });
	if (!p.ok) throw new Error(formatSceneIssues(p.issues));
	return p.plan;
}

/** Plans and applies `raw` as one transaction; returns the plan. */
function apply(h: Harness, raw: unknown, media: Record<string, string> = {}) {
	const p = plan(h, raw, media);
	if (p.commands.length) h.ok(p.commands);
	expect(checkInvariants(h.doc)).toEqual([]);
	return p;
}

const seqOf = (doc: ProjectDocument, name: string) => findSceneSequence(doc, name).seq!;
const clipNamed = (doc: ProjectDocument, name: string) =>
	Object.values(seqOf(doc, 'Promo').clips).find((c) => c.name === name)!;

const SCENE = {
	scene: 1,
	sequence: { name: 'Promo', size: [1280, 720], fps: 30, duration: 6, background: '#101018' },
	layers: [
		{ id: 'bg', type: 'shape', shape: 'rect', size: [1280, 720], fill: '#202A44', position: [640, 360] },
		{
			id: 'headline',
			type: 'text',
			text: 'Hello scene',
			font: 'Source Sans 3',
			size: 96,
			weight: 700,
			color: '#FFD166',
			position: [640, 300],
			start: 0.3,
			duration: 5,
			animation: { in: 'fade', out: { preset: 'fade', duration: 0.5 } },
			keyframes: {
				scale: [
					{ t: 0, value: 80, ease: 'ease-out' },
					{ t: 1, value: 100 },
				],
			},
			effects: [
				{
					effect: 'jasper.gaussian-blur',
					keyframes: {
						radius: [
							{ t: 0, value: 20, ease: 'basic.ease-in-out' },
							{ t: '15f', value: 0 },
						],
					},
				},
			],
		},
		{
			id: 'dot',
			type: 'shape',
			shape: 'ellipse',
			size: [120, 120],
			fill: '#EF476F',
			stroke: { color: '#FFFFFF', width: 6 },
			keyframes: {
				position: [
					{ t: 0, value: [200, 600], ease: 'cubic-bezier(0.2, 0, 0, 1)' },
					{ t: 2, value: [1080, 600], ease: 'hold' },
					{ t: 3, value: [640, 600] },
				],
				opacity: [
					{ t: 0, value: 0 },
					{ t: '500ms', value: 100 },
				],
			},
			masks: [{ ellipse: [0.1, 0.1, 0.8, 0.8], feather: 4 }],
		},
	],
};

/** A copy of SCENE to break freely. */
const loose = () => structuredClone(SCENE) as unknown as { layers: Record<string, unknown>[] };

describe('scene file validation', () => {
	it('points every problem at its path in the file', () => {
		const h = new Harness();
		const bad = loose();
		(bad.layers[2]!.keyframes as { position: { ease?: string }[] }).position[0]!.ease = 'foo';
		expect(issuesOf(h, bad)).toBe('layers[2].keyframes.position[0].ease: unknown ease "foo"');
		const typo = loose();
		typo.layers[1]!.colour = '#fff';
		expect(issuesOf(h, typo)).toBe('layers[1]: unknown key "colour"');
		const multi = loose();
		(multi.layers[2]!.keyframes as { opacity: { ease?: string }[] }).opacity[0]!.ease = 'bounce.out-3';
		expect(issuesOf(h, multi)).toMatch(
			/^layers\[2\]\.keyframes\.opacity\[0\]\.ease: "bounce\.out-3" is a multi-point curve/,
		);
		const fx = loose();
		fx.layers[1]!.effects = [{ effect: 'jasper.gaussian-blur', params: { radios: 3 } }];
		expect(issuesOf(h, fx)).toMatch(
			/^layers\[1\]\.effects\[0\]\.params\.radios: jasper\.gaussian-blur has no param "radios"/,
		);
		const anim = loose();
		anim.layers[1]!.animation = { in: 'wobble' };
		expect(issuesOf(h, anim)).toBe(
			'layers[1].animation.in: unknown text animation "wobble" (list_text_animations)',
		);
		const dup = structuredClone(SCENE);
		dup.layers[2]!.id = 'bg';
		expect(issuesOf(h, dup)).toBe('layers[2].id: id "bg" is also layers[0]');
		const both = loose();
		both.layers[2]!.opacity = 50;
		expect(issuesOf(h, both)).toBe(
			'layers[2].keyframes.opacity: give opacity or keyframes.opacity, not both',
		);
		expect(
			issuesOf(h, { scene: 1, sequence: { name: 'X' }, layers: [{ id: 'a', type: 'text', text: 'a' }] }),
		).toBe('layers[0].duration: needed (or give sequence.duration)');
		expect(issuesOf(h, { ...SCENE, layers: [{ id: 'p', type: 'image', src: 'missing.png' }] })).toBe(
			'layers[0].src: no such media "missing.png" in the project',
		);
		expect(issuesOf(h, [])).toBe('(file): a scene file is an object with scene, sequence and layers');
	});
});

describe('planScene / apply', () => {
	it('creates the sequence and layers in one transaction; a second apply plans nothing', () => {
		const h = new Harness();
		const first = apply(h, SCENE);
		expect(first.createsSequence).toBe(true);
		expect(first.layers.map((l) => [l.id, l.status])).toEqual([
			['bg', 'created'],
			['headline', 'created'],
			['dot', 'created'],
		]);
		const seq = seqOf(h.doc, 'Promo');
		expect(seq.settings).toMatchObject({ width: 1280, height: 720, frameRate: { num: 30, den: 1 } });
		const headline = clipNamed(h.doc, 'headline');
		expect(headline).toMatchObject({ kind: 'text', start: 9, duration: 150 });
		expect(headline.kind === 'text' && headline.textAnimation?.out?.durationFrames).toBe(15);
		const dot = clipNamed(h.doc, 'dot');
		expect(
			dot.kind === 'shape' && dot.transform.position.keyframes.map((k) => [k.time > 0, k.interpolation]),
		).toEqual([
			[false, 'bezier'],
			[true, 'hold'],
			[true, 'linear'],
		]);
		expect(dot.kind === 'shape' && dot.masks?.length).toBe(1);
		expect(Object.keys(sceneBindingsOf(h.doc, seq.id)).sort()).toEqual(['bg', 'dot', 'headline']);
		const again = plan(h, SCENE);
		expect(again.commands).toEqual([]);
		expect(again.layers.every((l) => l.status === 'unchanged')).toBe(true);
	});

	it('a headline moved 40 px is one param.set in one transaction (the previous document is kept for undo)', () => {
		const h = new Harness();
		apply(h, SCENE);
		const before = h.doc;
		const moved = structuredClone(SCENE);
		(moved.layers[1] as { position: number[] }).position = [680, 300];
		const p = apply(h, moved);
		const id = clipNamed(h.doc, 'headline').id;
		expect(p.commands).toEqual([
			{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: [680, 300] },
		]);
		expect(p.layers.find((l) => l.id === 'headline')).toMatchObject({
			status: 'updated',
			aspects: ['position'],
		});
		expect(plan(h, moved).commands).toEqual([]);
		const pos = (d: ProjectDocument) =>
			(clipNamed(d, 'headline') as { transform: { position: { value: number[] } } }).transform.position.value;
		expect([pos(before), pos(h.doc)]).toEqual([
			[640, 300],
			[680, 300],
		]);
	});

	it('removes only layers it created; adopted and unrelated clips stay', () => {
		const h = new Harness();
		apply(h, SCENE);
		const seqId = seqOf(h.doc, 'Promo').id;
		// the user adds a title by hand, and a clip the next scene adopts by name
		h.ok([
			{
				type: 'clip.addText',
				sequenceId: seqId,
				at: 0,
				duration: 30,
				track: 'V5',
				name: 'mine',
				content: { text: 'Mine' },
			},
			{
				type: 'clip.addText',
				sequenceId: seqId,
				at: 0,
				duration: 30,
				track: 'V6',
				name: 'logo',
				content: { text: 'Logo' },
			},
		]);
		const withLogo = structuredClone(SCENE) as typeof SCENE & { layers: unknown[] };
		withLogo.layers.push({ id: 'logo', type: 'text', text: 'Logo!', track: 6, duration: '30f' });
		const adopt = apply(h, withLogo);
		expect(adopt.layers.find((l) => l.id === 'logo')).toMatchObject({ status: 'updated', aspects: ['text'] });
		// drop the dot (created by the scene) and the logo (adopted): only the dot goes
		const fewer = structuredClone(SCENE);
		fewer.layers.splice(2, 1);
		const p = apply(h, fewer);
		expect(p.removed.map((r) => r.id)).toEqual(['dot']);
		const names = Object.values(seqOf(h.doc, 'Promo').clips)
			.map((c) => c.name)
			.sort();
		expect(names).toEqual(['bg', 'headline', 'logo', 'mine']);
		expect(Object.keys(sceneBindingsOf(h.doc, seqId)).sort()).toEqual(['bg', 'headline']);
		expect(plan(h, fewer).commands).toEqual([]);
	});

	it('refuses to overwrite a clip the scene does not own', () => {
		const h = new Harness();
		apply(h, SCENE);
		const seqId = seqOf(h.doc, 'Promo').id;
		h.ok([
			{
				type: 'clip.addText',
				sequenceId: seqId,
				at: 0,
				duration: 30,
				track: 'V4',
				name: 'mine',
				content: { text: 'x' },
			},
		]);
		const more = structuredClone(SCENE) as typeof SCENE & { layers: unknown[] };
		more.layers.push({ id: 'new', type: 'text', text: 'new' });
		expect(issuesOf(h, more)).toMatch(/^layers\[3\]\.track: V4 already holds clip "mine"/);
	});

	it('moves, retimes and reorders layers with clip.move / clip.trim (no recreation)', () => {
		const h = new Harness();
		apply(h, SCENE);
		const ids = ['bg', 'headline', 'dot'].map((n) => clipNamed(h.doc, n).id);
		const swapped = loose();
		swapped.layers[1]!.start = 1;
		swapped.layers[1]!.duration = 2;
		swapped.layers.splice(1, 0, { id: 'subtitle', type: 'text', text: 'sub' });
		const p = apply(h, swapped);
		expect(p.layers.map((l) => [l.id, l.status])).toEqual([
			['bg', 'unchanged'],
			['subtitle', 'created'],
			['headline', 'updated'],
			['dot', 'updated'],
		]);
		expect(['bg', 'headline', 'dot'].map((n) => clipNamed(h.doc, n).id)).toEqual(ids);
		expect(clipNamed(h.doc, 'headline')).toMatchObject({ start: 30, duration: 60 });
		expect(plan(h, swapped).commands).toEqual([]);
	});

	it('images: places the media, renames it, keeps it on a second apply', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'media.register', asset: videoAsset({ kind: 'image', width: 400, height: 200 }) },
		]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const scene = {
			scene: 1,
			sequence: { name: 'Promo', duration: 4 },
			layers: [{ id: 'logo', type: 'image', src: 'logo.png', position: [300, 200], scale: 50, opacity: 80 }],
		};
		apply(h, scene, { 'logo.png': mediaId });
		const clip = clipNamed(h.doc, 'logo');
		expect(clip).toMatchObject({ kind: 'still', mediaId, duration: 120 });
		expect(
			clip.kind === 'still' && [
				clip.transform.position.value,
				clip.transform.scale.value,
				clip.opacity.value,
			],
		).toEqual([[300, 200], 50, 80]);
		expect(plan(h, scene, { 'logo.png': mediaId }).commands).toEqual([]);
	});
});

describe('exportScene', () => {
	const exported = (h: Harness) =>
		exportScene(h.doc, seqOf(h.doc, 'Promo').id, { registries, srcOf: (id) => id }).file;

	it('export → apply plans nothing, and apply → export → apply on a fresh project matches the original', () => {
		const h = new Harness();
		apply(h, SCENE);
		const file = exported(h);
		expect(file.layers).toHaveLength(3);
		expect(plan(h, file).commands).toEqual([]);
		const fresh = new Harness({ seed: 900 });
		apply(fresh, file);
		expect(plan(fresh, SCENE).commands).toEqual([]);
	});

	it('pins clips whose names collide, so the file still matches them', () => {
		const h = new Harness();
		apply(h, SCENE);
		const seqId = seqOf(h.doc, 'Promo').id;
		h.ok([
			{
				type: 'clip.addText',
				sequenceId: seqId,
				at: 0,
				duration: 30,
				track: 'V5',
				name: 'Title',
				content: { text: 'A' },
			},
			{
				type: 'clip.addText',
				sequenceId: seqId,
				at: 0,
				duration: 30,
				track: 'V6',
				name: 'Title',
				content: { text: 'B' },
			},
		]);
		const file = exported(h) as { layers: { id: string; clip?: string; name?: string }[] };
		const titles = file.layers.filter((l) => (l.name ?? l.id) === 'Title');
		expect(titles.map((l) => [l.id, !!l.clip])).toEqual([
			['Title', true],
			['Title-2', true],
		]);
		expect(plan(h, file).commands).toEqual([]);
	});
});

describe('HTML composition pages', () => {
	const pageScene = (query?: string, extra: Record<string, unknown> = {}) => ({
		scene: 1,
		sequence: { name: 'Promo', duration: 4 },
		layers: [
			{
				id: 'pano',
				type: 'composition',
				bundle: PAGE,
				composition: 'pano',
				page: { width: 1080, height: 1350, fps: 30, ...(query ? { query } : {}) },
				...extra,
			},
		],
	});

	it('picks the import with the same query and size; export writes the page back and round-trips', () => {
		const h = new Harness();
		const plain = registerPage(h, '');
		const s2 = registerPage(h, 's=2');
		registerPage(h, 's=2', 720);
		apply(h, pageScene('s=2'));
		const clip = clipNamed(h.doc, 'pano');
		expect(clip.kind === 'composition' && clip.composition.mediaId).toBe(s2);
		expect(plan(h, pageScene('s=2')).commands).toEqual([]);
		// another query is another import: the layer is made again on it
		const swap = apply(h, pageScene());
		expect(swap.layers[0]).toMatchObject({ status: 'recreated', why: 'another composition' });
		expect((clipNamed(h.doc, 'pano') as { composition: { mediaId: string } }).composition.mediaId).toBe(
			plain,
		);
		apply(h, pageScene('s=2'));
		const file = exportScene(h.doc, seqOf(h.doc, 'Promo').id, { registries, srcOf: srcOf(h.doc) }).file as {
			layers: Record<string, unknown>[];
		};
		expect(file.layers[0]).toMatchObject({
			bundle: PAGE,
			composition: 'pano',
			page: { width: 1080, height: 1350, fps: 30, query: 's=2' },
		});
		expect(plan(h, file).commands).toEqual([]);
		const fresh = new Harness({ seed: 700 });
		registerPage(fresh, '');
		registerPage(fresh, 's=2');
		apply(fresh, file);
		expect(plan(fresh, pageScene('s=2')).commands).toEqual([]);
	});

	it('validates the page with paths', () => {
		const h = new Harness();
		registerPage(h, '');
		const noPage = pageScene();
		delete (noPage.layers[0] as { page?: unknown }).page;
		expect(issuesOf(h, noPage)).toBe(
			'layers[0].page: an HTML page needs page: {width, height, fps, query?} (the import to use)',
		);
		expect(issuesOf(h, pageScene(undefined, { composition: 'Main' }))).toBe(
			'layers[0].composition: an HTML page\'s composition is its file name without the extension: "pano"',
		);
		expect(issuesOf(h, pageScene('s=9'))).toBe(
			'layers[0].bundle: no import of "/pages/pano.html" at 1080×1350, 30 fps, query "s=9" in the project',
		);
		expect(issuesOf(h, pageScene('a#b'))).toMatch(/^layers\[0\]\.page\.query: a query has no "#"/);
		expect(
			issuesOf(h, { ...pageScene(), layers: [{ ...pageScene().layers[0], bundle: './remotion-project' }] }),
		).toBe('layers[0].page: page is for HTML pages (a bundle ending in .html or .htm, or its media id)');
	});
});

describe('scene.bind', () => {
	it('refuses a missing clip, keeps the previous document, drops an empty value; unreadable bindings are reported and repaired', () => {
		const h = new Harness();
		apply(h, SCENE);
		const seqId = seqOf(h.doc, 'Promo').id;
		const r = h.tx([{ type: 'scene.bind', sequenceId: seqId, clipIds: { x: 'clp_0000000000000ZZZ' } }]);
		expect(r.ok ? 'ok' : r.errors[0]!.code).toBe('E_NOT_FOUND');
		const before = h.doc;
		h.ok([{ type: 'scene.bind', sequenceId: seqId, clipIds: { bg: null } }]);
		expect(Object.keys(sceneBindingsOf(h.doc, seqId)).sort()).toEqual(['dot', 'headline']);
		expect(Object.keys(sceneBindingsOf(before, seqId)).sort()).toEqual(['bg', 'dot', 'headline']);
		const damaged = structuredClone(before);
		const stored = damaged.extensions[SCENE_EXTENSION_KEY] as {
			sequences: Record<string, { layers: Record<string, unknown> }>;
		};
		stored.sequences[seqId]!.layers.bg = 42;
		expect(checkInvariants(damaged).map((i) => i.invariant)).toContain('INV-SCENE');
		expect(sceneBindingsOf(damaged, seqId)).toEqual({});
		const { document, report } = repairDocument(damaged, h.ids);
		expect(report.map((x) => x.action)).toContain('repair-scene-bindings');
		expect(Object.keys(sceneBindingsOf(document, seqId)).sort()).toEqual(['dot', 'headline']);
		h.ok([{ type: 'scene.bind', sequenceId: seqId, clipIds: { dot: null, headline: null } }]);
		expect(h.doc.extensions[SCENE_EXTENSION_KEY]).toBeUndefined();
		expect(checkInvariants(document)).toEqual([]);
	});
});

const EASES = [
	'linear',
	'hold',
	'ease-out',
	'ease-in-out',
	'basic.ease',
	'cubic-bezier(0.2, 0, 0, 1)',
] as const;
const hex = fc
	.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
	.map((c) => `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`);
const keysArb = (value: fc.Arbitrary<unknown>) =>
	fc
		.uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 2, maxLength: 4 })
		.chain((ts) =>
			fc.tuple(
				...[...ts]
					.sort((a, b) => a - b)
					.map((t) => fc.record({ t: fc.constant(`${t}f`), value, ease: fc.constantFrom(...EASES) })),
			),
		);
const common = {
	start: fc.integer({ min: 0, max: 30 }).map((f) => `${f}f`),
	duration: fc.integer({ min: 45, max: 90 }).map((f) => `${f}f`),
	position: fc.option(fc.tuple(fc.integer({ min: -200, max: 2000 }), fc.integer({ min: -200, max: 1200 })), {
		nil: undefined,
	}),
	rotation: fc.option(fc.integer({ min: -720, max: 720 }), { nil: undefined }),
	keyframes: fc.option(
		fc.record(
			{
				opacity: keysArb(fc.integer({ min: 0, max: 100 })),
				scale: keysArb(fc.integer({ min: 1, max: 400 })),
			},
			{ requiredKeys: [] },
		),
		{ nil: undefined },
	),
	effects: fc.option(
		fc.array(
			fc.record({
				effect: fc.constant('jasper.gaussian-blur'),
				params: fc.record({ radius: fc.integer({ min: 0, max: 80 }) }),
			}),
			{ maxLength: 2 },
		),
		{ nil: undefined },
	),
	masks: fc.option(
		fc.array(
			fc.record({
				rect: fc.constant([0.1, 0.2, 0.5, 0.5]),
				inverted: fc.boolean(),
				feather: fc.integer({ min: 0, max: 40 }),
			}),
			{ maxLength: 2 },
		),
		{ nil: undefined },
	),
};
const textLayer = fc.record(
	{
		type: fc.constant('text'),
		text: fc.string({ minLength: 1, maxLength: 20 }),
		size: fc.option(fc.integer({ min: 10, max: 300 }), { nil: undefined }),
		weight: fc.option(fc.constantFrom(300, 400, 700), { nil: undefined }),
		color: fc.option(hex, { nil: undefined }),
		align: fc.option(fc.constantFrom('left', 'center', 'right'), { nil: undefined }),
		animation: fc.option(fc.record({ in: fc.constantFrom('fade', 'pop', 'typewriter') }), { nil: undefined }),
		...common,
	},
	{ requiredKeys: ['type', 'text', 'start', 'duration'] },
);
const shapeLayer = fc.record(
	{
		type: fc.constant('shape'),
		shape: fc.constantFrom('rect', 'ellipse'),
		size: fc.option(fc.tuple(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 })), {
			nil: undefined,
		}),
		fill: fc.option(fc.oneof(hex, fc.constant(null)), { nil: undefined }),
		stroke: fc.option(fc.record({ color: hex, width: fc.integer({ min: 0, max: 30 }) }), { nil: undefined }),
		...common,
	},
	{ requiredKeys: ['type', 'shape', 'start', 'duration'] },
);
/** A layer on one of the two imports of PAGE every property run registers (query "" and "s=2"). */
const pageLayer = fc.record(
	{
		type: fc.constant('composition'),
		bundle: fc.constant(PAGE),
		composition: fc.constant('pano'),
		page: fc.constantFrom(
			{ width: 1080, height: 1350, fps: 30 },
			{ width: 1080, height: 1350, fps: 30, query: 's=2' },
		),
		...common,
	},
	{ requiredKeys: ['type', 'bundle', 'composition', 'page', 'start', 'duration'] },
);
const withPages = (h: Harness) => {
	registerPage(h, '');
	registerPage(h, 's=2');
	return h;
};
const sceneArb = fc
	.array(fc.oneof(textLayer, shapeLayer, pageLayer), { minLength: 1, maxLength: 5 })
	.map((layers) => ({
		scene: 1,
		sequence: { name: 'Promo', fps: 30, size: [1920, 1080] },
		layers: layers.map((l, i) => {
			const o: Record<string, unknown> = { id: `layer-${i}` };
			for (const [k, v] of Object.entries(l)) if (v !== undefined) o[k] = v;
			return o;
		}),
	}));

describe('scene properties (fast-check)', () => {
	it('apply is idempotent and export round-trips', () => {
		fc.assert(
			fc.property(sceneArb, (scene) => {
				const h = withPages(new Harness());
				apply(h, scene);
				expect(plan(h, scene).commands).toEqual([]);
				const file = exportScene(h.doc, seqOf(h.doc, 'Promo').id, { registries, srcOf: srcOf(h.doc) }).file;
				expect(validateSceneFile(file).ok).toBe(true);
				expect(plan(h, file).commands).toEqual([]);
				const fresh = withPages(new Harness({ seed: 5000 }));
				apply(fresh, file);
				expect(plan(fresh, scene).commands).toEqual([]);
			}),
			{ numRuns: 60 },
		);
	});
});
