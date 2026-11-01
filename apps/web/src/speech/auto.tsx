// wp speech: "Automatically transcribe media on import" (Premiere: Preferences ▸ Transcription / Auto-transcribe on
// import). When on, media with sound added to the project — by the user (File ▸ Import, drops) or, spec 18
// AF-DIG-003, by an agent while the editor is open — are transcribed in the background with the chosen model and
// language, if that model is downloaded. Not on undo/redo, and not media that already have a transcript or a
// transcription job queued or running on the engine (an agent's `import_media {transcribe}` queues its jobs before the
// import transaction, so they are seen here). Mounted invisibly through the Program monitor overlay registry, like
// the other session runtimes.
import { type SpeechModel, TERMINAL_JOB_STATES } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { useEffect } from 'react';
import { z } from 'zod';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { transcribeMedia } from './jobs.ts';
import { defaultOptions, hasAudio, requestOptions } from './model.ts';

const AutoTranscribeSchema = z.object({
	enabled: z.boolean().catch(false),
	model: z.string().min(1).catch('whisper-base'),
	language: z.string().min(1).catch('auto'),
});
export type AutoTranscribe = z.infer<typeof AutoTranscribeSchema>;

export function parseAutoTranscribe(value: unknown): AutoTranscribe {
	const parsed = AutoTranscribeSchema.safeParse(value);
	return parsed.success ? parsed.data : AutoTranscribeSchema.parse({});
}
const KEY = 'jasper:speech-auto';

export function loadAuto(): AutoTranscribe {
	try {
		return parseAutoTranscribe(JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null'));
	} catch {
		return parseAutoTranscribe(null);
	}
}

export function saveAuto(a: AutoTranscribe): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(a));
	} catch {
		/* storage unavailable */
	}
}

/** The media ids among `created` that should be transcribed now. */
export function autoTargets(session: EditorSession, created: readonly string[]): string[] {
	const doc = session.getCommitted();
	return created.filter((id) => {
		const m = doc.media[id] as MediaAsset | undefined;
		return (
			!!m &&
			// derived media (processed versions, Derive Media results) are not imports
			!m.derivation &&
			hasAudio(m) &&
			!!mediaKeyOf(m) &&
			!Object.values(doc.transcripts).some((t) => t.mediaId === id)
		);
	});
}

/**
 * Media keys with a transcription job queued or running on the engine for this project (empty when the engine cannot
 * list jobs: the job's own dedupe key still prevents an identical second job).
 */
export async function pendingTranscriptionKeys(
	client: EngineClient,
	projectId: string,
): Promise<Set<string>> {
	try {
		const { jobs } = await client.listJobs({ active: '1', projectId });
		return new Set(
			jobs
				.filter((j) => j.kind === 'transcription' && j.assetId && !TERMINAL_JOB_STATES.has(j.state))
				.map((j) => j.assetId as string),
		);
	} catch {
		return new Set();
	}
}

const byAgent = (origin: unknown) => typeof origin === 'object' && origin !== null && 'agent' in origin;

export function AutoTranscribeHost({ session }: Pick<ProgramOverlayHostProps, 'session'>) {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	useEffect(() => {
		if (!session || !client) return;
		return session.on('doc.changed', (ev) => {
			if (ev.isUndo || ev.isRedo || session.getState().readOnly) return;
			if (ev.origin !== 'user' && !byAgent(ev.origin)) return;
			if (!ev.created.some((id) => id.startsWith('med_'))) return;
			const auto = loadAuto();
			if (!auto.enabled) return;
			const created = autoTargets(session, ev.created);
			if (!created.length) return;
			void (async () => {
				const pending = await pendingTranscriptionKeys(client, session.projectId);
				const doc = session.getCommitted();
				const ids = created.filter((id) => {
					const key = mediaKeyOf(doc.media[id] as MediaAsset | undefined);
					return !!key && !pending.has(key);
				});
				if (!ids.length) return;
				const models = ((await client.call('speechModels')) as { models: SpeechModel[] }).models;
				const m = models.find((x) => x.id === auto.model);
				if (!m?.installed) {
					toast({
						kind: 'info',
						title: 'Not transcribed automatically',
						detail: `${m?.name ?? auto.model} is not downloaded (Preferences ▸ Transcription).`,
					});
					return;
				}
				const options = requestOptions({ ...defaultOptions(m.id), language: auto.language }, m.multilingual);
				await transcribeMedia({ engine: client, session, mediaIds: ids, options, replace: false });
			})().catch((error) =>
				toast({ kind: 'error', title: 'Automatic transcription failed', detail: errorText(error) }),
			);
		});
	}, [session, client]);
	return null;
}
