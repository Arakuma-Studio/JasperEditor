// Spec 19 TL-113: `.asl` and `.psd` layer styles. Files are written with ag-psd (a real Photoshop style library cannot be
// committed: its origin is unknown) and read through the same code as a user's file. Parsers are fuzzed.
import { mapPsStyle, PsStyleSchema } from '@jasper/project';
import { bytesTarget, describeFuzz } from '@jasper/testkit/fuzz';
import { type LayerEffectsInfo, writePsdUint8Array } from 'ag-psd';
import { GrdT, serializeEffects, writeVersionAndDescriptor } from 'ag-psd/dist/descriptor.js';
import {
	createWriter,
	getWriterBuffer,
	writeSignature,
	writeUint16,
	writeUint32,
} from 'ag-psd/dist/psdWriter.js';
import { describe, expect, it } from 'vitest';
import { readLayerStyles, StyleFileError } from '../src/title-looks/ps-styles.ts';

const px = (value: number) => ({ units: 'Pixels' as const, value });
const RED = { r: 255, g: 0, b: 0 };

const STROKE: LayerEffectsInfo = {
	stroke: [
		{
			enabled: true,
			size: px(6),
			position: 'outside',
			fillType: 'color',
			blendMode: 'normal',
			opacity: 1,
			color: RED,
		},
	],
};

/** One style block of an `.asl`: length, name descriptor, style descriptor (`Lefx` as in a layer's `lfx2`). */
function aslBlock(name: string, desc: Record<string, unknown>): Uint8Array {
	const w = createWriter(1024);
	writeUint32(w, 16);
	writeVersionAndDescriptor(w, '', 'null', { 'Nm  ': name, Idnt: 'x' } as never);
	writeVersionAndDescriptor(w, '', 'null', { Lefx: desc } as never);
	return getWriterBuffer(w) as unknown as Uint8Array;
}

function asl(styles: { name: string; desc: Record<string, unknown> }[]): Uint8Array {
	const w = createWriter(4096);
	writeUint16(w, 2);
	writeSignature(w, '8BSL');
	writeUint16(w, 3);
	writeUint32(w, 0);
	writeUint32(w, styles.length);
	for (const s of styles) {
		const body = new Uint8Array(aslBlock(s.name, s.desc)).subarray(4);
		writeUint32(w, body.length);
		for (const b of body) w.view.setUint8(w.offset++, b), ensure(w);
		while (w.offset % 4) w.view.setUint8(w.offset++, 0), ensure(w);
	}
	return new Uint8Array(getWriterBuffer(w) as ArrayBuffer);
}

/** ag-psd's writer grows on its own write calls; raw bytes above need the room. */
function ensure(w: ReturnType<typeof createWriter>): void {
	if (w.offset + 8 < w.buffer.byteLength) return;
	const bigger = new ArrayBuffer(w.buffer.byteLength * 2);
	new Uint8Array(bigger).set(new Uint8Array(w.buffer));
	w.buffer = bigger;
	w.view = new DataView(bigger);
}

const effectsDesc = (e: LayerEffectsInfo) => serializeEffects(e, false, true) as unknown as Record<string, unknown>;

function psdWith(effects: LayerEffectsInfo, extra: Record<string, unknown> = {}) {
	return writePsdUint8Array(
		{
			width: 32,
			height: 32,
			imageResources: { globalAngle: 90, globalAltitude: 40 },
			children: [{ name: 'Styled', left: 0, top: 4, bottom: 20, right: 10, effects, ...extra }],
		},
		{ noBackground: true },
	);
}

