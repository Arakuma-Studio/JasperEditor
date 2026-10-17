// Built-in workspaces as data (S05 §4.2, WS-001/003, R-PUI §5.4). Sizes are proportions of the parent
// split applied to the real window size when a layout is created; fixed-size panels (Tools 40 px, Audio
// Meters 52 px) keep their pixel size and `fill` absorbs the remainder. Splits alternate row/column.
import type { PanelKind } from '../../panels/types.ts';

export type LayoutSize = number | { px: number } | 'fill';
export type LayoutNode =
	| { split: 'row' | 'column'; children: { size: LayoutSize; node: LayoutNode }[] }
	| { group: PanelKind[]; active?: PanelKind };

export type WorkspaceDefinition = { id: string; name: string; layout: LayoutNode };

const g = (group: PanelKind[], active?: PanelKind): LayoutNode => ({ group, active });
const row = (...children: [LayoutSize, LayoutNode][]): LayoutNode => ({
	split: 'row',
	children: children.map(([size, node]) => ({ size, node })),
});
const col = (...children: [LayoutSize, LayoutNode][]): LayoutNode => ({
	split: 'column',
	children: children.map(([size, node]) => ({ size, node })),
});

/** Tools 40 px · Timeline · Audio Meters 52 px (S05:WS-003, MTR-001). */
const TIMELINE_STRIP = (lead?: [LayoutSize, LayoutNode]): LayoutNode =>
	row(
		...(lead ? [lead] : []),
		[{ px: 40 }, g(['tools'])],
		['fill', g(['timeline'])],
		[{ px: 52 }, g(['audioMeters'])],
	);

/**
 * Editing (default, S05 §4.2 v25 variant): top row ≈ 55 % with the left group 31 % and Program 47 %;
 * Properties full-height right column 22 %; bottom row Project group 21 %, Tools 40 px,
 * Timeline, Audio Meters 52 px. Proportions inside the left column are relative to its 78 %.
 */
const editing: WorkspaceDefinition = {
	id: 'editing',
	name: 'Editing',
	layout: row(
		[
			0.78,
			col(
				[
					0.55,
					row(
						[31 / 78, g(['source', 'effectControls', 'lumetri', 'scopes', 'motionTemplates'], 'source')],
						['fill', g(['program'])],
					),
				],
				[
					'fill',
					TIMELINE_STRIP([
						21 / 78,
						g(['project', 'effects', 'text', 'markers', 'history', 'info', 'jobs'], 'project'),
					]),
				],
			),
		],
		['fill', g(['properties'])],
	),
};

const assembly: WorkspaceDefinition = {
	id: 'assembly',
	name: 'Assembly',
	layout: col(
		[
			0.58,
			row(
				[0.5, g(['project', 'effects', 'markers', 'history'], 'project')],
				[0.25, g(['source'])],
				['fill', g(['program'])],
			),
		],
		['fill', TIMELINE_STRIP()],
	),
};

const effects: WorkspaceDefinition = {
	id: 'effects',
	name: 'Effects',
	layout: col(
		[
			0.58,
			row(
				[0.32, g(['effectControls', 'source'], 'effectControls')],
				['fill', g(['program'])],
				[0.24, col([0.5, g(['effects'])], ['fill', g(['properties', 'history'], 'properties')])],
			),
		],
		['fill', TIMELINE_STRIP([0.2, g(['project', 'info'], 'project')])],
	),
};

const motion: WorkspaceDefinition = {
	id: 'motion',
	name: 'Motion',
	layout: col(
		[
			0.58,
			row(
				[0.26, g(['motionTemplates', 'essentialGraphics', 'project'], 'motionTemplates')],
				['fill', g(['program'])],
				[0.28, col([0.45, g(['properties'])], ['fill', g(['effectControls'])])],
			),
		],
		['fill', TIMELINE_STRIP()],
	),
};

const essentials: WorkspaceDefinition = {
	id: 'essentials',
	name: 'Essentials',
	layout: col(
		[0.58, row(['fill', g(['program'])], [0.3, g(['project', 'properties'], 'project')])],
		['fill', TIMELINE_STRIP()],
	),
};

/**
 * Color (S06:CGU-003, wp-m2-color): Lumetri Scopes top-left next to a large Program, the Lumetri Color panel as
 * the right column (Effect Controls and Properties as tabs behind it), Timeline strip at the bottom.
 */
const color: WorkspaceDefinition = {
	id: 'color',
	name: 'Color',
	layout: row(
		[
			0.76,
			col(
				[0.6, row([0.34, g(['scopes', 'project', 'history'], 'scopes')], ['fill', g(['program'])])],
				['fill', TIMELINE_STRIP()],
			),
		],
		['fill', g(['lumetri', 'effectControls', 'properties'], 'lumetri')],
	),
};

