// Agent queries (S01 §21.2, S02:TL-951, ARCHITECTURE §11 Stage 1): read-only JSON views of a document,
// shared by the in-page bridge (with session state) and the engine's headless path (document only).
// Frames are integers and are always accompanied by timecode strings for LLM readability (TL-951).
import { z } from 'zod';
import type { TransactionResult } from '../commands/types.ts';
import { clipsInRange, linkedPartners, sequenceDuration, sourceOut, trackLabel } from '../derive/index.ts';
import { checkInvariants } from '../invariants.ts';
import { evaluate } from '../keyframes.ts';
import type { EffectRegistry } from '../registry/effects.ts';
import { clipContentTime, resolveSceneAt } from '../render/scene.ts';
import { buildRenderSnapshot, type MediaHandle } from '../render/snapshot.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import { flicksToSeconds, fpsOf, type Rational } from '../time.ts';
import { formatTimecode } from '../timecode.ts';
import { AddressError, pickSequence, resolveFrameInput } from './addressing.ts';

export class AgentQueryError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM' | 'E_AMBIGUOUS' | 'E_NO_SESSION' | 'E_NOT_IMPLEMENTED',
		message: string,
	) {
		super(message);
		this.name = 'AgentQueryError';
	}
}

const TimeArg = z.union([
	z.number().int(),
	z.object({ frames: z.number().int() }),
	z.object({ seconds: z.number() }),
	z.string(),
]);

/** Argument schemas of every Stage 1 query (exported as JSON Schema by `GET /api/agent/schema`). */
export const AGENT_QUERY_ARGS = {
	'doc.get': z.object({
		path: z.array(z.string()).optional().describe('Subtree path, e.g. ["sequences", "seq_…"]'),
		fields: z.array(z.string()).optional().describe('Keep only these keys of the returned object'),
	}),
	'doc.revision': z.object({}),
	'sequence.summary': z.object({ sequenceId: z.string().optional() }),
	'sequence.clipsInRange': z.object({
		sequenceId: z.string().optional(),
		from: TimeArg.describe('Start frame (inclusive): frames, {frames}, {seconds} or timecode'),
		to: TimeArg.describe('End frame (exclusive)'),
		tracks: z.array(z.string()).optional().describe('Track ids or labels ("V1", "A2"); default all'),
	}),
	'sequence.at': z.object({ sequenceId: z.string().optional(), frame: TimeArg }),
	'media.list': z.object({}),
	'selection.get': z.object({}),
	'playhead.get': z.object({}),
	'history.list': z.object({}),
	validate: z.object({
		transaction: z.record(z.string(), z.unknown()).optional().describe('Dry-run this transaction'),
	}),
	'frame.capture': z.object({
		sequenceId: z.string().optional(),
		frame: TimeArg,
		width: z.number().int().positive().max(1280).optional(),
	}),
} as const;
export type AgentQuery = keyof typeof AGENT_QUERY_ARGS;
export const AGENT_QUERY_NAMES = Object.keys(AGENT_QUERY_ARGS) as AgentQuery[];

export const AGENT_QUERY_DESCRIPTIONS: Record<AgentQuery, string> = {
	'doc.get': 'The whole document or a subtree by path, with an optional fields projection.',
	'doc.revision': 'The current document revision.',
	'sequence.summary': 'Settings, duration, tracks (label, kind, lock, mute…), clip counts, markers, In/Out.',
	'sequence.clipsInRange': 'Clips intersecting [from, to) with timing, source range in seconds, links.',
	'sequence.at': 'The evaluated visual stack (bottom→top) and audible clips at a frame.',
	'media.list': 'Media assets with probe summaries, project item names, usage and runtime status.',
	'selection.get': 'The editor selection (needs an open session).',
	'playhead.get': 'The playhead of the active sequence (needs an open session).',
	'history.list': 'Undo history entries with labels, origins and revisions (needs an open session).',
	validate: 'The invariant report of the document, or the dry-run result of a transaction.',
	'frame.capture': 'A PNG still of the Program output at a frame (engine /api/stills; max 1280 px).',
};

