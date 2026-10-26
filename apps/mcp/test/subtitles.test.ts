// spec 13 AS-041: the subtitle tools (captions_from_transcript's Create Subtitles path, list_caption_groups,
// align_captions_to_cuts, convert_captions, regenerate_captions, subtitle templates, export_captions {groupId})
// against an in-process engine stand-in that applies transactions with the real command system and keeps a template
// library and a font catalog; plus the describe_commands examples of the subtitle commands.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	captionGroupsOf,
	captionOf,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
	type SubtitleTemplate,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const S = 705_600_000;

function asset(n: number): Omit<MediaAsset, 'id'> {
	return {
		kind: 'video',
		fingerprint: `q1:${String(n).padStart(64, '0')}`,
		originalName: `clip${n}.mp4`,
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 10 * S,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 25, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
				{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' },
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${n}` }],
		derivation: null,
		importedAt: '2026-10-25T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

const WORDS: Array<[string, number, number]> = [
	['Hola', 0.2, 0.5],
	['a', 0.5, 0.6],
	['todos', 0.6, 1.0],
	['hoy', 1.0, 1.4],
	['hice', 2.1, 2.4],
	['el', 2.4, 2.5],
	['juego', 2.5, 2.9],
	['de', 2.9, 3.0],
	['Doors.', 3.0, 3.6],
];

function fakeEngine() {
	const ids = createCounterIdSource(41);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Subs', preset: 'hd-1080p-25' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const labels: string[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, ...tx, origin: 'user' } as never,
			{ ids, now: () => '2026-10-25T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok && !tx.dryRun) {
			if (r.document !== doc) labels.push(String(tx.label));
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = (commands: unknown[]) => {
		const r = apply({ label: 'setup', commands });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const a = setup([{ type: 'media.register', asset: asset(1), ref: '$a' }]).refs.$a!;
	const b = setup([{ type: 'media.register', asset: asset(2), ref: '$b' }]).refs.$b!;
	setup([{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: ['A1'] } }]);
	// a picture cut at frame 50 (2 s): B overwrites V1, A's audio continues
	setup([{ type: 'clip.place', source: { mediaId: b }, at: 50, tracks: { video: 'V1' }, audio: false }]);
	setup([
		{
			type: 'transcript.create',
			mediaId: a,
			language: 'es',
			origin: 'manual',
			words: WORDS.map(([text, s, e]) => ({ text, start: Math.round(s * S), end: Math.round(e * S) })),
		},
	]);
	const library: SubtitleTemplate[] = [];
	let libRevision = 0;
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		listFonts: async () => ({
			fonts: [
				{
					family: 'Montserrat',
					source: 'bundled',
					weights: [400, 800],
					styles: ['normal'],
					files: [{ weight: 800, style: 'normal', url: '/fonts/m.woff2' }],
				},
			],
		}),
		call: async (
			name: string,
			opts: { params?: Record<string, string>; body?: { template?: SubtitleTemplate } } = {},
		) => {
			if (name === 'subtitleTemplatesList')
				return { revision: libRevision, templates: structuredClone(library) };
			if (name === 'subtitleTemplateSave') {
				const t = { ...opts.body!.template!, id: opts.params!.templateId! };
				const i = library.findIndex((x) => x.id === t.id);
				if (i >= 0) library[i] = t;
				else library.push(t);
				libRevision++;
				return t;
			}
			if (name === 'subtitleTemplateDelete') {
				const i = library.findIndex((x) => x.id === opts.params!.templateId);
				if (i < 0) throw new Error('Subtitle template not found');
				library.splice(i, 1);
				libRevision++;
				return { ok: true, removed: opts.params!.templateId };
			}
			throw new Error(`unexpected engine call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, seqId, labels, library, apply };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'subtitles-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'subtitles-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>, withProject = true) => {
		const r = (await client.callTool({
			name,
			arguments: withProject ? { projectId: 'prj_test', ...args } : args,
		})) as CallToolResult;
		const text = (r.content as { type: string; text: string }[]).map((c) => c.text).join('');
		let body: Json = {};
		try {
			body = JSON.parse(text) as Json;
		} catch {
			body = { text };
		}
		return { isError: !!r.isError, body };
	};
	return { engine, call };
}

