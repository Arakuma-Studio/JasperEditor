// Clipboard tools without an engine (wp-clipboard, S01 §20): copy_clips → paste_clips into another project
// (media resolved), copy_items → paste_items, error hints, and the clipboard command examples of
// describe_commands (dry-run here too; integration.test.ts runs every example against a real engine).
import {
	applyTransaction,
	type CommandContext,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	resolveAgentAddresses,
} from '@jasper/project';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/context.ts';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import { CLIPBOARD_GUIDE, registerClipboardTools } from '../src/tools/clipboard.ts';

let fp = 0;
function video(): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind: 'video',
		fingerprint: `q1:${String(fp).padStart(64, '0')}`,
		originalName: `clip-${fp}.mp4`,
		sizeBytes: 10,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
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
		importedAt: '2026-10-01T00:00:00.000Z',
	};
}

/** An in-memory project behind a fake engine (doc.get + agentTx) with the clipboard tools registered. */
function project(seed: number) {
	const ids = createSeededIdSource(seed);
	let doc: ProjectDocument = createEmptyProject({ ids, name: `P${seed}`, preset: 'hd-1080p-30' });
	let revision = 0;
	const cctx = (): CommandContext => ({
		ids,
		now: () => '2026-10-01T00:00:00.000Z',
		revision,
		registries: defaultRegistries(),
	});
	const apply = (tx: { commands: unknown[]; sequenceId?: string; dryRun?: boolean; label?: string }) => {
		const resolved = resolveAgentAddresses(doc, tx.commands, { sequenceId: tx.sequenceId });
		if (!resolved.ok) return { ok: false as const, revision, errors: resolved.errors };
		const r = applyTransaction(
			doc,
			{ label: tx.label ?? 't', origin: { agent: 'test' }, ...tx, commands: resolved.commands },
			cctx(),
		);
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision = r.result.revision;
		}
		return r.result;
	};
	const tools = new Map<string, (args: unknown, extra: unknown) => Promise<CallToolResult>>();
	const ctx = {
		server: { registerTool: (name: string, _c: unknown, h: never) => tools.set(name, h) },
		agentName: () => 'test',
		engine: async (fn: (c: unknown) => Promise<unknown>) =>
			fn({
				agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
				agentTx: async ({ transaction }: { transaction: { commands: unknown[] } }) => ({
					result: apply(transaction),
					appliedBy: 'engine',
				}),
			}),
	} as unknown as ToolContext;
	registerClipboardTools(ctx);
	const call = async <T>(name: string, args: Record<string, unknown>) => {
		const r = await tools.get(name)!({ projectId: doc.projectId, ...args }, {});
		const text = (r.content[0] as { text: string }).text;
		return { error: !!r.isError, json: JSON.parse(text) as T };
	};
	return {
		get doc() {
			return doc;
		},
		apply,
		call,
		tools,
	};
}

describe('clipboard tools', () => {
	it('copy_clips → paste_clips across projects (linked pair, media added once, new ids)', async () => {
		const a = project(1);
		const reg = a.apply({ commands: [{ type: 'media.register', asset: video() }] });
		if (!reg.ok) throw new Error('setup');
		const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
		const placed = a.apply({
			commands: [
				{
					type: 'clip.place',
					source: { mediaId },
					at: 0,
					sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				},
			],
		});
		if (!placed.ok) throw new Error('setup');
		const [v] = (placed.results[0] as { clipIds: string[] }).clipIds;
		const copied = await a.call<{
			payload: Record<string, unknown>;
			summary: { clips: number; media: string[] };
		}>('copy_clips', { clipIds: [v] });
		expect(copied.error).toBe(false);
		expect(copied.json.summary).toMatchObject({ clips: 1, media: ['clip-1.mp4'] });
		const b = project(2);
		const pasted = await b.call<{
			ok: boolean;
			created: string[];
			clips: { kind: string; start: unknown }[];
		}>('paste_clips', { payload: copied.json.payload, at: { seconds: 1 }, mode: 'insert' });
		expect(pasted.error).toBe(false);
		expect(pasted.json.clips.map((c) => c.kind)).toEqual(['video']);
		expect(Object.values(b.doc.media).map((m) => m.fingerprint)).toEqual([a.doc.media[mediaId]!.fingerprint]);
		expect(pasted.json.created).not.toContain(v);
		// Unknown clip ids name the fix.
		const bad = await a.call<{ code: string; hint: string }>('copy_clips', { clipIds: ['clp_NOPE'] });
		expect(bad.error).toBe(true);
		expect(JSON.stringify(bad.json)).toContain('get_timeline');
	});

	it('copy_items → paste_items deep-copies a sequence into a bin', async () => {
		const a = project(3);
		a.apply({
			commands: [{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' } }],
		});
		const seqItem = Object.values(a.doc.items).find((i) => i.kind === 'sequence')!;
		const copied = await a.call<{ payload: Record<string, unknown>; summary: { sequences: number } }>(
			'copy_items',
			{ itemIds: [seqItem.id] },
		);
		expect(copied.json.summary.sequences).toBe(1);
		const b = project(4);
		const bin = b.apply({ commands: [{ type: 'bin.create', name: 'In', ref: '$b' }] });
		if (!bin.ok) throw new Error('setup');
		const r = await b.call<{ ok: boolean }>('paste_items', {
			payload: copied.json.payload,
			binId: bin.refs.$b,
		});
		expect(r.json.ok).toBe(true);
		expect(Object.keys(b.doc.sequences)).toHaveLength(2);
		expect(Object.values(b.doc.fonts).map((f) => f.family)).toEqual(
			Object.values(a.doc.fonts).map((f) => f.family),
		);
	});

	it('the guide names the tools and the commands', () => {
		for (const n of [
			'copy_clips',
			'paste_clips',
			'copy_items',
			'paste_items',
			'clip.pasteAttributes',
			'effect.paste',
		])
			expect(CLIPBOARD_GUIDE).toContain(n);
	});
});

describe('clipboard command examples (describe_commands)', () => {
	it('every clipboard example validates against a project with a clip on V1 at 0', () => {
		const p = project(5);
		const reg = p.apply({ commands: [{ type: 'media.register', asset: video() }] });
		if (!reg.ok) throw new Error('setup');
		p.apply({
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: (reg.results[0] as { mediaId: string }).mediaId },
					at: 0,
					sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				},
			],
		});
		const fx = p.apply({
			commands: [
				{
					type: 'effect.add',
					target: { clipId: { clipAt: { track: 'V1', at: 0 } } },
					effectId: 'jasper.gaussian-blur',
				},
			],
		});
		expect(fx.ok).toBe(true);
		for (const type of [
			'clip.paste',
			'clip.pasteAttributes',
			'clip.removeAttributes',
			'effect.paste',
			'keyframe.paste',
			'project.pasteItems',
		]) {
			const r = p.apply({ commands: [COMMAND_EXAMPLES[type]], dryRun: true });
			expect(r.ok, `${type}: ${JSON.stringify(r.ok ? null : r.errors)}`).toBe(true);
		}
	});
});
