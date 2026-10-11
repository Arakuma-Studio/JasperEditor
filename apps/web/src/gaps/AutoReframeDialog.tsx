import type { ReframeResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	REFRAME_ASPECTS,
	REFRAME_TRACKING,
	type ReframeSubjectPath,
	type ReframeTracking,
	reframeJobsFor,
	reframeSize,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, Select, TextField, toast } from '@jasper/ui';
import { useState } from 'react';
import { errorText, followJob } from '../processing/engine-jobs.ts';

export const AUTO_REFRAME_DIALOG = 'gaps.autoReframe';

type Props = { session: EditorSession; engine: EngineClient; sequenceId: string };

/** Analyses every video clip of a sequence and applies the reframe; resolves with the new sequence id. */
export async function runAutoReframe(
	engine: EngineClient,
	session: EditorSession,
	opts: {
		sequenceId: string;
		aspect: { num: number; den: number };
		tracking: ReframeTracking;
		name?: string;
	},
): Promise<string | null> {
	const doc = session.getCommitted();
	const seq = doc.sequences[opts.sequenceId];
	if (!seq) return null;
	const jobs = reframeJobsFor(doc as never, opts.sequenceId);
	if (!jobs.length) {
		toast({
			kind: 'warning',
			title: 'Auto Reframe',
			detail: 'The sequence has no video clips of engine media.',
		});
		return null;
	}
	const subjects: ReframeSubjectPath[] = [];
	let faces = 0;
	let note: string | undefined;
	for (const j of jobs) {
		const job = await engine.call('reframeAnalysis', {
			body: {
				projectId: session.projectId,
				mediaKey: j.mediaKey,
				startFrame: j.startFrame,
				frameCount: j.frameCount,
			},
		});
		const done = await followJob(engine, job.id, { intervalMs: 500 });
		if (done.state !== 'succeeded') throw new Error(done.error?.message ?? `Analysis ${done.state}`);
		const r = done.result as ReframeResult;
		faces += r.facesFound;
		note ??= r.note;
		for (const clipId of j.clipIds)
			subjects.push({ clipId, start: r.start, frameDuration: r.frameDuration, points: r.points });
	}
	const size = reframeSize(seq.settings.width, seq.settings.height, opts.aspect);
	const res = session.apply({
		label: 'Auto Reframe Sequence',
		origin: 'user',
		commands: [
			{
				type: 'sequence.autoReframe',
				sequenceId: opts.sequenceId,
				width: size.width,
				height: size.height,
				tracking: opts.tracking,
				...(opts.name ? { name: opts.name } : {}),
				subjects,
			} as never,
		],
	});
	if (!res.ok) throw new Error(res.errors.map((e) => e.message).join('; '));
	const out = res.results[0] as { sequenceId: string; reframed: string[]; skipped: { reason: string }[] };
	toast({
		kind: 'info',
		title: 'Auto Reframe Sequence',
		detail: `${out.reframed.length} clips reframed${out.skipped.length ? `, ${out.skipped.length} kept (animated Motion)` : ''}; subject from ${
			faces ? 'faces' : 'motion and contrast'
		}${note === 'FACE_MODEL_NOT_INSTALLED' ? ' (install the face model in Preferences ▸ Roto & Face Tracking to follow faces)' : ''}.`,
	});
	session.openSequence(out.sequenceId);
	return out.sequenceId;
}

function AutoReframeDialog(props: HostedDialogProps<Props>) {
	const { session, engine, sequenceId } = props;
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const item = Object.values(doc.items).find(
		(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === sequenceId,
	);
	const [aspect, setAspect] = useState<string>('vertical-9-16');
	const [custom, setCustom] = useState({ num: 9, den: 16 });
	const [tracking, setTracking] = useState<ReframeTracking>('default');
	const ratio = aspect === 'custom' ? custom : REFRAME_ASPECTS.find((a) => a.id === aspect)!;
	const size = seq ? reframeSize(seq.settings.width, seq.settings.height, ratio) : null;
	const [name, setName] = useState(`${item?.name ?? 'Sequence'} - (${ratio.num}:${ratio.den})`);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && !busy && props.close()}
			title="Auto Reframe Sequence"
			primaryLabel={busy ? 'Analyzing…' : 'Create'}
			primaryDisabled={busy || !seq}
			onPrimary={async () => {
				setBusy(true);
				setError(null);
				try {
					await runAutoReframe(engine, session, {
						sequenceId,
						aspect: ratio,
						tracking,
						name: name.trim() || undefined,
					});
					props.close();
				} catch (e) {
					setError(errorText(e));
					setBusy(false);
				}
				return false;
			}}
			data-testid="auto-reframe-dialog"
		>
			<div className="flex flex-col gap-2">
				<TextField
					aria-label="Sequence Name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					data-testid="reframe-name"
				/>
				<Select
					label="Target Aspect Ratio"
					value={aspect}
					onValueChange={(v) => {
						setAspect(v);
						const r = v === 'custom' ? custom : REFRAME_ASPECTS.find((a) => a.id === v)!;
						setName(`${item?.name ?? 'Sequence'} - (${r.num}:${r.den})`);
					}}
					options={[
						...REFRAME_ASPECTS.map((a) => ({ value: a.id, label: a.label })),
						{ value: 'custom', label: 'Custom' },
					]}
				/>
				{aspect === 'custom' ? (
					<div className="flex items-center gap-2">
						<TextField
							aria-label="Aspect width"
							type="number"
							min={1}
							max={100}
							className="w-16"
							value={custom.num}
							onChange={(e) =>
								setCustom((c) => ({ ...c, num: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))
							}
						/>
						<span>:</span>
						<TextField
							aria-label="Aspect height"
							type="number"
							min={1}
							max={100}
							className="w-16"
							value={custom.den}
							onChange={(e) =>
								setCustom((c) => ({ ...c, den: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))
							}
						/>
					</div>
				) : null}
				<Select
					label="Motion Tracking"
					value={tracking}
					onValueChange={(v) => setTracking(v as ReframeTracking)}
					options={(Object.keys(REFRAME_TRACKING) as ReframeTracking[]).map((k) => ({
						value: k,
						label: REFRAME_TRACKING[k].label,
					}))}
				/>
				{size ? (
					<p className="text-pr-small text-pr-muted">
						New frame size {size.width} × {size.height}; clips are scaled to fill it and follow their subject.
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerAutoReframeDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(AUTO_REFRAME_DIALOG, AutoReframeDialog);
}