const subs = (doc: ProjectDocument, seqId: string) =>
	Object.values(doc.sequences[seqId]!.clips)
		.filter((c) => c.kind === 'text' && captionOf(c))
		.sort((p, q) => p.start - q.start);

describe('subtitle MCP tools (spec 13 AS-041)', () => {
	it('captions_from_transcript: dry run, then text-clip subtitles with a template, never across the cut', async () => {
		const { call, engine } = await connect();
		const before = engine.doc();
		const dry = await call('captions_from_transcript', { template: 'builtin:pixel-pop', dryRun: true });
		expect(dry.isError, JSON.stringify(dry.body)).toBe(false);
		expect(engine.doc()).toBe(before);
		expect(dry.body.stats.count).toBe(dry.body.captions.length);
		expect(dry.body.captions[0].in.timecode).toMatch(/^\d\d:\d\d:\d\d:\d\d$/);
		const made = await call('captions_from_transcript', {
			template: 'builtin:pixel-pop',
			rules: { maxWords: 2 },
		});
		expect(made.isError, JSON.stringify(made.body)).toBe(false);
		expect(made.body.subtitles.groupId).toMatch(/^cgp_/);
		expect(made.body.subtitles.stats.crossing).toBe(0);
		const list = subs(engine.doc(), engine.seqId);
		expect(list.length).toBe(made.body.subtitles.count);
		for (const c of list) expect(c.start >= 50 || c.start + c.duration <= 50).toBe(true);
		expect(engine.labels.at(-1)).toBe('Create Subtitles');
	});

	it('captions_from_transcript keeps the original caption-track path for the original arguments', async () => {
		const { call, engine } = await connect();
		const r = await call('captions_from_transcript', { maxChars: 30, preset: 'builtin:broadcast' });
		expect(r.isError, JSON.stringify(r.body)).toBe(false);
		const seq = engine.doc().sequences[engine.seqId]!;
		expect(seq.captionTracks).toHaveLength(1);
		expect(subs(engine.doc(), engine.seqId)).toHaveLength(0);
		const cap = await call('captions_from_transcript', {
			output: 'caption-track',
			template: 'builtin:subtitles',
		});
		expect(cap.isError, JSON.stringify(cap.body)).toBe(false);
		expect(engine.doc().sequences[engine.seqId]!.captionTracks).toHaveLength(2);
	});

	it('refusals: unknown template, unknown argument, mixed paths, locked track', async () => {
		const { call, engine } = await connect();
		const unknown = await call('captions_from_transcript', { template: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(JSON.stringify(unknown.body)).toContain('E_NOT_FOUND');
		const bad = await call('captions_from_transcript', { rules: { maxWordz: 3 } });
		expect(bad.isError).toBe(true);
		const mixed = await call('captions_from_transcript', { template: 'builtin:pixel-pop', fromWord: 0 });
		expect(mixed.isError).toBe(true);
		engine.apply({
			label: 'lock',
			commands: [
				{
					type: 'track.update',
					trackId: engine.doc().sequences[engine.seqId]!.videoTracks[0]!.id,
					patch: { locked: true },
				},
			],
		});
		const locked = await call('captions_from_transcript', { track: 'V1', output: 'text-clips' });
		expect(locked.isError).toBe(true);
		expect(JSON.stringify(locked.body)).toContain('E_TRACK_LOCKED');
	});

	it('list_caption_groups, align_captions_to_cuts, regenerate_captions, export_captions {groupId}', async () => {
		const { call, engine } = await connect();
		const made = await call('captions_from_transcript', {
			cutAware: false,
			rules: { maxWords: 5, maxChars: 40 },
		});
		const groupId = made.body.subtitles.groupId as string;
		const groups = await call('list_caption_groups', {});
		expect(groups.body.groups.map((g: Json) => [g.groupId, g.clips > 0, g.language])).toEqual([
			[groupId, true, 'es'],
		]);
		const page = await call('list_caption_groups', { groupId, limit: 1 });
		expect(page.body.clips).toHaveLength(1);
		expect(page.body.clips[0].in.timecode).toBe('00:00:00:05');
		expect(page.body.nextOffset).toBe(1);
		const dry = await call('align_captions_to_cuts', { groupId, dryRun: true });
		expect(dry.isError, JSON.stringify(dry.body)).toBe(false);
		const aligned = await call('align_captions_to_cuts', { groupId });
		expect(aligned.body.report.crossing).toBe(0);
		for (const c of subs(engine.doc(), engine.seqId))
			expect(c.start >= 50 || c.start + c.duration <= 50).toBe(true);
		const regen = await call('regenerate_captions', { groupId, dryRun: true });
		expect(regen.isError, JSON.stringify(regen.body)).toBe(false);
		expect(regen.body.report.dryRun).toBe(true);
		const srt = await call('export_captions', { groupId, format: 'srt' });
		expect(srt.isError, JSON.stringify(srt.body)).toBe(false);
		expect(srt.body.content).toContain('Hola');
		expect((await call('export_captions', { groupId: 'cgp_0000000000000000' })).isError).toBe(true);
		expect((await call('align_captions_to_cuts', {})).isError).toBe(true);
	});

	it('convert_captions both ways', async () => {
		const { call, engine } = await connect();
		const made = await call('captions_from_transcript', { template: 'builtin:bold-pop' });
		const groupId = made.body.subtitles.groupId as string;
		const n = subs(engine.doc(), engine.seqId).length;
		const toTrack = await call('convert_captions', { groupId, to: 'caption-track' });
		expect(toTrack.isError, JSON.stringify(toTrack.body)).toBe(false);
		expect(subs(engine.doc(), engine.seqId)).toHaveLength(0);
		const back = await call('convert_captions', { captionTrack: 'C1', to: 'text-clips' });
		expect(back.isError, JSON.stringify(back.body)).toBe(false);
		expect(subs(engine.doc(), engine.seqId)).toHaveLength(n);
		expect((await call('convert_captions', { to: 'text-clips' })).isError).toBe(true);
	});

	it('subtitle templates: list (font status), save to project + library, apply from the library, delete', async () => {
		const { call, engine } = await connect();
		const list = await call('list_subtitle_templates', {});
		const row = (id: string) => list.body.templates.find((t: Json) => t.templateId === id);
		expect(row('builtin:pixel-pop').fontStatus).toBe('missing');
		expect(row('builtin:pixel-pop').notice).toContain('Pixel12x10');
		expect(row('builtin:bold-pop').fontStatus).toBe('bundled');
		const made = await call('captions_from_transcript', { template: 'builtin:bold-pop' });
		const groupId = made.body.subtitles.groupId as string;
		const clipId = subs(engine.doc(), engine.seqId)[0]!.id;
		const saved = await call('save_subtitle_template', { clipId, name: 'Mine' });
		expect(saved.isError, JSON.stringify(saved.body)).toBe(false);
		expect(engine.library.map((t) => t.name)).toEqual(['Mine']);
		const templateId = saved.body.templateId as string;
		// a library-only template is passed to the command as an object
		engine.library.push({ ...engine.library[0]!, id: 'lib_only', name: 'Library only' });
		const applied = await call('apply_subtitle_template', { template: 'lib_only', groupId });
		expect(applied.isError, JSON.stringify(applied.body)).toBe(false);
		expect(captionGroupsOf(engine.doc().sequences[engine.seqId]!)[groupId]!.templateId).toBe('lib_only');
		const withProject = await call('list_subtitle_templates', {});
		expect(
			withProject.body.templates.some((t: Json) => t.templateId === templateId && t.source === 'project'),
		).toBe(true);
		expect((await call('delete_subtitle_template', { templateId, from: 'project' })).isError).toBe(false);
		expect(
			(await call('delete_subtitle_template', { templateId: 'lib_only', from: 'library' }, false)).isError,
		).toBe(false);
		expect(
			(await call('delete_subtitle_template', { templateId: 'builtin:pixel-pop', from: 'library' }, false))
				.isError,
		).toBe(true);
	});

	it('the describe_commands examples of the subtitle commands apply in order', () => {
		const engine = fakeEngine();
		const order = [
			'clip.addText',
			'captions.generate',
			'captions.alignToCuts',
			'captions.regenerate',
			'subtitleTemplate.apply',
			'captions.updateGroup',
			'captions.convert',
			'subtitleTemplate.save',
			'captions.deleteGroup',
		];
		for (const type of order) expect(COMMAND_EXAMPLES[type], type).toBeTruthy();
		const r = engine.apply({
			label: 'examples',
			dryRun: true,
			commands: order.map((x) => COMMAND_EXAMPLES[x]),
		});
		expect(r.ok, JSON.stringify(r)).toBe(true);
	});
});
