// Workstream gaps (docs/wp-notes/gaps.md): Project Settings read with defaults, and the invariants / repairs of every
// optional field this workstream added (project settings, attached proxies, sequence pixel aspect and fields, clip
// audio channel maps, Warp Stabilizer analyses, graphic layers). `invariants.ts` calls `gapsIssues` and `repairGaps`.
import type { Issue } from '../commands/types.ts';
import {
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
type GapsCheck = {
	issues(doc: ProjectDocument): { invariant: string; message: string; path: string[] }[];
	repair(doc: ProjectDocument, note: Note): void;
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
	},
});

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

/** Conservative repairs of the gaps fields (unreadable → removed / defaults), each noted in the report. */
export function repairGaps(doc: ProjectDocument, note: Note): void {
	for (const c of CHECKS) c.repair(doc, note);
}