/** Queries that need an editor session (no headless answer). */
export const SESSION_ONLY_QUERIES: ReadonlySet<AgentQuery> = new Set([
	'selection.get',
	'playhead.get',
	'history.list',
]);

export type AgentHistoryEntry = {
	label: string;
	origin: unknown;
	time: number;
	revisionBefore: number;
	revisionAfter: number;
	created: string[];
	changed: string[];
	deleted: string[];
};

/** What a query sees. `session` is absent in headless mode. */
export type AgentQueryEnv = {
	doc: ProjectDocument;
	revision: number;
	effects?: EffectRegistry;
	/** Dry-runs a transaction against `doc` (the `validate` query). */
	dryRun?(tx: Record<string, unknown>): TransactionResult;
	session?: {
		activeSequenceId: string | null;
		selection(): unknown;
		playhead(): { frame: number; playing: boolean };
		history(): { entries: AgentHistoryEntry[]; position: number };
		mediaRuntime?(mediaId: string): unknown;
	};
};

// ---------------------------------------------------------------- helpers

export function sequenceTimecode(seq: Sequence, frame: number): string {
	return formatTimecode(frame, seq.settings.frameRate as Rational, {
		dropFrame: seq.settings.dropFrame,
		startFrames: seq.settings.startTimecodeFrames,
	});
}

const frameInfo = (seq: Sequence, frame: number) => ({ frame, timecode: sequenceTimecode(seq, frame) });

function sequenceName(doc: ProjectDocument, seqId: string): string {
	for (const item of Object.values(doc.items))
		if (item.kind === 'sequence' && item.sequenceId === seqId) return item.name;
	return seqId;
}

function allTracksOf(seq: Sequence): Track[] {
	return [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks];
}

function wrap<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof AddressError) throw new AgentQueryError(e.code, e.message);
		throw e;
	}
}

function rate(seq: Sequence): Rational {
	return seq.settings.frameRate as Rational;
}

function clipSource(clip: Clip): Record<string, unknown> {
	const c = clip as Record<string, unknown>;
	if (typeof c.mediaId === 'string') return { mediaId: c.mediaId };
	if (clip.kind === 'text') return { text: (c.content as { text?: string })?.text ?? '' };
	if (clip.kind === 'motion-graphic') return { template: c.template, params: c.params };
	if (typeof c.syntheticId === 'string') return { syntheticId: c.syntheticId };
	if (typeof c.sequenceId === 'string') return { sequenceId: c.sequenceId };
	return {};
}

