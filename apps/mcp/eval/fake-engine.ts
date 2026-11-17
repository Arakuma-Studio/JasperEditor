// An in-memory engine for the eval. The tool handlers stay the real ones, so results, hints and refusals are the
// current source's; this fakes only the engine behind them. Documents go through the real command system and queries
// (`applyTransaction`, `runAgentQuery`), so an edit changes the project and a bad command gets its real `E_*`. Anything
// not modelled here fails loudly and marks the sample invalid: a gap in the fake is an eval bug, not agent behaviour.
import {
	AlphaDeliveryRequestSchema,
	AlphaDeliveryResultSchema,
	AudioAnalyzeResultSchema,
	AutoToneRequestSchema,
	AutoToneResponseSchema,
	ExportVerifyResultSchema,
	FontCatalogSchema,
	GamutCheckRequestSchema,
	GamutCheckResultSchema,
	GradingScopesRequestSchema,
	GradingScopesResponseSchema,
	LayerStyleFileSchema,
	LayerStyleReadQuerySchema,
	MgHtmlImportRequestSchema,
	type PsdPlan,
	PsdPlanSchema,
	PsdRequestSchema,
	PsdResultSchema,
	SplitImageAnalysisSchema,
	SplitImageRequestSchema,
	SplitImageResultSchema,
	StillSheetRequestSchema,
	StillSheetResultSchema,
	TitleLookLibraryResponseSchema,
	TranscriptFixResultSchema,
	TranscriptionResultSchema,
} from '@jasper/api';
import { EngineError as DefaultEngineError } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	AutomationInputError,
	type AutomationPass,
	analyzeSequenceCleanup,
	applyTransaction,
	autoTone,
	builtinCleanupSettings,
	type CleanupAnalysis,
	type Clip,
	colorSpace,
	createCounterIdSource,
	createEmptyProject,
	createProposal,
	DEFAULT_FONT_FAMILY,
	defaultRegistries,
	diffDocuments,
	EMPTY_PROBE,
	exportAgentQuerySchemas,
	exportAgentSchema,
	FACTORY_LOOKS,
	type MediaAsset,
	mergeCleanupSettings,
	normalizeAgentTransaction,
	type ProjectDocument,
	type Proposal,
	passDraft,
	passItems,
	passSummary,
	planPass,
	proposalItemFailures,
	resolveAgentAddresses,
	runAgentQuery,
	type Sequence,
	sequenceCleanupSettings,
	sequenceColorInfo,
	type Transcript,
} from '@jasper/project';
import type { z } from 'zod';
import { EngineRequestAborted } from '../src/link.ts';
import { encodePng } from '../src/png.ts';

const S = 705_600_000;
const NOW = '2026-11-02T10:00:00.000Z';
const LOUDNESS = {
	integratedLufs: -19.4,
	lra: 6.2,
	truePeakDbtp: -3.1,
	samplePeakDb: -3.4,
	maxMomentaryLufs: -12.8,
	maxShortTermLufs: -15.2,
	durationSec: 40,
};

type HistoryStep = { agent: string; label: string; before: ProjectDocument; after: ProjectDocument };

export type EngineFault = {
	/** Fails with an engine error, or answers `result` instead of the fake's own answer. */
	error?: { code: string; message: string; status?: number; detail?: unknown };
	result?: unknown;
	/** How many calls it applies to (default: all). */
	times?: number;
	/**
	 * Cuts the request off like a lost connection (with `afterApply`, after the engine applied it), or like an engine
	 * that took it and never answered (`timeout`).
	 */
	abort?: 'connection-lost' | 'timeout';
	afterApply?: boolean;
};

export type EngineSetup = {
	/** `none`: no project at all. `empty`: one empty project. `interview`: a transcribed interview on a timeline. */
	project?: 'none' | 'empty' | 'interview';
	projectName?: string;
	preset?: string;
	/** Engine method (`agentTx`, `getJob`…), `call:<route>`, or `tx:<command type>` for a refused transaction. */
	faults?: Record<string, EngineFault>;
	/** What the reviewer does to a proposal; default `accept`. */
	review?: 'accept' | 'reject';
	/** A brief stored on the sequence. */
	brief?: Record<string, unknown>;
	/** Commands already in the project, for a history that claims them. */
	seed?: Record<string, unknown>[];
	/** Polls an export takes to finish; default 1. */
	exportPolls?: number;
	/** A file is already at every export's outputPath: kept as the engine does (" (2)") unless `overwrite`. */
	outputExists?: boolean;
	/**
	 * A transcription of broll-workshop.mp4 (`interview`) already queued, still running for `polls` job reads:
	 * `{{pendingJob}}` (the job a timed-out `transcribe` named).
	 */
	pendingTranscription?: { polls: number };
	/**
	 * Job reads an audio analysis takes (a long mix through slow effects); a request that waits for it (`wait=1`) is cut
	 * off like the 180 s engine request deadline.
	 */
	analysisPolls?: number;
	/** What an export's verification finds. */
	verify?: { failRow?: string };
	/** A finished export of the project wrote this path in an earlier session (its job id is not in the chat). */
	pastExport?: string;
	/** A still `logo.png` (three letters with gaps between them) on V2 at 0: `{{still}}`. */
	logo?: boolean;
};

/** The still of `setup.logo`: 600 × 200, three alpha islands (the letters), as `image_split` analyses it. */
const LOGO = { key: 'mk_logo', width: 600, height: 200 };
const LOGO_ISLANDS = [
	{ x0: 20, y0: 40, x1: 180, y1: 160 },
	{ x0: 220, y0: 40, x1: 380, y1: 160 },
	{ x0: 420, y0: 40, x1: 580, y1: 160 },
];
const imageProbe = (width: number, height: number): MediaAsset['probe'] => ({
	durationFlicks: null,
	startTimecode: null,
	streams: [
		{
			index: 0,
			type: 'video',
			codec: 'png',
			width,
			height,
			pixelAspect: { num: 1, den: 1 },
			frameRate: { num: 25, den: 1 },
			pixelFormat: 'rgba',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'pc' },
			browserDecodable: true,
		},
	],
	rotationDegrees: 0,
	hasAlpha: true,
	variableFrameRate: false,
});
const imageAsset = (key: string, name: string, width: number, height: number) => ({
	kind: 'image' as const,
	fingerprint: `q1:${key.padStart(64, '0')}`,
	originalName: name,
	sizeBytes: 1,
	container: 'png_pipe',
	probe: imageProbe(width, height),
	locators: [{ type: 'engine-store' as const, engineId: 'local', key }],
});

/** What `layerStylesRead` finds in any style file: two styles, one of them with a pattern the mapper cannot draw. */
const STYLE_FILE = {
	styles: [
		{
			name: 'Brand Gold',
			origin: 'style library' as const,
			refPx: 100,
			refKnown: false,
			refNote: 'The file names no text size: 100 px is a suggestion; pass refPx to confirm it.',
			style: {
				effects: {
					stroke: [
						{ enabled: true, size: { units: 'Pixels', value: 6 }, position: 'outside', fillType: 'color' },
					],
					patternOverlay: { enabled: true, pattern: { name: 'Bricks' } },
				},
				baseColor: null,
				ppi: 72,
				globalAngle: 120,
				globalAltitude: 30,
				fillOpacity: 1,
				knockout: false,
			},
		},
		{
			name: 'Brand Outline',
			origin: 'style library' as const,
			refPx: 100,
			refKnown: false,
			refNote: 'The file names no text size: 100 px is a suggestion; pass refPx to confirm it.',
			style: {
				effects: {
					stroke: [
						{ enabled: true, size: { units: 'Pixels', value: 3 }, position: 'center', fillType: 'color' },
					],
				},
				baseColor: null,
				ppi: 72,
				globalAngle: 120,
				globalAltitude: 30,
				fillOpacity: 0,
				knockout: false,
			},
		},
	],
	skipped: [],
};

