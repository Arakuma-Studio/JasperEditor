// Toolsets (spec 18 AF-CTX-001/002, docs/wp-notes/agent-footage-context.md): every MCP tool belongs to exactly one
// named toolset. A session advertises (`tools/list`) the `core` toolset plus the ones chosen with
// `JASPER_MCP_TOOLSETS` / `--toolsets` or `enable_toolsets`; every registered tool stays callable:
//   - by name when its toolset is advertised (a tool of another toolset returns E_TOOLSET_NOT_ENABLED naming it);
//   - through core `call_tool {name, arguments}` always (the same SDK pipeline as a direct call: strict
//     validation, handler, error results, progress and cancellation on the caller's request).
// All tools stay registered and enabled in the SDK; this module filters `tools/list` and gates `tools/call`
// around the SDK's own handlers, so `call_tool` reuses them verbatim and one `enable_toolsets` call sends one
// `notifications/tools/list_changed`.
//
// Adding a tool to a toolset is one line in TOOLSETS below; `apps/mcp/test/toolsets.test.ts` fails on a
// registered tool that is unmapped or mapped twice, and on a mapped name that is not registered.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT_IDEMPOTENT,
	type Extra,
	READ_ONLY,
	type ToolContext,
} from './context.ts';
import { jsonResult, ToolError, toErrorResult } from './errors.ts';

type ToolsetDef = {
	name: string;
	description: string;
	/** Guide topics (`get_guide {topic}`, `jasper://guide/<topic>`) for this toolset's tools. */
	guides: readonly string[];
	tools: readonly string[];
};

/** At most this many tools in `core` (spec 18 AF-CTX-001). */
export const CORE_TOOL_BUDGET = 32;

