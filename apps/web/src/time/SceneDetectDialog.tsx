import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, ScrubbyNumber, Slider } from '@jasper/ui';
import { useMemo, useRef, useState } from 'react';
import {
	applySceneEdits,
	DEFAULT_SCENE_OPTIONS,
	detectScenes,
	type SceneOptions,
	sceneTargets,
} from './scenes.ts';

export const SCENE_DETECT_DIALOG = 'time.sceneEditDetection';

export type SceneDetectDialogProps = { session: EditorSession; sequenceId: string; clipIds: string[] };

let last: SceneOptions = DEFAULT_SCENE_OPTIONS;

export function SceneDetectDialog(props: HostedDialogProps<SceneDetectDialogProps>) {
	const { session, sequenceId, clipIds } = props;
	const [open, setOpen] = useState(true);
	const [o, setO] = useState<SceneOptions>(last);
	const [busy, setBusy] = useState<{ done: number; label: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	const targets = useMemo(() => sceneTargets(session, sequenceId, clipIds), [session, sequenceId, clipIds]);
	const close = (r?: unknown) => {
		setOpen(false);
		props.close(r);
	};
	const any = o.applyCuts || o.createSubclips || o.createMarkers;
	const analyse = async () => {
		const engine = session.engine;
		if (!engine) {
			setError('The engine is not connected');
			return false;
		}
		last = o;
		setError(null);
		const ac = new AbortController();
		abort.current = ac;
		try {
			const results = await detectScenes(
				engine,
				session.projectId,
				targets,
				o,
				(done, label) => setBusy({ done, label }),
				ac.signal,
			);
			const cuts = [...results.values()].reduce((n, r) => n + r.cuts.length, 0);
			if (cuts === 0) {
				setBusy(null);
				setError('Scene Edit Detection found no cut points');
				return false;
			}
			const r = applySceneEdits(session, sequenceId, results, o);
			if (!r.ok) {
				setBusy(null);
				setError(r.errors[0]?.message ?? 'Scene Edit Detection failed');
				return false;
			}
			close({ cuts });
			return true;
		} catch (e) {
			setBusy(null);
			setError((e as Error).message);
			return false;
		} finally {
			abort.current = null;
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) {
					abort.current?.abort();
					close();
				}
			}}
			title="Scene Edit Detection"
			size="medium"
			primaryLabel="Analyze"
			primaryDisabled={!any || targets.length === 0 || !!busy}
			onPrimary={() => {
				void analyse();
				return false;
			}}
			data-testid="scene-detect-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<Checkbox
					checked={o.applyCuts}
					onCheckedChange={(v) => setO({ ...o, applyCuts: v })}
					label="Apply a cut at each detected cut point"
					disabled={!!busy}
				/>
				<Checkbox
					checked={o.createSubclips}
					onCheckedChange={(v) => setO({ ...o, createSubclips: v })}
					label="Create subclip for each cut (in a new bin)"
					disabled={!!busy}
				/>
				<Checkbox
					checked={o.createMarkers}
					onCheckedChange={(v) => setO({ ...o, createMarkers: v })}
					label="Generate clip markers at each detected cut point"
					disabled={!!busy}
				/>
				<div className="flex items-center gap-2">
					<span className="w-[140px] shrink-0 text-pr-muted">Sensitivity</span>
					<Slider
						value={o.sensitivity}
						min={0}
						max={100}
						step={1}
						defaultValue={50}
						label="Sensitivity"
						disabled={!!busy}
						onChange={(v) => setO({ ...o, sensitivity: v })}
						onCommit={(v) => setO({ ...o, sensitivity: v })}
					/>
					<span className="w-[32px] text-right">{o.sensitivity}</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-[140px] shrink-0 text-pr-muted">Shortest shot</span>
					<ScrubbyNumber
						label="Shortest shot"
						value={o.minShotFrames}
						min={1}
						max={1000}
						unit="frames"
						disabled={!!busy}
						onCommit={(v) => setO({ ...o, minShotFrames: v })}
						onScrubEnd={(v) => setO({ ...o, minShotFrames: v })}
					/>
				</div>
				<p className="text-pr-small text-pr-muted">
					{targets.length === 0
						? 'Select one or more video clips in the Timeline.'
						: `${targets.length} clip${targets.length === 1 ? '' : 's'} will be analysed. Cuts are applied to linked audio too; the result is one undo step.`}
				</p>
				{busy ? (
					<div className="flex flex-col gap-1" data-testid="scene-detect-progress">
						<span className="text-pr-small">{busy.label}</span>
						<div className="h-[4px] w-full bg-pr-field">
							<div className="h-full bg-pr-accent" style={{ width: `${Math.round(busy.done * 100)}%` }} />
						</div>
					</div>
				) : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
