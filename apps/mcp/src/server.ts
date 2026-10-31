// The JasperEditor MCP server (tools, resources, prompts). Transport-agnostic: `cli.ts` serves it over
// stdio (jasper-mcp), the engine serves the same definitions over Streamable HTTP at /mcp.

import { expressionReferenceMarkdown } from '@jasper/expressions';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadDoc, makeContext, type ToolContext } from './context.ts';
import { pickSequence, timelineTable } from './format.ts';
import type { EngineConnection } from './link.ts';
import { installStrictValidation } from './strict.ts';
import { ANIMATION_GUIDE, registerAnimationTools } from './tools/animation.ts';
import { AUDIO_GUIDE, registerAudioTools } from './tools/audio.ts';
import { AUDIO_FX_GUIDE, registerAudioFxTools } from './tools/audio-fx.ts';
import { AUTOMATION_GUIDE, registerAutomationTools } from './tools/automation.ts';
import { registerBriefTools } from './tools/brief.ts';
import { CACHE_GUIDE, registerCacheTools } from './tools/cache.ts';
import { CAPTIONS_GUIDE, registerCaptionTools } from './tools/captions.ts';
import { CLEANUP_GUIDE, registerCleanupTools } from './tools/cleanup.ts';
import { CLIPBOARD_GUIDE, registerClipboardTools } from './tools/clipboard.ts';
import { COLOR_GUIDE, registerColorTools } from './tools/color.ts';
import { COLOR_MGMT_GUIDE, registerColorMgmtTools } from './tools/color-mgmt.ts';
import { COMPOSITION_GUIDE, registerCompositionTools } from './tools/compositions.ts';
import { EASE_GUIDE, registerEaseTools } from './tools/ease.ts';
import { EDIT_UX_GUIDE, registerEditUxTools } from './tools/edit-ux.ts';
import { registerEditingTools } from './tools/editing.ts';
import { EXPRESSIONS_GUIDE, registerExpressionTools } from './tools/expressions.ts';
import { FONTS_GUIDE, registerFontTools } from './tools/fonts.ts';
import { GAPS_GUIDE, registerGapsTools } from './tools/gaps.ts';
import { GLOSSARY_GUIDE, registerGlossaryTools } from './tools/glossary.ts';
import { registerGradingTools } from './tools/grading.ts';
import { IMPORTS_GUIDE, registerImportsTools } from './tools/imports.ts';
import { INSPECT_GUIDE, registerInspectTools } from './tools/inspect.ts';
import { INTERCHANGE_GUIDE, registerInterchangeTools } from './tools/interchange.ts';
import { KEYFRAMES_BLEND_GUIDE, registerKeyframesBlendTools } from './tools/keyframes-blend.ts';
import { MASKS_GUIDE, registerMaskTools } from './tools/masks.ts';
import { MOTION_PATH_GUIDE, registerMotionPathTools } from './tools/motion-path.ts';
import { MULTICAM_GUIDE, registerMulticamTools } from './tools/multicam.ts';
import { POLISH_GUIDE, registerPolishTools } from './tools/polish.ts';
import { PRESETS_GUIDE, registerPresetTools } from './tools/presets.ts';
import { PREVIEWS_GUIDE, registerPreviewTools } from './tools/previews.ts';
import { PROCESSING_GUIDE, registerProcessingTools } from './tools/processing.ts';
import { registerProjectTools } from './tools/projects.ts';
import { PROPOSALS_GUIDE, registerProposalTools } from './tools/proposals.ts';
import { registerRenderTools } from './tools/render.ts';
import { ROTO_GUIDE, registerRotoTools } from './tools/roto.ts';
import { registerShapeTools, registerVectorShapeTools, SHAPES_GUIDE } from './tools/shapes.ts';
import { registerSimWarpTools, SIM_WARP_GUIDE } from './tools/sim-warp.ts';
import { registerSoundTools, SOUND_GUIDE } from './tools/sound.ts';
import { registerSoundBedTools } from './tools/sound-beds.ts';
import { registerSoundCheckTools } from './tools/sound-check.ts';
import { registerSoundDesignTools } from './tools/sound-design.ts';
import { registerSoundListenTools } from './tools/sound-listen.ts';
import { registerSoundMotionTools } from './tools/sound-motion.ts';
import { registerSoundProfileTools } from './tools/sound-profile.ts';
import { registerSoundSemanticTools } from './tools/sound-semantic.ts';
import { registerSoundTimelineTools } from './tools/sound-timeline.ts';
import { registerSpeechTools, SPEECH_GUIDE } from './tools/speech.ts';
import { registerStructureTools, STRUCTURE_GUIDE } from './tools/structure.ts';
import { registerStyleTools, STYLE_GUIDE } from './tools/style.ts';
import { registerSubtitleTools, SUBTITLES_GUIDE } from './tools/subtitles.ts';
import { registerTemplateTools, TEMPLATES_GUIDE } from './tools/templates.ts';
import { registerTextAnimatorTools, TEXT_ANIMATORS_GUIDE } from './tools/text-animators.ts';
import { registerTextStyleTools, TEXT_STYLES_GUIDE } from './tools/text-styles.ts';
import { registerThreeDTools, THREE_D_GUIDE } from './tools/three-d.ts';
import { registerTimeTools, TIME_GUIDE } from './tools/time.ts';
import { registerTrackingTools, TRACKING_GUIDE } from './tools/tracking.ts';
import { registerTranscriptFixTools, TRANSCRIPT_FIX_GUIDE } from './tools/transcript-fix.ts';
import { registerTransitionTools, TRANSITION_GUIDE } from './tools/transitions.ts';
import { registerTrimPathTools, TRIM_PATHS_GUIDE } from './tools/trim-paths.ts';
import { registerUiTools, UI_GUIDE } from './tools/ui.ts';
import { registerVersionTools, VERSIONS_GUIDE } from './tools/versions.ts';
import { registerVoiceTools, VOICE_GUIDE } from './tools/voice.ts';
import { MCP_SERVER_VERSION } from './version.ts';

