// Schema versions and migrations (S01:MIG-001…005) and the load pipeline (S01:PER-004):
// envelope → migrate → zod validate → invariants → conservative repair.

import type { Issue } from './commands/types.ts';
import { createRandomIdSource, type IdSource } from './ids.ts';
import { checkInvariants, nullPrototypeRecords, type RepairEntry, repairDocument } from './invariants.ts';
import { dropUnreadableKeySides } from './keyframes.ts';
import type { EffectRegistry } from './registry/effects.ts';
import type { MgTemplateRegistry } from './registry/mg.ts';
import { CURRENT_SCHEMA_VERSION, type ProjectDocument, ProjectDocumentSchema } from './schema/document.ts';
import { soundDesignNeedsRepair } from './sound/repair.ts';
import { textStylesNeedRepair } from './text-styles/model.ts';

export type MigrationStep = {
	from: number;
	to: number;
	migrate(doc: Record<string, unknown>): Record<string, unknown>;
};
export type MigrationReport = { fromVersion: number; toVersion: number; steps: string[] };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * v1 → v2: audio clips take the Audio label by default (S05:DT-021). v1 painted the audio half of a
 * linked A/V clip with the item's Movie label (Violet). Audio clips of video media that still carry
 * Violet get Caribbean; any other label was chosen by the user and is kept.
 */
function migrateV1ToV2(doc: Rec): Rec {
	const media = isRec(doc.media) ? doc.media : {};
	const sequences = isRec(doc.sequences) ? doc.sequences : {};
	for (const seq of Object.values(sequences)) {
		if (!isRec(seq) || !isRec(seq.clips)) continue;
		for (const clip of Object.values(seq.clips)) {
			if (!isRec(clip) || clip.kind !== 'audio' || clip.label !== 'violet') continue;
			const asset = typeof clip.mediaId === 'string' ? media[clip.mediaId] : undefined;
			if (isRec(asset) && asset.kind === 'video') clip.label = 'caribbean';
		}
	}
	return doc;
}

/**
 * v4 → v5 (M3, S07:PRC-015): processed versions (`derivation.recipe.op` `process`, and plain `transcode`s)
 * were made from the whole source in M2 and swapped 1:1 in content time. They get the explicit `sourceRange`
 * that says so — `{mediaId: <source>, firstFrame: 0, frames, frameRate: <source rate>, origin: 'process'}` —
 * so every version carries the range it holds. Assets whose source or rate is unknown are left alone (they keep
 * the identity mapping).
 */
function migrateV4ToV5(doc: Rec): Rec {
	const media = isRec(doc.media) ? doc.media : {};
	const videoRate = (a: Rec): { num: number; den: number } | null => {
		const probe = isRec(a.probe) ? a.probe : null;
		const streams = Array.isArray(probe?.streams) ? (probe.streams as unknown[]) : [];
		const vs = streams.find((s) => isRec(s) && s.type === 'video') as Rec | undefined;
		const r = vs && isRec(vs.frameRate) ? vs.frameRate : null;
		return r && typeof r.num === 'number' && typeof r.den === 'number' && r.num > 0 && r.den > 0
			? { num: r.num, den: r.den }
			: null;
	};
	for (const a of Object.values(media)) {
		if (!isRec(a) || a.sourceRange !== undefined || !isRec(a.derivation)) continue;
		const d = a.derivation;
		const op = isRec(d.recipe) ? d.recipe.op : undefined;
		if ((op !== 'process' && op !== 'transcode') || typeof d.fromMediaId !== 'string') continue;
		const src = media[d.fromMediaId];
		if (!isRec(src)) continue;
		const rate = videoRate(src) ?? videoRate(a);
		const probe = isRec(a.probe) ? a.probe : null;
		const dur = typeof probe?.durationFlicks === 'number' ? probe.durationFlicks : null;
		if (!rate || dur === null) continue;
		const frames = Math.round((dur * rate.num) / (705_600_000 * rate.den));
		if (frames < 1) continue;
		a.sourceRange = {
			mediaId: d.fromMediaId,
			sourceName: typeof src.originalName === 'string' ? src.originalName : null,
			firstFrame: 0,
			frames,
			frameRate: rate,
			origin: 'process',
		};
	}
	return doc;
}

