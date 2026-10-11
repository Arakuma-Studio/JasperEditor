// Timeline imports reuse clipboard project-item insertion to remap ids and deduplicate media by fingerprint.
import { z } from 'zod';
import { type ClipboardPayload, ClipboardPayloadSchema } from '../../clipboard/payload.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { captionHandlers } from './captions.ts';
import { insertProjectItems } from './clipboard.ts';
import { insertItem } from './project-items.ts';
import type { HandlerMap } from './util.ts';

export const INTERCHANGE_OWNER = 'wp-interchange';

const FragmentCaptionsSchema = z.looseObject({
	sequenceId: z.string(),
	name: z.string().nullable(),
	language: z.string().optional(),
	cues: z
		.array(
			z.looseObject({
				start: z.number().int().min(0),
				end: z.number().int().min(1),
				text: z.string(),
				speaker: z.string().nullable().optional(),
				settings: z.string().optional(),
			}),
		)
		.max(100_000),
});

function importTimeline(doc: DDoc, cmd: CommandOf<'project.importTimeline'>, h: HandlerContext) {
	const f = cmd.fragment as Record<string, unknown>;
	const arr = (k: string) => (Array.isArray(f[k]) ? (f[k] as unknown[]) : []);
	const rootItems = arr('rootItems');
	if (rootItems.length === 0)
		h.fail('E_INVALID_PARAM', 'The imported document holds nothing to add', { path: ['fragment'] });
	const raw = {
		format: 'jasper-clipboard',
		version: 1,
		sourceProjectId: 'interchange:import',
		sourceSequenceId: null,
		kind: 'project-items',
		items: { items: arr('items'), sequences: arr('sequences'), rootItems },
		media: arr('media'),
		synthetics: arr('synthetics'),
		transcripts: arr('transcripts'),
		fonts: arr('fonts'),
	};
	const parsed = ClipboardPayloadSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
		h.fail('E_SCHEMA', `Invalid import fragment${where}: ${issue?.message ?? ''}`, { path: ['fragment'] });
	}
	let binId = cmd.binId;
	let createdBin: string | null = null;
	if (binId === undefined) {
		createdBin = h.ids.next('bin');
		const name =
			cmd.binName ?? (typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'Imported Timeline');
		doc.items[createdBin] = {
			id: createdBin,
			kind: 'bin',
			name: name.slice(0, 256),
			children: [],
			label: 'violet',
		};
		insertItem(doc, createdBin, null);
		binId = createdBin;
	}
	const r = insertProjectItems(doc, parsed.data as unknown as ClipboardPayload, binId, undefined, h);
	// Caption tracks (FCPXML captions, OTIO): through the Captions workstream's import (transcript + caption clips).
	const captionTrackIds: string[] = [];
	for (const raw of Array.isArray(f.captions) ? (f.captions as unknown[]) : []) {
		const parsed = FragmentCaptionsSchema.safeParse(raw);
		if (!parsed.success) {
			h.warn('W_CLIP_SKIPPED', 'A caption track of the imported document is malformed and was skipped');
			continue;
		}
		const c = parsed.data;
		const sequenceId = r.sequenceMap[c.sequenceId];
		if (!sequenceId) continue;
		const res = captionHandlers['caption.import']!(
			doc,
			{
				type: 'caption.import',
				sequenceId,
				track: 'new',
				cues: c.cues.map((q) => ({
					start: q.start,
					end: q.end,
					text: q.text,
					...(q.speaker ? { speaker: q.speaker } : {}),
					...(q.settings ? { settings: q.settings } : {}),
				})),
				...(c.name ? { name: c.name } : {}),
				...(c.language ? { language: c.language } : {}),
			} as never,
			h,
		) as { trackId: string };
		captionTrackIds.push(res.trackId);
	}
	const tops = Array.isArray(f.topSequences) ? (f.topSequences as unknown[]) : [];
	const topSequenceIds = tops
		.map((t) => (typeof t === 'string' ? r.sequenceMap[t] : undefined))
		.filter((x): x is string => !!x);
	return { ...r, binId: createdBin ?? cmd.binId ?? null, topSequenceIds, captionTrackIds };
}

export const interchangeHandlers = {
	'project.importTimeline': importTimeline,
} satisfies HandlerMap;