/** The toolsets, in the order `list_toolsets` and the server instructions show them. `core` is always on. */
export const TOOLSETS = [
	{
		name: 'core',
		description:
			'Always on: projects, reading the timeline, commands, the main edits, footage digest/takes/view, proposals, brief, export and verification, guides and these toolset tools.',
		guides: ['editing', 'proposals'],
		tools: [
			'list_toolsets',
			'enable_toolsets',
			'disable_toolsets',
			'call_tool',
			'describe_tool',
			'get_guide',
			'list_projects',
			'create_project',
			'get_project',
			'import_media',
			'get_timeline',
			'describe_commands',
			'apply_commands',
			'undo',
			'add_clip',
			'trim_clip',
			'split_at',
			'delete_clips',
			'render_frame',
			'transcribe',
			'wait_for_proposal',
			'start_export',
			'wait_for_job',
			'get_brief',
			'set_brief',
			'list_agent_notes',
			'add_agent_note',
			'get_footage_digest',
			'find_takes',
			'view_media_range',
			'propose_edits',
			'verify_export',
		],
	},
	{
		name: 'project',
		description: 'Engine status, opening the editor, project and sequence settings, versions, cache, fonts.',
		guides: ['versions', 'cache', 'fonts', 'project-settings'],
		tools: [
			'engine_status',
			'open_project_in_editor',
			'find',
			'get_project_settings',
			'set_project_settings',
			'get_sequence_settings',
			'set_sequence_settings',
			'new_sequence_from_clip',
			'project_manager',
			'list_project_versions',
			'restore_project_version',
			'save_project_copy',
			'list_unsaved_changes',
			'set_cache_location',
			'get_cache_usage',
			'clean_cache',
			'list_fonts',
			'install_font',
			'remove_font',
		],
	},
	{
		name: 'media',
		description:
			'Media info, browsing and relinking, footage interpretation, image sequences, layered/PDF imports, proxies, derived media.',
		guides: ['imports', 'browse-media', 'project-settings', 'derive'],
		tools: [
			'list_media',
			'get_media_info',
			'browse_media_files',
			'locate_media',
			'get_media_interpretation',
			'interpret_footage',
			'detect_image_sequence',
			'import_image_sequence',
			'list_document_layers',
			'import_layered_document',
			'import_pdf_pages',
			'list_offline_media',
			'link_media',
			'replace_footage',
			'set_media_source_range',
			'use_media_version',
			'create_proxies',
			'attach_proxy',
			'detach_proxies',
			'reconnect_full_resolution',
			'derive_media',
		],
	},
	{
		name: 'processing',
		description:
			'Clip processing (restoration, upscaling, denoise…) models and settings, remote executors, Warp Stabilizer.',
		guides: ['processing'],
		tools: [
			'list_processing_models',
			'install_processing_model',
			'process_clip',
			'get_processing_settings',
			'set_processing_settings',
			'test_remote_executor',
			'stabilize_clip',
		],
	},
	{
		name: 'editing',
		description:
			'More timeline edits: move, redo, markers, tracks, playhead, copy/paste, three-point edits, trims, match frame, subclips, property reads, Auto Reframe.',
		guides: ['edit-ux', 'clipboard', 'inspect'],
		tools: [
			'redo',
			'move_clip',
			'add_marker',
			'add_tracks',
			'delete_tracks',
			'get_playhead',
			'set_playhead',
			'copy_clips',
			'paste_clips',
			'copy_items',
			'paste_items',
			'match_frame',
			'reverse_match_frame',
			'source_edit',
			'find_edit_points',
			'trim_edit_points',
			'make_subclip',
			'edit_subclip',
			'set_split_marks',
			'get_clip_properties',
			'get_param',
			'auto_reframe_sequence',
		],
	},
	{
		name: 'structure',
		description:
			'Nests, adjustment layers, groups, sequences, synthetics, cuts and through edits, gaps, subsequences, frame holds.',
		guides: ['structure'],
		tools: [
			'nest_clips',
			'unnest_clips',
			'place_sequence',
			'list_nests',
			'add_adjustment_layer',
			'group_clips',
			'ungroup_clips',
			'duplicate_sequence',
			'delete_sequence',
			'remove_unused_media',
			'create_synthetic',
			'update_synthetic',
			'list_through_edits',
			'list_cuts',
			'join_through_edits',
			'find_gaps',
			'make_subsequence',
			'add_frame_hold',
			'insert_frame_hold_segment',
			'frame_hold_options',
		],
	},
	{
		name: 'time',
		description:
			'Speed, time remapping, freeze and reverse segments, time interpolation, scene edit detection.',
		guides: ['time'],
		tools: [
			'get_time_remap',
			'set_time_remap',
			'set_segment_speed',
			'add_speed_keyframe',
			'remove_speed_keyframes',
			'move_speed_keyframe',
			'set_speed_transition',
			'add_freeze_segment',
			'add_reverse_segment',
			'set_time_interpolation',
			'detect_scene_edits',
		],
	},
	{
		name: 'multicam',
		description: 'Synchronize clips, merged clips, multi-camera sequences, angle switching and recording.',
		guides: ['multicam'],
		tools: [
			'measure_audio_sync',
			'synchronize_clips',
			'merge_clips',
			'create_multicam_sequence',
			'switch_multicam_angle',
			'record_multicam_cuts',
			'set_multicam_enabled',
			'flatten_multicam',
			'edit_multicam_cameras',
			'get_multicam',
		],
	},
	{
		name: 'transitions',
		description: 'Video and audio transitions: add, list, update, remove, defaults.',
		guides: ['transitions'],
		tools: [
			'add_transition',
			'list_transition_types',
			'list_transitions',
			'update_transition',
			'remove_transitions',
			'apply_default_transitions',
			'set_transition_defaults',
		],
	},
	{
		name: 'color',
		description:
			'Lumetri grading, LUTs, scopes, colour match, looks, colour management (working spaces, HDR, log, OCIO).',
		guides: ['color', 'color-management'],
		tools: [
			'import_lut',
			'grade_clip',
			'get_grade',
			'copy_grade',
			'scopes_read',
			'color_match',
			'auto_tone',
			'list_looks',
			'list_color_spaces',
			'get_color_settings',
			'set_working_color_space',
			'interpret_footage_color',
			'set_clip_color_space',
			'import_ocio_config',
		],
	},
	{
		name: 'effects',
		description: 'Effect presets, blend modes, masks and track mattes, puppet / liquify / mesh warps.',
		guides: ['presets', 'keyframes-blend', 'masks', 'sim-warp'],
		tools: [
			'list_effect_presets',
			'get_effect_preset',
			'apply_effect_preset',
			'save_effect_preset',
			'delete_effect_preset',
			'list_blend_modes',
			'set_blend_mode',
			'list_masks',
			'add_mask',
			'edit_mask',
			'remove_masks',
			'track_mask',
			'auto_trace_mask',
			'set_track_matte',
			'get_puppet',
			'add_puppet_pins',
			'move_puppet_pins',
			'record_puppet_pins',
			'remove_puppet_pins',
			'liquify_stroke',
			'set_mesh_warp_vertex',
		],
	},
	{
		name: 'keyframes',
		description: 'Keyframe easing and velocity, motion paths, roving keyframes, expressions.',
		guides: ['ease', 'motion-path', 'keyframes-blend', 'expressions'],
		tools: [
			'get_motion_path',
			'set_spatial_interpolation',
			'set_roving',
			'list_ease_presets',
			'get_keyframe_eases',
			'apply_ease',
			'transfer_ease',
			'transfer_keyframe_values',
			'set_keyframe_velocity',
			'create_path_controller',
			'cleanup_motion_path',
			'simplify_keyframes',
			'set_expression',
			'clear_expression',
			'enable_expression',
			'test_expression',
			'get_property_values',
			'list_expression_properties',
			'list_expression_presets',
			'add_expression_control',
		],
	},
	{
		name: 'text',
		description: 'Titles: text clips, text animations and animators, text on a path, text styles.',
		guides: ['text-animation', 'text-animators', 'text-styles'],
		tools: [
			'add_text',
			'list_text_animations',
			'set_text_animation',
			'list_text_animator_presets',
			'apply_text_animator_preset',
			'add_text_animator',
			'add_text_selector',
			'get_text_animators',
			'remove_text_animators',
			'set_text_path',
			'convert_text_animation',
			'style_text',
			'list_text_styles',
			'create_text_style',
			'apply_text_style',
			'update_text_style',
			'delete_text_style',
		],
	},
	{
		name: 'graphics',
		description:
			'Motion-graphic templates (social comments, lower thirds…), Remotion compositions, Essential Graphics templates.',
		guides: ['templates', 'compositions'],
		tools: [
			'add_motion_graphic',
			'duplicate_motion_graphic',
			'import_motion_graphics_csv',
			'list_motion_templates',
			'render_motion_graphic_preview',
			'set_motion_graphic_params',
			'import_mg_bundle',
			'list_compositions',
			'add_composition',
			'set_composition_props',
			'prerender_composition',
			'list_composition_texts',
			'set_composition_text',
			'scaffold_mg_project',
			'create_graphic',
			'set_graphic',
			'export_graphic_template',
			'import_graphic_template',
		],
	},
	{
		name: 'shapes',
		description: 'Rectangles, ellipses and vector shapes, SVG import, path editing, Trim Paths.',
		guides: ['shapes', 'trim-paths'],
		tools: [
			'add_shape',
			'list_shape_presets',
			'add_vector_shape',
			'svg_to_shape',
			'get_shape',
			'add_shape_items',
			'update_shape_item',
			'remove_shape_items',
			'move_shape_item',
			'group_shape_items',
			'duplicate_shape_item',
			'edit_shape_path',
			'convert_shape_to_vector',
			'animate_trim_paths',
			'reverse_path_direction',
			'add_line',
			'add_trim_tracer',
		],
	},
	{
		name: '3d',
		description: '3D layers, materials, cameras, lights, the 3D renderer and the 3D camera tracker.',
		guides: ['3d'],
		tools: [
			'set_3d_layer',
			'set_3d_transform',
			'set_material',
			'add_camera',
			'camera_settings',
			'move_camera',
			'add_light',
			'light_settings',
			'set_3d_renderer',
			'get_3d_scene',
			'track_camera',
			'get_camera_tracker',
			'create_tracked_camera',
			'set_tracker_ground',
			'delete_track_points',
		],
	},
	{
		name: 'vfx',
		description: 'Point/planar tracking and corner pins, roto / object mattes, face tracking and blurring.',
		guides: ['tracking', 'roto'],
		tools: [
			'add_tracker',
			'track',
			'apply_tracking',
			'get_tracker',
			'set_corner_pin',
			'list_roto_models',
			'install_roto_model',
			'remove_roto_model',
			'create_roto',
			'add_roto_strokes',
			'propagate_roto',
			'get_roto',
			'apply_object_matte',
			'convert_roto_to_masks',
			'freeze_roto',
			'remove_roto',
			'track_faces',
			'blur_faces',
			'face_to_keyframes',
		],
	},
	{
		name: 'audio',
		description:
			'Loudness, mixer, submixes, sends, automation, ducking, audio effects, Essential Sound, remix and music fitting, audio channels.',
		guides: ['audio', 'audio-fx'],
		tools: [
			'measure_loudness',
			'get_mixer',
			'set_mixer_strip',
			'add_submix',
			'add_send',
			'write_automation',
			'set_audio_gain',
			'auto_duck',
			'set_loudness_normalization',
			'normalize_media_loudness',
			'list_audio_effects',
			'get_audio_effects',
			'add_audio_effect',
			'set_audio_effect',
			'remove_audio_effect',
			'get_essential_sound',
			'set_essential_sound',
			'clear_essential_sound',
			'auto_match_loudness',
			'auto_tag_audio',
			'generate_essential_ducking',
			'remix_audio',
			'find_music_drops',
			'fit_music_to_picture',
			'revert_remix',
			'get_audio_channels',
			'set_audio_channels',
		],
	},
	{
		name: 'sound',
		description:
			'The sound-effect library: search, describe-search, import, insert, packs, folders, credits, sound profiles.',
		guides: ['sound'],
		tools: [
			'sound_library_status',
			'search_sounds',
			'get_sound',
			'view_sounds',
			'import_sounds',
			'insert_sound',
			'list_sound_credits',
			'export_sound_credits',
			'add_sound_folder',
			'remove_sound_folder',
			'rescan_sound_library',
			'list_sound_packs',
			'install_sound_pack',
			'remove_sound_pack',
			'describe_search_status',
			'install_describe_search_model',
			'remove_describe_search_model',
			'prepare_describe_search',
			'match_sound',
			'find_sound_moment',
			'insert_sound_moment',
			'list_sound_profiles',
			'get_sound_profile',
			'build_sound_profile',
			'rename_sound_profile',
			'delete_sound_profile',
			'export_sound_profile',
			'import_sound_profile',
			'set_sound_profile',
		],
	},
	{
		name: 'sound-design',
		description:
			'Sound design passes: plan, cues, placement, peaks, beds and room tone, Sound Check, picture motion, listening sheets.',
		guides: ['sound'],
		tools: [
			'plan_sound_design',
			'rebalance_sfx',
			'apply_delivery',
			'set_room_glue',
			'find_sound_cues',
			'set_sound_cues',
			'place_sound',
			'swap_sound',
			'align_peak',
			'detect_sound_peak',
			'lay_ambience_bed',
			'fill_room_tone',
			'sound_check',
			'get_sound_check',
			'acknowledge_sound_issue',
			'analyze_picture_motion',
			'view_sound_timeline',
			'listen_to_sequence',
		],
	},
	{
		name: 'transcript',
		description:
			'Speech models and transcripts, text-based editing, voice analysis and speech cleanup, script fixes, glossary.',
		guides: ['speech', 'cleanup', 'transcript-fix', 'voice', 'glossary'],
		tools: [
			'list_speech_models',
			'install_speech_model',
			'remove_speech_model',
			'get_transcript',
			'import_transcript',
			'transcript_inspect',
			'transcript_search',
			'transcript_select',
			'transcript_extract',
			'transcript_lift',
			'insert_transcript_selection',
			'remove_fillers',
			'remove_pauses',
			'rename_speaker',
			'get_voice_analysis',
			'analyze_voice',
			'plan_cleanup',
			'apply_cleanup',
			'set_cleanup_settings',
			'attach_script',
			'fix_transcript',
			'list_glossary',
			'save_glossary_entry',
			'remove_glossary_entry',
		],
	},
	{
		name: 'captions',
		description:
			'Caption tracks, import/export (SRT, VTT…), automatic subtitles, caption groups, subtitle templates.',
		guides: ['captions', 'subtitles'],
		tools: [
			'import_captions',
			'export_captions',
			'list_captions',
			'add_caption',
			'edit_caption',
			'split_captions',
			'merge_captions',
			'delete_captions',
			'style_captions',
			'caption_track',
			'captions_from_transcript',
			'list_caption_groups',
			'align_captions_to_cuts',
			'convert_captions',
			'regenerate_captions',
			'list_subtitle_templates',
			'save_subtitle_template',
			'apply_subtitle_template',
			'delete_subtitle_template',
		],
	},
	{
		name: 'review',
		description: 'Proposals beyond waiting: features and policies, list, read, refresh, accept, reject.',
		guides: ['proposals'],
		tools: [
			'list_proposal_features',
			'list_proposals',
			'get_proposal',
			'refresh_proposal',
			'accept_proposal',
			'reject_proposal',
		],
	},
	{
		name: 'automation',
		description:
			'Editing automation passes (cut kits, punch-ins, Ken Burns, reactions, slides, music beds, stingers) and style recipes.',
		guides: ['editing-automation', 'style'],
		tools: [
			'decorate_cuts',
			'add_punch_ins',
			'add_ken_burns',
			'place_reactions',
			'slide_overlays',
			'lay_music_bed',
			'add_stingers',
			'list_style_recipes',
			'get_style_recipe',
			'save_style_recipe',
			'apply_style',
			'style_check',
		],
	},
	{
		name: 'export',
		description:
			'Export presets and jobs, frame sequences and stills, timeline interchange (EDL, FCP XML, AAF, OTIO), Lottie, render previews.',
		guides: ['previews', 'interchange'],
		tools: [
			'list_export_presets',
			'get_job',
			'cancel_job',
			'render_frames',
			'export_frame',
			'import_timeline',
			'export_timeline',
			'export_lottie',
			'get_render_bar_state',
			'render_previews',
			'delete_render_files',
			'perf_stats',
		],
	},
	{
		name: 'ui',
		description: 'The live editor window: state, elements, screenshots, clicks, drags, keys, UI commands.',
		guides: ['ui'],
		tools: [
			'ui_state',
			'ui_elements',
			'ui_screenshot',
			'ui_click',
			'ui_drag',
			'ui_scroll',
			'ui_key',
			'ui_type',
			'ui_set',
			'ui_locate',
			'ui_hit',
			'ui_commands',
			'ui_command',
		],
	},
] as const satisfies readonly ToolsetDef[];

