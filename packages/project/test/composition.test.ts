// Composition clips (M2, S08 §2, §8 test 3): clip.addComposition, props overrides validated against the
// composition's JSON Schema, props.* property specs, bounded content, the render snapshot, JSON Schema tools.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type CompositionClip,
	checkInvariants,
	clipHandles,
	compositionClipRenderRange,
	compositionFrameAt,
	compositionPropsPropertySpecs,
	compositionRenderKeyMaterial,
	compositionSequenceFrames,
	contentDurationFlicks,
	EMPTY_PROBE,
	effectiveCompositionProps,
	FLICKS_PER_SECOND,
	inferPropsSchema,
	isCssColor,
	jsonSchemaPropertySpecs,
	kindCapabilities,
	type MediaAsset,
	type MgBundleInfo,
	mergeProps,
	propertyKeyToParamPath,
	type RenderCompositionSource,
	resolvePropertySpec,
	setPropOverride,
	unsetPropOverride,
	validateJsonSchema,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

/** JSON Schema of the fixture Title (as `z.toJSONSchema` writes it). */
const TITLE_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		title: { type: 'string', minLength: 1, maxLength: 80, description: 'Headline text' },
		accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
		delay: { type: 'integer', minimum: 0, maximum: 60 },
	},
	required: ['title', 'accent', 'delay'],
	additionalProperties: false,
};

const BADGE_DEFAULTS = {
	label: 'NEW',
	color: '#22aaff',
	size: 96,
	rounded: true,
	tags: ['fixture', 'badge'],
};

function bundleInfo(over: Partial<MgBundleInfo> = {}): MgBundleInfo {
	const badge = inferPropsSchema(BADGE_DEFAULTS);
	return {
		remotionVersion: '4.0.499',
		bundleHash: 'a'.repeat(64),
		builtAt: '2026-10-01T00:00:00.000Z',
		source: { type: 'project-dir', path: '/tmp/mg-project', name: 'mg-project' },
		compositions: [
			{
				id: 'Title',
				width: 1920,
				height: 1080,
				fps: 30,
				durationInFrames: 90,
				defaultProps: { title: 'Hello Jasper', accent: '#ff3366', delay: 6 },
				propsSchema: TITLE_SCHEMA,
				schemaSource: 'bundle',
				ui: { accent: { control: 'color' } },
			},
			{
				id: 'Badge',
				width: 640,
				height: 360,
				fps: 25,
				durationInFrames: 50,
				defaultProps: BADGE_DEFAULTS,
				propsSchema: badge.schema,
				schemaSource: 'inferred',
				ui: badge.ui,
			},
		],
		...over,
	};
}