const MCP_SERVER_NAME = 'jasper-editor';

/** How to drive JasperEditor; sent as the server's `instructions` and by the `edit-video` prompt. */
export const EDITING_GUIDE = `JasperEditor is a Premiere-style video editor. These tools edit its projects through the local engine.

Workflow:
1. list_projects (or create_project) → projectId. open_project_in_editor if the user wants to watch; edits then appear live in their editor window, each as one undoable "Agent: <label>" History entry.
2. import_media with absolute file paths → mediaIds. get_media_info for durations and streams.
3. Build the cut: add_clip / move_clip / trim_clip / split_at / delete_clips / add_text / add_marker / add_motion_graphic / add_transition, or apply_commands for anything else (describe_commands lists every command with schemas and examples). Several related changes belong in one apply_commands transaction (atomic, one undo step).
4. Check it: get_timeline (text table) and render_frame (PNG of the Program output at a time).
5. start_export → wait_for_job → the output file.

Rules:
- Times are sequence frames; every time argument of these tools also accepts {"seconds": x}, "3s" / "1.5s" / "250ms", a clock "00:03" (M:SS) or "1:02:03" (H:MM:SS), or timecode "HH:MM:SS:FF" (four fields are always timecode). Commands inside apply_commands take frames, {"frames": n}, {"seconds": x} or timecode. Results give both frames and timecode.
- add_motion_graphic never overwrites unless you name a track: graphics go on the first free video track for their time range (one call can add many: items[], one undo step). duplicate_motion_graphic adds another after an existing graphic (fresh random identity and stats for social comments); import_motion_graphics_csv adds one graphic per CSV / TSV row.
- Tracks are "V1", "V2"… (video, V1 lowest) and "A1", "A2"… (audio). A video file placed with add_clip creates a linked video+audio pair.
- Deleting tracks/items or anything with force: true needs the user's approval in an open editor window; if they deny it (E_APPROVAL_DENIED), do not retry without asking.
- The same goes for destructive operations outside the timeline: deleting an effect preset, removing a downloaded model, cleaning cache that saved projects use, deleting all render files, moving the cache, restoring a version over a project, changing processing settings. The user answers on a card in the editor; only they can (you cannot approve or deny through any tool).
- A clip's video effects render top to bottom in stack order (Premiere's standard effects), Crop included, then Motion and Opacity: Crop before or after a Horizontal Flip, Mirror or blur gives a different picture (apply_commands effect.reorder moves an effect). Crop's Edge Feather (px of the clip's own frame) fades the picture in from each crop edge.
- Undo/redo only touch this agent's own History entries.
- Errors come back as tool errors with a code and a hint on what to do next.
- Arguments are strict: an unknown key (at any depth, in tool arguments and inside apply_commands commands) is an error (E_UNKNOWN_ARGUMENT / E_SCHEMA) naming it, the accepted keys and the likely typo — never silently ignored.
- Long calls (start_export with wait, wait_for_job, render_frame(s), process_clip, track, prerender_composition, track_mask, normalize_media_loudness…) send progress notifications (at most one per 100 ms) when you pass a progressToken; cancelling the request (notifications/cancelled) cancels the engine job and the engine deletes its partial output.
- Every tool carries readOnlyHint / destructiveHint / idempotentHint / openWorldHint, so read-only tools can run without asking.
- The same tools run from a shell: \`jasper\` (pnpm jasper --help), e.g. \`jasper exec marker.add frame=30 name=Intro\`, \`jasper props <clipId>\`, \`jasper render-frame --at 2s --out f.png\`, \`jasper export --out cut.mp4\`.`;