/**
 * v7 → v8: Crop is applied where it sits in the effect stack (Premiere's order). v7 builds always applied a clip's
 * Crop effects before its other effects wherever they were listed, so every stack that lists a Crop after another
 * effect is reordered to put its Crop effects first (in their order; the other effects keep theirs): v7 projects
 * render as before. Effect stacks are clip `effects` arrays inside `sequences`.
 */
function migrateV7ToV8(doc: Rec): Rec {
	const sequences = isRec(doc.sequences) ? doc.sequences : {};
	for (const seq of Object.values(sequences)) {
		if (!isRec(seq) || !isRec(seq.clips)) continue;
		for (const clip of Object.values(seq.clips)) {
			if (!isRec(clip) || !Array.isArray(clip.effects)) continue;
			const isCrop = (e: unknown) => isRec(e) && e.effectId === 'jasper.crop';
			const crops = clip.effects.filter(isCrop);
			if (crops.length === 0) continue;
			const firstOther = clip.effects.findIndex((e) => !isCrop(e));
			const lastCrop = clip.effects.length - 1 - [...clip.effects].reverse().findIndex(isCrop);
			if (firstOther === -1 || lastCrop < firstOther) continue;
			clip.effects = [...crops, ...clip.effects.filter((e) => !isCrop(e))];
		}
	}
	return doc;
}

/** Migrations run in order; every supported version keeps a loadable fixture (S01:MIG-002). */
export const MIGRATIONS: readonly MigrationStep[] = [
	{ from: 1, to: 2, migrate: migrateV1ToV2 },
	// v3 marks M2 additions so older builds open them read-only; existing data needs no changes.
	{ from: 2, to: 3, migrate: (doc) => doc },
	// v4 (S11, D-32): text animators, anime templates and shapes; same read-only policy, no data changes.
	{ from: 3, to: 4, migrate: (doc) => doc },
	// v5 (M3): source ranges of processed versions (S07:PRC-015).
	{ from: 4, to: 5, migrate: migrateV4ToV5 },
	// v6 (parity program, D-36…D-48): masks, track mattes, nests, adjustment layers, groups, captions and
	// transcripts, time remapping, vector shapes, text animators, expressions, 3D layers / cameras / lights,
	// multicam, roto mattes, audio effects / buses / Essential Sound, working colour spaces, interpreted footage
	// and the other optional schema-v6 fields. Existing data needs no changes; the bump makes
	// v5 builds open v6 files read-only instead of silently dropping the new fields on their next save.
	{ from: 5, to: 6, migrate: (doc) => doc },
	// v7 (sound design, spec 12 Phases 0–1): Essential Sound SFX Pan is an offset on the clip's own pan
	// (`panOffset`, `residual`), and media carry library provenance (`MediaAsset.library`, lead-silence copies).
	// Existing data needs no changes here (SFX Pan settings of older builds are read by `migrate-essential-pan` in
	// repair and by the Essential Sound commands); the bump makes v6 builds open v7 files read-only, because a v6
	// build editing Essential Sound Pan would write an absolute pan under the offset marker, which v7 then misreads.
	{ from: 6, to: 7, migrate: (doc) => doc },
	// v8 (Premiere port): Crop applies in stack order, user font library references, per-side keyframe
	// interpolation, curved paths on effect points, Premiere crossfade shapes, the Universe-style Slide transition
	// and relink metadata. v7 stacks listing a Crop after another effect are reordered so they render as before;
	// the bump makes v7 builds open v8 files read-only (they would apply Crop first and misread the new fields).
	{ from: 7, to: 8, migrate: migrateV7ToV8 },
	// v9 (workflow automation, specs 13–16): subtitle text clips with words and caption groups, linked project text
	// styles and subtitle templates, voice-cleanup settings and scripts, style recipes, automation provenance and text
	// shadow spread. Existing data needs no changes; the bump makes v8 builds open v9 files read-only instead of
	// dropping or misreading the new fields on their next save.
	{ from: 8, to: 9, migrate: (doc) => doc },
];

/** Data that is not a loadable project (not an object, an unknown format, no migration path, schema mismatch). */
export class ProjectLoadError extends Error {
	override readonly name = 'ProjectLoadError';
}

