import {
	APPROVAL_COMMANDS,
	COMMAND_CATALOG,
	EditModeSchema,
	IdListSchema,
	OPEN_OBJECT,
	resolveFrameInput,
	TrackRefSchema,
	transitionSpec,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { COMMAND_EXAMPLES, TRANSACTION_EXAMPLE } from '../examples.ts';
import { clipSummary } from '../format.ts';
import { registerAddMotionGraphic } from './add-motion-graphic.ts';
import { AnimateArg, textAnimationOf } from './animation.ts';
import { registerBulkMotionGraphics } from './bulk-motion-graphics.ts';
import { transitionEffectId } from './transitions.ts';

const COMMAND_TYPES = Object.keys(COMMAND_CATALOG) as [string, ...string[]];

const ClipIdsArg = z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…") from get_timeline');

const TIME_NOTES = [
	'Times on the timeline are sequence frames; every time argument of a command also accepts {"frames": n}, {"seconds": x} or a timecode string "HH:MM:SS:FF" (the helper tools also take "3s", "250ms", "00:03" and "1:02:03").',
	'Generator clips (clip.addText / addSolid / addShape / addMotionGraphic) take placement: "first-free" to land on the lowest unlocked track at or above `track` that is empty for their range (a new top track when none is) instead of overwriting; clip.addMotionGraphic {fill: {seed}} fills omitted params with the template\'s fill hook.',
	'Tracks are addressed by label: "V1" is the lowest video track, "A1" the first audio track (or by track id).',
	'Creating commands may declare "ref": "$name"; later commands in the same transaction can use "$name" as an id.',
	'Instead of ids you can write {"mediaByName": "file.mp4"}, {"clipAt": {"track": "V1", "at": "00:00:01:00"}}, {"markerByName": "Intro"} or {"itemByName": "Cam A.mp4"} (a project item).',
	'A transaction is atomic: all commands apply or none. Use dryRun: true to validate first.',
	`Transactions containing ${APPROVAL_COMMANDS.join(', ')} or any "force": true need the user's approval in an open editor (60 s timeout); without an editor they are rejected.`,
];

let schemaCache: { url: string; schema: Record<string, unknown> } | null = null;

export async function engineSchema(ctx: ToolContext): Promise<Record<string, unknown>> {
	const url = ctx.link.target?.url ?? '';
	if (schemaCache && schemaCache.url === url) return schemaCache.schema;
	const schema = (await ctx.engine((c) => c.agentSchema())) as Record<string, unknown>;
	schemaCache = { url: ctx.link.target?.url ?? url, schema };
	return schema;
}

/** Runs a transaction built by a helper tool and returns the applied result plus the touched clips. */
export async function applyHelper(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Parameters<typeof transact>[3],
	opts: { sequenceId?: string } = {},
) {
	const res = await transact(ctx, projectId, { label, commands, sequenceId: opts.sequenceId }, extra);
	const r = requireOk(res);
	const touched = [...r.created, ...r.changed];
	const { doc } = await loadDoc(ctx, projectId);
	const clips: ReturnType<typeof clipSummary>[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const id of touched) {
			const clip = seq.clips[id];
			if (clip) clips.push(clipSummary(doc, seq, clip));
		}
	return jsonResult({ ...txBody(res, r), ...(clips.length ? { clips } : {}) });
}

export function hexToRgba(hex: string): [number, number, number, number] {
	const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
	if (!m) throw new ToolError('E_INVALID_PARAM', `Invalid color "${hex}"`, 'Use #RRGGBB or #RRGGBBAA.');
	const n = Number.parseInt(m[1]!, 16);
	const a = m[2] ? Number.parseInt(m[2], 16) / 255 : 1;
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, Math.round(a * 1000) / 1000];
}

