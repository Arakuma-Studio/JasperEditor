// project.importTimeline (wp interchange): adds an imported timeline fragment — bins, media items (resolved files or
// offline placeholders), synthetic sources and sequences — through the clipboard's project-items machinery, so ids
// are new, media already in the project (same fingerprint) is reused and everything is one transaction.
import { type ClipboardPayload, ClipboardPayloadSchema } from '../../clipboard/payload.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import { insertProjectItems } from './clipboard.ts';
import { insertItem } from './project.ts';
import type { HandlerMap } from './util.ts';

export const INTERCHANGE_OWNER = 'wp-interchange';

function importTimeline(doc: DDoc, cmd: CommandOf<'project.importTimeline'>, h: HandlerContext): unknown {
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
	const tops = Array.isArray(f.topSequences) ? (f.topSequences as unknown[]) : [];
	const topSequenceIds = tops
		.map((t) => (typeof t === 'string' ? r.sequenceMap[t] : undefined))
		.filter((x): x is string => !!x);
	return { ...r, binId: createdBin ?? cmd.binId ?? null, topSequenceIds };
}

export const interchangeHandlers: HandlerMap = {
	'project.importTimeline': importTimeline,
};
