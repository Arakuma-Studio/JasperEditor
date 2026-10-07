// Live-UI automation tools (docs/wp-notes/mcp-cli.md §4): look at and operate the open editor window — web app
// or desktop app — through the engine relay (`POST /api/agent/ui` → WS /agent → the window's agent bridge).
import type { AgentUiAction } from '@jasper/api';
import { z } from 'zod';
import { DESTRUCTIVE, defineTool, type Extra, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const UI_GUIDE = `Live UI (the editor window itself, web or desktop; needs a window with a project open — open_project_in_editor):
- ui_state: window size, workspace, mode, open panels with bounds, focused panel, dialogs, playhead.
- ui_elements {panel?, query?}: every interactive element with a stable automation id (data-testid, or "<scope>/<role>[<name>]"), role, name, bounds, enabled, value/checked; entity targets too (timeline.clip.<id>, timeline.track.<id>, keyframe.<id>…).
- ui_screenshot {panel?, id?}: a PNG of the window, one dock panel or one element (desktop: the real pixels; web: a DOM rasterisation — use render_frame for the rendered picture).
- ui_click / ui_drag / ui_scroll / ui_key / ui_type / ui_set act like the user. Targets are {id} (optionally fx/fy 0..1 inside it), {x, y} window CSS pixels, {timeline: {frame?, track?, clipId?, edge?}} or {program: {x, y}} (sequence pixels).
- ui_locate / ui_hit map timeline time ↔ x and track ↔ y, and Program monitor sequence pixels ↔ window points.
- ui_commands {filter?} lists the UI commands (menus, shortcuts) with enabled and why-not; ui_command {id, args?} runs one (e.g. "panel.focus.lumetri", "workspace.switch" {id: "color"}, "timeline.zoomToSequence").
A good loop: ui_elements → ui_click/ui_drag → ui_screenshot {panel} to check. Prefer apply_commands for edits (exact, undoable, no pixels); use the UI tools to drive and verify the UI itself.`;

const WindowArg = z
	.string()
	.min(1)
	.optional()
	.describe(
		'Target the editor window that has this project open (default: the most recently connected window)',
	);

const ModifiersArg = z
	.strictObject({
		shift: z.boolean().optional(),
		alt: z.boolean().optional(),
		ctrl: z.boolean().optional(),
		meta: z.boolean().optional(),
		command: z.boolean().optional().describe('⌘ on macOS, Ctrl elsewhere'),
	})
	.optional()
	.describe('Modifier keys held during the action');

const TimelineTarget = z.strictObject({
	frame: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Sequence frame (x); default: the middle of the visible range'),
	track: z.string().optional().describe('Track label "V1", "A2" or id (y: the row centre)'),
	clipId: z.string().optional().describe('A clip: its body centre, or an edge'),
	edge: z.enum(['in', 'out', 'center']).optional().describe('With clipId: the in edge, out edge or centre'),
});
const ProgramTarget = z.strictObject({
	x: z.number().describe('Sequence pixel x (0 = left edge of the frame)'),
	y: z.number().describe('Sequence pixel y'),
});

const TargetArg = z
	.union([
		z.strictObject({
			id: z.string().min(1).describe('Automation id from ui_elements'),
			fx: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe('Horizontal position inside the element, 0..1 (default 0.5)'),
			fy: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.describe('Vertical position inside the element, 0..1 (default 0.5)'),
		}),
		z.strictObject({ x: z.number().min(0), y: z.number().min(0) }),
		z.strictObject({ timeline: TimelineTarget }),
		z.strictObject({ program: ProgramTarget }),
	])
	.describe(
		'{id, fx?, fy?} | {x, y} (window CSS px) | {timeline: {frame?, track?, clipId?, edge?}} | {program: {x, y}}',
	);

async function ui(
	ctx: ToolContext,
	action: AgentUiAction,
	projectId: string | undefined,
	args: Record<string, unknown>,
	extra?: Extra,
): Promise<{ result: unknown; window: { projectId: string; sessionId: string } }> {
	return ctx.engine((c) =>
		c.agentUi({ action, ...(projectId ? { projectId } : {}), args }, extra?.signal),
	) as Promise<{ result: unknown; window: { projectId: string; sessionId: string } }>;
}

/** The window's answer, with which window answered (`window: {projectId, sessionId}`). */
async function uiJson(...a: Parameters<typeof ui>) {
	const r = await ui(...a);
	const body =
		r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : { result: r.result };
	return jsonResult({ ...body, window: r.window });
}

const strip = <T extends Record<string, unknown>>(o: T) =>
	Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== 'projectId'));