const FULL_GUIDE = [
	EDITING_GUIDE,
	COLOR_GUIDE,
	PROCESSING_GUIDE,
	COMPOSITION_GUIDE,
	TRACKING_GUIDE,
	TRANSITION_GUIDE,
	ANIMATION_GUIDE,
	TEXT_ANIMATORS_GUIDE,
	MOTION_PATH_GUIDE,
	KEYFRAMES_BLEND_GUIDE,
	EASE_GUIDE,
	THREE_D_GUIDE,
	MASKS_GUIDE,
	SHAPES_GUIDE,
	TRIM_PATHS_GUIDE,
	TEMPLATES_GUIDE,
	CLIPBOARD_GUIDE,
	PRESETS_GUIDE,
	FONTS_GUIDE,
	CACHE_GUIDE,
	PREVIEWS_GUIDE,
	STRUCTURE_GUIDE,
	TIME_GUIDE,
	COLOR_MGMT_GUIDE,
	EDIT_UX_GUIDE,
	MULTICAM_GUIDE,
	VERSIONS_GUIDE,
	AUDIO_GUIDE,
	AUDIO_FX_GUIDE,
	SOUND_GUIDE,
	PROPOSALS_GUIDE,
	AUTOMATION_GUIDE,
	STYLE_GUIDE,
	CAPTIONS_GUIDE,
	SUBTITLES_GUIDE,
	TEXT_STYLES_GUIDE,
	SPEECH_GUIDE,
	GLOSSARY_GUIDE,
	TRANSCRIPT_FIX_GUIDE,
	VOICE_GUIDE,
	CLEANUP_GUIDE,
	ROTO_GUIDE,
	SIM_WARP_GUIDE,
	INTERCHANGE_GUIDE,
	IMPORTS_GUIDE,
	INSPECT_GUIDE,
	UI_GUIDE,
	EXPRESSIONS_GUIDE,
	GAPS_GUIDE,
	POLISH_GUIDE,
].join('\n\n');

type JasperMcpOptions = {
	link: EngineConnection;
	/** Name recorded in History origins; default = the MCP client's name (e.g. "claude-code"). */
	agentName?: string;
};

