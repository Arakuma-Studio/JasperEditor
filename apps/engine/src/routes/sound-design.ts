// Sound design routes (spec 12 §2.8; wp-note "WP2.3 cue route & MCP tools"):
//   POST /api/sound-design/cues   cue suggestions derived from the edit (`deriveCues` of @jasper/project with the
//                                 engine's motion-graphic template registry), for an inline envelope or a project's
//                                 live document. Read-only: nothing is stored.
import {
	type EnvelopeJson,
	type SoundCueSuggestion,
	SoundCuesRequestSchema,
	type SoundCuesResponse,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	bindExpressions,
	type CueAnchor,
	type DerivedCue,
	deriveCues,
	documentHasActiveExpressions,
	loadProject,
	type ProjectDocument,
	type Rational,
	type Sequence,
	sequenceDialogueRanges,
	sequenceDuration,
	sequenceTimecode,
	soundCuesOf,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';

/** Keys sorted at every depth: two anchors with the same content compare equal. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object')
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v) ?? 'null';
}

/**
 * The stored cue each derived cue stands for: one with the same anchor (or one of the merged anchors), else one at
 * the same frame with the same kind. A stored cue matches at most one suggestion.
 */
export function matchStoredCues(seq: Sequence, cues: readonly DerivedCue[]): (string | null)[] {
	const stored = soundCuesOf(seq);
	const byAnchor = new Map<string, string>();
	const byFrameKind = new Map<string, string>();
	for (const c of stored) {
		if (c.anchor) byAnchor.set(canonical(c.anchor), c.id);
		const k = `${c.frame}|${c.kind}`;
		if (!byFrameKind.has(k)) byFrameKind.set(k, c.id);
	}
	const used = new Set<string>();
	return cues.map((d) => {
		for (const a of [d.anchor, ...(d.also ?? [])] as CueAnchor[]) {
			const id = byAnchor.get(canonical(a));
			if (id && !used.has(id)) {
				used.add(id);
				return id;
			}
		}
		const id = byFrameKind.get(`${d.frame}|${d.kind}`);
		if (id && !used.has(id)) {
			used.add(id);
			return id;
		}
		return null;
	});
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Longest curve returned per clip (frames): the 20 000 the deriver samples at most. */
const MAX_CURVE_FRAMES = 20_000;

export default async function soundDesignRoutes(app: FastifyInstance): Promise<void> {
	app.post(
		'/api/sound-design/cues',
		guarded(async (req) => {
			const body = parseOr400(SoundCuesRequestSchema, req.body ?? {});
			let doc: ProjectDocument;
			let revision: number | null = null;
			if (body.envelope) {
				try {
					doc = loadProject(body.envelope as EnvelopeJson, { mgTemplates: mgRegistry }).document;
				} catch (e) {
					throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
				}
				revision = body.envelope.revision;
			} else {
				const agent = app.jasper.services.agent as AgentService | undefined;
				if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
				// The live document: the open editor's when one holds the project, else the saved one.
				const r = await agent.query({ projectId: body.projectId!, query: 'doc.get', args: {} });
				const d = r.result as ProjectDocument | undefined;
				if (!d || typeof d !== 'object' || !d.sequences || typeof d.sequences !== 'object')
					throw new HttpError(422, 'VALIDATION_FAILED', 'The project has no readable document');
				doc = d;
				revision = typeof r.revision === 'number' ? r.revision : null;
			}
			const seqId = body.sequenceId ?? Object.keys(doc.sequences)[0];
			const seq =
				seqId !== undefined && Object.hasOwn(doc.sequences, seqId) ? doc.sequences[seqId] : undefined;
			if (!seq || !seqId)
				throw new HttpError(
					404,
					'SEQUENCE_NOT_FOUND',
					body.sequenceId ? `Sequence not found: ${body.sequenceId}` : 'The project has no sequence',
				);
			// Expression-driven motion moves like the renderer shows it (deriveCues samples resolved properties).
			if (documentHasActiveExpressions(doc)) doc = bindExpressions(doc);
			const opts = body.opts ?? {};
			const density = opts.density ?? soundDesignSettingsOf(seq).density;
			const respectDialogue = opts.respectDialogue ?? true;
			const out = deriveCues(doc, seqId, {
				...(opts.range ? { range: opts.range } : {}),
				...(opts.sources ? { sources: opts.sources } : {}),
				density,
				respectDialogue,
				...(opts.minGapFrames !== undefined ? { minGapFrames: opts.minGapFrames } : {}),
				...(opts.maxCues !== undefined ? { maxCues: opts.maxCues } : {}),
				mgTemplates: mgRegistry,
			});
			const rate = seq.settings.frameRate as Rational;
			const fps = rate.num / rate.den;
			const stored = matchStoredCues(seq, out.cues);
			const cues: SoundCueSuggestion[] = out.cues.map((c, i) => ({
				key: c.key,
				frame: c.frame,
				timecode: sequenceTimecode(seq, c.frame),
				seconds: round3(c.frame / fps),
				kind: c.kind,
				weight: c.weight,
				types: c.types,
				align: c.align,
				...(c.pan !== undefined ? { pan: c.pan } : {}),
				...(c.panSweep ? { panSweep: { from: c.panSweep.from, to: c.panSweep.to } } : {}),
				anchor: c.anchor,
				...(c.also?.length ? { also: c.also } : {}),
				confidence: round3(c.confidence),
				reason: c.reason,
				...(c.window ? { window: { start: c.window.start, end: c.window.end } } : {}),
				source: c.source,
				from: c.from,
				...(c.group ? { group: c.group } : {}),
				score: c.score,
				storedCueId: stored[i] ?? null,
			}));
			const res: SoundCuesResponse = {
				projectId: body.projectId ?? null,
				sequenceId: seqId,
				revision,
				frameRate: { num: rate.num, den: rate.den },
				durationFrames: Math.max(0, Math.round(sequenceDuration(seq))),
				density,
				respectDialogue,
				cues,
				stats: out.stats,
				warnings: out.warnings,
				dialogue: respectDialogue
					? sequenceDialogueRanges(doc, seq).map(([start, end]) => ({ start: Math.max(0, start), end }))
					: [],
				storedCues: soundCuesOf(seq).length,
				...(opts.curves
					? {
							curves: out.curves.map((c) => ({
								clipId: c.clipId,
								start: c.start,
								speed: Array.from(c.speed.subarray(0, MAX_CURVE_FRAMES), round3),
							})),
						}
					: {}),
			};
			return res;
		}),
	);
}
