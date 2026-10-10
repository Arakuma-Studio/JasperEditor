// Regressions for the bugs the parser fuzzing found (golden-fuzz). Each case is the minimal form of a failing input.
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	createCounterIdSource,
	defaultRegistries,
	loadProject,
	ModelParseError,
	ProjectLoadError,
	parseModel,
	parseSvgPath,
	SvgPathError,
	svgToShapeContents,
} from '../src/index.ts';
import { modelSeeds, projectSeeds } from './fuzz-seeds.ts';

const effects = defaultRegistries().effects;
const load = (raw: unknown) => loadProject(raw, { ids: createCounterIdSource(1), effects });
/** The v5 fixture's bare document (a fresh copy). */
const v5 = () => {
	const raw = projectSeeds()[4] as { document?: Record<string, unknown> } & Record<string, unknown>;
	return (raw.document ?? raw) as Record<string, any>;
};

describe('fuzz regressions: project load / repair', () => {
	it('a reference named like an Object.prototype member is a missing reference, not a crash', () => {
		const d = v5();
		const seq = Object.values(d.sequences)[0] as { clips: Record<string, { mediaId?: string }> };
		const clip = Object.values(seq.clips).find((c) => typeof c.mediaId === 'string')!;
		clip.mediaId = '__proto__';
		const r = load(d);
		expect(r.issues).toEqual([]);
		expect(r.repairs.some((x) => x.action === 'drop-clip')).toBe(true);
	});

	it('a project id equal to an item id is replaced in place; the item keeps its id (FUZZ=1, verify)', () => {
		const d = v5();
		const itemId = Object.keys(d.items)[0]!;
		d.projectId = itemId;
		const r = load(d);
		expect(r.issues).toEqual([]);
		expect(r.document.projectId).toMatch(/^prj_/);
		expect(Object.keys(r.document.items)).toContain(itemId);
		expect(r.document.items[itemId]!.id).toBe(itemId);
	});

	it('record keys that disagree with ids, malformed and duplicate ids are repaired', () => {
		const d = v5();
		const seq = Object.values(d.sequences)[0] as {
			clips: Record<string, { id: string }>;
			videoTracks: { id: string }[];
		};
		const [k0] = Object.keys(seq.clips);
		seq.clips[k0!]!.id = 'clp_ZZZZZZZZZZZZZZZZ';
		seq.videoTracks[0]!.id = 'not an id';
		for (const c of Object.values(seq.clips))
			if ((c as { trackId?: string }).trackId === 'trk_0000000000000V01')
				(c as { trackId?: string }).trackId = 'not an id';
		const r = load(d);
		expect(r.issues).toEqual([]);
		expect(r.repairs.filter((x) => x.action === 'fix-id').length).toBeGreaterThan(0);
		expect(checkInvariants(r.document, { effects })).toEqual([]);
	});

	it('an id named like a document field ("media") is replaced only where ids live', () => {
		const d = v5();
		const seq = Object.values(d.sequences)[0] as Record<string, any>;
		const old = seq.videoTracks[0].id as string;
		seq.videoTracks[0].id = 'media';
		for (const c of Object.values(seq.clips) as { trackId: string }[])
			if (c.trackId === old) c.trackId = 'media';
		const r = load(d);
		expect(r.issues).toEqual([]);
		expect(Object.keys(r.document.media).length).toBeGreaterThan(0);
		const s2 = r.document.sequences[seq.id]!;
		expect(s2.videoTracks[0]!.id).toMatch(/^trk_/);
		expect(Object.values(s2.clips).some((c) => c.trackId === s2.videoTracks[0]!.id)).toBe(true);
	});

	it('impossible settings, wrong track kinds, out-of-range opacity and clips past their media are repaired', () => {
		const d = v5();
		const seq = Object.values(d.sequences)[0] as Record<string, any>;
		seq.settings.width = 1_000_000;
		seq.audioTracks[0].kind = 'video';
		const clips = Object.values(seq.clips) as Record<string, any>[];
		const visual = clips.find((c) => c.opacity)!;
		visual.opacity.value = 250;
		const media = clips.find((c) => typeof c.mediaId === 'string' && c.kind === 'video')!;
		media.duration = 10_000_000;
		const r = load(d);
		expect(r.issues).toEqual([]);
		expect(r.document.sequences[seq.id]!.settings.width).toBe(8192);
	});

	it('data that is not a project fails with ProjectLoadError', () => {
		for (const bad of [
			null,
			42,
			'x',
			[],
			{ format: 'nope' },
			{ format: 'jasper-project' },
			{ schemaVersion: 1 },
		])
			expect(() => load(bad)).toThrow(ProjectLoadError);
	});
});

describe('fuzz regressions: vector and model parsers', () => {
	it('a group transform inside a degenerate (skewed) matrix is baked instead of recursing forever', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g transform="matrix(1 0 1000 0.001 0 0)"><g transform="translate(5 5) rotate(10)"><rect width="10" height="10"/></g></g></svg>`;
		const r = svgToShapeContents(svg);
		expect(r.contents.length).toBeGreaterThan(0);
	});

	it('malformed SVG path data throws SvgPathError', () => {
		expect(() => parseSvgPath('1 2')).toThrow(SvgPathError);
		expect(() => parseSvgPath('M 1')).toThrow(SvgPathError);
		expect(() => parseSvgPath('M 0 0 K 1 1')).toThrow(SvgPathError);
	});

	it('invalid UTF-8 and broken JSON in models are ModelParseErrors', () => {
		const obj = new Uint8Array([
			...new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n# '),
			0xf7,
			0xbf,
			0xbf,
			0xbf,
		]);
		expect(parseModel(obj, 'obj').triangles).toBe(1);
		const glb = modelSeeds().glb.slice(0, 40);
		expect(() => parseModel(glb, 'glb')).toThrow(ModelParseError);
		expect(() =>
			parseModel(new TextEncoder().encode('{"asset":{"version":"2.0"},"scenes":3}'), 'gltf'),
		).toThrow(ModelParseError);
		expect(() => parseModel(new TextEncoder().encode('null'), 'gltf')).toThrow(ModelParseError);
	});
});