export function registerEditingTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'describe_commands',
		{
			title: 'Describe edit commands',
			description:
				'The catalog of document commands accepted by apply_commands (protocol jasper.tx/1): without arguments a list of every command type with its label, whether it is implemented and whether it needs user approval, plus addressing and time rules and a sample transaction. With `types`, the full JSON Schema and a worked example for each of those commands. Also lists motion-graphic templates and sequence presets, and counts the effects (list_effects lists them).',
			input: {
				types: z
					.array(z.string())
					.max(30)
					.optional()
					.describe('Command types to describe in full, e.g. ["clip.place", "clip.addText"]'),
			},
			annotations: READ_ONLY,
		},
		async ({ types }) => {
			const schema = await engineSchema(ctx);
			const commands = schema.commands as Record<
				string,
				{ label: string; implemented: boolean; milestone: string; schema: unknown }
			>;
			if (types?.length) {
				const unknown = types.filter((t) => !commands[t]);
				if (unknown.length)
					throw new ToolError(
						'E_NOT_FOUND',
						`Unknown command type(s): ${unknown.join(', ')}`,
						'Call describe_commands without arguments for the list of types.',
					);
				return jsonResult({
					commands: types.map((t) => ({
						type: t,
						label: commands[t]!.label,
						implemented: commands[t]!.implemented,
						needsApproval: (APPROVAL_COMMANDS as readonly string[]).includes(t),
						schema: commands[t]!.schema,
						...(COMMAND_EXAMPLES[t] ? { example: COMMAND_EXAMPLES[t] } : {}),
					})),
					rules: TIME_NOTES,
				});
			}
			return jsonResult({
				protocol: 'jasper.tx/1',
				rules: TIME_NOTES,
				commands: Object.entries(commands).map(([type, c]) => ({
					type,
					label: c.label,
					...(c.implemented ? {} : { implemented: false }),
					...((APPROVAL_COMMANDS as readonly string[]).includes(type) ? { needsApproval: true } : {}),
				})),
				exampleTransaction: TRANSACTION_EXAMPLE,
				mgTemplates: (schema.mgTemplates as { id: string; version: number; name: string }[] | undefined)?.map(
					(t) => `${t.id}@${t.version} (${t.name})`,
				),
				presets: (schema.presets as { id: string }[] | undefined)?.map((p) => p.id),
				effects: {
					count: (schema.effects as unknown[] | undefined)?.length ?? 0,
					hint: 'list_effects searches them by words and category; effect.add takes an id.',
				},
				properties: (schema.properties as { key: string; animatable: string }[] | undefined)?.map(
					(p) => p.key,
				),
			});
		},
	);

	defineTool(
		ctx,
		'apply_commands',
		{
			title: 'Apply edit commands',
			description:
				'Applies a transaction of document commands (see describe_commands) atomically. If an editor window has the project open the change appears live there as one undoable History entry "Agent: <label>" (appliedBy: session); otherwise the engine applies and saves it headlessly. dryRun: true validates without changing anything. Returns the new revision, created/changed/deleted ids and the ids bound to "$refs". Destructive commands (track.remove, item.delete, sequence.delete, force: true) wait for the user to approve in the editor.',
			input: {
				projectId: ProjectIdArg,
				label: z
					.string()
					.min(1)
					.max(80)
					.describe('Short description shown in the editor History as "Agent: <label>"'),
				commands: z
					.array(
						// Each command's own keys are checked against its schema by the engine (unknown keys anywhere
						// in a command are E_SCHEMA errors naming the accepted ones).
						z
							.looseObject({ type: z.enum(COMMAND_TYPES).describe('Command type (describe_commands)') })
							.meta(OPEN_OBJECT),
					)
					.min(1)
					.max(5000)
					.describe('Commands in order; each is {"type": "...", ...arguments}'),
				dryRun: z.boolean().optional().describe('Validate only: report what would change'),
				expectedRevision: z
					.number()
					.int()
					.optional()
					.describe('Reject if the project changed since this revision (optimistic concurrency)'),
				sequenceId: SequenceIdArg,
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, label, commands, dryRun, expectedRevision, sequenceId }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{ label, commands, dryRun, expectedRevision, sequenceId },
				extra,
			);
			return jsonResult(txBody(res, requireOk(res), !!dryRun));
		},
	);

	for (const [name, kind] of [
		['undo', 'history.undo'],
		['redo', 'history.redo'],
	] as const)
		defineTool(
			ctx,
			name,
			{
				title: name === 'undo' ? 'Undo' : 'Redo',
				description:
					name === 'undo'
						? "Undoes the editor's most recent History entry if this agent made it (the user's own edits are never undone by agents). Needs an editor window with the project open."
						: 'Redoes the next History entry if this agent made it. Needs an editor window with the project open.',
				input: { projectId: ProjectIdArg },
				annotations: EDIT,
			},
			async ({ projectId }, extra) => {
				const res = await transact(ctx, projectId, { label: name, commands: [{ type: kind }] }, extra);
				const r = requireOk(res);
				return jsonResult({ ...txBody(res, r), [name === 'undo' ? 'undone' : 'redone']: r.results[0] });
			},
		);

	defineTool(
		ctx,
		'add_clip',
		{
			title: 'Add clip to timeline',
			description:
				'Places imported media on the timeline (clip.place). Video files create a linked video + audio pair (V track + A track). Overwrite mode replaces what is under the new clip; insert mode pushes later clips right. Returns the new clip ids with their times.',
			input: {
				projectId: ProjectIdArg,
				media: z.string().min(1).describe('mediaId ("med_…") or the Project item / file name ("clip-a.mp4")'),
				at: timeArg('Where the clip starts on the timeline'),
				track: TrackRefSchema.optional().describe('Video track label or id (default V1)'),
				audioTrack: TrackRefSchema.optional().describe('Audio track label or id (default A1)'),
				sourceIn: z.number().min(0).optional().describe('Start inside the media, in seconds (default 0)'),
				sourceOut: z
					.number()
					.min(0)
					.optional()
					.describe('End inside the media, in seconds (default: the end; required with sourceIn)'),
				sourceInFrame: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						'Frame-exact alternative to sourceIn: first media frame (0-based, at the media frame rate)',
					),
				sourceOutFrame: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						'Frame-exact alternative to sourceOut: media frame after the last one used (exclusive); the clip is sourceOutFrame − sourceInFrame frames long',
					),
				mode: EditModeSchema.optional().describe('overwrite (default) or insert (ripples later clips)'),
				videoOnly: z.boolean().optional().describe('Place only the video'),
				audioOnly: z.boolean().optional().describe('Place only the audio'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const source = /^med_/.test(a.media) ? { mediaId: a.media } : { mediaByName: a.media };
			const cmd: Record<string, unknown> = {
				type: 'clip.place',
				source,
				at: a.at,
				matchSequence: 'keep',
				...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				...(a.track || a.audioTrack
					? {
							tracks: {
								...(a.track ? { video: a.track } : {}),
								...(a.audioTrack ? { audio: a.audioTrack } : {}),
							},
						}
					: {}),
				...(a.mode ? { mode: a.mode } : {}),
				...(a.videoOnly ? { audio: false } : {}),
				...(a.audioOnly ? { video: false } : {}),
				// A track label above the existing ones ("V4") creates the missing tracks.
				...(a.track || a.audioTrack ? { createTracks: true } : {}),
			};
			const frameRange = a.sourceInFrame !== undefined || a.sourceOutFrame !== undefined;
			if (frameRange && (a.sourceIn !== undefined || a.sourceOut !== undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give the source range in seconds or in frames, not both',
					'Use sourceInFrame/sourceOutFrame for frame-exact edits.',
				);
			if (frameRange) {
				if (a.sourceOutFrame === undefined)
					throw new ToolError('E_INVALID_PARAM', 'sourceInFrame needs sourceOutFrame too');
				if (a.sourceOutFrame <= (a.sourceInFrame ?? 0))
					throw new ToolError('E_INVALID_PARAM', 'sourceOutFrame must be after sourceInFrame');
				cmd.sourceRange = {
					in: { sourceFrames: a.sourceInFrame ?? 0 },
					out: { sourceFrames: a.sourceOutFrame },
				};
			} else if (a.sourceIn !== undefined || a.sourceOut !== undefined) {
				if (a.sourceOut === undefined)
					throw new ToolError('E_INVALID_PARAM', 'sourceIn needs sourceOut too', 'Pass both, in seconds.');
				cmd.sourceRange = { in: { seconds: a.sourceIn ?? 0 }, out: { seconds: a.sourceOut } };
			}
			return applyHelper(ctx, a.projectId, `Add ${a.media}`, [cmd], extra);
		},
	);

	defineTool(
		ctx,
		'move_clip',
		{
			title: 'Move clips',
			description:
				'Moves clips in time and/or to other tracks (clip.move). Give either deltaFrames or `to` (the new start of the first clip). Linked audio/video partners move along. overwrite (default) replaces what is under the destination; insert ripples later clips.',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				deltaFrames: z.number().int().optional().describe('Frames to move by (negative = earlier)'),
				to: timeArg('New start time of the first clip (instead of deltaFrames)').optional(),
				deltaTracks: z
					.number()
					.int()
					.optional()
					.describe('Tracks to move up (+) or down (−) within the same kind'),
				mode: EditModeSchema.optional().describe('overwrite (default) or insert (ripples later clips)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, deltaFrames, to, deltaTracks, mode }, extra) => {
			let delta = deltaFrames ?? 0;
			if (to !== undefined) {
				const { doc } = await loadDoc(ctx, projectId);
				const seq = Object.values(doc.sequences).find((s) => s.clips[clipIds[0]!]);
				if (!seq)
					throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipIds[0]}`, 'Call get_timeline for ids.');
				delta = resolveFrameInput(seq, to) - seq.clips[clipIds[0]!]!.start;
			} else if (deltaFrames === undefined && !deltaTracks)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to do', 'Pass deltaFrames, to or deltaTracks.');
			return applyHelper(
				ctx,
				projectId,
				'Move clips',
				[
					{
						type: 'clip.move',
						clipIds,
						deltaFrames: delta,
						...(deltaTracks ? { deltaTracks } : {}),
						...(mode ? { mode } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'trim_clip',
		{
			title: 'Trim clip',
			description:
				'Moves the in (head) or out (tail) edge of a clip by deltaFrames (clip.trim). Positive moves the edge later. regular leaves a gap / needs room; ripple shifts later clips to close or open the gap; roll moves the edit point shared with the neighbour. Linked partners trim along.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				edge: z.enum(['in', 'out']).describe('in = head (start), out = tail (end)'),
				deltaFrames: z
					.number()
					.int()
					.describe('Frames to move the edge by (e.g. -30 shortens a tail by 1 s at 30 fps)'),
				mode: z.enum(['regular', 'ripple', 'roll']).optional().describe('Default regular'),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, edge, deltaFrames, mode }, extra) =>
			applyHelper(
				ctx,
				projectId,
				`Trim ${edge === 'in' ? 'head' : 'tail'}`,
				[{ type: 'clip.trim', clipId, edge, deltaFrames, ...(mode ? { mode } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'split_at',
		{
			title: 'Split clips',
			description:
				'Cuts clips in two at a time (clip.split, like the razor tool). By default every clip under that time on all unlocked tracks is split; restrict with clipIds or tracks. A cut inside a transition keeps the transition on its edit, shortened to the part of the clip it still has (W_TRANSITION_SHORTENED, as Premiere). Returns the new right-hand halves.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Where to cut'),
				clipIds: ClipIdsArg.optional(),
				tracks: z.array(TrackRefSchema).min(1).optional().describe('Track labels, e.g. ["V1", "A1"]'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async ({ projectId, at, clipIds, tracks, sequenceId }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Split',
				[
					{
						type: 'clip.split',
						at,
						...(sequenceId ? { sequenceId } : {}),
						...(clipIds ? { clipIds } : tracks ? { tracks } : { scope: 'all-unlocked' }),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'delete_clips',
		{
			title: 'Delete clips',
			description:
				'Removes clips from the timeline. ripple: false (default) lifts them and leaves a gap (clip.lift); ripple: true closes the gap by shifting later clips (clip.extract). Linked partners are removed too. Media stays in the project. Undoable in the editor.',
			input: {
				projectId: ProjectIdArg,
				clipIds: IdListSchema.describe(
					'Clip ids ("clp_…") from get_timeline, or "$selection" for the clips selected in the open editor',
				),
				ripple: z.boolean().optional().describe('Close the gap (ripple delete)'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, clipIds, ripple }, extra) =>
			applyHelper(
				ctx,
				projectId,
				ripple ? 'Ripple delete' : 'Delete clips',
				[{ type: ripple ? 'clip.extract' : 'clip.lift', clipIds }],
				extra,
			),
	);

	defineTool(
		ctx,
		'add_text',
		{
			title: 'Add text',
			description:
				"Adds a text (title) clip (clip.addText) on a video track above the footage. Position is in sequence pixels (0,0 = top left; default: centred). animateIn/animateOut add text animations (list_text_animations). strokes: every entry is drawn, the first on top (outside / center / inside of the glyph outline); shadow: the glyphs and their strokes grown by spreadPx, blurred (blurPx = CSS blur radius, Gaussian σ = blurPx / 2), offset by distancePx at angleDeg (0 = right, 90 = down), opacity = the colour's alpha. The box follows the glyph metrics of the font (measured in the editor or the engine's render browser; `layoutPending` marks an estimate). vertical: right-to-left columns, with 1 to 3 half-width characters upright (tate-chu-yoko). Preview and every export draw the same.",
			input: {
				projectId: ProjectIdArg,
				text: z.string().min(1).max(2000).describe('The text to show (line breaks allowed)'),
				at: timeArg('Start time'),
				duration: timeArg('Length, e.g. {"seconds": 3}'),
				track: TrackRefSchema.optional().describe('Video track (default V2)'),
				sizePx: z.number().positive().max(2000).optional().describe('Font size in pixels'),
				// wp fonts
				font: z
					.string()
					.min(1)
					.max(200)
					.optional()
					.describe('Font family or PostScript name (list_fonts; default Source Sans 3)'),
				color: z.string().optional().describe('Text color "#RRGGBB" or "#RRGGBBAA" (default white)'),
				// spec 13 SH-004
				strokes: z
					.array(
						z.object({
							color: z.string().describe('"#RRGGBB" or "#RRGGBBAA" (alpha = opacity)'),
							widthPx: z.number().min(0).max(1000),
							position: z.enum(['outside', 'center', 'inside']).optional().describe('Default outside'),
						}),
					)
					.max(16)
					.optional()
					.describe('Strokes, the first drawn on top'),
				shadow: z
					.object({
						color: z.string().describe('"#RRGGBB" or "#RRGGBBAA" (alpha = opacity)'),
						angleDeg: z.number().min(-3600).max(3600).optional().describe('Default 90 (down)'),
						distancePx: z.number().min(0).max(10000).optional().describe('Default 0'),
						blurPx: z.number().min(0).max(10000).optional().describe('Default 0'),
						spreadPx: z
							.number()
							.min(0)
							.max(10000)
							.optional()
							.describe('Growth before the blur (Premiere Size); default 0'),
					})
					.optional()
					.describe('Drop shadow of the glyphs and strokes'),
				position: z.tuple([z.number(), z.number()]).optional().describe('[x, y] in sequence pixels'),
				// M2 (wp-m2-text-anim, S11:ANA-002): text animators of the new clip (see list_text_animations).
				vertical: z.boolean().optional().describe('Set the text in right-to-left columns'),
				animateIn: AnimateArg.optional().describe(
					'In animation over the first frames: a preset id ("slide-up") or {preset, durationFrames | durationSeconds, params}',
				),
				animateOut: AnimateArg.optional().describe(
					'Out animation over the last frames (the mirrored motion): same forms as animateIn',
				),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const style: Record<string, unknown> = {};
			if (a.sizePx) style.sizePx = a.sizePx;
			if (a.color) style.fill = hexToRgba(a.color);
			if (a.font) style.fontId = '$font';
			if (a.strokes)
				style.strokes = a.strokes.map((st) => ({
					color: hexToRgba(st.color),
					widthPx: st.widthPx,
					position: st.position ?? 'outside',
				}));
			if (a.shadow)
				style.shadow = {
					color: hexToRgba(a.shadow.color),
					angleDeg: a.shadow.angleDeg ?? 90,
					distancePx: a.shadow.distancePx ?? 0,
					blurPx: a.shadow.blurPx ?? 0,
					...(a.shadow.spreadPx ? { spreadPx: a.shadow.spreadPx } : {}),
				};
			// M2 (wp-m2-text-anim, S11:ANA-002)
			const textAnimation = await textAnimationOf(
				ctx,
				a.projectId,
				{ in: a.animateIn, out: a.animateOut },
				{ sequenceId: a.sequenceId },
			);
			return applyHelper(
				ctx,
				a.projectId,
				`Text "${a.text.slice(0, 30)}"`,
				[
					...(a.font ? [{ type: 'font.add', family: a.font, ref: '$font' }] : []),
					{
						type: 'clip.addText',
						at: a.at,
						duration: a.duration,
						track: a.track ?? 'V2',
						content: {
							text: a.text,
							...(Object.keys(style).length ? { style } : {}),
							...(a.vertical ? { writingMode: 'vertical' } : {}),
						},
						...(a.position ? { transform: { position: a.position } } : {}),
						...(textAnimation ? { textAnimation } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'add_transition',
		{
			title: 'Add transition',
			description:
				'Adds a transition at an edit point or a fade at a clip edge (transition.add). Address it by clipId + edge ("in" = head, "out" = tail) or by track + at (the frame where one clip ends and the next begins). Video: cross-dissolve (the incoming clip fades in over the outgoing one; needs media beyond the cut, "handles") or dip-to-black; at a free clip edge they are fades from/to transparent or black; or any GPU transition of list_transition_types (push, iris-round, cross-zoom, s.dissolve-luma, …; params e.g. {"direction": "eastToWest"}; a GPU transition at a free clip edge transitions from/to transparency). Audio tracks: constant-gain (linear), constant-power (quarter sine), exponential-fade or custom-fade (Premiere\'s Custom Fade: params fadeShape "linear" | "cosine", fadeValue −100…100 — Cosine at 19 is constant power, Linear at 0 constant gain; symmetry "symmetric" | "asymmetric" with outFadeShape / outFadeValue for the outgoing clip) fades at a clip edge (clipId + edge), or crossfades between two audio clips at an edit point (track + at). cutOffset places the cut off-centre (Premiere\'s Custom Start: frames of the span before the cut). The duration is shortened (with a warning) to what the clips and their handles allow.',
			input: {
				projectId: ProjectIdArg,
				type: z
					.string()
					.min(1)
					.describe(
						'Transition type: cross-dissolve, dip-to-black, constant-gain, constant-power, exponential-fade, custom-fade, or any type of list_transition_types (short name, effect id or label)',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Param values {name: value} of the type (list_transition_types lists them)'),
				durationFrames: z.number().int().min(1).max(600).describe('Length in frames'),
				clipId: z.string().min(1).optional().describe('Clip id ("clp_…"), with edge'),
				edge: z.enum(['in', 'out']).optional().describe('in = the clip head, out = the clip tail'),
				track: TrackRefSchema.optional().describe('Track label or id, with at (instead of clipId)'),
				at: z.number().int().min(0).optional().describe('Frame of the edit point on that track'),
				alignment: z
					.enum(['center', 'start-at-cut', 'end-at-cut'])
					.optional()
					.describe(
						'Where a transition between two clips sits (default center); start-at-cut needs handles only on the outgoing clip, end-at-cut only on the incoming one',
					),
				cutOffset: z
					.number()
					.int()
					.min(0)
					.max(600)
					.optional()
					.describe(
						"Custom Start (transitions between two clips): frames of the span before the cut, 0…durationFrames, instead of alignment (Premiere's off-centre crossfades)",
					),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if (!(a.clipId && a.edge) && !(a.track && a.at !== undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give clipId + edge, or track + at',
					'get_timeline lists clip ids and their start/end frames.',
				);
			const effectId = transitionEffectId(a.type);
			const spec = transitionSpec(effectId);
			return applyHelper(
				ctx,
				a.projectId,
				spec ? (spec.appliesTo === 'audio' ? 'Audio Fade' : spec.label) : 'Add Transition',
				[
					{
						type: 'transition.add',
						effectId,
						duration: a.durationFrames,
						...(a.params ? { params: a.params } : {}),
						...(a.clipId ? { clipId: a.clipId, edge: a.edge } : { trackId: a.track, at: a.at }),
						...(a.alignment ? { alignment: a.alignment } : {}),
						...(a.cutOffset !== undefined ? { cutOffset: a.cutOffset } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'add_marker',
		{
			title: 'Add marker',
			description:
				'Adds a sequence marker (marker.add) shown on the timeline ruler, with an optional comment and duration.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Marker time'),
				name: z.string().max(200).describe('Marker name'),
				comment: z.string().max(2000).optional().describe('Longer note shown in the Markers panel'),
				duration: timeArg('Span marker length (default 0)').optional(),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async ({ projectId, at, name, comment, duration, sequenceId }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{
					label: `Marker "${name.slice(0, 30)}"`,
					commands: [
						{
							type: 'marker.add',
							frame: at,
							name,
							...(comment ? { comment } : {}),
							...(duration !== undefined ? { duration } : {}),
							...(sequenceId ? { sequenceId } : {}),
						},
					],
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	// add_motion_graphic: single item or items[], presets, first-free placement, fill, dry run + preview (its own
	// module, add-motion-graphic.ts).
	registerAddMotionGraphic(ctx);
	// duplicate_motion_graphic ("Add another") and import_motion_graphics_csv (bulk-motion-graphics.ts).
	registerBulkMotionGraphics(ctx);
}