export function registerUiTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'ui_state',
		{
			title: 'UI state',
			description:
				'The open editor window: URL, runtime (web/desktop), window size and pixel ratio, project and sequence, playhead, workspace (id, name, available), mode, focused panel, maximized, every dock panel with its kind, instance id, title, visibility and bounds, open dialogs and menus, the focused element.',
			input: { projectId: WindowArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }, extra) => uiJson(ctx, 'state', projectId, {}, extra),
	);

	defineTool(
		ctx,
		'ui_elements',
		{
			title: 'UI elements',
			description:
				'Interactive elements on screen with stable automation ids: id, stable, role, name, panel, bounds {x, y, width, height} (window CSS px), enabled, focused, value / checked / selected / expanded / pressed; kind "control" or "target" (entities a panel draws: timeline.clip.<id>, timeline.track.<id>, timeline.transition.<id>, keyframe.<id>, project.item.<id>…). Filter by panel kind ("timeline", "effectControls"…) and/or a query (substring of id or name, or a role).',
			input: {
				projectId: WindowArg,
				panel: z.string().optional().describe('Only this dock panel (kind or instance id)'),
				query: z.string().optional().describe('Substring of the id or name, or a role ("button", "slider")'),
				targets: z.boolean().optional().describe('Include entity targets (default true)'),
				limit: z.number().int().min(1).max(2000).optional().describe('At most this many (default 400)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => uiJson(ctx, 'elements', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_screenshot',
		{
			title: 'UI screenshot',
			description:
				'A PNG of the editor window, of one dock panel (panel kind or instance id) or of one element (id). The desktop app captures its real pixels; the web app rasterises the DOM (WebGL canvases may be blank or stale there: render_frame shows the rendered frame).',
			input: {
				projectId: WindowArg,
				panel: z.string().optional().describe('Crop to this dock panel (kind or instance id)'),
				id: z.string().optional().describe('Crop to this element (automation id)'),
				maxWidth: z
					.number()
					.int()
					.min(64)
					.max(4096)
					.optional()
					.describe('Scale down to at most this width (default 1600)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			if (a.panel && a.id) throw new ToolError('E_INVALID_PARAM', 'Give panel or id, not both');
			const r = await ui(ctx, 'screenshot', a.projectId, strip(a), extra);
			const shot = r.result as {
				png: string;
				width: number;
				height: number;
				bounds: unknown;
				via: string;
				note?: string;
			};
			if (!shot?.png) throw new ToolError('INTERNAL', 'The window returned no image');
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							width: shot.width,
							height: shot.height,
							bounds: shot.bounds,
							via: shot.via,
							...(shot.note ? { note: shot.note } : {}),
							window: r.window,
						}),
					},
					{ type: 'image', data: shot.png, mimeType: 'image/png' },
				],
			};
		},
	);

	defineTool(
		ctx,
		'ui_click',
		{
			title: 'UI click',
			description:
				'Clicks like the user: by automation id (centre, or fx/fy inside it), at window coordinates, on the timeline (frame/track/clip) or in the Program monitor (sequence pixels). button left/right/middle (right opens context menus), count 2 = double-click, modifiers. Returns the point and the element clicked.',
			input: {
				projectId: WindowArg,
				id: z.string().optional().describe('Automation id from ui_elements'),
				fx: z.number().min(0).max(1).optional().describe('With id: horizontal position inside, 0..1'),
				fy: z.number().min(0).max(1).optional().describe('With id: vertical position inside, 0..1'),
				x: z.number().min(0).optional().describe('Window x (CSS px), without id'),
				y: z.number().min(0).optional().describe('Window y (CSS px), without id'),
				timeline: TimelineTarget.optional().describe(
					'Click on the timeline instead: {frame?, track?, clipId?, edge?}',
				),
				program: ProgramTarget.optional().describe('Click in the Program monitor at a sequence pixel'),
				button: z.enum(['left', 'right', 'middle']).optional(),
				count: z.number().int().min(1).max(3).optional().describe('2 = double-click'),
				modifiers: ModifiersArg,
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const ways = [
				a.id !== undefined,
				a.x !== undefined || a.y !== undefined,
				!!a.timeline,
				!!a.program,
			].filter(Boolean).length;
			if (ways !== 1)
				throw new ToolError('E_INVALID_PARAM', 'Give exactly one target: id, x+y, timeline or program');
			return uiJson(ctx, 'click', a.projectId, strip(a), extra);
		},
	);

	defineTool(
		ctx,
		'ui_drag',
		{
			title: 'UI drag',
			description:
				'Press, move in `steps` (one per frame, default 12) and release, like a mouse drag: move/trim clips, drag sliders and handles, marquee-select. HTML5 drag sources (Project panel items, effects, motion templates) get a real dragstart/dragover/drop sequence. Targets as in ui_click.',
			input: {
				projectId: WindowArg,
				from: TargetArg,
				to: TargetArg,
				steps: z.number().int().min(1).max(200).optional(),
				holdMs: z.number().int().min(0).max(5000).optional().describe('Pause before releasing'),
				modifiers: ModifiersArg,
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'drag', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_scroll',
		{
			title: 'UI scroll',
			description:
				'A mouse-wheel event over an element or point (dy > 0 scrolls down; with modifiers the timeline zooms or scrolls sideways as for the user).',
			input: {
				projectId: WindowArg,
				id: z.string().optional(),
				x: z.number().min(0).optional(),
				y: z.number().min(0).optional(),
				dx: z.number().optional(),
				dy: z.number().optional(),
				modifiers: ModifiersArg,
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'scroll', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_key',
		{
			title: 'UI key',
			description:
				'Presses a key or shortcut in the window: "Space", "J", "Shift+Delete", "Cmd+K" (Cmd = ⌘ on macOS, Ctrl elsewhere), "Ctrl+Shift+Z", "F9", "Escape", "ArrowLeft". The keymap handles it exactly as a real key press (KeyboardEvent.code). With id, the element is clicked/focused first.',
			input: {
				projectId: WindowArg,
				key: z.string().min(1).describe('Key or chord, e.g. "Space", "Cmd+K", "Shift+Delete"'),
				id: z.string().optional().describe('Focus this element first'),
				repeat: z.number().int().min(1).max(50).optional().describe('Press it this many times'),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'key', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_type',
		{
			title: 'UI type',
			description:
				'Types text into the focused field (or the field `id`, clicked first), one key press per character; "\\n" presses Enter.',
			input: {
				projectId: WindowArg,
				text: z.string().describe('Text to type'),
				id: z.string().optional().describe('Field to type into'),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'type', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_set',
		{
			title: 'UI set value',
			description:
				'Sets a control to a value the way a user would and commits it: text and number fields (also scrubby numbers and timecodes: Enter, replace, Enter), checkboxes / switches / toggle buttons (true/false), selects and dropdowns (option label or value), range sliders. Returns the value the control shows afterwards.',
			input: {
				projectId: WindowArg,
				id: z.string().min(1).describe('Automation id from ui_elements'),
				value: z.union([z.string(), z.number(), z.boolean()]).describe('The new value'),
				commit: z.boolean().optional().describe('Press Enter after text entry (default true)'),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'set', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_locate',
		{
			title: 'UI locate',
			description:
				'Window coordinates of a timeline position ({timeline: {frame?, track?, clipId?, edge?}} → x for the frame, y for the track row; with the visible range and zoom), of a Program monitor sequence pixel ({program: {x, y}} → window point; with the frame rectangle and scale), or of an element (id → bounds and centre).',
			input: {
				projectId: WindowArg,
				timeline: TimelineTarget.optional(),
				program: ProgramTarget.optional(),
				id: z.string().optional(),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => uiJson(ctx, 'locate', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_hit',
		{
			title: 'UI hit test',
			description:
				'What is at a window point: the panel, the element (automation id), on the timeline the frame, timecode, track and clip (with the edge zone), in the Program monitor the sequence pixel.',
			input: { projectId: WindowArg, x: z.number().min(0), y: z.number().min(0) },
			annotations: READ_ONLY,
		},
		async (a, extra) => uiJson(ctx, 'hit', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_commands',
		{
			title: 'List UI commands',
			description:
				'The UI commands of the window (what menus, shortcuts and buttons run): id, label, scope, enabled and — when disabled — why, checked state, keyboard shortcut. These complement the document commands of describe_commands (panels, workspaces, view, playback, tools).',
			input: {
				projectId: WindowArg,
				filter: z.string().optional().describe('Substring of the id or label'),
				enabledOnly: z.boolean().optional(),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => uiJson(ctx, 'commands', a.projectId, strip(a), extra),
	);

	defineTool(
		ctx,
		'ui_command',
		{
			title: 'Run UI command',
			description:
				'Runs a UI command like its menu item or shortcut (ui_commands lists them): e.g. "panel.focus.lumetri", "workspace.switch" {id: "color"}, "panel.maximize", "timeline.zoomToSequence", "transport.playPause". A disabled command fails with the reason.',
			input: {
				projectId: WindowArg,
				id: z.string().min(1).describe('UI command id'),
				args: z.record(z.string(), z.unknown()).optional().describe('Arguments for commands that take them'),
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => uiJson(ctx, 'command', a.projectId, strip(a), extra),
	);
}
