// Saved versions, Save a Copy and crash-recovery journals for agents (process workstream, ARCHITECTURE D-39,
// docs/project-files.md). Restoring in place is refused while the project is open in an editor (the editor owns
// it: File ▸ Project Versions…); restoring as a copy always works.
import type { VersionInfo } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { makeEnvelope } from '@jasper/project';
import { z } from 'zod';
import { DESTRUCTIVE, defineTool, EDIT, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const VERSIONS_GUIDE = `Project versions and recovery: the engine keeps a saved version of a project every 5 minutes of editing (newest 20), before every restore, and before the first save over a project written by an older JasperEditor (an "older-format backup"). list_project_versions shows them; restore_project_version mode "copy" opens one as a new project (safe), mode "replace" writes it over the project and keeps the current state as a version (refused while the project is open in an editor: ask the user to use File ▸ Project Versions… there). save_project_copy saves the current state (live from the open editor when there is one) as a new project, e.g. before a risky batch of edits. list_unsaved_changes reports crash-recovery journals: unsaved editor changes of sessions that ended before saving; the user recovers them in the editor (File ▸ Recover Unsaved Changes…), so tell them rather than acting yourself.`;

const VersionIdArg = z.string().min(1).describe('versionId from list_project_versions');

const KIND: Record<string, string> = {
	auto: 'auto-saved',
	'before-restore': 'state before a restore',
	'schema-backup': 'older-format backup (for older JasperEditor builds)',
};

const versionSummary = (v: VersionInfo) => ({
	versionId: v.versionId,
	savedAt: v.savedAt,
	revision: v.revision,
	kind: v.kind ?? 'auto',
	what: KIND[v.kind ?? 'auto'] ?? v.kind,
	...(v.schemaVersion !== undefined ? { schemaVersion: v.schemaVersion } : {}),
	sizeKB: Math.max(1, Math.round(v.sizeBytes / 1024)),
});

export function registerVersionTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_project_versions',
		{
			title: 'List saved versions',
			description:
				'Saved versions of a project, newest first: auto-saved every 5 minutes of editing, the state before each restore, and the older-format backup kept before the first save over a project from an older JasperEditor.',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const { versions } = await ctx.engine((c) => c.listVersions(projectId));
			return jsonResult({ projectId, versions: versions.map(versionSummary) });
		},
	);

	defineTool(
		ctx,
		'restore_project_version',
		{
			title: 'Restore a saved version',
			description:
				'mode "copy" (default): a new project holding the saved version (name optional), the original untouched. mode "replace": the version becomes the project\'s current state and the state it replaces is kept as a version (undo by restoring that one); refused while the project is open in an editor window.',
			input: {
				projectId: ProjectIdArg,
				versionId: VersionIdArg,
				mode: z.enum(['copy', 'replace']).optional().describe('"copy" (default) or "replace"'),
				name: z.string().min(1).max(200).optional().describe('copy: name of the new project'),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, versionId, mode, name }) => {
			try {
				const r = await ctx.engine((c) =>
					c.restoreVersion(projectId, versionId, { mode: mode ?? 'copy', ...(name ? { name } : {}) }),
				);
				return jsonResult({
					projectId: r.projectId,
					revision: r.revision,
					...(r.keptAs ? { previousStateKeptAs: r.keptAs } : {}),
					next:
						mode === 'replace'
							? 'The project now holds the restored version.'
							: 'Work on the new project with this projectId; the original is unchanged.',
				});
			} catch (e) {
				if (e instanceof EngineError && e.code === 'LEASE_HELD')
					throw new ToolError(
						'LEASE_HELD',
						'The project is open in an editor window, so it cannot be replaced from here',
						'Use mode "copy", or ask the user to restore it with File ▸ Project Versions… in the editor.',
					);
				throw e;
			}
		},
	);

	defineTool(
		ctx,
		'save_project_copy',
		{
			title: 'Save a copy of a project',
			description:
				'Saves the current state of a project (live from the open editor when there is one, unsaved edits included) as a new project with the given name, like File ▸ Save a Copy. Returns the new projectId.',
			input: { projectId: ProjectIdArg, name: z.string().min(1).max(200).describe('Name of the copy') },
			annotations: EDIT,
		},
		async ({ projectId, name }) => {
			const { doc, live } = await loadDoc(ctx, projectId);
			const copyId = await ctx.engine(async (c) => {
				const { projectId: id } = await c.createProject({
					name,
					preset: doc.settings?.defaultSequencePreset ?? 'hd-1080p-30',
				});
				const fresh = await c.getProject(id);
				const copy = { ...structuredClone(doc), projectId: id, name };
				await c.putProject(
					id,
					makeEnvelope(copy, {
						revision: fresh.revision + 1,
						savedAt: new Date().toISOString(),
						platform: 'mcp',
					}),
					fresh.revision,
				);
				return id;
			});
			return jsonResult({ projectId: copyId, name, from: projectId, fromLiveEditor: live });
		},
	);

	defineTool(
		ctx,
		'list_unsaved_changes',
		{
			title: 'List recoverable unsaved changes',
			description:
				'Crash-recovery journals of a project: unsaved changes of editor sessions that ended before they were saved (a crash, a killed tab), with when and what (History labels). The user recovers or discards them in the editor (File ▸ Recover Unsaved Changes…; the editor also asks when it opens the project).',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const { candidates } = await ctx.engine((c) => c.listRecovery(projectId));
			return jsonResult({
				projectId,
				unsaved: candidates.map((c) => ({
					sessionId: c.sessionId,
					savedAt: c.savedAt,
					changeCount: c.changeCount,
					changes: c.changes,
					savedAgainSince: c.projectRevision > c.baseRevision,
				})),
				...(candidates.length
					? { next: 'Tell the user: open the project in the editor and choose Recover (or Discard).' }
					: {}),
			});
		},
	);
}