export type ToolsetName = (typeof TOOLSETS)[number]['name'];
export const TOOLSET_NAMES = TOOLSETS.map((t) => t.name) as readonly ToolsetName[];

const TOOLSET_BY_TOOL: ReadonlyMap<string, ToolsetName> = (() => {
	const m = new Map<string, ToolsetName>();
	for (const ts of TOOLSETS) for (const tool of ts.tools) if (!m.has(tool)) m.set(tool, ts.name);
	return m;
})();

/** The toolset of a tool name (undefined for an unmapped tool). */
export function toolsetOf(tool: string): ToolsetName | undefined {
	return TOOLSET_BY_TOOL.get(tool);
}

const isToolsetName = (s: string): s is ToolsetName => (TOOLSET_NAMES as readonly string[]).includes(s);

/**
 * The toolsets a session starts with from `--toolsets` / `JASPER_MCP_TOOLSETS`: `all`, or a comma list of names
 * (spaces and empty entries ignored). `core` is always included; an empty value means `core`. Throws an Error
 * naming the unknown entries and the valid names.
 */
export function parseToolsets(spec: string | readonly string[] | undefined): Set<ToolsetName> {
	const parts = (typeof spec === 'string' ? spec.split(',') : (spec ?? []))
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (parts.includes('all')) return new Set(TOOLSET_NAMES);
	const unknown = parts.filter((p) => !isToolsetName(p));
	if (unknown.length)
		throw new Error(
			`Unknown toolset${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}: use "all" or a comma list of ${TOOLSET_NAMES.join(', ')}`,
		);
	return new Set<ToolsetName>(['core', ...(parts as ToolsetName[])]);
}