function bundleAsset(info: MgBundleInfo = bundleInfo()): Omit<MediaAsset, 'id'> {
	return {
		kind: 'mg-bundle',
		fingerprint: `q1:${info.bundleHash}`,
		originalName: 'mg-project',
		sizeBytes: 3609,
		container: 'remotion-bundle',
		probe: EMPTY_PROBE,
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${info.bundleHash.slice(0, 24)}` }],
		derivation: null,
		importedAt: '2026-10-01T00:00:00.000Z',
		mgBundle: info,
	};
}

function setup(preset = 'hd-1080p-30') {
	const h = new Harness({ preset });
	const r = h.ok([{ type: 'media.register', asset: bundleAsset() }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	return { h, mediaId };
}

function addTitle(h: Harness, mediaId: string, extra: Record<string, unknown> = {}) {
	const r = h.ok([
		{ type: 'clip.addComposition', composition: { mediaId, id: 'Title' }, at: 30, track: 'V2', ...extra },
	]);
	return (r.results[0] as { clipId: string }).clipId;
}

const clipOf = (h: Harness, id: string) => h.seq.clips[id] as CompositionClip;
const errCode = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!.code);

describe('clip.addComposition (S08:MGC-003/004/007, §8 test 3)', () => {
	it('places a 90-frame composition clip with the composition size as canvas', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId);
		const c = clipOf(h, id);
		expect(c.kind).toBe('composition');
		expect([c.start, c.duration, c.sourceIn]).toEqual([30, 90, 0]);
		expect(c.composition).toEqual({ mediaId, id: 'Title', version: 1 });
		expect(c.props).toEqual({});
		expect(c.canvas).toEqual({ width: 1920, height: 1080 });
		expect(c.label).toBe('magenta');
		expect(c.name).toBe('Title');
		expect(c.transform.scale.value).toBe(100);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('fits a larger composition into a smaller sequence and keeps overrides', () => {
		const { h, mediaId } = setup('hd-720p-30');
		const id = addTitle(h, mediaId, { props: { title: 'Hola' }, duration: 45 });
		const c = clipOf(h, id);
		expect(c.duration).toBe(45);
		expect(c.props).toEqual({ title: 'Hola' });
		expect(c.transform.scale.value).toBeCloseTo((1280 / 1920) * 100, 6);
	});

	it('rejects unknown bundles, compositions and invalid props; clamps a too-long duration', () => {
		const { h, mediaId } = setup();
		expect(
			errCode(
				h.tx([
					{
						type: 'clip.addComposition',
						composition: { mediaId: 'med_ZZZZZZZZZZZZZZZZ', id: 'Title' },
						at: 0,
						track: 'V1',
					},
				]),
			),
		).toBe('E_NOT_FOUND');
		expect(
			errCode(
				h.tx([{ type: 'clip.addComposition', composition: { mediaId, id: 'Nope' }, at: 0, track: 'V1' }]),
			),
		).toBe('E_NOT_FOUND');
		const bad = h.tx([
			{
				type: 'clip.addComposition',
				composition: { mediaId, id: 'Title' },
				props: { title: 42 },
				at: 0,
				track: 'V1',
			},
		]);
		expect(errCode(bad)).toBe('E_INVALID_PARAM');
		if (!bad.ok) expect(bad.errors[0]!.message).toMatch(/title: expected string/);
		const long = h.ok([
			{
				type: 'clip.addComposition',
				composition: { mediaId, id: 'Title' },
				at: 0,
				track: 'V1',
				duration: 500,
			},
		]);
		expect(long.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
		expect(h.clips('V1')[0]!.duration).toBe(90);
	});

	it('an mg-bundle cannot be placed with clip.place', () => {
		const { h, mediaId } = setup();
		const r = h.tx([{ type: 'clip.place', source: { mediaId }, at: 0 }]);
		expect(errCode(r)).toBe('E_INVALID_PARAM');
		if (!r.ok) expect(r.errors[0]!.message).toMatch(/clip.addComposition/);
	});

	it('renders at the sequence rate: a 25 fps composition in a 30 fps sequence is scaled and warned about', () => {
		const { h, mediaId } = setup();
		const r = h.ok([
			{ type: 'clip.addComposition', composition: { mediaId, id: 'Badge' }, at: 0, track: 'V1' },
		]);
		expect(r.warnings.map((w) => w.code)).toContain('MG_FPS_MISMATCH');
		const c = h.clips('V1')[0]!;
		expect(c.duration).toBe(60); // 50 frames at 25 fps = 2 s = 60 frames at 30 fps
		expect((c as CompositionClip).canvas).toEqual({ width: 640, height: 360 });
	});
});

describe('props editing (S08:MGC-007, §8 test 3)', () => {
	it('param.set props.title validates against the schema: a number is rejected', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId);
		h.ok([{ type: 'param.set', target: ['clip', id, 'props', 'title'], value: 'Edited' }]);
		expect(clipOf(h, id).props).toEqual({ title: 'Edited' });
		const bad = h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'title'], value: 5 }]);
		expect(errCode(bad)).toBe('E_INVALID_PARAM');
		const regex = h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'accent'], value: 'red' }]);
		expect(errCode(regex)).toBe('E_INVALID_PARAM');
		const empty = h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'title'], value: '' }]);
		expect(errCode(empty)).toBe('E_INVALID_PARAM');
		const unknown = h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'extra'], value: 1 }]);
		expect(errCode(unknown)).toBe('E_INVALID_PARAM');
		// Numbers clamp to the schema range (like every property).
		const clamped = h.ok([{ type: 'param.set', target: ['clip', id, 'props', 'delay'], value: 100 }]);
		expect(clamped.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect(clipOf(h, id).props).toEqual({ title: 'Edited', delay: 60 });
		// Not animatable (hold-only, S08:MGC-006).
		const at = h.tx([
			{ type: 'param.set', target: ['clip', id, 'props', 'title'], value: 'x', at: { frames: 3 } },
		]);
		expect(errCode(at)).toBe('E_INVALID_PARAM');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('clip.update {props} replaces the override object; {} resets to defaults', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId, { props: { title: 'A', delay: 3 } });
		h.ok([{ type: 'clip.update', clipId: id, patch: { props: { accent: '#00ff00' } } }]);
		expect(clipOf(h, id).props).toEqual({ accent: '#00ff00' });
		expect(errCode(h.tx([{ type: 'clip.update', clipId: id, patch: { props: { delay: 'soon' } } }]))).toBe(
			'E_INVALID_PARAM',
		);
		h.ok([{ type: 'clip.update', clipId: id, patch: { props: {} } }]);
		expect(clipOf(h, id).props).toEqual({});
		// props do not apply to other kinds; params do not apply to compositions.
		expect(errCode(h.tx([{ type: 'clip.update', clipId: id, patch: { params: { a: 1 } } }]))).toBe(
			'E_INVALID_PARAM',
		);
		h.ok([{ type: 'clip.update', clipId: id, patch: { canvas: 'sequence' } }]);
		expect(clipOf(h, id).canvas).toBe('sequence');
	});

	it('writes into nested values: array elements keep their siblings (inferred Badge schema)', () => {
		const { h, mediaId } = setup();
		const r = h.ok([
			{ type: 'clip.addComposition', composition: { mediaId, id: 'Badge' }, at: 0, track: 'V1' },
		]);
		const id = (r.results[0] as { clipId: string }).clipId;
		h.ok([{ type: 'param.set', target: ['clip', id, 'props', 'tags', '1'], value: 'edited' }]);
		expect(clipOf(h, id).props).toEqual({ tags: ['fixture', 'edited'] });
		h.ok([{ type: 'param.set', target: ['clip', id, 'props', 'size'], value: 120 }]);
		expect(errCode(h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'size'], value: 1.5 }]))).toBe(
			'E_INVALID_PARAM',
		); // inferred integer
		expect(
			errCode(h.tx([{ type: 'param.set', target: ['clip', id, 'props', 'rounded'], value: 'yes' }])),
		).toBe('E_INVALID_PARAM');
		expect(effectiveCompositionProps(h.doc, clipOf(h, id))).toEqual({
			...BADGE_DEFAULTS,
			size: 120,
			tags: ['fixture', 'edited'],
		});
	});

	it('undo is the previous document (snapshot history): the edit never mutates it', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId);
		const before = h.doc;
		h.ok([{ type: 'param.set', target: ['clip', id, 'props', 'title'], value: 'Next' }]);
		expect(clipOf(h, id).props).toEqual({ title: 'Next' });
		expect((before.sequences[h.seqId]!.clips[id] as CompositionClip).props).toEqual({});
		expect(checkInvariants(before)).toEqual([]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('bounded content (S08:MGC-004)', () => {
	it('cannot be trimmed beyond the composition; transitions get handles inside it', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId, { duration: 60 });
		expect(kindCapabilities('composition')?.bounded).toBe('yes');
		expect(contentDurationFlicks(h.doc, clipOf(h, id))).toBe(3 * FLICKS_PER_SECOND);
		const r = h.ok([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: 100 }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');
		expect(clipOf(h, id).duration).toBe(90);
		h.ok([{ type: 'clip.trim', clipId: id, edge: 'in', deltaFrames: 20 }]);
		const c = clipOf(h, id);
		expect(clipHandles(h.doc, h.seq, c)).toEqual({ head: 20, tail: 0 });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('split keeps the composition content time continuous', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId);
		h.ok([{ type: 'clip.split', clipIds: [id], at: 60 }]);
		const [a, b] = h.clips('V2') as CompositionClip[];
		expect([a!.start, a!.duration, b!.start, b!.duration]).toEqual([30, 30, 60, 60]);
		expect(compositionFrameAt(b!.sourceIn, h.seq.settings.frameRate)).toBe(30);
		expect(b!.composition.id).toBe('Title');
	});
});

describe('media.relink of a rebuilt bundle (S08:MGC-013)', () => {
	it('accepts the new header and fingerprint without force', () => {
		const { h, mediaId } = setup();
		const next = bundleInfo({ bundleHash: 'b'.repeat(64) });
		h.ok([
			{
				type: 'media.relink',
				mediaId,
				locator: { type: 'engine-store', engineId: 'local', key: `mk_${'b'.repeat(24)}` },
				fingerprint: `q1:${'b'.repeat(64)}`,
				mgBundle: next,
			},
		]);
		const a = h.doc.media[mediaId]!;
		expect(a.mgBundle?.bundleHash).toBe('b'.repeat(64));
		expect(a.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: `mk_${'b'.repeat(24)}` });
		// Other kinds still need force to change their fingerprint.
		const v = h.registerVideo();
		const r = h.tx([
			{
				type: 'media.relink',
				mediaId: v,
				locator: { type: 'engine-store', engineId: 'local', key: 'mk_x' },
				fingerprint: 'q1:x',
			},
		]);
		expect(errCode(r)).toBe('E_INVALID_PARAM');
	});
});

describe('render snapshot (S08:MGC-008)', () => {
	it('carries effective props, the bundle key and composition info; resolveComposition adds pre-renders', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId, { props: { title: 'Snap' } });
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
			resolveComposition: ({ clipId, source }) =>
				clipId === id ? { masterUrl: `/m/${source.compositionId}.mov`, previewUrl: null } : null,
		});
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;
		const src = (clip.source as { composition: RenderCompositionSource }).composition;
		expect(src.props).toEqual({ title: 'Snap', accent: '#ff3366', delay: 6 });
		expect(src.bundle).toEqual({
			key: `mk_${'a'.repeat(24)}`,
			hash: 'a'.repeat(64),
			remotionVersion: '4.0.499',
		});
		expect(src.info).toEqual({ width: 1920, height: 1080, fps: 30, durationInFrames: 90 });
		expect(src.prerender).toEqual({ masterUrl: '/m/Title.mov', previewUrl: null });
		expect(clip.bounded).toBe(true);
		expect(clip.intrinsicBox).toEqual({ width: 1920, height: 1080 });
	});

	it('a composition missing from the bundle has info null (rendered as a card, MGC-014)', () => {
		const { h, mediaId } = setup();
		const id = addTitle(h, mediaId);
		h.ok([
			{
				type: 'media.relink',
				mediaId,
				locator: { type: 'engine-store', engineId: 'local', key: 'mk_cccccccccccccccccccccccc' },
				fingerprint: `q1:${'c'.repeat(64)}`,
				mgBundle: bundleInfo({ bundleHash: 'c'.repeat(64), compositions: [] }),
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;
		expect((clip.source as { composition: RenderCompositionSource }).composition.info).toBeNull();
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('props property specs (S08:MGU-003)', () => {
	it('builds one spec per leaf from the schema, with hints, defaults and ParamPaths', () => {
		const info = bundleInfo().compositions[0]!;
		const specs = compositionPropsPropertySpecs(info);
		expect(specs.map((s) => [s.key, s.kind, s.ui.control])).toEqual([
			['props.title', 'string', 'text'],
			['props.accent', 'string', 'color'],
			['props.delay', 'number', 'scrub'],
		]);
		const delay = specs[2]!;
		expect(delay.range).toEqual({ min: 0, max: 60, step: 1 });
		expect(delay.defaultValue).toBe(6);
		expect(delay.animatable).toBe('no');
		expect(specs[0]!.description).toBe('Headline text');
		expect(propertyKeyToParamPath({ clipId: 'clp_1' }, 'props.title')).toEqual([
			'clip',
			'clp_1',
			'props',
			'title',
		]);
		expect(resolvePropertySpec('props.title', undefined, info)?.kind).toBe('string');
		expect(resolvePropertySpec('props.title')).toBeUndefined();
	});

	it('nested objects become dotted keys; arrays and free-form values are json', () => {
		const specs = jsonSchemaPropertySpecs(
			{
				type: 'object',
				properties: {
					layout: {
						type: 'object',
						properties: { x: { type: 'number' }, align: { enum: ['left', 'right'] } },
					},
					items: { type: 'array', items: { type: 'string' } },
					meta: { type: 'object' },
					maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					mode: { anyOf: [{ const: 'a' }, { const: 'b' }] },
					ref: { $ref: '#/$defs/n' },
				},
				$defs: { n: { type: 'integer', minimum: 1 } },
			},
			{ keyPrefix: 'props', storageRoot: ['props'], group: 'props', appliesTo: () => true },
		);
		expect(specs.map((s) => [s.key, s.kind])).toEqual([
			['props.layout.x', 'number'],
			['props.layout.align', 'enum'],
			['props.items', 'json'],
			['props.meta', 'json'],
			['props.maybe', 'string'],
			['props.mode', 'enum'],
			['props.ref', 'number'],
		]);
		expect(specs.find((s) => s.key === 'props.ref')!.range).toEqual({ min: 1, max: undefined, step: 1 });
	});
});

describe('JSON Schema tools (S08:MGC-011)', () => {
	it('validates the common keywords', () => {
		expect(validateJsonSchema(TITLE_SCHEMA, { title: 'x', accent: '#aabbcc', delay: 3 })).toEqual([]);
		const issues = validateJsonSchema(TITLE_SCHEMA, { title: '', accent: 'red', delay: 3.5, extra: 1 });
		expect(issues.map((i) => i.path).sort()).toEqual(['accent', 'delay', 'extra', 'title']);
		expect(
			validateJsonSchema(TITLE_SCHEMA, { title: 'x' })
				.map((i) => i.path)
				.sort(),
		).toEqual(['accent', 'delay']);
		const s = {
			type: 'object',
			properties: {
				list: { type: 'array', items: { type: 'number' }, minItems: 1, uniqueItems: true },
				pick: { oneOf: [{ type: 'string' }, { type: 'number' }] },
				n: { type: ['number', 'null'], exclusiveMinimum: 0, multipleOf: 0.5 },
			},
		};
		expect(validateJsonSchema(s, { list: [1, 2], pick: 'a', n: 1.5 })).toEqual([]);
		expect(validateJsonSchema(s, { list: [], pick: true, n: 0 }).length).toBe(3);
		expect(validateJsonSchema(s, { list: [1, 1], n: null })).toEqual([
			{ path: 'list', message: 'items must be unique' },
		]);
	});

	it('infers a form schema from defaultProps', () => {
		const { schema, ui } = inferPropsSchema({
			text: 'Hi',
			long: 'x'.repeat(81),
			multi: 'a\nb',
			color: '#fff',
			rgba: 'rgba(0, 0, 0, 0.5)',
			n: 3,
			f: 0.5,
			on: true,
			list: [1, 2],
			words: ['a'],
			mixed: [1, 'a'],
			img: 'images/logo.png',
			nested: { a: 1, b: { c: 'x' } },
			nothing: null,
		});
		expect(schema).toMatchObject({
			type: 'object',
			properties: {
				text: { type: 'string' },
				n: { type: 'integer' },
				f: { type: 'number' },
				on: { type: 'boolean' },
				list: { type: 'array', items: { type: 'integer' } },
				words: { type: 'array', items: { type: 'string' } },
				mixed: { type: 'array' },
				nested: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'object' } } },
				nothing: {},
			},
		});
		expect(ui).toEqual({
			long: { control: 'textarea' },
			multi: { control: 'textarea' },
			color: { control: 'color' },
			rgba: { control: 'color' },
			img: { control: 'asset' },
		});
		expect(isCssColor('#12345678')).toBe(true);
		expect(isCssColor('blue')).toBe(false);
	});
});

describe('overrides, timing and render keys', () => {
	it('merges objects, replaces arrays; set/unset paths', () => {
		expect(mergeProps({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({
			a: { b: 1, c: 3 },
			l: [9],
		});
		const eff = { a: { b: 1, c: 2 }, l: [1, 2] };
		expect(setPropOverride({}, eff, ['a', 'b'], 5)).toEqual({ a: { b: 5, c: 2 } });
		expect(setPropOverride({}, eff, ['l', '0'], 7)).toEqual({ l: [7, 2] });
		expect(unsetPropOverride({ a: { b: 5 }, x: 1 }, ['a', 'b'])).toEqual({ x: 1 });
	});

	it('maps content time to composition frames and render ranges with handles', () => {
		const r30 = { num: 30, den: 1 };
		expect(compositionSequenceFrames({ fps: 25, durationInFrames: 50 }, r30)).toBe(60);
		expect(compositionFrameAt(FLICKS_PER_SECOND, r30)).toBe(30);
		const range = compositionClipRenderRange(
			{ start: 100, duration: 30, sourceIn: FLICKS_PER_SECOND / 3, headHandle: 5, tailHandle: 10 },
			r30,
			90,
		);
		expect(range).toEqual({ startFrame: 5, durationFrames: 45, layerStart: 95 });
		const clamped = compositionClipRenderRange(
			{ start: 0, duration: 90, sourceIn: 0, tailHandle: 10 },
			r30,
			90,
		);
		expect(clamped).toEqual({ startFrame: 0, durationFrames: 90, layerStart: 0 });
		const k1 = compositionRenderKeyMaterial({
			bundleHash: 'h',
			compositionId: 'Title',
			props: { b: 1, a: 2 },
			width: 1920,
			height: 1080,
			fps: r30,
			startFrame: 0,
			durationFrames: 90,
		});
		const k2 = compositionRenderKeyMaterial({
			bundleHash: 'h',
			compositionId: 'Title',
			props: { a: 2, b: 1 },
			width: 1920,
			height: 1080,
			fps: r30,
			startFrame: 0,
			durationFrames: 90,
		});
		expect(k1).toBe(k2);
		expect(k1).toContain('"renderer":"4.0.499"');
	});
});
