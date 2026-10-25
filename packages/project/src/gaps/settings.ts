import type { Issue } from '../commands/types.ts';
import { projectSettingFeatures } from '../proposals/features.ts';
import {
	ProjectAgentProposalsSchema,
	type ProjectDisplay,
	ProjectDisplaySchema,
	type ProjectDocument,
	type ProjectIngest,
	ProjectIngestSchema,
	ProjectScratchSchema,
} from '../schema/document.ts';

export type ResolvedProjectSettings = {
	display: Required<Pick<ProjectDisplay, 'video' | 'audio'>>;
	scratch: { media: string | null };
	ingest: {
		enabled: boolean;
		action: ProjectIngest['action'];
		preset: string | null;
		destination: string | null;
	};
};

/** The gaps project settings with read-time defaults (timecode / samples, default folders, ingest off). */
export function projectSettingsOf(doc: Pick<ProjectDocument, 'settings'>): ResolvedProjectSettings {
	const s = doc.settings as ProjectDocument['settings'] & Record<string, unknown>;
	const d = ProjectDisplaySchema.safeParse(s.display);
	const sc = ProjectScratchSchema.safeParse(s.scratch);
	const ing = ProjectIngestSchema.safeParse(s.ingest);
	return {
		display: {
			video: (d.success && d.data.video) || 'timecode',
			audio: (d.success && d.data.audio) || 'samples',
		},
		scratch: {
			media: sc.success && typeof sc.data.media === 'string' && sc.data.media ? sc.data.media : null,
		},
		ingest: ing.success
			? {
					enabled: ing.data.enabled,
					action: ing.data.action,
					preset: ing.data.preset ?? null,
					destination: ing.data.destination ?? null,
				}
			: { enabled: false, action: 'proxies', preset: null, destination: null },
	};
}

type Note = (action: string, entity: string, detail: string) => void;
type GapsIssue = { invariant: string; message: string; path: string[] };
type GapsCheck = {
	issues(doc: ProjectDocument): GapsIssue[];
	repair(doc: ProjectDocument, note: Note): void;
	/**
	 * perf-core: the clip-level part of `issues` (also included there), run by the incremental invariant check on the
	 * changed clips only (`doc.sequences` holds partial sequences).
	 */
	clipIssues?(doc: Pick<ProjectDocument, 'media' | 'sequences'>): GapsIssue[];
};

/** Checks registered by the gaps modules (settings here; proxies, channels, warp, graphics register theirs). */
const CHECKS: GapsCheck[] = [];

/** Adds a gaps invariant / repair pair (each module registers its own at load). */
export function registerGapsCheck(check: GapsCheck): void {
	CHECKS.push(check);
}

registerGapsCheck({
	issues(doc) {
		const out: { invariant: string; message: string; path: string[] }[] = [];
		const s = doc.settings as Record<string, unknown>;
		const bad = (key: string, schema: { safeParse(v: unknown): { success: boolean } }) => {
			if (s[key] !== undefined && !schema.safeParse(s[key]).success)
				out.push({
					invariant: 'INV-PROJECT-SETTINGS',
					message: `invalid project settings: ${key}`,
					path: ['settings', key],
				});
		};
		bad('display', ProjectDisplaySchema);
		bad('scratch', ProjectScratchSchema);
		bad('ingest', ProjectIngestSchema);
		// v9 (spec 15 EA-001): Project Settings ▸ Agent Proposals
		bad('agentProposals', ProjectAgentProposalsSchema);
		return out;
	},
	repair(doc, note) {
		const s = doc.settings as Record<string, unknown>;
		for (const [key, schema] of [
			['display', ProjectDisplaySchema],
			['scratch', ProjectScratchSchema],
			['ingest', ProjectIngestSchema],
		] as const) {
			if (s[key] !== undefined && !schema.safeParse(s[key]).success) {
				delete s[key];
				note(
					'reset-project-settings',
					doc.projectId,
					`unreadable project settings (${key}) replaced by the defaults`,
				);
			}
		}
		agentProposalsRepair(s, (detail) => note('reset-project-settings', doc.projectId, detail));
	},
});

/**
 * Unreadable Project Settings ▸ Agent Proposals (spec 15 EA-001): readable entries are kept; the rest are rewritten as
 * off — never as the default on, so damage never lets agents apply what the user may have turned off. Reported.
 */
function agentProposalsRepair(s: Record<string, unknown>, report: (detail: string) => void): void {
	const v = s.agentProposals;
	if (v === undefined || ProjectAgentProposalsSchema.safeParse(v).success) return;
	const out: Record<string, boolean> = {};
	if (v && typeof v === 'object' && !Array.isArray(v))
		for (const [k, x] of Object.entries(v as Record<string, unknown>))
			if (/^[a-z][a-z0-9-]{0,63}$/.test(k) && Object.keys(out).length < 64) out[k] = x === true;
	for (const f of projectSettingFeatures()) if (!Object.hasOwn(out, f.id)) out[f.id] = false;
	s.agentProposals = out;
	report(
		'unreadable "Allow agents to apply … proposals" settings: agents may not apply those proposals until you turn them on again (Project Settings ▸ General ▸ Agent Proposals)',
	);
}

const issue = (invariant: string, message: string, path: string[]): Issue => ({
	commandIndex: -1,
	code: 'E_INVARIANT',
	invariant,
	message: `${invariant}: ${message}`,
	path,
});

/** Every gaps invariant violation of a document. */
export function gapsIssues(doc: ProjectDocument): Issue[] {
	const out: Issue[] = [];
	for (const c of CHECKS) for (const i of c.issues(doc)) out.push(issue(i.invariant, i.message, i.path));
	return out;
}

/** The clip-level gaps violations of (partial) sequences: the incremental invariant check's share. */
export function gapsClipIssues(doc: Pick<ProjectDocument, 'media' | 'sequences'>): Issue[] {
	const out: Issue[] = [];
	for (const c of CHECKS)
		for (const i of c.clipIssues?.(doc) ?? []) out.push(issue(i.invariant, i.message, i.path));
	return out;
}

/** Conservative repairs of the gaps fields (unreadable → removed / defaults), each noted in the report. */
export function repairGaps(doc: ProjectDocument, note: Note): void {
	for (const c of CHECKS) c.repair(doc, note);
}
