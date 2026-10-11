import { previewSettingsOf } from '../../schema/sequence.ts';
import type { HandlerContext } from '../context.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { HandlerMap } from './util.ts';

export const PREVIEWS_OWNER = 'previews' as const;

export const previewsHandlers = {
	'sequence.setPreviewSettings': (doc, cmd: CommandOf<'sequence.setPreviewSettings'>, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const cur = previewSettingsOf(seq);
		const next = {
			format: cmd.format ?? cur.format,
			size: cmd.size ?? cur.size,
			quality: cmd.quality ?? cur.quality,
		};
		seq.previews = next;
		return { previews: next };
	},
} satisfies HandlerMap;
