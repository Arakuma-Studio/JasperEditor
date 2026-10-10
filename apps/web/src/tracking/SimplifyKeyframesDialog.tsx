// "Simplify Keyframes" dialog (S09:TRK-023, TRU-006): reduces dense keyframes (tracking output, any keyframed
// parameter) to the fewest keys within a tolerance. While it is open the result is previewed live through a session
// gesture — the Program monitor and Effect Controls show the simplified animation — with the key counts, the
// measured deviation (max / mean, per group) and a deviation-over-time graph against the tolerance. Apply is one
// History entry "Simplify Keyframes"; Cancel / Esc leaves the document untouched.
import type { Command, SimplifyGroupReport, SimplifyReport } from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { cx, Dialog, type HostedDialogProps, ScrubbyNumber } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

export const SIMPLIFY_DIALOG = 'keyframes.simplify';

/** What to simplify (exactly one of the selection forms of `keyframes.simplify`). */
export type SimplifySelection =
	| { keyframeIds: string[] }
	| { targets: string[][] }
	| { clipIds: string[]; trackedOnly?: boolean };

export type SimplifyDialogProps = {
	session: EditorSession;
	selection: SimplifySelection;
	/** Shown under the title, e.g. "Corner Pin of Screen.png" or "12 selected keyframes". */
	subject?: string;
	/** Initial tolerance (default: the last one used, else 0.1). */
	tolerance?: number;
};

const STORAGE_KEY = 'jasper.simplify.tolerance';
const PRESETS = [0.05, 0.1, 0.25, 0.5, 1, 2];
const DEBOUNCE_MS = 120;

export function lastSimplifyTolerance(): number {
	try {
		const v = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
		return Number.isFinite(v) && v > 0 ? v : 0.1;
	} catch {
		return 0.1;
	}
}

function rememberTolerance(v: number): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, String(v));
	} catch {
		// private mode: per session only
	}
}

/** The `keyframes.simplify` command for a selection. */
function simplifyCommand(selection: SimplifySelection, tolerance: number, details = false): Command {
	return {
		type: 'keyframes.simplify',
		tolerance,
		...selection,
		...(details ? { details: true } : {}),
	} as Command;
}

const fmt = (v: number) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const unitLabel = (u: string) => (u === 'deg' ? '°' : u ? ` ${u}` : '');

export function SimplifyKeyframesDialog(props: HostedDialogProps<SimplifyDialogProps>) {
	const { session, selection, subject, close } = props;
	const [open, setOpen] = useState(true);
	const [tolerance, setTolerance] = useState(props.tolerance ?? lastSimplifyTolerance());
	const [report, setReport] = useState<SimplifyReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const gesture = useRef<Gesture | null>(null);
	const readOnly = session.getState().readOnly;

	// Live preview: one gesture for the dialog's lifetime; every tolerance change re-applies to the base document.
	useEffect(() => {
		if (readOnly) return;
		try {
			gesture.current = session.beginGesture('Simplify Keyframes');
		} catch (e) {
			setError((e as Error).message);
		}
		return () => {
			gesture.current?.cancel();
			gesture.current = null;
		};
	}, [session, readOnly]);

	useEffect(() => {
		const id = setTimeout(() => {
			const g = gesture.current;
			const cmd = simplifyCommand(selection, tolerance, true);
			const r = g?.active
				? g.update([cmd])
				: session.apply({ label: 'Simplify Keyframes', origin: 'user', commands: [cmd], dryRun: true });
			if (r.ok) {
				setReport(r.results[0] as SimplifyReport);
				setError(null);
			} else {
				setReport(null);
				setError(r.errors.map((e) => e.message).join('; '));
			}
		}, DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [session, selection, tolerance]);

	const closed = useRef(false);
	const finish = (result?: unknown) => {
		gesture.current?.cancel();
		gesture.current = null;
		setOpen(false);
		if (closed.current) return; // Apply closes, then the dialog's own onOpenChange(false) arrives
		closed.current = true;
		close(result);
	};
	const apply = () => {
		gesture.current?.cancel();
		gesture.current = null;
		const r = session.apply({
			label: 'Simplify Keyframes',
			origin: 'user',
			commands: [simplifyCommand(selection, tolerance)],
		});
		if (!r.ok) {
			setError(r.errors.map((e) => e.message).join('; '));
			return false;
		}
		rememberTolerance(tolerance);
		finish(r.results[0]);
		return true;
	};

	const geometric = report ? report.groups.every((g) => g.kind === 'geometry') : true;
	const worst = useMemo(
		() =>
			report?.groups.reduce<SimplifyGroupReport | null>(
				(w, g) => (!w || g.maxError > w.maxError ? g : w),
				null,
			) ?? null,
		[report],
	);
	const nothing = report && report.properties.length === 0;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title="Simplify Keyframes"
			description="Reduce keyframes while keeping the animation within a tolerance"
			size="medium"
			primaryLabel="Apply"
			primaryDisabled={readOnly || !report || !!nothing || report.removed === 0}
			onPrimary={apply}
			data-testid="simplify-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				{subject ? <p className="text-pr-muted">{subject}</p> : null}
				<div className="flex items-center gap-2">
					<span className="w-[92px] shrink-0 text-pr-muted">Tolerance</span>
					<ScrubbyNumber
						value={tolerance}
						label="Tolerance"
						unit={geometric ? 'px' : undefined}
						min={0.001}
						max={100}
						step={0.01}
						precision={3}
						onScrub={(v) => setTolerance(v)}
						onScrubEnd={(v) => setTolerance(v)}
						onCommit={(v) => setTolerance(v)}
						className="w-[84px]"
						id="simplify-tolerance"
					/>
					<fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0" aria-label="Tolerance presets">
						{PRESETS.map((p) => (
							<button
								key={p}
								type="button"
								onClick={() => setTolerance(p)}
								className={cx(
									'h-[20px] rounded-pr-control px-2 text-pr-small pr-tabular',
									Math.abs(p - tolerance) < 1e-9
										? 'bg-pr-selected text-pr-strong'
										: 'bg-pr-field text-pr-text hover:bg-pr-hover',
								)}
								data-testid={`simplify-preset-${p}`}
							>
								{p}
							</button>
						))}
					</fieldset>
				</div>
				<p className="text-pr-small text-pr-dim">
					{geometric
						? 'Largest allowed movement of the picture, in sequence pixels, at any frame.'
						: 'Largest allowed change at any frame: sequence pixels for Motion and Corner Pin, the parameter’s own units otherwise.'}
				</p>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert" data-testid="simplify-error">
						{error}
					</p>
				) : null}
				{nothing ? (
					<p className="text-pr-small text-pr-warning" data-testid="simplify-nothing">
						Nothing to simplify: {report.skipped[0]?.reason ?? 'no keyframed parameters'}.
					</p>
				) : null}
				{report && !nothing ? (
					<>
						<div className="grid grid-cols-[92px_1fr] gap-y-1" data-testid="simplify-stats">
							<span className="text-pr-muted">Keyframes</span>
							<span className="text-pr-text pr-tabular" data-testid="simplify-counts">
								{report.before} → <span className="text-pr-strong">{report.after}</span>
								{report.before > 0 ? ` (−${Math.round((100 * report.removed) / report.before)} %)` : ''}
							</span>
							<span className="text-pr-muted">Deviation</span>
							<span className="text-pr-text pr-tabular" data-testid="simplify-deviation">
								max {fmt(report.maxError)}
								{worst ? unitLabel(worst.unit) : ''}
								{worst ? ` · mean ${fmt(worst.meanError)}${unitLabel(worst.unit)}` : ''}
								<span className="text-pr-muted"> (tolerance {fmt(tolerance)})</span>
							</span>
						</div>
						{worst?.errors?.length ? <DeviationGraph group={worst} tolerance={tolerance} /> : null}
						<PropertyTable report={report} />
					</>
				) : null}
				{readOnly ? <p className="text-pr-small text-pr-warning">The project is read-only.</p> : null}
			</div>
		</Dialog>
	);
}

