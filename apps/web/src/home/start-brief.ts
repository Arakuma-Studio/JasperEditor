// Spec 18 AF-BRF-005: Home ▸ Describe your video. Home creates the project with the sequence preset the brief implies
// and opens the editor; the editor (ProjectLifecycle, `useStartBrief`) then finishes the start once its session is
// open: one "Describe Your Video" step sets the brief (and a frame shape no preset has), the files are imported into
// the project, and when no agent has called the engine recently Help ▸ Connect an AI Agent… opens. The pending start
// lives in memory (files cannot be stored), keyed by project id, and is taken once.
import type { AgentPresence } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { type BriefForm, briefPatch, formAspect, sequenceShapeFor } from '../brief/model.ts';
import { t } from '../i18n/runtime.ts';
import type { ImportResult } from '../state/services.ts';

export type PendingStart = {
	form: BriefForm;
	/** The frame the sequence must get when no preset has the brief's shape (`sequenceShapeFor`). */
	settings: { width: number; height: number } | null;
	files: File[];
	/** Desktop: absolute paths picked with the native dialog. */
	paths: string[];
};

const pending = new Map<string, PendingStart>();

export function stashStart(projectId: string, start: PendingStart): void {
	pending.set(projectId, start);
}

/** The pending start of a project, removed (a start runs once). */
export function takeStart(projectId: string): PendingStart | null {
	const s = pending.get(projectId) ?? null;
	pending.delete(projectId);
	return s;
}

/** The frame shape a form asks for and the sequence preset (and custom frame) Home creates for it. */
export function startShape(form: BriefForm) {
	const aspect = formAspect(form);
	return { aspect, ...sequenceShapeFor(aspect) };
}

export type StartDeps = {
	importFiles(input: { files?: File[]; paths?: string[] }): Promise<ImportResult>;
	/** Agents seen by the engine recently; null when the engine could not say. */
	presence(): Promise<AgentPresence | null>;
	openConnectAgent(): void;
	notify(n: { kind: 'success' | 'warning' | 'error'; message: string; detail?: string }): void;
};

export type StartOutcome = {
	briefSet: boolean;
	imported: number;
	failed: number;
	agentConnected: boolean;
};

/** Finishes a start in the open session (see the file comment). Never throws: failures are notified. */
export async function runStart(
	session: EditorSession,
	start: PendingStart,
	deps: StartDeps,
): Promise<StartOutcome> {
	const out: StartOutcome = { briefSet: false, imported: 0, failed: 0, agentConnected: false };
	if (session.getState().readOnly) {
		deps.notify({
			kind: 'error',
			message: t('The brief was not saved'),
			detail: t('The project opened read-only.'),
		});
		return out;
	}
	const doc = session.getCommitted();
	const seqId = session.getState().activeSequenceId ?? Object.keys(doc.sequences)[0];
	if (seqId) {
		const commands: unknown[] = [];
		if (start.settings)
			commands.push({ type: 'sequence.updateSettings', sequenceId: seqId, settings: start.settings });
		commands.push({ type: 'sequence.setBrief', sequenceId: seqId, brief: briefPatch(start.form) });
		const r = session.apply({
			label: t('Describe Your Video'),
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		out.briefSet = r.ok;
		if (!r.ok)
			deps.notify({
				kind: 'error',
				message: t('The brief was not saved'),
				detail: r.errors.map((e) => `${e.code}: ${e.message}`).join('; '),
			});
	}
	if (start.files.length || start.paths.length) {
		try {
			const res = await deps.importFiles({
				...(start.files.length ? { files: start.files } : {}),
				...(start.paths.length ? { paths: start.paths } : {}),
			});
			out.imported = res.mediaIds.length;
			out.failed = res.failed.length;
		} catch (e) {
			out.failed = start.files.length + start.paths.length;
			deps.notify({
				kind: 'error',
				message: t('Importing the files failed'),
				detail: e instanceof Error ? e.message : String(e),
			});
		}
	}
	let presence: AgentPresence | null = null;
	try {
		presence = await deps.presence();
	} catch {
		presence = null;
	}
	out.agentConnected = !!presence && presence.agents.length > 0;
	if (out.agentConnected)
		deps.notify({
			kind: 'success',
			message: t('Brief saved for {0}', presence!.agents[0]!.name),
			detail: t('Ask your agent to read the brief (get_brief) and propose a cut.'),
		});
	else deps.openConnectAgent();
	return out;
}