type RawHandler = (request: unknown, extra: Extra) => Promise<unknown>;

/** The per-session advertised toolsets, wrapped around the SDK's `tools/list` and `tools/call` handlers. */
export type ToolsetController = {
	enabled(): ReadonlySet<ToolsetName>;
	/** Turns toolsets on (true) or off; sends one `notifications/tools/list_changed` when the set changed. */
	set(names: readonly ToolsetName[], on: boolean): boolean;
	/** Whether a registered tool name is advertised now (unmapped tools always are). */
	advertised(tool: string): boolean;
	/** Every registered tool with its definition as `tools/list` shows it, advertised or not. */
	allTools(): Promise<Tool[]>;
	/** Runs a registered tool through the SDK's `tools/call` pipeline, advertised or not. */
	call(name: string, args: unknown, extra: Extra): Promise<CallToolResult>;
};

/**
 * Installs the toolset filter on `server`. Call after every tool is registered (the SDK installs its tool handlers
 * with the first tool). Throws at start-up if the SDK's handler map is gone, so an SDK update cannot silently
 * advertise or hide the wrong tools (toolsets.test.ts covers it too).
 */
export function installToolsets(server: McpServer, initial: ReadonlySet<ToolsetName>): ToolsetController {
	const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RawHandler> })
		._requestHandlers;
	const list = handlers?.get('tools/list');
	const call = handlers?.get('tools/call');
	const tools = (server as unknown as { _registeredTools?: unknown })._registeredTools;
	if (!(handlers instanceof Map) || !list || !call || !tools || typeof tools !== 'object')
		throw new Error(
			'The MCP SDK no longer exposes its tools/list and tools/call handlers or its tool registry: update apps/mcp/src/toolsets.ts',
		);
	const on = new Set<ToolsetName>(initial);
	on.add('core');
	const advertised = (tool: string) => {
		const ts = toolsetOf(tool);
		return ts === undefined || on.has(ts);
	};
	// tools/list of every registered tool, kept until a tool is registered or removed (JSON Schemas are costly).
	let cache: { count: number; tools: Promise<Tool[]> } | null = null;
	const allTools = (extra: Extra): Promise<Tool[]> => {
		const count = registeredCount(server);
		if (!cache || cache.count !== count) {
			const tools = (list({ method: 'tools/list', params: {} }, extra) as Promise<{ tools: Tool[] }>).then(
				(r) => r.tools,
			);
			cache = { count, tools };
			tools.catch(() => {
				cache = null;
			});
		}
		return cache.tools;
	};
	handlers.set('tools/list', async (request, extra) => {
		const r = (await list(request, extra)) as { tools: Tool[] };
		return { ...r, tools: r.tools.filter((t) => advertised(t.name)) };
	});
	handlers.set('tools/call', async (request, extra) => {
		const name = (request as { params?: { name?: unknown } }).params?.name;
		if (typeof name === 'string' && !advertised(name) && registered(server, name))
			return toErrorResult(notEnabledError(name, toolsetOf(name)!));
		return call(request, extra);
	});
	return {
		enabled: () => on,
		set(names, enable) {
			let changed = false;
			for (const n of names) {
				if (n === 'core') continue;
				if (enable && !on.has(n)) {
					on.add(n);
					changed = true;
				} else if (!enable && on.delete(n)) changed = true;
			}
			if (changed) server.sendToolListChanged();
			return changed;
		},
		advertised,
		allTools: () => allTools({ signal: new AbortController().signal } as Extra),
		async call(name, args, extra) {
			const params = {
				name,
				arguments: args ?? {},
				...(extra._meta ? { _meta: extra._meta } : {}),
			};
			return (await call({ method: 'tools/call', params }, extra)) as CallToolResult;
		},
	};
}

