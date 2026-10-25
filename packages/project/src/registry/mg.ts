// Motion-graphic template registry interface (ARCHITECTURE §5.4). Implemented by @jasper/mg-templates
// and injected through CommandContext; @jasper/project never imports template code.
import type { ZodType } from 'zod';
import type { MgRenderer } from '../schema/sequence.ts';

export type MgCanvasSize = { width: number; height: number };

/** Timing of a clip whose template motion is measured: sequence rate and content length (sourceIn + duration). */
export type MgTemplateMotionTiming = { fps: number; totalFrames: number };

/**
 * A named param preset of a template (social comments: one per platform variant). `params` holds only the params
 * the preset sets; the template defaults fill the rest (`{...defaults, ...params}` must pass the params schema,
 * which `createMgRegistry` checks). Referenced as `"<templateId>:<presetId>"` / `"<templateId>@<version>:<presetId>"`.
 */
export type MgTemplatePreset = {
	/** Lower-case id (`[a-z0-9][a-z0-9-]*`), unique within the template. */
	id: string;
	name: string;
	description?: string;
	params: Record<string, unknown>;
};

/** Valid preset ids (they appear in `"<id>:<preset>"` refs). */
export const MG_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The parts of a template reference: `"<id>"`, `"<id>@<version>"`, `"<id>:<preset>"` or `"<id>@<version>:<preset>"`. */
export type MgTemplateRefParts = { id: string; version?: number; preset?: string };

const TEMPLATE_REF = /^([^@:\s]+)(?:@([1-9]\d{0,8}))?(?::([a-z0-9][a-z0-9-]*))?$/;

/** Parses a template reference (null when malformed: empty id, a non-positive version, a bad preset id). */
export function parseMgTemplateRef(ref: string): MgTemplateRefParts | null {
	if (typeof ref !== 'string' || ref.length > 256) return null;
	const m = TEMPLATE_REF.exec(ref.trim());
	if (!m) return null;
	return {
		id: m[1]!,
		...(m[2] !== undefined ? { version: Number(m[2]) } : {}),
		...(m[3] !== undefined ? { preset: m[3] } : {}),
	};
}

/** UI hints of one template param (Properties / Effect Controls). */
export type MgTemplateParamUi = {
	/** Row label (default: the schema `title`, else the humanized param name). */
	label?: string;
	/** Tooltip (default: the schema `.describe()` text). */
	description?: string;
	/** String params: a multi-line text area. */
	multiline?: boolean;
	/** Shown only while the param `param` holds one of `in` (e.g. fields that exist only on some variants). */
	visibleWhen?: { param: string; in: readonly unknown[] };
	/** Name of a custom control registered by the web app (`registerTemplateParamControl`). */
	control?: string;
	/**
	 * Enum params: the menu label of each value (`{'classic-pop': 'Classic pop'}`); values without one show the value.
	 * Every key must be a valid value of the param.
	 */
	options?: Readonly<Record<string, string>>;
};

/**
 * UI hints of a template: ordered groups of params (one sub-section each; params in no group come first) and
 * per-param hints. Validated by `createMgRegistry` (every name must be a param of the template).
 */
export type MgTemplateUi = {
	groups?: ReadonlyArray<{ id: string; label: string; params: readonly string[] }>;
	params?: Readonly<Record<string, MgTemplateParamUi>>;
	/**
	 * "Add another" (`clip.duplicateMotionGraphic`, social-comments design §7.9): `reroll` names the params the copy
	 * gets fresh values for from the template's `fill` hook (e.g. a comment's identity and stats); every other param is
	 * copied from the source clip. Needs a `fill` hook. Absent = the copy keeps every param.
	 */
	addAnother?: { reroll: readonly string[] };
	/** Spreadsheet / CSV bulk import (`planMgImport`): extra column names, ignored columns, value prefixes. */
	import?: MgTemplateImportUi;
};

/**
 * Where an import column goes: a param name, or a param chosen per row by the value of another param (`byParam`,
 * e.g. the variant: a "User" column fills `displayName` on TikTok and `handle` on Instagram). `otherwise` applies
 * to values `map` does not list.
 */
export type MgTemplateImportTarget =
	| string
	| { byParam: string; map: Readonly<Record<string, string>>; otherwise: string };

