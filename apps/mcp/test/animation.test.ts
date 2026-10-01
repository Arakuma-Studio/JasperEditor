// Text animation tools (S11:ANA-002/004/008) without an engine: the list_text_animations catalogue, side
// arguments (preset ids, seconds → frames), History labels, render_frames' frame spread and sheet size, the PNG
// codec and grid behind the contact sheet, and the get_timeline text of animated text / anime templates.
import { deflateSync } from 'node:zlib';
import {
	applyTransaction,
	type Clip,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/context.ts';
import { ToolError } from '../src/errors.ts';
import { clipSourceText } from '../src/format.ts';
import { FixedEngineLink } from '../src/link.ts';
import { composeGrid, decodePng, encodePng, type RgbaImage } from '../src/png.ts';
import { createJasperMcpServer } from '../src/server.ts';
import {
	ANIMATION_GUIDE,
	animationLabel,
	animatorCommand,
	MAX_SHEET_SIZE,
	sequenceFor,
	sheetCellWidth,
	spreadFrames,
	textAnimationCatalogue,
	textAnimationOf,
} from '../src/tools/animation.ts';

function project(preset = 'hd-1080p-25') {
	const ids = createSeededIdSource(7);
	let doc = createEmptyProject({ ids, name: 'Anim', preset });
	const ctx = { ids, now: () => '2026-10-01T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', label: 't', origin: 'user', commands } as never,
			ctx,
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		return r.result;
	};
	return {
		get doc() {
			return doc;
		},
		tx,
	};
}

/** A ToolContext whose engine answers doc.get (and selection.get when given; counts the calls). */
function fakeCtx(doc: ProjectDocument, selection?: string[]) {
	let calls = 0;
	const ctx = {
		engine: async (fn: (c: unknown) => Promise<unknown>) => {
			calls++;
			return fn({
				agentQuery: async ({ query }: { query: string }) => {
					if (query !== 'selection.get') return { result: doc, revision: 1, via: 'headless' };
					if (!selection) throw new Error('E_NO_SESSION');
					return { result: { selection: { timeline: { clips: selection } } }, via: 'session' };
				},
			});
		},
	} as unknown as ToolContext;
	return { ctx, calls: () => calls };
}

