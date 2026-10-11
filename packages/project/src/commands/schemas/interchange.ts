// @jasper/interchange converts external timelines into fragments; import applies a fragment as one transaction.
import { z } from 'zod';
import { cmd, IdRefSchema } from './common.ts';

/** The fragment travels opaque here; the handler validates it with the clipboard payload schemas. */
export const InterchangeFragmentArgSchema = z
	.record(z.string(), z.unknown())
	.describe(
		'An imported timeline fragment {items, rootItems, media, synthetics, sequences, fonts, transcripts, topSequences} as returned by POST /api/interchange/import (or the import_timeline tool)',
	);

export const ProjectImportTimelineCmd = cmd('project.importTimeline', {
	fragment: InterchangeFragmentArgSchema,
	/** Destination bin (default: a new bin named after the document; `null` = the project root). */
	binId: IdRefSchema.nullable().optional(),
	/** Name of the bin created for the import when `binId` is absent (default: the fragment's name). */
	binName: z.string().min(1).max(256).optional(),
});

export const INTERCHANGE_COMMANDS = [ProjectImportTimelineCmd] as const;