/** Bulk-import hints of a template (all names compared ignoring case, spaces, `_`, `-`, `.` and `:`). */
export type MgTemplateImportUi = {
	/** Column names besides the param names and labels (`"Comment"` → `text`). */
	aliases?: Readonly<Record<string, MgTemplateImportTarget>>;
	/** Columns recognised but not imported → the reason the import preview shows (e.g. remote image URLs). */
	ignored?: Readonly<Record<string, string>>;
	/** Prefixes removed from a param's cells before validation (`{handle: '@'}`: "@luna" → "luna"). */
	trimPrefix?: Readonly<Record<string, string>>;
	/**
	 * An age in one cell ("3h", "2 weeks", "just now"; `parseAgeCell`) → the count param `value` and the unit param
	 * `unit` (an enum offering some of `AGE_UNITS`: 'minute', 'hour'…). Read from the columns of `value` (its name,
	 * label and aliases) and from `columns` (more names, e.g. "Time", "Age"); a bare number stays the count alone.
	 */
	age?: { value: string; unit: string; columns?: readonly string[] };
};

export type MgTemplateInfo = {
	id: string;
	version: number;
	name: string;
	category: string;
	/** Validates (and defaults) the params object. */
	paramsSchema: ZodType;
	defaults: Record<string, unknown>;
	introFrames: number;
	outroFrames: number;
	/** Canvas used when a clip says `canvas: 'sequence'` is not wanted. */
	canvasDefault: MgCanvasSize | 'sequence';
	canvases?: MgCanvasSize[];
	/** M2 (S11:ATP-001): `anime` templates are drawn by `@jasper/motion/templates`; absent = fframes. */
	renderer?: MgRenderer;
	/** M2 (S11:ANA-001): one-line gallery description. */
	description?: string;
	/** M2 (S11:ANA-001): default clip length when inserted (S05:MGT-002). */
	defaultDurationSeconds?: number;
	/** Named param presets (gallery cards, `"<id>:<preset>"` refs). */
	presets?: readonly MgTemplatePreset[];
	/** Labels, tooltips, groups, visibility and custom controls of the params (`paramsPropertySpecs`). */
	ui?: MgTemplateUi;
	/**
	 * Sound design (spec 12 §2.2, optional): the template's picture speed per CONTENT frame `0 … totalFrames − 1`
	 * at `timing.fps` (`speed[i]`: from frame i − 1 to i, `speed[0]` = 0) in canvas diagonals per second, the units
	 * of the keyframed-clip sampler (`sound/cues/motion.ts`). Null (or absent) when the motion cannot be measured;
	 * the mg cues then fall back to the declared `introFrames` / `outroFrames`. Must be pure and never throw.
	 */
	motionSpeed?(params: Record<string, unknown>, timing: MgTemplateMotionTiming): number[] | null;
	/**
	 * Optional fill hook (social-comments design §7.10; `MgTemplateDefinition.fill`): fills the params `partial`
	 * omits, deterministically for `seed` (never touching given ones), for `clip.addMotionGraphic {fill}`.
	 * `params` = `partial` plus the filled values (the defaults are merged after); `filled` = the filled names.
	 */
	fill?(partial: Record<string, unknown>, seed: number): MgTemplateFillResult;
	/**
	 * Optional content name of a clip (`mgClipName`): what tells clips of this template apart in the timeline, the
	 * asset chip and export messages ("X post · Luna Park"); absent or empty = the template name. Pure.
	 */
	clipName?(params: Readonly<Record<string, unknown>>): string | undefined;
};

/** Result of a template fill hook (MgTemplateInfo.fill). */
export type MgTemplateFillResult =
	| { ok: true; params: Record<string, unknown>; filled: string[] }
	| { ok: false; error: string; issues?: unknown };

/** Result of a template version upgrade (S11:ATP-009). */
export type MgTemplateUpgrade = { version: number; params: Record<string, unknown> };

export interface MgTemplateRegistry {
	get(id: string, version: number): MgTemplateInfo | undefined;
	list(): MgTemplateInfo[];
	/**
	 * M2 (S11:ATP-009, optional): migrates params of `id@fromVersion` to the newest version that has an upgrade
	 * path; null when there is none. Implemented by `@jasper/mg-templates` (wp-m2-anime-templates).
	 * `toVersion` (additive, wp-m2-anime-templates): stop at that version (null when the path does not reach it).
	 */
	upgrade?(
		id: string,
		fromVersion: number,
		params: Record<string, unknown>,
		toVersion?: number,
	): MgTemplateUpgrade | null;
}

export const emptyMgRegistry: MgTemplateRegistry = {
	get: () => undefined,
	list: () => [],
};

export function createStaticMgRegistry(infos: MgTemplateInfo[]): MgTemplateRegistry {
	const map = new Map(infos.map((t) => [`${t.id}@${t.version}`, t]));
	return {
		get: (id, version) => map.get(`${id}@${version}`),
		list: () => [...map.values()],
	};
}
