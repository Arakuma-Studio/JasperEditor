// Spec 18 AF-DIG-002 / AF-TAK-002: reading footage as text — the packed footage digest (`get_footage_digest`, resource
// `jasper://projects/{id}/footage`) and takes of the same line across files (`find_takes`). Both read the project
// document; nothing changes (docs/wp-notes/agent-footage-digest.md).
import {
	DIGEST_DEFAULT_MAX_CHARS,
	DIGEST_MAX_CHARS_LIMIT,
	DIGEST_MIN_MAX_CHARS,
	FLICKS_PER_SECOND,
	type FootageError,
	findTakes,
	footageMedia,
	type ProjectDocument,
	packFootageDigest,
	TAKES_DEFAULT_MIN_SIMILARITY,
	TAKES_MAX_PHRASES,
} from '@jasper/project';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import { defineTool, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const FOOTAGE_GUIDE = `Reading footage (read before you cut): get_footage_digest returns every transcribed media as packed phrase lines — "## <mediaId> "<name>" (duration, size fps, N phrases, speakers S0 S1)" then "  [002.52-005.36] S0 text" (media seconds; phrases split at a ≥ 0.5 s pause, a speaker change, a caption break or 12 s; "~word" = low recognition confidence, check it before quoting). Media with sound but no transcript are listed with a hint: transcribe them (transcribe, or import_media with transcribe: true). mediaIds narrows it; sequenceId gives one sequence in sequence time (what the cut says now). maxChars (default ${DIGEST_DEFAULT_MAX_CHARS}) cuts only between media and ends with "… N more media not shown: pass mediaIds". The same text is the resource jasper://projects/{projectId}/footage. find_takes groups phrases that say the same line (across files too; case, punctuation and fillers ignored, LCS ratio ≥ minSimilarity, default ${TAKES_DEFAULT_MIN_SIMILARITY}): each member has media, range, text, mean confidence and complete (ends a sentence, no restart or stutter); "suggested" is the last complete take. Read the digest, pick takes, then cut with media seconds ({"seconds": x}).`;

const MediaIdsArg = z
	.array(z.string().min(1))
	.min(1)
	.max(500)
	.optional()
	.describe('Default: every media with sound.');

function footageError(e: FootageError): never {
	throw new ToolError(e.code, e.message, e.hint, e.details);
}

const sec = (flicks: number) => Math.round((flicks / FLICKS_PER_SECOND) * 1000) / 1000;

/** The digest as a tool result: the text, plus what `maxChars` left out. */
function digestResult(
	doc: ProjectDocument,
	a: { mediaIds?: string[]; sequenceId?: string; maxChars?: number },
) {
	const r = packFootageDigest(doc, a);
	if (!r.ok) footageError(r);
	const content: CallToolResult['content'] = [{ type: 'text', text: r.text }];
	if (r.notShown.length || r.cutPhrases)
		content.push({
			type: 'text',
			text: JSON.stringify({
				...(r.notShown.length ? { notShown: r.notShown } : {}),
				...(r.cutPhrases ? { cutPhrases: r.cutPhrases } : {}),
				next: r.notShown.length
					? 'Call get_footage_digest again with mediaIds from notShown.'
					: `Pass a larger maxChars (≤ ${DIGEST_MAX_CHARS_LIMIT}) or read the rest with get_transcript.`,
			}),
		});
	return { content } satisfies CallToolResult;
}

export function registerFootageTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_footage_digest',
		{
			title: 'Footage digest',
			description:
				'Read transcribed media as timed text: `[start-end] S0 words` in seconds, `~` on unsure words. Media with no transcript are listed. Read it before planning a cut.',
			input: {
				projectId: ProjectIdArg,
				mediaIds: MediaIdsArg,
				sequenceId: z.string().min(1).optional().describe('One sequence in sequence time, instead of media.'),
				maxChars: z
					.number()
					.int()
					.min(DIGEST_MIN_MAX_CHARS)
					.max(DIGEST_MAX_CHARS_LIMIT)
					.optional()
					.describe(`Default ${DIGEST_DEFAULT_MAX_CHARS}.`),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, ...a }) => {
			const { doc } = await loadDoc(ctx, projectId);
			return digestResult(doc, a);
		},
	);

	defineTool(
		ctx,
		'find_takes',
		{
			title: 'Find takes',
			description: `Group lines said more than once across transcribed media, with the \`suggested\` take of each; times are media seconds for \`add_clip\`. Beyond ${TAKES_MAX_PHRASES} phrases pass \`mediaIds\`.`,
			input: {
				projectId: ProjectIdArg,
				mediaIds: MediaIdsArg,
				minSimilarity: z
					.number()
					.min(0.3)
					.max(1)
					.optional()
					.describe(`Default ${TAKES_DEFAULT_MIN_SIMILARITY}.`),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, mediaIds, minSimilarity }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const r = findTakes(doc, { mediaIds, minSimilarity });
			if (!r.ok) footageError(r);
			const names = new Map(footageMedia(doc, mediaIds, 'transcribed').media.map((m) => [m.id, m.name]));
			return jsonResult({
				minSimilarity: r.minSimilarity,
				phrasesCompared: r.phrasesCompared,
				groups: r.groups.map((g) => ({
					id: g.id,
					suggested: g.suggested,
					members: g.members.map((m) => ({
						mediaId: m.mediaId,
						name: names.get(m.mediaId) ?? m.mediaId,
						start: sec(m.start),
						end: sec(m.end),
						text: m.text,
						meanConfidence: m.meanConfidence,
						complete: m.complete,
					})),
				})),
				...(r.groups.length
					? {
							next: 'Cut the suggested take of each group (add_clip with sourceIn / sourceOut in media seconds).',
						}
					: { note: 'No line was said more than once at this similarity.' }),
			});
		},
	);

	ctx.server.registerResource(
		'project-footage',
		new ResourceTemplate('jasper://projects/{projectId}/footage', {
			list: async () => {
				const { projects } = await ctx.engine((c) => c.listProjects());
				return {
					resources: projects.map((p) => ({
						uri: `jasper://projects/${p.projectId}/footage`,
						name: `${p.name} (footage digest)`,
						mimeType: 'text/plain',
					})),
				};
			},
		}),
		{
			title: 'Footage digest',
			description:
				'Every transcribed media of a project as packed phrase lines (get_footage_digest with its defaults).',
			mimeType: 'text/plain',
		},
		async (uri, { projectId }) => {
			const { doc } = await loadDoc(ctx, String(projectId));
			const r = packFootageDigest(doc, {});
			if (!r.ok) footageError(r);
			return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: r.text }] };
		},
	);
}