export function createJasperMcpServer(opts: JasperMcpOptions): { server: McpServer } {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, title: 'JasperEditor', version: MCP_SERVER_VERSION },
		{
			instructions: FULL_GUIDE,
			capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
		},
	);
	// Strict arguments for every tool on this server (strict.ts): unknown keys are errors, never dropped.
	installStrictValidation(server);
	const ctx = makeContext(server, opts.link, opts.agentName);
	registerProjectTools(ctx);
	registerEditingTools(ctx);
	registerRenderTools(ctx);
	registerColorTools(ctx);
	registerGradingTools(ctx);
	registerProcessingTools(ctx);
	registerCompositionTools(ctx);
	registerTrackingTools(ctx);
	registerTransitionTools(ctx);
	registerAnimationTools(ctx);
	registerTextAnimatorTools(ctx);
	registerMotionPathTools(ctx);
	registerKeyframesBlendTools(ctx);
	registerEaseTools(ctx);
	registerThreeDTools(ctx);
	registerMaskTools(ctx);
	registerShapeTools(ctx);
	registerVectorShapeTools(ctx);
	registerTrimPathTools(ctx);
	registerTemplateTools(ctx);
	registerClipboardTools(ctx);
	registerPresetTools(ctx);
	registerFontTools(ctx);
	registerCacheTools(ctx);
	registerPreviewTools(ctx);
	registerStructureTools(ctx);
	registerTimeTools(ctx);
	registerColorMgmtTools(ctx);
	registerImportsTools(ctx);
	registerEditUxTools(ctx);
	registerMulticamTools(ctx);
	registerVersionTools(ctx);
	registerAudioTools(ctx);
	registerAudioFxTools(ctx);
	registerSoundTools(ctx);
	registerSoundDesignTools(ctx);
	registerSoundBedTools(ctx);
	registerSoundCheckTools(ctx);
	registerSoundMotionTools(ctx);
	registerSoundTimelineTools(ctx);
	registerSoundListenTools(ctx);
	registerSoundSemanticTools(ctx);
	registerSoundProfileTools(ctx);
	registerProposalTools(ctx);
	registerAutomationTools(ctx);
	registerStyleTools(ctx);
	registerCaptionTools(ctx);
	registerSubtitleTools(ctx);
	registerTextStyleTools(ctx);
	registerSpeechTools(ctx);
	registerGlossaryTools(ctx);
	registerVoiceTools(ctx);
	registerCleanupTools(ctx);
	registerTranscriptFixTools(ctx);
	registerRotoTools(ctx);
	registerSimWarpTools(ctx);
	registerInterchangeTools(ctx);
	registerInspectTools(ctx);
	registerUiTools(ctx);
	registerExpressionTools(ctx);
	registerGapsTools(ctx);
	registerPolishTools(ctx);
	registerBriefTools(ctx);
	registerResources(ctx);
	registerPrompts(ctx);
	return { server };
}