const probe = (seconds: number, audio: boolean, video: boolean): MediaAsset['probe'] => ({
	durationFlicks: seconds * S,
	startTimecode: null,
	streams: [
		...(video
			? [
					{
						index: 0,
						type: 'video' as const,
						codec: 'h264',
						width: 1920,
						height: 1080,
						pixelAspect: { num: 1, den: 1 },
						frameRate: { num: 30, den: 1 },
						pixelFormat: 'yuv420p',
						bitDepth: 8,
						color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' as const },
						browserDecodable: true,
					},
				]
			: []),
		...(audio
			? [
					{
						index: video ? 1 : 0,
						type: 'audio' as const,
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
});

const say = (line: string, at: number) =>
	line.split(' ').map((text, k) => ({
		text,
		start: Math.round((at + k * 0.4) * S),
		end: Math.round((at + k * 0.4 + 0.3) * S),
		confidence: 0.92,
		speaker: null,
		breakBefore: 'none' as const,
	}));

const assetCommand = (key: string, name: string, seconds: number, ref: string) => ({
	type: 'media.register',
	ref,
	asset: {
		kind: 'video',
		fingerprint: `q1:${key.padStart(64, '0')}`,
		originalName: name,
		sizeBytes: 1,
		container: 'mov,mp4',
		probe: probe(seconds, true, true),
		locators: [{ type: 'engine-store', engineId: 'local', key }],
	},
});

const greyPng = (width: number, height: number): Buffer => {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 96;
		data[i + 1] = 96;
		data[i + 2] = 96;
		data[i + 3] = 255;
	}
	return encodePng({ width, height, data });
};

type Job = { id: string; kind: string; title: string; polls: number; result: unknown; failure?: unknown };

/** What a title clip paints in the fake's pictures: a box of 40 % × 16 % of the frame around its position. */
const TITLE_BOX = { w: 0.4, h: 0.16 };
const TITLE_FACE = [245, 245, 245];
const FOOTAGE_GREY = [96, 96, 96];

/** The clips of `seq` on screen at `frame`, bottom track first. */
function visibleAt(seq: Sequence, frame: number, hidden: readonly string[] = []): Clip[] {
	// a track whose output (eye) is off draws nothing, as in the engine
	const order = new Map(seq.videoTracks.flatMap((t, i) => (t.output === false ? [] : [[t.id, i] as const])));
	return (Object.values(seq.clips) as Clip[])
		.filter(
			(c) =>
				order.has(c.trackId) &&
				!hidden.includes(c.id) &&
				(c as { enabled?: boolean }).enabled !== false &&
				frame >= c.start &&
				frame < c.start + c.duration,
		)
		.sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)!);
}

const isTitleClip = (c: Clip) => c.kind === 'text' || c.kind === 'shape';

/** A title's box in sequence px: centred on its position, else on the frame. */
function titleBox(seq: Sequence, c: Clip) {
	const { width, height } = seq.settings;
	const pos = (c as { transform?: { position?: { value?: [number, number] } } }).transform?.position?.value;
	const w = Math.round(width * TITLE_BOX.w);
	const h = Math.round(height * TITLE_BOX.h);
	const [cx, cy] = pos ?? [width / 2, height / 2];
	return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

/**
 * A frame as the fake renders it: the top picture under the titles (a solid's colour, grey for footage, black for
 * nothing), then each title as a light box. Stand-in pixels with known answers, so the title check's matting, bounds and
 * contrast measure something real; not the look itself.
 */
function rasterFrame(
	doc: ProjectDocument,
	sequenceId: string,
	frame: number,
	width: number,
	hide?: string[],
) {
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	if (!seq) throw new Error(`no sequence ${sequenceId}`);
	const w = Math.max(16, Math.min(width, 480));
	const k = w / seq.settings.width;
	const h = Math.max(16, Math.round(seq.settings.height * k));
	const clips = visibleAt(seq, frame, hide);
	let back = [0, 0, 0];
	for (const c of clips) {
		if (isTitleClip(c)) continue;
		if (c.kind === 'solid') {
			const syn = (doc.synthetics as Record<string, { color?: readonly number[] }>)[
				(c as { syntheticId?: string }).syntheticId ?? ''
			];
			back = (syn?.color ?? [0, 0, 0, 1]).slice(0, 3).map((v) => Math.round(v * 255));
		} else back = FOOTAGE_GREY;
	}
	const data = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set([back[0]!, back[1]!, back[2]!, 255], i * 4);
	for (const c of clips.filter(isTitleClip)) {
		const b = titleBox(seq, c);
		for (let y = Math.max(0, Math.round(b.y * k)); y < Math.min(h, Math.round((b.y + b.h) * k)); y++)
			for (let x = Math.max(0, Math.round(b.x * k)); x < Math.min(w, Math.round((b.x + b.w) * k)); x++)
				data.set([TITLE_FACE[0]!, TITLE_FACE[1]!, TITLE_FACE[2]!, 255], (y * w + x) * 4);
	}
	return { png: encodePng({ width: w, height: h, data }), width: w, height: h };
}

/** Every family the library's looks name, and the default: the engine bundles them (TL-053). */
function fontCatalog() {
	const families = new Set<string>([DEFAULT_FONT_FAMILY]);
	for (const l of FACTORY_LOOKS) {
		const f = l.recipe.font as { family?: string; fallback?: string; ja?: { family?: string } } | undefined;
		for (const name of [f?.family, f?.fallback, f?.ja?.family]) if (name) families.add(name);
	}
	const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
	return FontCatalogSchema.parse({
		fonts: [...families].map((family) => ({
			family,
			source: 'bundled',
			weights,
			styles: ['normal', 'italic'],
			files: weights.flatMap((weight) =>
				(['normal', 'italic'] as const).map((style) => ({
					weight,
					style,
					url: `/fonts/${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${weight}-${style}.woff2`,
				})),
			),
		})),
	});
}

export type FakeEngine = {
	client: unknown;
	/** Ids a case may name in its prompt and history as `{{name}}`. */
	vars: Record<string, string>;
	/** Engine calls the fake could not answer, since the last read. */
	takeUnmodelled(): string[];
};

/**
 * `EngineError` is the class of the checkout under test: its handlers test `instanceof`, and a second copy of the class
 * would turn every engine error into `INTERNAL`, a worse text than real agents get.
 */
export function createFakeEngine(
	setup: EngineSetup = {},
	EngineError: typeof DefaultEngineError = DefaultEngineError,
): FakeEngine {
	// The built-in motion-graphic templates, as the engine serves its TS catalog without the native renderer.
	const registries = defaultRegistries(mgRegistry);
	const ids = createCounterIdSource(41);
	const mode = setup.project ?? 'interview';
	const projects = new Map<string, { name: string; doc: ProjectDocument; revision: number }>();
	const vars: Record<string, string> = {};
	const unmodelled: string[] = [];
	const faults = new Map(Object.entries(setup.faults ?? {}).map(([k, v]) => [k, { ...v }]));
	const jobs = new Map<string, Job>();
	const proposals = new Map<string, Proposal>();
	const reviewed = new Set<string>();
	/** Headless undo / redo stacks per project, valid while the project is at `revision` (as the engine's). */
	const history = new Map<string, { revision: number; undo: HistoryStep[]; redo: HistoryStep[] }>();
	/** Projects `open_project_in_editor` opened: reads say an editor has them (edits still apply headless). */
	const opened = new Set<string>();
	/** Pictures jobs wrote, by the URL the engine would serve them at. */
	const files = new Map<string, Uint8Array>();
	let jobN = 0;
	let proposalN = 0;

	const newProject = (name: string, preset: string) => {
		const doc = createEmptyProject({ ids, name, preset });
		projects.set(doc.projectId, { name, doc, revision: 0 });
		return doc.projectId;
	};
	const project = (id: string) => {
		const p = projects.get(id);
		if (!p) throw new EngineError('PROJECT_NOT_FOUND', `No project ${id}`, { status: 404 });
		return p;
	};
	const applyTo = (id: string, raw: Record<string, unknown>) => {
		const p = project(id);
		const tx = normalizeAgentTransaction(raw as never);
		const addressed = resolveAgentAddresses(p.doc, tx.commands, { sequenceId: tx.sequenceId });
		if (!addressed.ok) return { ok: false as const, revision: p.revision, errors: addressed.errors };
		const r = applyTransaction(p.doc, { ...tx, commands: addressed.commands } as never, {
			ids,
			now: () => NOW,
			revision: p.revision,
			registries,
		});
		if (r.result.ok && !tx.dryRun) {
			p.doc = r.document;
			p.revision++;
		}
		return r.result;
	};
	/** A fault configured for `key`, consumed once per call. */
	const fault = (key: string): EngineFault | undefined => {
		const f = faults.get(key);
		if (!f) return undefined;
		if (f.times !== undefined) {
			if (f.times <= 0) return undefined;
			f.times--;
		}
		return f;
	};
	/** A request body as the engine's route checks it (`parseOr400`). */
	const body = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
		const r = schema.safeParse(value);
		if (r.success) return r.data;
		const i = r.error.issues[0];
		throw new EngineError('VALIDATION_FAILED', `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`, {
			status: 400,
		});
	};
	/** The document and sequence of a delivery request. */
	const framed = (envelope: { document: unknown }, sequenceId: string) => {
		const doc = envelope.document as unknown as ProjectDocument;
		const seq = doc.sequences?.[sequenceId] as Sequence | undefined;
		if (!seq) throw new EngineError('VALIDATION_FAILED', `No sequence ${sequenceId}`, { status: 400 });
		return { doc, seq };
	};
	const refuse = (f: EngineFault): never => {
		const e = f.error!;
		throw new EngineError(e.code, e.message, {
			status: e.status ?? 500,
			...(e.detail ? { detail: e.detail } : {}),
		});
	};

	if (mode !== 'none') {
		const projectId = newProject(setup.projectName ?? 'Founder interview', setup.preset ?? 'hd-1080p-30');
		vars.project = projectId;
		const p = project(projectId);
		const seqId = Object.keys(p.doc.sequences)[0]!;
		vars.sequence = seqId;
		if (mode === 'interview') {
			const setupTx = applyTo(projectId, {
				protocol: 'jasper.tx/1',
				label: 'setup',
				origin: { agent: 'eval' },
				sequenceId: seqId,
				commands: [
					assetCommand('mk_a', 'interview-a.mp4', 40, '$a'),
					assetCommand('mk_b', 'interview-b.mp4', 30, '$b'),
					assetCommand('mk_c', 'broll-workshop.mp4', 20, '$c'),
					{
						type: 'clip.place',
						source: { mediaId: '$a' },
						at: 0,
						matchSequence: 'keep',
						sourceRange: undefined,
					},
				],
			});
			if (!setupTx.ok) throw new Error(`eval seed failed: ${JSON.stringify(setupTx.errors)}`);
			vars.mediaA = setupTx.refs.$a!;
			vars.mediaB = setupTx.refs.$b!;
			vars.mediaC = setupTx.refs.$c!;
			const transcripts: Record<string, Transcript> = {
				trs_00000000000000A1: {
					id: 'trs_00000000000000A1',
					mediaId: vars.mediaA,
					language: 'en',
					origin: 'whisper-local',
					words: [
						...say('Um so we started the company in a garage.', 1),
						...say('We started the company in a garage in twenty nineteen.', 8),
						...say('Our first customer was a bakery down the street.', 16),
						...say('The hardest part was hiring the first engineer.', 24),
					],
					speakers: {},
				},
				trs_00000000000000B1: {
					id: 'trs_00000000000000B1',
					mediaId: vars.mediaB,
					language: 'en',
					origin: 'whisper-local',
					words: [
						...say('We started the company in a garage in twenty nineteen.', 2),
						...say('What matters most is talking to customers every week.', 12),
					],
					speakers: {},
				},
			};
			p.doc = { ...p.doc, transcripts };
			const clips = Object.values(p.doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
			if (clips[0]) vars.clip = clips[0].id;
			if (clips[1]) vars.linkedClip = clips[1].id;
		}
		if (setup.logo) {
			const r = applyTo(projectId, {
				protocol: 'jasper.tx/1',
				label: 'logo',
				origin: { agent: 'eval' },
				sequenceId: seqId,
				commands: [
					{
						type: 'media.register',
						asset: imageAsset(LOGO.key, 'logo.png', LOGO.width, LOGO.height),
						ref: '$l',
					},
					{
						type: 'clip.place',
						source: { mediaId: '$l' },
						at: 0,
						tracks: { video: 'V2' },
						ref: '$s',
					},
				],
			});
			if (!r.ok) throw new Error(`eval logo seed failed: ${JSON.stringify(r.errors)}`);
			vars.still = r.refs.$s!;
		}
		if (setup.seed) {
			const r = applyTo(projectId, {
				protocol: 'jasper.tx/1',
				label: 'seed',
				origin: { agent: 'eval' },
				sequenceId: seqId,
				commands: setup.seed,
			});
			if (!r.ok) throw new Error(`eval seed failed: ${JSON.stringify(r.errors)}`);
			// The refs of the seed, for prompts and tests: `$t` is `{{seed_t}}`.
			for (const [ref, id] of Object.entries(r.refs)) vars[`seed_${ref.slice(1)}`] = id;
		}
		if (setup.brief) {
			const r = applyTo(projectId, {
				protocol: 'jasper.tx/1',
				label: 'brief',
				origin: { agent: 'eval' },
				sequenceId: seqId,
				commands: [{ type: 'sequence.setBrief', sequenceId: seqId, ...setup.brief }],
			});
			if (!r.ok) throw new Error(`eval brief seed failed: ${JSON.stringify(r.errors)}`);
		}
	}

	const cleanups = new Map<
		string,
		{ projectId: string; sequenceId: string; analysis: CleanupAnalysis; sent: boolean }
	>();
	const newJob = (kind: string, title: string, polls: number, result: unknown, failure?: unknown): Job => {
		const job: Job = { id: `job_${String(++jobN).padStart(4, '0')}`, kind, title, polls, result, failure };
		jobs.set(job.id, job);
		return job;
	};
	const jobView = (job: Job) => {
		const done = job.polls <= 0;
		return {
			id: job.id,
			kind: job.kind,
			title: job.title,
			origin: { type: 'user' },
			state: done ? (job.failure ? 'failed' : 'succeeded') : 'running',
			progress: done ? 1 : 0.4,
			createdAt: NOW,
			priority: 'user',
			cpuSlots: 1,
			...(done && !job.failure ? { result: job.result } : {}),
			...(done && job.failure ? { error: job.failure } : {}),
		};
	};
	/** Exports written with `videoOnly`: their file has no audio stream (and no sound rows). */
	const pictureOnly = new Set<string>();
	const verifyResult = (exportId: string, checks: 'fast' | 'full', target?: string) => {
		const row = (
			id: string,
			status: 'pass' | 'fail',
			measured: unknown,
			expected: unknown,
			message: string,
		) => ({
			id,
			kind: id === 'loudness' ? 'judgement' : 'format',
			status,
			measured,
			expected,
			tolerance: null,
			message,
		});
		const failing = setup.verify?.failRow;
		const sound = !pictureOnly.has(exportId);
		const ids = (
			checks === 'fast'
				? ['streams', 'duration', 'av-skew']
				: ['decode', 'streams', 'duration', 'av-skew', 'loudness']
		).filter((id) => sound || (id !== 'av-skew' && id !== 'loudness'));
		const rows = ids.map((id) =>
			id === failing
				? row(id, 'fail', -9.1, -14, 'Integrated loudness −9.1 LUFS against the −14 LUFS target')
				: row(id, 'pass', 'ok', 'ok', `${id} ok`),
		);
		const fail = rows.filter((r) => r.status === 'fail').length;
		return ExportVerifyResultSchema.parse({
			exportId,
			checks,
			...(target ? { target } : {}),
			deliverable: 'video',
			output: {
				container: 'mp4',
				durationSec: 40,
				sizeBytes: 48_000_000,
				streams: [
					{
						index: 0,
						type: 'video',
						codec: 'h264',
						width: 1920,
						height: 1080,
						frameRate: 30,
						pixFmt: 'yuv420p',
					},
					...(sound ? [{ index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2 }] : []),
				],
			},
			rows,
			verified: fail === 0,
			counts: { pass: rows.length - fail, warn: 0, fail, unverified: 0 },
		});
	};
	const reviewedProposal = (proposalId: string): Proposal => {
		const stored = proposals.get(proposalId);
		if (!stored) throw new EngineError('PROPOSAL_NOT_FOUND', 'gone', { status: 404 });
		// The reviewer answers on the second read: the tool's wait sees the pending state first, like a real wait.
		if (reviewed.has(proposalId)) return stored;
		reviewed.add(proposalId);
		return stored;
	};
	const decide = (proposalId: string) => {
		const stored = proposals.get(proposalId);
		if (!stored || stored.updatedAt !== NOW) return;
		const state = setup.review === 'reject' ? 'rejected' : 'accepted';
		proposals.set(proposalId, {
			...stored,
			updatedAt: '2026-11-02T10:05:00.000Z',
			items: stored.items.map((i) => ({ ...i, state })) as Proposal['items'],
		});
	};

	/** One layer per clip on screen, bottom first, named as `planPsd` names them; titles split into rims, face and fx. */
	const psdPlan = (req: z.infer<typeof PsdRequestSchema>): PsdPlan => {
		const { seq } = framed(req.envelope, req.sequenceId);
		const { width, height } = seq.settings;
		const layers: PsdPlan['layers'] = [];
		const baked: string[] = [];
		const KIND_WORD: Record<string, string> = { text: 'text rasterised', shape: 'shape rasterised' };
		for (const c of visibleAt(seq, req.frame)) {
			const name = (c as { name?: string }).name || c.kind;
			const look = (c as { effects?: { effectId: string }[] }).effects?.some(
				(fx) => fx.effectId === 'jasper.title-look',
			);
			const here = [
				...(KIND_WORD[c.kind] ? [KIND_WORD[c.kind]!] : []),
				...(look ? ['title look rasterised'] : []),
			];
			for (const b of here) baked.push(`${name}: ${b}`);
			const layer = { kind: 'pixels' as const, blend: 'normal', opacity: 1, hidden: false, baked: here };
			if (req.splitTitles && look) {
				layers.push({
					name,
					kind: 'group',
					children: 3,
					blend: 'pass through',
					opacity: 1,
					hidden: false,
					baked: [],
				});
				layers.push({ ...layer, name: 'rim 1', hidden: true }, { ...layer, name: 'face', hidden: true });
				layers.push({ ...layer, name: 'fx' });
			} else layers.push({ ...layer, name });
		}
		const renders = layers.filter((l) => l.kind === 'pixels').length;
		return PsdPlanSchema.parse({
			width,
			height,
			frame: req.frame,
			layers,
			baked: [...new Set(baked)],
			blockers: layers.length
				? []
				: [{ code: 'PSD_EMPTY', message: 'Nothing is visible at this frame on a transparent background' }],
			warnings: [
				{
					code: 'PSD_RASTERISED',
					message: 'Everything is rasterised at 8 bits per channel: text is pixels, not editable type.',
				},
			],
			estimate: { renders: renders + 1, bytes: (renders + 1) * width * height * 4 },
		});
	};

	const routes: Record<string, (opts: { params?: Record<string, string>; body?: never }) => unknown> = {
		// An HTML composition page: 6 s long, whatever the file says (the contract errors come from `setup.faults`).
		mgBundleImportHtml: ({ body: raw }) => {
			const b = body(MgHtmlImportRequestSchema, raw);
			if (!/\.html?$/i.test(b.path))
				throw new EngineError('HTML_NOT_A_PAGE', `${b.path} is not an .html file`, {
					status: 400,
					detail: { hint: 'Pass the absolute path of the page file (…/page.html), not its folder.' },
				});
			const entry = b.path.split('/').pop()!;
			const query = (b.query ?? '').replace(/^\?/, '');
			const tag = [...`${b.path}?${query}@${b.width}x${b.height}@${b.fps}`]
				.reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
				.toString(16)
				.padStart(8, '0');
			const name = `${entry}${query ? `?${query}` : ''}`;
			const frames = Math.round(6 * b.fps);
			return {
				mediaKey: `mk_${tag.repeat(3)}`,
				fingerprint: `q1:${tag}`,
				originalName: name,
				sizeBytes: 4096,
				container: 'html-page',
				kind: 'mg-bundle',
				probe: EMPTY_PROBE,
				locators: [],
				browserPlayable: 'no',
				mgBundle: {
					remotionVersion: '4.0.499',
					bundleHash: tag,
					builtAt: NOW,
					source: { type: 'html-page', path: b.path, name },
					compositions: [
						{
							id: entry.replace(/\.html?$/i, ''),
							width: b.width,
							height: b.height,
							fps: b.fps,
							durationInFrames: frames,
							defaultProps: {},
							propsSchema: { type: 'object', properties: {}, additionalProperties: false },
							schemaSource: 'inferred',
							thumbnailFrame: Math.floor((frames - 1) / 2),
						},
					],
					html: { entry, query },
				},
			};
		},
		mediaTranscribe: ({ params }) =>
			jobView(
				newJob(
					'transcription',
					`Transcribe ${params?.key}`,
					1,
					TranscriptionResultSchema.parse({
						target: { type: 'media', mediaKey: params?.key ?? '', streamIndex: 1 },
						model: 'whisper-base',
						language: 'en',
						languageProbability: 0.98,
						task: 'transcribe',
						duration: 20 * S,
						words: say('This is where we build every prototype by hand.', 2),
						speakers: {},
						segments: [],
						timings: { decodeMs: 100, loadMs: 100, transcribeMs: 900 },
					}),
				),
			),
		speechModels: () => ({
			models: [{ id: 'whisper-base', label: 'Whisper base', installed: true, sizeBytes: 150_000_000 }],
		}),
		sequenceRangeAudio: ({ body }) => {
			const { startFrame, endFrame } = body as unknown as { startFrame: number; endFrame: number };
			const frameCount = Math.round(((endFrame - startFrame) / 30) * 100);
			return {
				start: startFrame / 30,
				end: endFrame / 30,
				frameSec: 0.01,
				frameCount,
				level: Buffer.alloc(frameCount, 120).toString('base64'),
				classes: Buffer.alloc(frameCount, 2).toString('base64'),
				source: 'mix',
				streamIndex: null,
				levels: { floorDb: -60, speechDb: -20, speechThresholdDb: -40 },
			};
		},
		mediaFrames: ({ params, body }) => {
			const { times, width } = body as unknown as { times: number[]; width: number };
			const height = Math.max(16, Math.round((width * 9) / 16));
			const png = greyPng(width, height).toString('base64');
			return {
				mediaKey: params?.mediaKey ?? '',
				durationSec: 40,
				frames: times.map((time) => ({ time, at: time, width, height, png })),
			};
		},
		titleLooksList: () => TitleLookLibraryResponseSchema.parse({ revision: 0, readOnly: false, looks: [] }),
		layerStylesRead: (opts) => {
			const { name } = LayerStyleReadQuerySchema.parse((opts as { query?: unknown }).query);
			return LayerStyleFileSchema.parse({ fileName: name, ...STYLE_FILE });
		},
		splitImageAnalyze: ({ params }) => {
			if (params?.key !== LOGO.key)
				throw new EngineError('NOT_FOUND', `No still ${params?.key} in the store`, { status: 404 });
			const job = newJob('split-image', 'Analyse logo.png', 1, null);
			job.result = SplitImageAnalysisSchema.parse({
				width: LOGO.width,
				height: LOGO.height,
				cell: 1,
				cols: LOGO.width,
				rows: LOGO.height,
				bitDepth: 8,
				islands: LOGO_ISLANDS,
				labelMapUrl: `/renders/${job.id}/labels`,
			});
			return jobView(job);
		},
		splitImage: ({ params, body: raw }) => {
			const req = body(SplitImageRequestSchema, raw);
			if (params?.key !== LOGO.key)
				throw new EngineError('NOT_FOUND', `No still ${params?.key} in the store`, { status: 404 });
			const job = newJob('split-image', `Split logo.png into ${req.groups.length}`, 1, null);
			job.result = SplitImageResultSchema.parse({
				parts: req.groups.map((group, i) => {
					const boxes = group.map((k) => LOGO_ISLANDS[k]!);
					const x = Math.min(...boxes.map((b) => b.x0));
					const y = Math.min(...boxes.map((b) => b.y0));
					const w = Math.max(...boxes.map((b) => b.x1)) - x;
					const h = Math.max(...boxes.map((b) => b.y1)) - y;
					const key = `mk_logo_part_${i + 1}`;
					return {
						media: {
							...imageAsset(key, `logo part ${i + 1}.png`, w, h),
							mediaKey: key,
							locators: [],
							browserPlayable: 'yes',
						},
						box: { x, y, w, h },
					};
				}),
			});
			return jobView(job);
		},
		psdPlan: ({ body: raw }) => psdPlan(body(PsdRequestSchema, raw)),
		psdExport: ({ body: raw }) => {
			const req = body(PsdRequestSchema, raw);
			const plan = psdPlan(req);
			if (plan.blockers.length)
				throw new EngineError('PSD_BLOCKED', plan.blockers[0]!.message, { status: 409 });
			const job = newJob('psd-export', `PSD of frame ${req.frame}`, 1, null);
			job.result = PsdResultSchema.parse({
				url: `/renders/${job.id}/output`,
				...(req.destination ? { path: `${req.destination.folder}/${req.destination.name}.psd` } : {}),
				bytes: plan.estimate.bytes,
				width: plan.width,
				height: plan.height,
				layers: plan.layers,
				baked: plan.baked,
				warnings: plan.warnings,
			});
			return jobView(job);
		},
		alphaDelivery: ({ body: raw }) => {
			const req = body(AlphaDeliveryRequestSchema, raw);
			const { seq } = framed(req.envelope, req.sequenceId);
			const frames = req.range.end - req.range.start;
			const title = req.clipIds ? 'Export Title' : frames === 1 ? `Frame ${req.range.start}` : 'PNG sequence';
			// Trimmed to what the titles paint: the boxes of the fake's pictures, grown by the margin.
			const painted = (Object.values(seq.clips) as Clip[]).filter(
				(c) => isTitleClip(c) && (!req.clipIds || req.clipIds.includes(c.id)),
			);
			const m = req.trim?.marginPx ?? 0;
			const boxes = painted.map((c) => titleBox(seq, c));
			const x0 = Math.min(...boxes.map((b) => b.x));
			const y0 = Math.min(...boxes.map((b) => b.y));
			const area =
				req.trim && boxes.length
					? {
							x: x0 - m,
							y: y0 - m,
							w: Math.max(...boxes.map((b) => b.x + b.w)) - x0 + 2 * m,
							h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 + 2 * m,
						}
					: { x: 0, y: 0, w: seq.settings.width, h: seq.settings.height };
			const job = newJob('alpha-delivery', title, 1, null);
			const format = frames === 1 ? 'png' : 'zip';
			const dest = req.destination;
			job.result = AlphaDeliveryResultSchema.parse({
				url: `/renders/${job.id}/output`,
				format,
				frames,
				width: area.w,
				height: area.h,
				origin: { x: area.x, y: area.y },
				...(dest ? { path: `${dest.folder}/${dest.name}${format === 'png' ? '.png' : ''}` } : {}),
				warnings: [],
			});
			return jobView(job);
		},
		gamutCheck: ({ body: raw }) => {
			const req = body(GamutCheckRequestSchema, raw);
			const { seq } = framed(req.envelope, req.sequenceId);
			const output =
				!req.output || req.output === 'working' ? sequenceColorInfo(seq.settings as never).space : req.output;
			const job = newJob('gamut-check', `Gamut check of frame ${req.frame}`, 1, null);
			// Grey footage and light titles: inside every video gamut, a sliver over the legal range at the title's edge.
			job.result = GamutCheckResultSchema.parse({
				frame: req.frame,
				output,
				outputLabel: colorSpace(output)?.label ?? output,
				width: seq.settings.width,
				height: seq.settings.height,
				gamutPercent: 0,
				legalPercent: 0.4,
				anyPercent: 0.4,
				maskUrl: `/renders/${job.id}/output`,
			});
			return jobView(job);
		},
		mediaRangeAudio: ({ body }) => {
			const { start, end } = body as unknown as { start: number; end: number };
			const frameCount = Math.round((end - start) * 100);
			return {
				start,
				end,
				frameSec: 0.01,
				frameCount,
				level: Buffer.alloc(frameCount, 120).toString('base64'),
				classes: Buffer.alloc(frameCount, 2).toString('base64'),
				source: 'voice-analysis',
				streamIndex: 1,
				levels: { floorDb: -60, speechDb: -20, speechThresholdDb: -40 },
			};
		},
	};

	const methods: Record<string, (...args: never[]) => unknown> = {
		/** Fix Transcript: a finished job; nothing to fix or rewrite (no proposal), the report for the mode asked. */
		transcriptFix: (projectId: string, sequenceId: string, body: { mode?: string; offScript?: string }) => {
			const p = project(projectId);
			const t = Object.values(p.doc.transcripts)[0];
			const mode = body.mode === 'dryRun' || body.mode === 'rebuild' ? body.mode : 'propose';
			const report = {
				settings: { sources: ['script'], scope: 'recordings', strictness: 'standard', showRejected: false },
				sourcesUsed: ['script'],
				perMedia: t
					? [
							{
								mediaId: t.mediaId ?? 'med_a',
								transcriptId: t.id,
								name: 'interview-a.mp4',
								language: t.language,
								words: t.words.length,
								wordsInScope: t.words.length,
								alignment: null,
								candidates: 0,
								windows: 0,
								readings: 0,
							},
						]
					: [],
				candidates: { total: 0, byGroup: {}, byCategory: {}, byKind: {} },
				decisions: [],
				decisionsTruncated: false,
				skipped: {},
				unusedLines: [],
				patch: { edits: 0, patched: 0, skipped: [], stale: 0 },
				speech: { model: 'whisper-base' },
				device: null,
				timings: { readMs: 1, alignMs: 1, scoreMs: 0, decideMs: 0, totalMs: 2, speechSeconds: 30 },
				...(mode === 'rebuild'
					? {
							rebuild: {
								offScript: body.offScript === 'keep' ? 'keep' : 'drop',
								spans: 2,
								changedSpans: 0,
								seconds: 30,
								heardWords: 40,
								writtenWords: 40,
								counts: { exact: 40 },
								offScriptSpans: 0,
								silentSpans: 0,
								unwritableSpans: 0,
								model: 'whisper-base',
							},
						}
					: {}),
				warnings: [],
			};
			const result = TranscriptFixResultSchema.parse({
				mode,
				projectId,
				sequenceId,
				proposalId: null,
				itemCount: 0,
				revision: p.revision,
				report,
			});
			return jobView(newJob('transcript-fix', 'Fix Transcript', 1, result));
		},
		capabilities: () => ({
			engine: { version: 'eval' },
			render: { native: true, remotionLocal: true, fframes: true },
			media: { encoding: { export: { label: 'H.264 (software)' } } },
		}),
		listProjects: () => ({
			projects: [...projects.entries()].map(([projectId, p]) => ({
				projectId,
				name: p.name,
				modifiedAt: NOW,
				createdAt: NOW,
			})),
		}),
		createProject: (req: { name: string; preset: string }) => {
			const projectId = newProject(req.name, req.preset);
			return { projectId };
		},
		agentOpenProject: (req: { projectId: string }) => {
			project(req.projectId);
			opened.add(req.projectId);
			return { projectId: req.projectId, path: `/projects/${req.projectId}`, editors: 1, live: true };
		},
		agentSchema: () => ({ ...exportAgentSchema(registries), queries: exportAgentQuerySchemas() }),
		agentQuery: (req: { projectId: string; query: string; args?: unknown }) => {
			const p = project(req.projectId);
			return {
				result: runAgentQuery(
					{ doc: p.doc, revision: p.revision, effects: registries.effects },
					req.query,
					req.args ?? {},
				),
				revision: p.revision,
				via: opened.has(req.projectId) ? 'session' : 'headless',
			};
		},
		agentTx: (req: { projectId: string; transaction: Record<string, unknown> }) => {
			const commands = (req.transaction.commands ?? []) as { type?: string }[];
			for (const c of commands) {
				const f = c.type ? fault(`tx:${c.type}`) : undefined;
				if (f?.error)
					return {
						appliedBy: 'headless',
						result: {
							ok: false,
							revision: project(req.projectId).revision,
							errors: [{ commandIndex: 0, code: f.error.code, message: f.error.message }],
						},
					};
			}
			const p = project(req.projectId);
			const agent = normalizeAgentTransaction(req.transaction as never).origin.agent;
			const kind =
				commands[0]?.type === 'history.undo' ? 'undo' : commands[0]?.type === 'history.redo' ? 'redo' : null;
			if (kind && commands.length === 1) {
				// As the real engine without an editor session: the agent's own headless steps while nothing else changed.
				const h = history.get(req.projectId);
				const entry = h?.[kind].at(-1);
				const refuse = (code: string, message: string) => ({
					appliedBy: 'headless' as const,
					result: { ok: false, revision: p.revision, errors: [{ commandIndex: -1, code, message }] },
				});
				if (!h || !entry) return refuse('E_NOT_FOUND', `Nothing to ${kind}`);
				if (entry.agent !== agent) return refuse('E_NOT_OWNER', `The history entry was not made by ${agent}`);
				if (h.revision !== p.revision) return refuse('E_NOT_OWNER', 'The project was changed after it');
				const from = p.doc;
				p.doc = kind === 'undo' ? entry.before : entry.after;
				p.revision++;
				h[kind].pop();
				h[kind === 'undo' ? 'redo' : 'undo'].push(entry);
				h.revision = p.revision;
				const diff = diffDocuments(from, p.doc);
				return {
					appliedBy: 'headless',
					result: {
						ok: true,
						revision: p.revision,
						refs: {},
						...diff,
						warnings: [],
						results: [{ [`history.${kind}`]: entry.label }],
					},
				};
			}
			const [before, base] = [p.doc, p.revision];
			const result = applyTo(req.projectId, req.transaction);
			if (result.ok && p.doc !== before) {
				const h = history.get(req.projectId);
				const undo = h && h.revision === base ? h.undo : [];
				const label = String(req.transaction.label ?? '');
				undo.push({
					agent,
					label: label.startsWith('Agent: ') ? label : `Agent: ${label}`,
					before,
					after: p.doc,
				});
				history.set(req.projectId, { revision: p.revision, undo, redo: [] });
			}
			return { result, appliedBy: 'headless' };
		},
		registerMedia: (req: { paths: string[] }) => ({
			items: req.paths.map((path) => {
				const name = path.split('/').at(-1) ?? path;
				const key = `mk_${name.replace(/[^a-z0-9]/gi, '')}`;
				return {
					mediaKey: key,
					kind: 'video',
					fingerprint: `q1:${key.padStart(64, '0')}`,
					originalName: name,
					sizeBytes: 1,
					container: 'mov,mp4',
					probe: probe(30, true, true),
					locators: [{ type: 'path', path, relativeToProject: null }],
					browserPlayable: 'yes',
				};
			}),
			errors: [],
		}),
		mediaStatus: () => ({ status: 'ready' }),
		mgTemplates: () => ({
			templates: mgRegistry.catalogJson().map((d) => ({ ...d, native: false })),
			renderer: { status: 'unavailable', reason: 'eval: no native renderer' },
		}),
		// Clean Up: the real detector and planner on the project's document, in word mode (the fake has no audio: every
		// media is a voice analysis `missing`)
		analyzeCleanup: (req: {
			projectId: string;
			sequenceId?: string;
			document?: unknown;
			clipIds?: string[];
			range?: { from: number; to: number };
			presetId?: string;
			overrides?: Parameters<typeof mergeCleanupSettings>[1];
			script?: string | null;
			language?: string;
			decisions?: Parameters<typeof analyzeSequenceCleanup>[0]['decisions'];
		}) => {
			const p = project(req.projectId);
			const sent = req.document as { document?: ProjectDocument } | ProjectDocument | undefined;
			const doc = sent
				? ((sent as { document?: ProjectDocument }).document ?? (sent as ProjectDocument))
				: p.doc;
			const seq = doc.sequences[req.sequenceId ?? Object.keys(doc.sequences)[0]!];
			if (!seq) throw new EngineError('SEQUENCE_NOT_FOUND', `No sequence ${req.sequenceId}`, { status: 404 });
			const base = builtinCleanupSettings(req.presetId) ?? sequenceCleanupSettings(seq);
			const a = analyzeSequenceCleanup({
				doc,
				seq,
				voice: () => null,
				settings: mergeCleanupSettings(base, req.overrides),
				...(req.script !== undefined ? { script: req.script } : {}),
				...(req.language ? { language: req.language } : {}),
				...(req.decisions ? { decisions: req.decisions } : {}),
				scope: {
					...(req.clipIds ? { clipIds: req.clipIds } : {}),
					...(req.range ? { range: req.range } : {}),
				},
			});
			if (!a.ok)
				return jobView(
					newJob('cleanup-analysis', 'Clean Up analysis', 0, null, { code: a.code, message: a.message }),
				);
			const analysisId = `cla_${String(cleanups.size + 1).padStart(4, '0')}`;
			cleanups.set(analysisId, { projectId: req.projectId, sequenceId: seq.id, analysis: a, sent: !!sent });
			const byKind: Record<string, number> = {};
			for (const f of a.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
			return jobView(
				newJob('cleanup-analysis', 'Clean Up analysis', 0, {
					analysisId,
					url: `/api/cleanup/analyses/${analysisId}`,
					projectId: req.projectId,
					sequenceId: seq.id,
					findings: a.findings.length,
					byKind,
					groups: a.groups.length,
					ranges: a.plan.ranges.length,
					stats: a.plan.stats,
					voice: {
						cached: [],
						analysed: [],
						missing: a.media.map((m) => ({ mediaId: m.mediaId, reason: 'eval: no audio' })),
					},
					elapsedMs: 1,
				}),
			);
		},
		getCleanupAnalysis: (analysisId: string) => {
			const c = cleanups.get(analysisId);
			if (!c)
				throw new EngineError('CLEANUP_ANALYSIS_NOT_FOUND', `No analysis ${analysisId}`, { status: 404 });
			return {
				format: 'jasper-cleanup-analysis',
				version: 1,
				analysisId,
				projectId: c.projectId,
				sequenceId: c.sequenceId,
				revision: c.sent ? -1 : project(c.projectId).revision,
				createdAt: NOW,
				analysis: c.analysis,
			};
		},
		listJobs: () => ({ jobs: [...jobs.values()].reverse().map(jobView) }),
		getJob: (id: string) => {
			const job = jobs.get(id);
			if (!job) throw new EngineError('NOT_FOUND', `No job ${id}`, { status: 404 });
			job.polls--;
			return jobView(job);
		},
		cancelJob: (id: string) => {
			const job = jobs.get(id);
			if (!job) throw new EngineError('NOT_FOUND', `No job ${id}`, { status: 404 });
			return { ...jobView(job), state: 'cancelled' };
		},
		planExport: () => ({
			planId: 'plan_1',
			path: 'native',
			blockers: [],
			warnings: [],
			audio: {},
		}),
		startExport: (req: {
			settings?: {
				outputPath?: string;
				format?: string;
				destination?: { type: string; path?: string; overwrite?: boolean };
				videoOnly?: boolean;
			};
		}) => {
			const dest = req.settings?.destination;
			const asked = dest?.type === 'path' ? dest.path : undefined;
			const kept = !!asked && setup.outputExists && !dest?.overwrite;
			const path = kept
				? asked.replace(/(\.[^./]+)?$/, (ext) => ` (2)${ext}`)
				: (asked ?? req.settings?.outputPath ?? `/home/user/exports/cut.${req.settings?.format ?? 'mp4'}`);
			const job = newJob('export', 'Export', setup.exportPolls ?? 1, {
				path,
				...(kept ? { requestedPath: asked } : {}),
				...(asked && setup.outputExists && dest?.overwrite ? { replaced: true } : {}),
				sizeBytes: 48_000_000,
			});
			if (req.settings?.videoOnly) pictureOnly.add(job.id);
			return jobView(job);
		},
		deriveMedia: (key: string, req: { recipe: { op: string; format?: string } }) => {
			const { recipe } = req;
			const name = `derived-${recipe.op}.${recipe.format ?? 'wav'}`;
			return jobView(
				newJob('derive', 'Derive media', 1, {
					registered: {
						mediaKey: `mk_${recipe.op}`,
						kind: 'audio',
						fingerprint: `q1:${recipe.op.padStart(64, '0')}`,
						originalName: name,
						sizeBytes: 1,
						container: 'wav',
						probe: probe(40, true, false),
						locators: [{ type: 'path', path: `/home/user/derived/${name}`, relativeToProject: null }],
						browserPlayable: 'yes',
					},
					fromMediaKey: key,
					recipe,
					recipeVersion: 1,
					recipeHash: `hash_${recipe.op}`,
					reused: false,
					notes: [],
				}),
			);
		},
		analyzeAudio: (_req: unknown, wait?: boolean) => {
			const polls = setup.analysisPolls ?? 0;
			if (wait && polls > 0)
				throw new EngineRequestAborted('timeout', 'The engine did not answer within 180 s');
			return jobView(
				newJob(
					'audio-analyze',
					'Measure loudness',
					polls,
					AudioAnalyzeResultSchema.parse({
						sampleRate: 48000,
						range: { startFrame: 0, endFrame: 1200 },
						loudness: LOUDNESS,
						mixHash: 'mix_1',
					}),
				),
			);
		},
		verifyExport: (exportId: string, req: { checks?: 'fast' | 'full'; target?: string } = {}) =>
			jobView(newJob('export-verify', 'Verify', 1, verifyResult(exportId, req.checks ?? 'full', req.target))),
		/** The frame as `rasterFrame` draws it (black where no shown track has a picture). */
		requestStill: (req: {
			envelope: { document: unknown };
			sequenceId: string;
			frame: number;
			width?: number;
		}) => {
			const job = newJob('still', 'Still', 1, null);
			const url = `/stills/${job.id}.png`;
			const doc = req.envelope.document as unknown as ProjectDocument;
			files.set(url, rasterFrame(doc, req.sequenceId, req.frame, req.width ?? 640).png);
			job.result = { url };
			return jobView(job);
		},
		/** The grey footage everywhere: every channel at 96/255, nothing clipped. */
		gradingScopes: (raw: unknown) => {
			const req = body(GradingScopesRequestSchema, raw);
			const v = Math.round((96 / 255) * 1000) / 10;
			const level = { min: v, max: v, mean: v };
			const columns = req.columns ?? 8;
			const traces = (keys: string[]) =>
				Object.fromEntries(keys.map((k) => [k, Array.from({ length: columns }, () => level)]));
			return GradingScopesResponseSchema.parse({
				sequenceId: req.sequenceId,
				frame: req.frame,
				...(req.clipId ? { clipId: req.clipId } : {}),
				renderPath: 'native',
				samples: [480, 270],
				matrix: req.matrix ?? 'bt709',
				clamp: req.clamp ?? true,
				unit: '%',
				stats: {
					r: level,
					g: level,
					b: level,
					y: level,
					chromaMean: [0, 0],
					hueDeg: 0,
					saturation: 0,
					clipLow: [0, 0, 0, 0],
					clipHigh: [0, 0, 0, 0],
					samples: 480 * 270,
				},
				waveform: { type: req.waveformType ?? 'rgb', lo: v, hi: v, columns, traces: traces(['r', 'g', 'b']) },
			});
		},
		/** Auto Tone of the grey footage (96/255 everywhere) by the real solver, with the requested intent. */
		gradingAutoTone: (raw: unknown) => {
			const req = body(AutoToneRequestSchema, raw);
			const grey = { w: 16, h: 9, rgb: new Float32Array(16 * 9 * 3).fill(96 / 255) };
			const r = autoTone(grey, {}, req.intent ? { intent: req.intent } : {});
			const { before, after, ...params } = r;
			return AutoToneResponseSchema.parse({ clipId: req.clipId, effectId: null, params, before, after });
		},
		/** TL-103: every cell drawn by `rasterFrame`, served at `/renders/<job>/cells/<n>` like the engine's. */
		requestStillSheet: (raw: unknown) => {
			const req = body(StillSheetRequestSchema, raw);
			const job = newJob('still-sheet', `Sheet of ${req.cells.length} frames`, 1, null);
			const cells = req.cells.map((c, index) => {
				const doc = req.documents[c.document]!.document as unknown as ProjectDocument;
				const seq = doc.sequences?.[c.sequenceId] as Sequence | undefined;
				if (!seq)
					throw new EngineError('VALIDATION_FAILED', `cell ${index}: no sequence ${c.sequenceId}`, {
						status: 400,
					});
				const url = `/renders/${job.id}/cells/${index}`;
				files.set(url, rasterFrame(doc, c.sequenceId, c.frame, req.width ?? seq.settings.width, c.hide).png);
				return {
					index,
					url,
					document: c.document,
					sequenceId: c.sequenceId,
					frame: c.frame,
					...(c.tag ? { tag: c.tag } : {}),
					renderPath: 'native',
				};
			});
			job.result = StillSheetResultSchema.parse({ cells, ...(req.meta ? { meta: req.meta } : {}) });
			return jobView(job);
		},
		listFonts: () => fontCatalog(),
		fetchBytes: (url: string) => ({
			bytes: new Uint8Array(files.get(url) ?? greyPng(64, 36)),
			contentType: 'image/png',
		}),
		createProposal: (projectId: string, req: Record<string, unknown>) => {
			const p = project(projectId);
			const { allOrNothing, expectedRevision, author: _author, ...draft } = req;
			if (typeof expectedRevision === 'number' && expectedRevision !== p.revision)
				throw new EngineError('REVISION_CONFLICT', `Revision ${expectedRevision} is stale`, {
					status: 409,
					detail: { code: 'E_REVISION_MISMATCH', revision: p.revision },
				});
			const ctx = { registries, now: () => NOW, revision: p.revision };
			const r = createProposal(
				p.doc,
				draft as never,
				{
					id: `prp_${String(++proposalN).padStart(16, '0')}`,
					projectId,
					author: { agent: 'eval' },
					now: NOW,
					revision: p.revision,
				},
				ctx,
			);
			if (!r.ok)
				throw new EngineError('VALIDATION_FAILED', `The proposal is malformed: ${r.errors[0]!.message}`, {
					status: 400,
					detail: { code: r.errors[0]!.code, errors: r.errors },
				});
			const failures = allOrNothing ? proposalItemFailures(p.doc, r.proposal, ctx) : [];
			if (failures.length)
				throw new EngineError('PROPOSAL_INVALID', `Nothing was stored: ${failures.length} items fail`, {
					status: 422,
					detail: { code: 'E_PROPOSAL_INVALID', items: failures, revision: p.revision },
				});
			proposals.set(r.proposal.id, r.proposal);
			return {
				proposal: r.proposal,
				revision: p.revision,
				evicted: [],
				expiresAt: '2026-12-02T10:00:00.000Z',
			};
		},
		/** An automation pass planned by the real planners, without sounds (the eval has no sound library). */
		automationPass: (
			projectId: string,
			pass: AutomationPass,
			body: { sequenceId?: string; mode?: 'propose' | 'dryRun'; params?: Record<string, unknown> },
		) => {
			const p = project(projectId);
			let plan: ReturnType<typeof planPass>;
			try {
				plan = planPass(p.doc, pass, body.sequenceId, body.params ?? {}, {});
			} catch (e) {
				if (e instanceof AutomationInputError)
					throw new EngineError('VALIDATION_FAILED', e.message, { status: 400, detail: { code: e.code } });
				throw e;
			}
			const items = passItems(p.doc, plan);
			const summary = passSummary(plan, items);
			const mode = body.mode ?? 'propose';
			const base = {
				mode,
				pass,
				projectId,
				sequenceId: plan.sequenceId,
				summary,
				sfx: null,
				budget: { fits: true, items: items.items.length, commands: items.items.length },
				invalid: [],
				warnings: summary.warnings,
			};
			if (mode === 'dryRun')
				return { ...base, proposalId: null, revision: p.revision, itemCount: items.items.length };
			const draft = passDraft(plan, items, body.params ?? {});
			const stored = draft
				? (methods.createProposal as (id: string, req: Record<string, unknown>) => { proposal: Proposal })(
						projectId,
						draft as unknown as Record<string, unknown>,
					)
				: null;
			const result = {
				...base,
				proposalId: stored?.proposal.id ?? null,
				revision: p.revision,
				itemCount: stored?.proposal.items.length ?? 0,
			};
			return jobView(newJob('edit-automation', `Automation: ${pass}`, 0, result));
		},
		getProposal: (projectId: string, proposalId: string) => {
			const proposal = reviewedProposal(proposalId);
			const answer = {
				proposal,
				revision: project(projectId).revision,
				expiresAt: '2026-12-02T10:00:00.000Z',
			};
			decide(proposalId);
			return answer;
		},
		listProposals: () => ({ proposals: [], warnings: [] }),
		proposalFeatures: () => ({ features: [] }),
		call: (name: string, opts: { params?: Record<string, string>; body?: never } = {}) => {
			const f = fault(`call:${name}`);
			if (f?.error) refuse(f);
			if (f && 'result' in f) return f.result;
			const route = routes[name];
			if (route) return route(opts);
			unmodelled.push(`call:${name}`);
			throw new EngineError('NOT_IMPLEMENTED', `The eval's engine has no route ${name}`, { status: 501 });
		},
	};

	const client = new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop !== 'string' || prop === 'then') return undefined;
				return async (...args: never[]) => {
					const f = fault(prop);
					if (f?.error) refuse(f);
					if (f && 'result' in f) return f.result;
					const method = methods[prop];
					if (f?.abort) {
						if (f.afterApply) await method?.(...args);
						throw new EngineRequestAborted(
							f.abort,
							f.abort === 'timeout'
								? 'The engine accepted the request but did not answer in time'
								: 'The connection to the engine was lost',
						);
					}
					if (method) return method(...args);
					unmodelled.push(prop);
					throw new EngineError('NOT_IMPLEMENTED', `The eval's engine has no ${prop}`, { status: 501 });
				};
			},
		},
	);
	if (setup.pastExport)
		newJob('export', 'Export – Sequence 1', 0, { path: setup.pastExport, sizeBytes: 48_000_000 });
	if (setup.pendingTranscription) {
		const view = routes.mediaTranscribe!({ params: { key: 'mk_c' } }) as { id: string };
		jobs.get(view.id)!.polls = setup.pendingTranscription.polls;
		vars.pendingJob = view.id;
	}
	return { client, vars, takeUnmodelled: () => unmodelled.splice(0) };
}