/** Deviation over time of a group against the tolerance (the dashed line); bars over it would be a bug. */
function DeviationGraph({ group, tolerance }: { group: SimplifyGroupReport; tolerance: number }) {
	const W = 520;
	const H = 56;
	const errors = group.errors ?? [];
	const n = errors.length;
	const top = Math.max(tolerance, ...errors) || 1;
	const yOf = (e: number) => H - 2 - (e / top) * (H - 6);
	const path = errors
		.map((e, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, n - 1)) * W).toFixed(1)} ${yOf(e).toFixed(1)}`)
		.join(' ');
	return (
		<figure className="m-0 flex flex-col gap-1" data-testid="simplify-graph">
			<svg
				width="100%"
				height={H}
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="rounded-pr-control bg-pr-field-deep"
				role="img"
				aria-label={`Deviation per frame, max ${fmt(group.maxError)} of ${fmt(tolerance)}`}
			>
				<line
					x1={0}
					x2={W}
					y1={yOf(tolerance)}
					y2={yOf(tolerance)}
					stroke="var(--pr-warning)"
					strokeDasharray="4 3"
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
				/>
				<path
					d={path}
					fill="none"
					stroke="var(--pr-accent)"
					strokeWidth={1.25}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<figcaption className="text-pr-small text-pr-dim">
				Deviation at each of {n} samples (frames and original key times); dashed line = tolerance.
			</figcaption>
		</figure>
	);
}

function PropertyTable({ report }: { report: SimplifyReport }) {
	const rows = report.properties;
	if (rows.length <= 1 && !report.skipped.length) return null;
	return (
		<div
			className="max-h-[140px] overflow-auto rounded-pr-control border border-pr-border-subtle"
			data-testid="simplify-properties"
		>
			<table className="w-full text-pr-small">
				<tbody>
					{rows.map((p) => (
						<tr key={p.path.join('/')} className="border-b border-pr-border-subtle last:border-0">
							<td className="truncate px-2 py-[2px] text-pr-text">{p.label}</td>
							<td className="px-2 py-[2px] text-right text-pr-muted pr-tabular">
								{p.before} → <span className="text-pr-text">{p.after}</span>
							</td>
						</tr>
					))}
					{report.skipped.map((s) => (
						<tr key={`skip-${s.path.join('/')}`}>
							<td className="truncate px-2 py-[2px] text-pr-dim">
								{s.path.slice(2).join('.') || s.path.join('.')}
							</td>
							<td className="px-2 py-[2px] text-right text-pr-dim">{s.reason}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
