// Quick Export / queue (S05:EX-050, S04 §10.1): plans and starts an export of a sequence with the remembered
// (or default "Match Sequence – H.264", Auto engine) settings without opening Export mode.
import type { EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { trackExportJob } from './mode.ts';
import { blockingForEngine } from './PlanSummary.tsx';
import {
	buildExportSettings,
	exportEnvelope,
	exportExtension,
	exportRange,
	loadExportChoice,
	sanitizeFileName,
	validateExport,
} from './settings.ts';

export class QuickExportError extends Error {
	constructor(
		message: string,
		readonly reasons: string[] = [],
	) {
		super(message);
		this.name = 'QuickExportError';
	}
}

export async function startQuickExport(
	session: EditorSession,
	engine: EngineClient,
	sequenceId?: string | null,
): Promise<EngineJob> {
	const doc = session.getCommitted();
	const seqId = sequenceId ?? session.getState().activeSequenceId;
	const seq = seqId ? doc.sequences[seqId] : undefined;
	if (!seq) throw new QuickExportError('There is no sequence to export');
	const remembered = loadExportChoice(session.projectId, seq.id);
	const range = remembered?.range ?? 'entire';
	const engineChoice = remembered?.engine ?? 'auto';
	const errors = validateExport(seq, exportRange(seq, range));
	if (errors.length) throw new QuickExportError(errors[0]!, errors);
	const settings = buildExportSettings(seq, {
		range,
		engine: engineChoice,
		...(remembered?.codec ? { codec: remembered.codec } : {}),
		...(remembered?.encoder ? { encoder: remembered.encoder } : {}),
		...(remembered?.audio ? { audio: remembered.audio } : {}),
		...(remembered?.color ? { color: remembered.color } : {}),
		...(remembered?.alpha ? { alpha: true } : {}),
	});
	const envelope = exportEnvelope(doc, session.revision);
	const plan = await engine.planExport({ envelope, sequenceId: seq.id, settings });
	const blocking = blockingForEngine(plan, engineChoice);
	if (blocking.length)
		throw new QuickExportError(
			`Cannot export with the ${engineChoice} engine`,
			blocking.map((b) => b.reason),
		);
	const job = await engine.startExport({
		envelope,
		sequenceId: seq.id,
		settings,
		...(plan.planId ? { planId: plan.planId } : {}),
	});
	const itemName =
		Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === seq.id)?.name ?? 'Export';
	trackExportJob(
		job,
		`${sanitizeFileName(remembered?.fileName ?? itemName)}.${exportExtension(plan.encoder)}`,
	);
	return job;
}