describe('reading styles (TL-113)', () => {
	it('reads a .psd layer style, with the document light and a suggested size', () => {
		const r = readLayerStyles(psdWith(STROKE), 'a.psd');
		expect(r.fileName).toBe('a.psd');
		expect(r.styles).toHaveLength(1);
		const s = r.styles[0]!;
		expect(s.name).toBe('Styled');
		expect(s.origin).toBe('layer');
		expect(s.refKnown).toBe(false);
		const parsed = PsStyleSchema.parse(s.style);
		expect(parsed.globalAngle).toBe(90);
		expect(parsed.effects.stroke?.[0]?.size?.value).toBe(6);
		const look = mapPsStyle(parsed, s.refPx);
		expect(look.recipe.layers.some((l) => l.type === 'rim')).toBe(true);
	});

	it('takes the font size from a text layer', () => {
		const r = readLayerStyles(
			psdWith(STROKE, {
				text: { text: 'T', transform: [1, 0, 0, 1, 0, 0], style: { fontSize: 48, fillColor: RED } },
			}),
			'a.psd',
		);
		expect(r.styles[0]).toMatchObject({ origin: 'text layer', refPx: 48, refKnown: true });
	});

	it('a PSD without effects says so', () => {
		const bytes = writePsdUint8Array({ width: 8, height: 8, children: [{ name: 'plain' }] }, { noBackground: true });
		expect(() => readLayerStyles(bytes, 'a.psd')).toThrow(/No layer in this PSD has layer effects/);
	});

	it('reads an .asl library, one entry per style', () => {
		const r = readLayerStyles(asl([{ name: 'Gold', desc: effectsDesc(STROKE) }]), 's.asl');
		expect(r.styles.map((s) => [s.name, s.origin])).toEqual([['Gold', 'style library']]);
		expect(PsStyleSchema.parse(r.styles[0]!.style).effects.stroke).toHaveLength(1);
	});

	it('a style with blending options only is listed as skipped', () => {
		const r = readLayerStyles(
			asl([
				{ name: 'Gold', desc: effectsDesc(STROKE) },
				{ name: 'Nothing', desc: { masterFXSwitch: true } },
			]),
			's.asl',
		);
		expect(r.styles).toHaveLength(1);
		expect(r.skipped.join()).toContain('Nothing: no layer effects');
	});

	it('Shape Burst stroke: ag-psd alone would drop the style; here it survives and maps', () => {
		const stroke: LayerEffectsInfo = {
			stroke: [
				{
					enabled: true,
					size: px(6),
					position: 'outside',
					fillType: 'gradient',
					blendMode: 'normal',
					opacity: 1,
					gradient: {
						type: 'solid',
						name: 'Burst',
						smoothness: 1,
						colorStops: [
							{ color: RED, location: 0, midpoint: 0.5 },
							{ color: { r: 0, g: 0, b: 255 }, location: 1, midpoint: 0.5 },
						],
						opacityStops: [
							{ opacity: 1, location: 0, midpoint: 0.5 },
							{ opacity: 1, location: 1, midpoint: 0.5 },
						],
						style: 'linear',
						angle: 90,
						scale: 1,
						reverse: false,
						align: true,
						offset: { x: 0, y: 0 },
					} as never,
				},
			],
		};
		const desc = effectsDesc(stroke);
		// Photoshop writes the long enum value for this type; there is no 4-character code for it.
		const type = (desc as { FrFX?: { Type?: unknown }; frameFXMulti?: { Type?: unknown }[] }).frameFXMulti?.[0] ?? (desc as { FrFX: { Type?: unknown } }).FrFX;
		type.Type = 'GrdT.shapeburst';
		const bytes = asl([{ name: 'Burst', desc }]);
		const r = readLayerStyles(bytes, 's.asl');
		expect(r.styles.map((s) => s.name)).toEqual(['Burst']);
		const parsed = PsStyleSchema.parse(r.styles[0]!.style);
		expect(parsed.effects.stroke?.[0]?.gradient?.style).toBe('shapeburst');
		const look = mapPsStyle(parsed, 100);
		const paint = look.recipe.layers.find((l) => l.type === 'rim')!.params!.paint as { gradient: { type: string } };
		expect(paint.gradient.type).toBe('shape');

		// The upstream decoder, as it ships: the regression this patch answers.
		const patched = GrdT.decode;
		const upstream = Object.getOwnPropertyDescriptor(GrdT, 'upstreamDecode')?.value as ((v: string) => string) | undefined;
		if (upstream) {
			GrdT.decode = upstream as typeof GrdT.decode;
			try {
				const without = readLayerStyles(bytes, 's.asl');
				expect(without.styles).toHaveLength(0);
				expect(without.skipped.join()).toContain('Burst');
			} catch (e) {
				expect(e).toBeInstanceOf(StyleFileError);
			} finally {
				GrdT.decode = patched;
			}
		}
	});

	it('refuses what is not a style file, too large a file, and a lying style count', () => {
		expect(() => readLayerStyles(new TextEncoder().encode('hello'), 'x.asl')).toThrow(/Not a Photoshop file/);
		expect(() => readLayerStyles(new Uint8Array(0), 'x.asl')).toThrow(StyleFileError);
		const lying = asl([{ name: 'Gold', desc: effectsDesc(STROKE) }]);
		const view = new DataView(lying.buffer, lying.byteOffset);
		view.setUint32(12, 0xffff_ffff);
		const r = readLayerStyles(lying, 'x.asl');
		expect(r.styles.length).toBeLessThanOrEqual(1);
		expect(r.skipped.length).toBeGreaterThan(0);
	});
});

describeFuzz('@jasper/engine layer styles', [
	bytesTarget(
		'.asl style library',
		() => [asl([{ name: 'Gold', desc: effectsDesc(STROKE) }])],
		(b) => {
			try {
				const r = readLayerStyles(b, 'fuzz.asl');
				for (const s of r.styles) mapPsStyle(PsStyleSchema.parse(s.style), s.refPx);
			} catch (e) {
				if (!(e instanceof StyleFileError)) throw e;
			}
		},
		StyleFileError,
		{ iterations: 200, properties: 60 },
	),
	bytesTarget(
		'.psd layer styles',
		() => [psdWith(STROKE)],
		(b) => {
			try {
				const r = readLayerStyles(b, 'fuzz.psd');
				for (const s of r.styles) mapPsStyle(PsStyleSchema.parse(s.style), s.refPx);
			} catch (e) {
				if (!(e instanceof StyleFileError)) throw e;
			}
		},
		StyleFileError,
		{ iterations: 120, properties: 40, slowMs: 5000 },
	),
]);