function unwrap(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== 'object') throw new ProjectLoadError('Project data is not an object');
	const o = raw as Record<string, unknown>;
	if (o.format === 'jasper-project') {
		if (!o.document || typeof o.document !== 'object') throw new ProjectLoadError('Envelope has no document');
		return o.document as Record<string, unknown>;
	}
	if (o.format !== undefined) throw new ProjectLoadError(`Unknown project format ${String(o.format)}`);
	return o;
}

/**
 * Migrates raw project data (an envelope or a bare document) to the current schema version.
 * Newer versions are returned unchanged with `readOnly: true` (S01:MIG-003); they are never downgraded.
 */
export function migrate(raw: unknown): {
	document: ProjectDocument;
	report: MigrationReport;
	readOnly: boolean;
} {
	const doc = unwrap(raw);
	const version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
	if (version > CURRENT_SCHEMA_VERSION) {
		return {
			document: doc as unknown as ProjectDocument,
			report: { fromVersion: version, toVersion: version, steps: [] },
			readOnly: true,
		};
	}
	let cur: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
	const steps: string[] = [];
	for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
		const step = MIGRATIONS.find((m) => m.from === v);
		if (!step) throw new ProjectLoadError(`No migration from schema version ${v}`);
		cur = step.migrate(cur);
		cur.schemaVersion = step.to;
		steps.push(`v${step.from}→v${step.to}`);
	}
	if (cur.schemaVersion === undefined) cur.schemaVersion = CURRENT_SCHEMA_VERSION;
	return {
		document: cur as unknown as ProjectDocument,
		report: { fromVersion: version, toVersion: CURRENT_SCHEMA_VERSION, steps },
		readOnly: false,
	};
}

export type LoadResult = {
	document: ProjectDocument;
	readOnly: boolean;
	migration: MigrationReport;
	/** Conservative repairs applied (empty for healthy files). */
	repairs: RepairEntry[];
	/** Invariant issues that remain after repair (should be empty). */
	issues: Issue[];
};

/** Full load pipeline (S01:PER-004). Throws only when the data is not a project at all. */
export function loadProject(
	raw: unknown,
	opts: {
		ids?: IdSource;
		effects?: EffectRegistry;
		/** wp-m2-anime-templates (S11:ATP-002): re-stamps template renderers that contradict the registry. */
		mgTemplates?: MgTemplateRegistry;
	} = {},
): LoadResult {
	const m = migrate(raw);
	if (m.readOnly) {
		const parsed = ProjectDocumentSchema.safeParse(m.document);
		return {
			document: (parsed.success ? parsed.data : m.document) as ProjectDocument,
			readOnly: true,
			migration: m.report,
			repairs: [],
			issues: [],
		};
	}
	// keyframe-sides: an unreadable incoming interpolation is dropped before validation (lenient reading, reported).
	const sideRepairs: RepairEntry[] = dropUnreadableKeySides(m.document).map((id) => ({
		action: 'repair-key-sides',
		entity: id,
		detail:
			'unreadable incoming interpolation removed (the key is read with its interpolation on both sides)',
	}));
	const parsed = ProjectDocumentSchema.safeParse(m.document);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.slice(0, 5)
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
		throw new ProjectLoadError(`Project does not match the schema: ${msg}`);
	}
	let document = nullPrototypeRecords(parsed.data as ProjectDocument);
	let repairs: RepairEntry[] = [];
	const invOpts = { effects: opts.effects, mgTemplates: opts.mgTemplates };
	let issues = checkInvariants(document, invOpts);
	// sound-design: soft references (a cue's anchor or clips, a clip's cue) are tidied on load too (spec 12 §2.2).
	// spec 13 SH-002: so do links to a project text style that is gone (pasted from another project).
	if (issues.length > 0 || soundDesignNeedsRepair(document) || textStylesNeedRepair(document)) {
		const r = repairDocument(document, opts.ids ?? createRandomIdSource(), { mgTemplates: opts.mgTemplates });
		document = r.document;
		repairs = r.report;
		issues = checkInvariants(document, invOpts);
	}
	return { document, readOnly: false, migration: m.report, repairs: [...sideRepairs, ...repairs], issues };
}