function clipRow(seq: Sequence, clip: Clip) {
	const r = rate(seq);
	return {
		id: clip.id,
		kind: clip.kind,
		name: clip.name,
		trackId: clip.trackId,
		track: trackLabel(seq, clip.trackId),
		start: clip.start,
		end: clip.start + clip.duration,
		duration: clip.duration,
		startTimecode: sequenceTimecode(seq, clip.start),
		endTimecode: sequenceTimecode(seq, clip.start + clip.duration),
		durationSeconds: round3((clip.duration * r.den) / r.num),
		source: {
			...clipSource(clip),
			inSeconds: round3(flicksToSeconds(clip.sourceIn)),
			outSeconds: round3(flicksToSeconds(sourceOut(clip, r))),
		},
		speed: clip.speed.rate,
		reverse: clip.speed.reverse,
		enabled: clip.enabled,
		linked: linkedPartners(seq, clip.id).map((p) => p.id),
	};
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function pick(v: unknown, fields: readonly string[]): unknown {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
	const o = v as Record<string, unknown>;
	return Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
}

function stubMediaHandle(asset: MediaAsset): MediaHandle {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	return {
		url: '',
		proxyUrl: null,
		kind: asset.kind,
		width: vs && vs.type === 'video' ? vs.width : null,
		height: vs && vs.type === 'video' ? vs.height : null,
		durationFlicks: asset.probe.durationFlicks,
		hasAudio: asset.probe.streams.some((s) => s.type === 'audio'),
		rotation: asset.probe.rotationDegrees,
	};
}

// ---------------------------------------------------------------- queries

function docGet(env: AgentQueryEnv, args: z.infer<(typeof AGENT_QUERY_ARGS)['doc.get']>) {
	let v: unknown = env.doc;
	for (const seg of args.path ?? []) {
		if (v && typeof v === 'object' && seg in (v as object)) v = (v as Record<string, unknown>)[seg];
		else throw new AgentQueryError('E_NOT_FOUND', `No such path: ${(args.path ?? []).join('/')}`);
	}
	return args.fields?.length ? pick(v, args.fields) : v;
}

function sequenceSummary(env: AgentQueryEnv, args: { sequenceId?: string }) {
	const seq = wrap(() => pickSequence(env.doc, args.sequenceId, env.session?.activeSequenceId));
	const r = rate(seq);
	const duration = sequenceDuration(seq);
	const clips = Object.values(seq.clips);
	return {
		sequenceId: seq.id,
		name: sequenceName(env.doc, seq.id),
		settings: {
			width: seq.settings.width,
			height: seq.settings.height,
			frameRate: r,
			fps: round3(fpsOf(r)),
			dropFrame: seq.settings.dropFrame,
			startTimecode: sequenceTimecode(seq, 0),
		},
		duration: {
			frames: duration,
			timecode: sequenceTimecode(seq, duration),
			seconds: round3((duration * r.den) / r.num),
		},
		tracks: allTracksOf(seq).map((t) => ({
			id: t.id,
			label: trackLabel(seq, t.id),
			kind: t.kind,
			name: t.name,
			locked: t.locked,
			syncLock: t.syncLock,
			output: t.output ?? true,
			mute: t.mute ?? false,
			solo: t.solo ?? false,
			clipCount: clips.filter((c) => c.trackId === t.id).length,
		})),
		clipCount: clips.length,
		clipKinds: clips.reduce<Record<string, number>>((m, c) => {
			m[c.kind] = (m[c.kind] ?? 0) + 1;
			return m;
		}, {}),
		markers: seq.markers.map((m) => ({
			id: m.id,
			...frameInfo(seq, m.frame),
			name: m.name,
			markerType: m.type,
			duration: m.duration,
			comment: m.comment,
		})),
		inPoint: seq.inPoint === null ? null : frameInfo(seq, seq.inPoint),
		outPoint: seq.outPoint === null ? null : frameInfo(seq, seq.outPoint),
		workArea: seq.workArea
			? { start: frameInfo(seq, seq.workArea.start), end: frameInfo(seq, seq.workArea.end) }
			: null,
	};
}

function clipsInRangeQuery(
	env: AgentQueryEnv,
	args: z.infer<(typeof AGENT_QUERY_ARGS)['sequence.clipsInRange']>,
) {
	return wrap(() => {
		const seq = pickSequence(env.doc, args.sequenceId, env.session?.activeSequenceId);
		const from = resolveFrameInput(seq, args.from);
		const to = resolveFrameInput(seq, args.to);
		if (to <= from) throw new AgentQueryError('E_INVALID_PARAM', '`to` must be after `from`');
		const all = allTracksOf(seq);
		const tracks = args.tracks?.length
			? args.tracks.map((ref) => {
					const t = all.find(
						(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
					);
					if (!t) throw new AgentQueryError('E_NOT_FOUND', `Track not found: ${ref}`);
					return t;
				})
			: all;
		const rows = tracks.flatMap((t) => clipsInRange(seq, t.id, from, to).map((c) => clipRow(seq, c)));
		return {
			sequenceId: seq.id,
			from: frameInfo(seq, from),
			to: frameInfo(seq, to),
			clips: rows,
		};
	});
}

function sequenceAt(env: AgentQueryEnv, args: z.infer<(typeof AGENT_QUERY_ARGS)['sequence.at']>) {
	return wrap(() => {
		const seq = pickSequence(env.doc, args.sequenceId, env.session?.activeSequenceId);
		const frame = resolveFrameInput(seq, args.frame);
		if (frame < 0) throw new AgentQueryError('E_INVALID_PARAM', 'frame must be ≥ 0');
		const snapshot = buildRenderSnapshot(env.doc, seq.id, {
			range: { start: frame, end: frame + 1 },
			resolveMedia: stubMediaHandle,
			resolveFont: () => null,
		});
		const layers = resolveSceneAt(snapshot, frame).map((l) => {
			const clip = seq.clips[l.clip.clipId];
			const t = l.props.transform;
			return {
				clipId: l.clip.clipId,
				kind: l.clip.kind,
				name: l.clip.name,
				track: trackLabel(seq, l.clip.trackId),
				trackId: l.clip.trackId,
				localFrame: l.localFrame,
				opacity: round3(l.props.opacity),
				transform: t
					? {
							position: t.position.map(round3),
							anchor: t.anchor.map(round3),
							scale: round3(t.scale),
							scaleWidth: round3(t.scaleWidth),
							rotation: round3(t.rotation),
						}
					: null,
				bounds: l.props.bounds,
				blendMode: l.clip.blendMode,
				effects: l.props.effects.map((fx) => ({
					effectId: fx.effectId,
					enabled: fx.enabled,
					params: fx.params,
				})),
				...(clip ? { source: clipSource(clip) } : {}),
			};
		});
		const audio = snapshot.audioClips
			.filter((a) => frame >= a.start && frame < a.start + a.duration)
			.map((a) => {
				const ct = clipContentTime(a, frame, snapshot.settings.fps);
				return {
					clipId: a.clipId,
					track: trackLabel(seq, a.trackId),
					trackId: a.trackId,
					mediaId: a.mediaId,
					volumeDb: round3(evaluate(a.volumeDb, ct) + a.gainDb),
					pan: round3(evaluate(a.pan, ct)),
				};
			});
		return { sequenceId: seq.id, ...frameInfo(seq, frame), video: layers, audio };
	});
}

function mediaList(env: AgentQueryEnv) {
	const usage = new Map<string, { clips: number; sequences: Set<string> }>();
	for (const seq of Object.values(env.doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const id = (c as { mediaId?: unknown }).mediaId;
			if (typeof id !== 'string') continue;
			const u = usage.get(id) ?? { clips: 0, sequences: new Set<string>() };
			u.clips++;
			u.sequences.add(seq.id);
			usage.set(id, u);
		}
	return {
		media: Object.values(env.doc.media).map((m) => {
			const vs = m.probe.streams.find((s) => s.type === 'video');
			const as = m.probe.streams.filter((s) => s.type === 'audio');
			const names = Object.values(env.doc.items)
				.filter((i) => i.kind === 'media' && i.mediaId === m.id)
				.map((i) => ({ itemId: i.id, name: i.name }));
			const u = usage.get(m.id);
			return {
				mediaId: m.id,
				kind: m.kind,
				originalName: m.originalName,
				items: names,
				durationSeconds:
					m.probe.durationFlicks === null ? null : round3(flicksToSeconds(m.probe.durationFlicks)),
				video:
					vs && vs.type === 'video'
						? { width: vs.width, height: vs.height, fps: round3(fpsOf(vs.frameRate)), codec: vs.codec }
						: null,
				audio: as.length
					? as.map((a) =>
							a.type === 'audio' ? { channels: a.channels, sampleRate: a.sampleRate, codec: a.codec } : null,
						)
					: [],
				container: m.container,
				sizeBytes: m.sizeBytes,
				locators: m.locators.map((l) => l.type),
				derived: m.derivation !== null,
				usage: { clips: u?.clips ?? 0, sequences: [...(u?.sequences ?? [])] },
				...(env.session?.mediaRuntime ? { runtime: env.session.mediaRuntime(m.id) ?? null } : {}),
			};
		}),
	};
}

function needSession(env: AgentQueryEnv, name: string): NonNullable<AgentQueryEnv['session']> {
	if (!env.session) throw new AgentQueryError('E_NO_SESSION', `${name} needs an open editor session`);
	return env.session;
}

function playheadGet(env: AgentQueryEnv) {
	const s = needSession(env, 'playhead.get');
	const p = s.playhead();
	const seq = s.activeSequenceId ? env.doc.sequences[s.activeSequenceId] : undefined;
	return {
		sequenceId: s.activeSequenceId,
		frame: p.frame,
		timecode: seq ? sequenceTimecode(seq, p.frame) : null,
		playing: p.playing,
	};
}

function historyList(env: AgentQueryEnv) {
	const h = needSession(env, 'history.list').history();
	return {
		position: h.position,
		entries: h.entries.map((e, i) => ({
			index: i + 1,
			applied: i < h.position,
			label: e.label,
			origin: e.origin,
			time: new Date(e.time).toISOString(),
			revisionBefore: e.revisionBefore,
			revisionAfter: e.revisionAfter,
			created: e.created,
			changed: e.changed,
			deleted: e.deleted,
		})),
	};
}

function validateQuery(env: AgentQueryEnv, args: { transaction?: Record<string, unknown> }) {
	if (args.transaction) {
		if (!env.dryRun) throw new AgentQueryError('E_NOT_IMPLEMENTED', 'dry-run is not available here');
		return { dryRun: env.dryRun({ ...args.transaction, dryRun: true }) };
	}
	const issues = checkInvariants(env.doc, { effects: env.effects });
	return { ok: issues.length === 0, revision: env.revision, issues };
}

/**
 * Runs a document/session query. `frame.capture` is not answered here (it needs the engine's stills
 * service); callers implement it and pass everything else through.
 */
export function runAgentQuery(env: AgentQueryEnv, name: string, rawArgs: unknown = {}): unknown {
	if (!(name in AGENT_QUERY_ARGS)) throw new AgentQueryError('E_NOT_FOUND', `Unknown query: ${name}`);
	const q = name as AgentQuery;
	const parsed = AGENT_QUERY_ARGS[q].safeParse(rawArgs ?? {});
	if (!parsed.success)
		throw new AgentQueryError(
			'E_INVALID_PARAM',
			`${q}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
		);
	const args = parsed.data as never;
	switch (q) {
		case 'doc.get':
			return docGet(env, args);
		case 'doc.revision':
			return { revision: env.revision };
		case 'sequence.summary':
			return sequenceSummary(env, args);
		case 'sequence.clipsInRange':
			return clipsInRangeQuery(env, args);
		case 'sequence.at':
			return sequenceAt(env, args);
		case 'media.list':
			return mediaList(env);
		case 'selection.get':
			return { selection: needSession(env, 'selection.get').selection() };
		case 'playhead.get':
			return playheadGet(env);
		case 'history.list':
			return historyList(env);
		case 'validate':
			return validateQuery(env, args);
		case 'frame.capture':
			throw new AgentQueryError(
				'E_NOT_IMPLEMENTED',
				'frame.capture is answered by the engine stills service',
			);
	}
}

/** Resolves `frame.capture` arguments to a sequence and frame (the caller renders the still). */
export function resolveCaptureArgs(
	env: Pick<AgentQueryEnv, 'doc' | 'session'>,
	rawArgs: unknown,
): { sequenceId: string; frame: number; width: number } {
	const parsed = AGENT_QUERY_ARGS['frame.capture'].safeParse(rawArgs ?? {});
	if (!parsed.success)
		throw new AgentQueryError(
			'E_INVALID_PARAM',
			`frame.capture: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
		);
	return wrap(() => {
		const seq = pickSequence(env.doc, parsed.data.sequenceId, env.session?.activeSequenceId);
		const frame = resolveFrameInput(seq, parsed.data.frame);
		return { sequenceId: seq.id, frame: Math.max(0, frame), width: parsed.data.width ?? 1280 };
	});
}

/** JSON Schemas + descriptions of every query (for `GET /api/agent/schema`). */
export function exportAgentQuerySchemas(): Record<
	AgentQuery,
	{ description: string; sessionOnly: boolean; args: Record<string, unknown> }
> {
	const out = {} as Record<
		AgentQuery,
		{ description: string; sessionOnly: boolean; args: Record<string, unknown> }
	>;
	for (const q of AGENT_QUERY_NAMES)
		out[q] = {
			description: AGENT_QUERY_DESCRIPTIONS[q],
			sessionOnly: SESSION_ONLY_QUERIES.has(q),
			args: z.toJSONSchema(AGENT_QUERY_ARGS[q], { unrepresentable: 'any', io: 'input' }) as Record<
				string,
				unknown
			>,
		};
	return out;
}
