// social-comment §7.8: the render snapshot loads the fonts an anime template declares (even when no text clip uses
// them), lists its emoji URLs, and turns unavailable ones into warnings; nested sequences merge both.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	buildRenderSnapshot,
	createStaticMgRegistry,
	defaultRegistries,
	type RenderTemplateAssets,
	type SnapshotOptions,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const GRIN = '\u{1F600}';
const registry = createStaticMgRegistry([
	{
		id: 'social',
		version: 1,
		name: 'Social',
		category: 'Test',
		paramsSchema: z.object({ text: z.string() }),
		defaults: { text: '' },
		introFrames: 0,
		outroFrames: 0,
		canvasDefault: 'sequence',
		renderer: 'anime',
	},
]);

function setup(text = `hi ${GRIN}`) {
	const h = new Harness({ ctx: { registries: defaultRegistries(registry) } });
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 30,
			track: 'V1',
			template: { id: 'social', version: 1 },
			params: { text },
			ref: '$m',
		},
	]);
	return { h, id: r.refs.$m! };
}

const declared: RenderTemplateAssets = {
	fonts: [
		{ family: 'Chirp', weight: 700, style: 'normal' },
		{ family: 'Chirp', weight: 400, style: 'italic' },
	],
	emoji: [{ pack: 'apple', graphemes: [GRIN, '❤️'] }],
};

const opts = (o: Partial<NonNullable<SnapshotOptions['templateAssets']>> = {}): SnapshotOptions => ({
	resolveMedia: () => null,
	resolveFont: () => null,
	templateAssets: {
		required: (mg) => (mg.template.id === 'social' ? declared : null),
		font: (f) => (f.weight === 700 ? `/fonts/remote/chirp-${f.weight}.woff2` : null),
		emoji: (pack, g) => (g === GRIN ? `/fonts/emoji/${pack}/1/1f600.png` : null),
		...o,
	},
});

describe('template assets in the render snapshot', () => {
	it('loads declared faces (no text clip needed), lists emoji URLs and warns about the unavailable ones', () => {
		const { h, id } = setup();
		const snap = buildRenderSnapshot(h.doc, h.seqId, opts());
		expect(snap.fonts).toEqual([
			{
				fontId: 'template:Chirp',
				family: 'Chirp',
				weight: 700,
				style: 'normal',
				url: '/fonts/remote/chirp-700.woff2',
			},
		]);
		expect(snap.emoji).toEqual({ [`apple:${GRIN}`]: '/fonts/emoji/apple/1/1f600.png' });
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(clip.source).toMatchObject({ mg: { assets: declared } });
		expect(snap.warnings).toEqual([
			{ clipId: id, code: 'TEMPLATE_FONT_UNAVAILABLE', message: 'Font "Chirp" 400 italic is not available' },
			{
				clipId: id,
				code: 'TEMPLATE_EMOJI_UNAVAILABLE',
				message: 'Emoji ❤️ of the apple pack is not available',
			},
		]);
	});

	it('without the option (or a template that declares nothing) the snapshot is unchanged', () => {
		const { h } = setup();
		const bare = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(bare.fonts).toEqual([]);
		expect(bare.emoji).toBeUndefined();
		expect(bare.videoTracks[0]!.clips[0]!.source).not.toHaveProperty('mg.assets');
		const none = buildRenderSnapshot(h.doc, h.seqId, opts({ required: () => null }));
		expect(none).toEqual(bare);
	});

	it('nested sequences merge their template fonts, emoji and warnings into the parent', () => {
		const { h, id } = setup();
		h.ok([{ type: 'clip.nest', clipIds: [id], name: 'Nest', ref: '$n' }]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, opts());
		expect(snap.fonts.map((f) => f.fontId)).toEqual(['template:Chirp']);
		expect(snap.emoji).toEqual({ [`apple:${GRIN}`]: '/fonts/emoji/apple/1/1f600.png' });
		expect(snap.warnings.map((w) => w.code)).toEqual([
			'TEMPLATE_FONT_UNAVAILABLE',
			'TEMPLATE_EMOJI_UNAVAILABLE',
		]);
		expect(snap.warnings[0]!.message).toMatch(/^In nested sequence: /);
	});
});