function registerResources(ctx: ToolContext): void {
	const list = async () => {
		const { projects } = await ctx.engine((c) => c.listProjects());
		return projects;
	};
	ctx.server.registerResource(
		'project-document',
		new ResourceTemplate('jasper://projects/{projectId}/document', {
			list: async () => ({
				resources: (await list()).map((p) => ({
					uri: `jasper://projects/${p.projectId}/document`,
					name: `${p.name} (document)`,
					mimeType: 'application/json',
				})),
			}),
		}),
		{
			title: 'Project document',
			description:
				'The full JasperEditor project document (JSON, schema @jasper/project): media, items, sequences, tracks, clips with every property. Large; prefer get_project / get_timeline for overviews.',
			mimeType: 'application/json',
		},
		async (uri, { projectId }) => {
			const { doc } = await loadDoc(ctx, String(projectId));
			return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(doc) }] };
		},
	);
	ctx.server.registerResource(
		'project-timeline',
		new ResourceTemplate('jasper://projects/{projectId}/timeline', {
			list: async () => ({
				resources: (await list()).map((p) => ({
					uri: `jasper://projects/${p.projectId}/timeline`,
					name: `${p.name} (timeline)`,
					mimeType: 'text/plain',
				})),
			}),
		}),
		{
			title: 'Project timeline',
			description: 'The first sequence of a project as the get_timeline text table.',
			mimeType: 'text/plain',
		},
		async (uri, { projectId }) => {
			const { doc, revision, live } = await loadDoc(ctx, String(projectId));
			const seq = pickSequence(doc);
			return {
				contents: [
					{ uri: uri.href, mimeType: 'text/plain', text: timelineTable(doc, seq, { revision, live }) },
				],
			};
		},
	);
	ctx.server.registerResource(
		'cleanup-guide',
		'jasper://guide/cleanup',
		{
			title: 'Cleaning up speech',
			description:
				'How to remove retakes, fillers, pauses and breaths from recorded speech with analyze_voice / plan_cleanup / apply_cleanup, and the recommended agent policy.',
			mimeType: 'text/markdown',
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'text/markdown',
					text: `# Cleaning up speech\n\n${CLEANUP_GUIDE}\n\n${VOICE_GUIDE}`,
				},
			],
		}),
	);
	ctx.server.registerResource(
		'transcript-fix-guide',
		'jasper://guide/transcript-fix',
		{
			title: 'Fixing transcripts from a script',
			description:
				"How to fix a transcript's recognition errors from the video's script and the personal glossary: attach_script → fix_transcript (dryRun, then propose) → the user reviews → accept_proposal (subtitles are patched in place) → plan_cleanup.",
			mimeType: 'text/markdown',
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'text/markdown',
					text: `# Fixing transcripts from a script\n\n${TRANSCRIPT_FIX_GUIDE}\n\n## Personal glossary\n\n${GLOSSARY_GUIDE}`,
				},
			],
		}),
	);
	ctx.server.registerResource(
		'automation-guide',
		'jasper://guide/editing-automation',
		{
			title: 'Editing automation',
			description:
				'How to decorate an edit with the spec 15 passes (cut kits, punch-ins, Ken Burns, reactions, slides, music beds, stingers), style recipes, apply_style and style_check, with the recommended agent workflow: fix the transcript from the script → cleanup → subtitles → apply_style → review → accept → style_check.',
			mimeType: 'text/markdown',
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'text/markdown',
					text: `# Editing automation\n\n${AUTOMATION_GUIDE}\n\n## Style recipes\n\n${STYLE_GUIDE}`,
				},
			],
		}),
	);
	ctx.server.registerResource(
		'editing-guide',
		'jasper://guide',
		{
			title: 'JasperEditor editing guide',
			description: 'How to drive JasperEditor with these tools.',
			mimeType: 'text/markdown',
		},
		// Wave expressions: the guide resource carries the full expression language reference.
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'text/markdown',
					text: `${FULL_GUIDE}\n\n${expressionReferenceMarkdown()}`,
				},
			],
		}),
	);
}

function registerPrompts(ctx: ToolContext): void {
	ctx.server.registerPrompt(
		'edit-video',
		{
			title: 'Edit a video with JasperEditor',
			description: 'Guidance and a plan template for editing a video project with the JasperEditor tools.',
			argsSchema: {
				goal: z.string().describe('What the edit should achieve, e.g. "a 30 s teaser from interview.mp4"'),
				projectId: z.string().optional().describe('Existing project to edit (default: create one)'),
			},
		},
		({ goal, projectId }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: `${FULL_GUIDE}

Task: ${goal}
${projectId ? `Work in project ${projectId} (start with get_project).` : 'Create a project for it (create_project), or ask which existing project to use (list_projects).'}
Plan the cut first (shots, order, timings), apply it in a few well-labelled transactions, check key frames with render_frame, then tell me what you did and offer to export.`,
					},
				},
			],
		}),
	);
}