describe('list_text_animations catalogue', () => {
	it('lists every preset with its default length and a compact params summary', () => {
		const cat = textAnimationCatalogue();
		expect(cat.referenceFps).toBe(30);
		expect(cat.presets.map((p) => p.id)).toEqual([
			'fade',
			'slide-up',
			'slide-down',
			'slide-left',
			'slide-right',
			'pop',
			'blur',
			'typewriter',
			'tracking',
			'mask-reveal',
			'rotate-in',
			'drop',
		]);
		const slide = cat.presets.find((p) => p.id === 'slide-up')!;
		expect(slide).toMatchObject({
			version: 1,
			label: 'Slide Up',
			category: 'Slide',
			phases: ['in', 'out'],
			defaultDurationFrames: 20,
			defaultDurationSeconds: 0.667,
		});
		expect(slide.params).toEqual({
			unit: {
				type: 'string',
				enum: ['char', 'word', 'line'],
				description: 'Animated piece: each character, word or laid-out line',
				default: 'word',
			},
			stagger: {
				type: 'number',
				minimum: 0,
				maximum: 1,
				description: 'Fraction of the window spread across the units (0 = all together)',
				default: 0.3,
			},
			order: {
				type: 'string',
				enum: ['forward', 'backward', 'center', 'edges', 'random'],
				description: 'Order in which the units start',
				default: 'forward',
			},
			ease: expect.objectContaining({ type: 'string', default: 'outExpo' }),
			distance: expect.objectContaining({ type: 'number', minimum: 0, maximum: 4000, default: 60 }),
		});
		expect(cat.presets.find((p) => p.id === 'typewriter')!.params).toMatchObject({
			unit: { enum: ['char', 'word'], default: 'char' },
			caret: { type: 'boolean', default: true },
		});
	});

	it('is served by the MCP server without an engine, and the guide is in the instructions', async () => {
		const { server } = createJasperMcpServer({
			link: new FixedEngineLink('http://127.0.0.1:9', 'token'),
			agentName: 'animation-test',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const client = new Client({ name: 'animation-test', version: '1' });
		await client.connect(b);
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
			return { r, body: JSON.parse((r.content[0] as { text: string }).text) };
		};
		const list = await call('list_text_animations');
		expect(list.r.isError).toBeFalsy();
		expect(list.body).toEqual(JSON.parse(JSON.stringify(textAnimationCatalogue())));
		expect(client.getInstructions()).toContain(ANIMATION_GUIDE);
		// Argument errors come back before any engine round trip.
		const none = await call('set_text_animation', { projectId: 'prj_x', in: 'fade' });
		expect(none.body.error.code).toBe('E_INVALID_PARAM');
		const both = await call('render_frames', { projectId: 'prj_x', times: [0], count: 3 });
		expect(both.body.error.code).toBe('E_INVALID_PARAM');
		const tools = (await client.listTools()).tools;
		const addText = tools.find((t) => t.name === 'add_text')!;
		expect(Object.keys(addText.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(['animateIn', 'animateOut']),
		);
		expect(tools.find((t) => t.name === 'render_frames')!.annotations?.readOnlyHint).toBe(true);
		await client.close();
	});
});

describe('animator side arguments', () => {
	it('maps preset ids and converts seconds at the sequence rate (round, ≥ 1)', () => {
		expect(animatorCommand('fade', 25)).toEqual({ preset: 'fade' });
		expect(animatorCommand({ preset: 'pop', durationFrames: 12, params: { scale: 0.5 } }, 25)).toEqual({
			preset: 'pop',
			durationFrames: 12,
			params: { scale: 0.5 },
		});
		expect(animatorCommand({ preset: 'fade', durationSeconds: 0.5 }, 25)).toEqual({
			preset: 'fade',
			durationFrames: 13,
		});
		expect(animatorCommand({ durationSeconds: 1 }, 30000 / 1001)).toEqual({ durationFrames: 30 });
		expect(animatorCommand({ durationSeconds: 0.001 }, 24)).toEqual({ durationFrames: 1 });
		expect(() => animatorCommand({ durationFrames: 4, durationSeconds: 1 }, 30)).toThrow(ToolError);
	});

	it('loads the document only when a side gives seconds, at the clip sequence rate', async () => {
		const p = project('hd-1080p-25');
		const r = p.tx([
			{ type: 'clip.addText', at: 0, duration: 50, track: 'V2', content: { text: 'Hi' }, ref: '$t' },
		]);
		const clipId = r.refs.$t!;
		const quiet = fakeCtx(p.doc);
		expect(await textAnimationOf(quiet.ctx, 'prj', {}, {})).toBeUndefined();
		expect(await textAnimationOf(quiet.ctx, 'prj', { in: 'slide-up', out: null }, { clipId })).toEqual({
			in: { preset: 'slide-up' },
			out: null,
		});
		expect(quiet.calls()).toBe(0);
		const loud = fakeCtx(p.doc);
		expect(
			await textAnimationOf(
				loud.ctx,
				'prj',
				{ out: { preset: 'fade', durationSeconds: 1.5, params: { unit: 'char' } } },
				{ clipId },
			),
		).toEqual({ out: { preset: 'fade', durationFrames: 38, params: { unit: 'char' } } });
		expect(loud.calls()).toBe(1);
		expect(sequenceFor(p.doc, { clipId }).id).toBe(Object.keys(p.doc.sequences)[0]);
		expect(() => sequenceFor(p.doc, { sequenceId: 'seq_nope' })).toThrow(/Sequence not found/);
	});

	it('converts seconds at the rate of the sequence the transaction targets (selection, sequenceId, only one)', async () => {
		const p = project('hd-1080p-25');
		const first = Object.keys(p.doc.sequences)[0]!;
		const r = p.tx([
			{ type: 'sequence.create', name: 'Fast', settings: { frameRate: { num: 50, den: 1 } }, ref: '$s' },
		]);
		const fast = r.refs.$s!;
		const t = p.tx([
			{
				type: 'clip.addText',
				sequenceId: fast,
				at: 0,
				duration: 100,
				track: 'V2',
				content: { text: 'Hi' },
				ref: '$t',
			},
		]);
		const clipId = t.refs.$t!;
		const side = { in: { preset: 'fade', durationSeconds: 1 } };
		const frames = async (sel: string[] | undefined, where: Parameters<typeof textAnimationOf>[3]) =>
			(await textAnimationOf(fakeCtx(p.doc, sel).ctx, 'prj', side, where))?.in?.durationFrames;
		// "$selection" in the second (50 fps) sequence: not the first sequence's 25 fps
		expect(await frames([clipId], { selection: true })).toBe(50);
		expect(await frames([clipId], { selection: true, sequenceId: first })).toBe(50);
		expect(await frames(undefined, { clipId })).toBe(50);
		// add_text: the given sequence; several sequences without one fail like the transaction
		expect(await frames(undefined, { sequenceId: fast })).toBe(50);
		expect(await frames(undefined, { sequenceId: first })).toBe(25);
		await expect(frames(undefined, {})).rejects.toThrow(/sequenceId is required/);
		await expect(frames(undefined, { clipId: 'clp_nope' })).rejects.toThrow(/Clip not found/);
	});

	it('labels the History entry by side', () => {
		expect(animationLabel({ in: { preset: 'slide-up' }, out: null })).toBe(
			'Text Animation: in Slide Up, out none',
		);
		expect(animationLabel({ out: { durationFrames: 10 } })).toBe('Text Animation: out timing');
		expect(animationLabel({ in: { preset: 'custom-x' } })).toBe('Text Animation: in custom-x');
	});
});

describe('render_frames layout', () => {
	it('spreads frames evenly over [from, to) with both ends included', () => {
		expect(spreadFrames(150, 270, 5)).toEqual([150, 180, 210, 239, 269]);
		expect(spreadFrames(0, 100, 1)).toEqual([0]);
		expect(spreadFrames(10, 13, 6)).toEqual([10, 11, 12]);
		expect(spreadFrames(5, 6, 3)).toEqual([5]);
	});

	it('shrinks cells so the sheet stays within the size cap', () => {
		expect(sheetCellWidth(320, 4, 2, 16 / 9)).toBe(320);
		const w = sheetCellWidth(640, 4, 6, 16 / 9);
		expect(w).toBeLessThan(640);
		expect(6 * Math.round(w / (16 / 9)) + 7 * 4).toBeLessThanOrEqual(MAX_SHEET_SIZE);
		expect(8 * sheetCellWidth(640, 8, 1, 16 / 9) + 9 * 4).toBeLessThanOrEqual(MAX_SHEET_SIZE);
		expect(sheetCellWidth(640, 1, 24, 9 / 16)).toBe(64);
	});
});

// ---------------------------------------------------------------- PNG

/** A PNG of raw 8-bit samples with the given filter type per row (cycled), as encoders other than ours write. */
function filteredPng(
	width: number,
	height: number,
	channels: number,
	samples: Uint8Array,
	filters: number[],
) {
	const stride = width * channels;
	const raw = Buffer.alloc((stride + 1) * height);
	const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : samples[y * stride + x]!);
	for (let y = 0; y < height; y++) {
		const f = filters[y % filters.length]!;
		raw[y * (stride + 1)] = f;
		for (let x = 0; x < stride; x++) {
			const a = at(x - channels, y);
			const b = at(x, y - 1);
			const c = at(x - channels, y - 1);
			const p = a + b - c;
			const pr =
				Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
					? a
					: Math.abs(p - b) <= Math.abs(p - c)
						? b
						: c;
			const pred = [0, a, b, (a + b) >> 1, pr][f]!;
			raw[y * (stride + 1) + 1 + x] = (at(x, y) - pred) & 0xff;
		}
	}
	const chunk = (type: string, body: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); // CRC is not checked
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]!;
	const idat = deflateSync(raw);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		// Split IDAT, as large encoders do.
		chunk('IDAT', idat.subarray(0, 10)),
		chunk('IDAT', idat.subarray(10)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function noise(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	let s = seed;
	for (let i = 0; i < n; i++) out[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
	return out;
}

describe('PNG codec', () => {
	it('decodes RGB and RGBA rows of every filter type', () => {
		const rgb = noise(7 * 5 * 3);
		const a = decodePng(filteredPng(7, 5, 3, rgb, [0, 1, 2, 3, 4]));
		expect([a.width, a.height]).toEqual([7, 5]);
		for (let i = 0; i < 35; i++) {
			expect([...a.data.subarray(i * 4, i * 4 + 4)]).toEqual([...rgb.subarray(i * 3, i * 3 + 3), 255]);
		}
		const rgba = noise(6 * 4 * 4, 9);
		expect([...decodePng(filteredPng(6, 4, 4, rgba, [4, 3, 2, 1])).data]).toEqual([...rgba]);
	});

	it('decodes greyscale (with alpha) to RGBA and rejects what it does not support', () => {
		const g = decodePng(filteredPng(2, 1, 2, Uint8Array.from([10, 200, 30, 40]), [1]));
		expect([...g.data]).toEqual([10, 10, 10, 200, 30, 30, 30, 40]);
		expect(() => decodePng(Buffer.from('not a png'))).toThrow(/Not a PNG/);
		const sixteen = filteredPng(1, 1, 3, Uint8Array.from([1, 2, 3]), [0]);
		sixteen[8 + 8 + 8] = 16; // IHDR bit depth
		expect(() => decodePng(sixteen)).toThrow(/only 8-bit/);
	});

	it('round-trips through encodePng (opaque RGB with valid CRCs)', () => {
		const img: RgbaImage = { width: 9, height: 4, data: noise(9 * 4 * 4, 3) };
		for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
		const png = encodePng(img);
		expect(png.readUInt32BE(16)).toBe(9);
		expect(png[25]).toBe(2); // colour type RGB
		expect(decodePng(png)).toEqual(img);
	});

	it('composes a grid of cells with gaps over the background, alpha blended', () => {
		const solid = (w: number, h: number, rgba: number[]): RgbaImage => ({
			width: w,
			height: h,
			data: Uint8Array.from({ length: w * h * 4 }, (_, i) => rgba[i % 4]!),
		});
		const sheet = composeGrid(
			[solid(2, 1, [255, 0, 0, 255]), solid(2, 1, [0, 255, 0, 255]), solid(2, 1, [0, 0, 255, 128])],
			2,
			1,
			[10, 10, 10],
		);
		expect(sheet).toMatchObject({ width: 7, height: 5, cellWidth: 2, cellHeight: 1, rows: 2 });
		const px = (x: number, y: number) => [...sheet.data.subarray((y * 7 + x) * 4, (y * 7 + x) * 4 + 4)];
		expect(px(0, 0)).toEqual([10, 10, 10, 255]);
		expect(px(1, 1)).toEqual([255, 0, 0, 255]);
		expect(px(3, 1)).toEqual([10, 10, 10, 255]);
		expect(px(4, 1)).toEqual([0, 255, 0, 255]);
		expect(px(1, 3)).toEqual([5, 5, 133, 255]);
		expect(px(4, 3)).toEqual([10, 10, 10, 255]);
	});
});

describe('get_timeline text of animated clips (S11:ANA-008)', () => {
	it('shows text animators as in:<preset> out:<preset> and the anime renderer of templates', () => {
		const p = project('hd-1080p-30');
		const r = p.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 90,
				track: 'V2',
				content: { text: 'Hello' },
				textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'fade' } },
				ref: '$a',
			},
			{
				type: 'clip.addText',
				at: 100,
				duration: 90,
				track: 'V2',
				content: { text: 'Bye' },
				textAnimation: { out: { preset: 'drop' } },
				ref: '$b',
			},
			{ type: 'clip.addText', at: 200, duration: 30, track: 'V2', content: { text: 'Plain' }, ref: '$c' },
		]);
		const seq = Object.values(p.doc.sequences)[0]!;
		const text = (ref: string) => clipSourceText(p.doc, seq, seq.clips[r.refs[ref]!]!);
		expect(text('$a')).toBe('text "Hello" in:slide-up out:fade');
		expect(text('$b')).toBe('text "Bye" out:drop');
		expect(text('$c')).toBe('text "Plain"');
		const mg = (renderer?: string) =>
			({
				kind: 'motion-graphic',
				template: { id: 'title-reveal', version: 1, ...(renderer ? { renderer } : {}) },
			}) as unknown as Clip;
		expect(clipSourceText(p.doc, seq, mg('anime'))).toBe('motion graphic title-reveal@1 (anime)');
		expect(clipSourceText(p.doc, seq, mg('fframes'))).toBe('motion graphic title-reveal@1');
		expect(clipSourceText(p.doc, seq, mg())).toBe('motion graphic title-reveal@1');
	});
});