/**
 * Audio (audio-mix; Premiere's Audio workspace): Audio Track Mixer and Audio Clip Mixer next to a large Program,
 * the Timeline strip with the meters below, Properties on the right. The Sound Library (spec 12) is a tab next to
 * Essential Sound.
 */
const audio: WorkspaceDefinition = {
	id: 'audio',
	name: 'Audio',
	layout: row(
		[
			0.78,
			col(
				[
					0.58,
					row(
						[
							0.45,
							g(
								[
									'essentialSound',
									'soundLibrary',
									'audioTrackMixer',
									'audioClipMixer',
									'source',
									'effectControls',
								],
								'essentialSound',
							),
						],
						['fill', g(['program'])],
					),
				],
				['fill', TIMELINE_STRIP([0.2, g(['project', 'effects', 'markers', 'history'], 'project')])],
			),
		],
		['fill', g(['properties', 'info'], 'properties')],
	),
};

/**
 * Captions (wp captions; Premiere's "Captions and Graphics"): the Text panel as the left column next to a large
 * Program, Properties on the right, the Timeline strip at the bottom.
 */
const captions: WorkspaceDefinition = {
	id: 'captions',
	name: 'Captions',
	layout: col(
		[
			0.6,
			row(
				[0.3, g(['text', 'project'], 'text')],
				['fill', g(['program'])],
				[0.22, g(['properties', 'effectControls'], 'properties')],
			),
		],
		['fill', TIMELINE_STRIP()],
	),
};

/**
 * Sound Design (spec 12 §2.7; the 9th built-in, Alt+Shift+9): the Sound Library with Project and Media Browser on the
 * left, Review and Sound Check with Markers, History and Jobs below it; Program and the Timeline strip in the centre;
 * Essential Sound, Properties and the mixers on the right.
 */
const soundDesign: WorkspaceDefinition = {
	id: 'sound-design',
	name: 'Sound Design',
	layout: row(
		[
			0.24,
			col(
				[0.5, g(['soundLibrary', 'project', 'mediaBrowser'], 'soundLibrary')],
				['fill', g(['review', 'soundCheck', 'markers', 'history', 'jobs'], 'review')],
			),
		],
		['fill', col([0.55, g(['program'])], ['fill', TIMELINE_STRIP()])],
		[
			0.24,
			g(
				['essentialSound', 'properties', 'audioTrackMixer', 'audioClipMixer', 'effectControls'],
				'essentialSound',
			),
		],
	),
};

/** Built-ins in default order (Alt+Shift+1…9 follow the visible order, WS-010). */
export const BUILTIN_WORKSPACES: readonly WorkspaceDefinition[] = [
	editing,
	assembly,
	effects,
	motion,
	essentials,
	color,
	audio,
	captions,
	soundDesign,
];

/**
 * Built-in workspaces that were removed (the Agent workspace went with the Agent panel, wp-mcp). Stored
 * workspace state drops them on load; a stored layout that still contains the retired panel kind loses
 * that panel through `sanitizeLayout`.
 */
export const RETIRED_BUILTIN_WORKSPACES: readonly string[] = ['agent'];

/**
 * Compact desktop preset (900–1279 px, S05 §19.1): Program with Properties/Project/Effects as tabs
 * on top, Timeline below; Tools collapse into the timeline header, so no Tools panel.
 */
export const COMPACT_WORKSPACE: WorkspaceDefinition = {
	id: 'compact',
	name: 'Compact',
	layout: col(
		[
			0.55,
			row(
				['fill', g(['program', 'source'], 'program')],
				[0.36, g(['properties', 'project', 'effects', 'effectControls', 'history', 'jobs'], 'properties')],
			),
		],
		['fill', row(['fill', g(['timeline'])], [{ px: 52 }, g(['audioMeters'])])],
	),
};

/**
 * Phone preset (< 600 px, S05 §19.2 until the dedicated touch shell lands): one column with the viewer
 * on top and the timeline below; the inspectors and bins are tabs of the lower group instead of a
 * squeezed side column, and there are no fixed-width Tools/Meters strips.
 */
export const PHONE_WORKSPACE: WorkspaceDefinition = {
	id: 'phone',
	name: 'Phone',
	layout: col(
		[0.42, g(['program', 'source'], 'program')],
		['fill', g(['timeline', 'project', 'properties', 'effectControls', 'motionTemplates'], 'timeline')],
	),
};

/** Layout-mode presets: chosen by the layout switch, never listed in the workspace bar. */
export const LAYOUT_PRESETS: readonly WorkspaceDefinition[] = [COMPACT_WORKSPACE, PHONE_WORKSPACE];

export function isLayoutPreset(id: string): boolean {
	return LAYOUT_PRESETS.some((w) => w.id === id);
}

export const DEFAULT_WORKSPACE_ID = 'editing';

export function builtinWorkspace(id: string): WorkspaceDefinition | undefined {
	return LAYOUT_PRESETS.find((w) => w.id === id) ?? BUILTIN_WORKSPACES.find((w) => w.id === id);
}
