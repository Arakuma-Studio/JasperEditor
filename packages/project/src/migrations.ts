// Schema versions and migrations (S01:MIG-001…005) and the load pipeline (S01:PER-004):
// envelope → migrate → zod validate → invariants → conservative repair.

import type { Issue } from './commands/types.ts';
import { createRandomIdSource, type IdSource } from './ids.ts';
import { checkInvariants, type RepairEntry, repairDocument } from './invariants.ts';
import type { EffectRegistry } from './registry/effects.ts';
import { CURRENT_SCHEMA_VERSION, type ProjectDocument, ProjectDocumentSchema } from './schema/document.ts';

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
 * vN → vN+1 migrations, applied in order. Each step keeps a fixture under test/fixtures/v<N>/ that must
 * keep loading (S01:MIG-002).
 */
/**
 * v2 → v3 (M2, ARCHITECTURE §19.1): no data changes. The version bump only marks documents that may contain
 * the M2 additions (mg-bundle assets, trackers, curve params…) so M1 builds open them read-only.
 */
function migrateV2ToV3(doc: Rec): Rec {
	return doc;
}

export const MIGRATIONS: readonly MigrationStep[] = [
	{ from: 1, to: 2, migrate: migrateV1ToV2 },
	{ from: 2, to: 3, migrate: migrateV2ToV3 },
];

function unwrap(raw: unknown): { doc: Record<string, unknown>; fromEnvelope: boolean } {
	if (!raw || typeof raw !== 'object') throw new Error('Project data is not an object');
	const o = raw as Record<string, unknown>;
	if (o.format === 'jasper-project') {
		if (!o.document || typeof o.document !== 'object') throw new Error('Envelope has no document');
		return { doc: o.document as Record<string, unknown>, fromEnvelope: true };
	}
	if (o.format !== undefined) throw new Error(`Unknown project format ${String(o.format)}`);
	return { doc: o, fromEnvelope: false };
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
	const { doc } = unwrap(raw);
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
		if (!step) throw new Error(`No migration from schema version ${v}`);
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
	opts: { ids?: IdSource; effects?: EffectRegistry } = {},
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
	const parsed = ProjectDocumentSchema.safeParse(m.document);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.slice(0, 5)
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
		throw new Error(`Project does not match the schema: ${msg}`);
	}
	let document = parsed.data as ProjectDocument;
	let repairs: RepairEntry[] = [];
	let issues = checkInvariants(document, { effects: opts.effects });
	if (issues.length > 0) {
		const r = repairDocument(document, opts.ids ?? createRandomIdSource());
		document = r.document;
		repairs = r.report;
		issues = checkInvariants(document, { effects: opts.effects });
	}
	return { document, readOnly: false, migration: m.report, repairs, issues };
}