const registeredTools = (server: McpServer) =>
	(server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};

function registered(server: McpServer, name: string): boolean {
	return Object.hasOwn(registeredTools(server), name);
}

function registeredCount(server: McpServer): number {
	return Object.keys(registeredTools(server)).length;
}

function notEnabledError(name: string, toolset: ToolsetName): ToolError {
	return new ToolError(
		'E_TOOLSET_NOT_ENABLED',
		`${name} is in the "${toolset}" toolset, which this session does not advertise`,
		`Call enable_toolsets {"names": ["${toolset}"]} and then use ${name}, or run it now with call_tool {"name": "${name}", "arguments": {…}} (describe_tool {"name": "${name}"} shows its arguments).`,
		{ tool: name, toolset },
	);
}

const TOOLSET_ENUM = z.enum(TOOLSET_NAMES as [ToolsetName, ...ToolsetName[]]);
const NAMES_ARG = z
	.array(z.union([TOOLSET_ENUM, z.literal('all')]))
	.min(1)
	.max(TOOLSET_NAMES.length + 1)
	.describe(`Toolset names (${TOOLSET_NAMES.join(', ')}) or "all"`);

/** Core tools that read and change the advertised toolsets, and run or describe any registered tool. */
export function registerToolsetTools(ctx: ToolContext, toolsets: ToolsetController): void {
	const summary = async (only?: ReadonlySet<string>) => {
		const tools = await toolsets.allTools();
		const byToolset = new Map<string, Tool[]>();
		for (const t of tools) {
			const ts = toolsetOf(t.name);
			if (ts) byToolset.set(ts, [...(byToolset.get(ts) ?? []), t]);
		}
		return TOOLSETS.map((ts) => {
			const members = byToolset.get(ts.name) ?? [];
			return {
				name: ts.name,
				description: ts.description,
				tools: members.length,
				enabled: toolsets.enabled().has(ts.name),
				guides: ts.guides,
				...(only?.has(ts.name) ? { toolList: members.map((t) => ({ name: t.name, title: t.title })) } : {}),
			};
		});
	};
	const advertisedCount = async () =>
		(await toolsets.allTools()).filter((t) => toolsets.advertised(t.name)).length;
	const expand = (names: readonly (ToolsetName | 'all')[]): ToolsetName[] =>
		names.includes('all') ? [...TOOLSET_NAMES] : (names as ToolsetName[]);

	defineTool(
		ctx,
		'list_toolsets',
		{
			title: 'List toolsets',
			description:
				'Every toolset with its description, tool count, whether this session advertises it, and its guide topics (get_guide). `names` adds the tool names and titles of those toolsets. Tools of a toolset that is not enabled: enable_toolsets, or run one directly with call_tool.',
			input: {
				names: z
					.array(TOOLSET_ENUM)
					.max(TOOLSET_NAMES.length)
					.optional()
					.describe('Toolsets whose tools to list'),
			},
			annotations: READ_ONLY,
		},
		async ({ names }) =>
			jsonResult({ toolsets: await summary(new Set(names ?? [])), advertisedTools: await advertisedCount() }),
	);
	defineTool(
		ctx,
		'enable_toolsets',
		{
			title: 'Enable toolsets',
			description:
				'Advertises more toolsets in this session ("all" for every one) and sends notifications/tools/list_changed; re-read tools/list afterwards. If your client ignores that notification, run their tools with call_tool.',
			input: { names: NAMES_ARG },
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ names }) => {
			const changed = toolsets.set(expand(names), true);
			return jsonResult({
				enabled: [...toolsets.enabled()],
				changed,
				advertisedTools: await advertisedCount(),
				...(changed
					? { hint: 'tools/list changed. A client that ignores list_changed can use call_tool.' }
					: {}),
			});
		},
	);
	defineTool(
		ctx,
		'disable_toolsets',
		{
			title: 'Disable toolsets',
			description:
				'Stops advertising toolsets in this session ("all" = every one except core, which is always on) and sends notifications/tools/list_changed. Their tools stay reachable through call_tool.',
			input: { names: NAMES_ARG },
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ names }) => {
			if (names.includes('core'))
				throw new ToolError(
					'E_INVALID_PARAM',
					'The core toolset is always on',
					'Name other toolsets, or "all" to go back to core only.',
				);
			const changed = toolsets.set(expand(names), false);
			return jsonResult({
				enabled: [...toolsets.enabled()],
				changed,
				advertisedTools: await advertisedCount(),
			});
		},
	);
	defineTool(
		ctx,
		'describe_tool',
		{
			title: 'Describe a tool',
			description:
				'The definition of any registered tool, advertised or not: title, description, annotations, input schema (JSON Schema, as tools/list gives it) and toolset. Use before call_tool.',
			input: { name: z.string().min(1).max(128).describe('Tool name, e.g. "grade_clip"') },
			annotations: READ_ONLY,
		},
		async ({ name }) => {
			const def = (await toolsets.allTools()).find((t) => t.name === name);
			if (!def) throw unknownToolError(name);
			return jsonResult({
				...def,
				toolset: toolsetOf(name) ?? null,
				advertised: toolsets.advertised(name),
			});
		},
	);
	defineTool(
		ctx,
		'call_tool',
		{
			title: 'Call any tool',
			description:
				'Runs any registered tool by name, also one whose toolset is not advertised, exactly as a direct call: the same strict argument validation, approvals in the editor, progress, cancellation and error results. The client sees call_tool itself as destructive and open-world because it can run any tool; the tool it runs keeps its own hints (describe_tool shows them).',
			input: {
				name: z.string().min(1).max(128).describe('Tool name (describe_tool shows its arguments)'),
				arguments: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('The tool arguments, as for a direct call (default {})'),
			},
			annotations: { ...DESTRUCTIVE, openWorldHint: true },
		},
		async ({ name, arguments: args }, extra) => {
			if (name === 'call_tool')
				throw new ToolError(
					'E_INVALID_PARAM',
					'call_tool cannot run itself',
					'Name the tool to run directly.',
				);
			if (!registered(ctx.server, name)) throw unknownToolError(name);
			return toolsets.call(name, args ?? {}, extra);
		},
	);
}

function unknownToolError(name: string): ToolError {
	return new ToolError(
		'E_NOT_FOUND',
		`No tool named "${name}"`,
		'list_toolsets {"names": [...]} lists the tools of each toolset; jasper://guide/routing maps requests to tools.',
		{ tool: name },
	);
}
