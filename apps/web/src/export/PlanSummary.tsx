// Render plan summary (S04:EX-005, RP-008/010; S05:EX-012 Summary, EX-021): the chosen path and why,
// blockers per clip, warnings and estimates.
import type { RenderPlan } from '@jasper/api';
import type { Sequence } from '@jasper/project';
import { type ExportEngineChoice, formatDuration, planChoiceSummary, sizeEstimateText } from './settings.ts';

export type PlanState =
	| { status: 'idle' }
	| { status: 'planning' }
	| { status: 'ok'; plan: RenderPlan }
	| { status: 'error'; code: string; message: string; blockers?: RenderPlan['blockers'] };

function clipName(seq: Sequence | undefined, itemId: string | undefined): string | null {
	if (!itemId || !seq) return null;
	const c = seq.clips[itemId];
	return c ? (c.name ?? c.kind) : itemId;
}

/** Blockers that make the chosen engine impossible (forcing an ineligible path, S04:RP-012). */
export function blockingForEngine(plan: RenderPlan, engine: ExportEngineChoice): RenderPlan['blockers'] {
	if (engine === 'auto' || engine === 'remotion') return [];
	return plan.blockers.filter((b) => b.path === engine);
}

export function PlanSummary(props: { state: PlanState; engine: ExportEngineChoice; sequence?: Sequence }) {
	const { state, engine, sequence } = props;
	if (state.status === 'idle') return null;
	if (state.status === 'planning')
		return (
			<p className="text-pr-small text-pr-muted" data-testid="plan-summary">
				Planning export…
			</p>
		);
	if (state.status === 'error')
		return (
			<div data-testid="plan-summary" className="flex flex-col gap-1">
				<p className="text-pr-small text-pr-danger" data-testid="plan-error">
					{state.code === 'NOT_IMPLEMENTED'
						? 'The engine cannot plan exports yet.'
						: state.code === 'NETWORK'
							? 'Engine not reachable.'
							: `${state.code}: ${state.message}`}
				</p>
				{state.blockers?.length ? <BlockerList blockers={state.blockers} sequence={sequence} /> : null}
			</div>
		);
	const { plan } = state;
	const blocking = blockingForEngine(plan, engine);
	return (
		<div data-testid="plan-summary" className="flex flex-col gap-2 text-pr-small">
			<p className="text-pr-strong" data-testid="plan-path">
				Engine: {planChoiceSummary(plan, engine)}
			</p>
			<p className="text-pr-muted">
				{plan.segments.length} {plan.segments.length === 1 ? 'segment' : 'segments'} · audio {plan.audio.mode}{' '}
				· ~{formatDuration(plan.estimate.seconds)} to render · {sizeEstimateText(plan)}
			</p>
			{blocking.length ? (
				<p className="text-pr-danger" data-testid="plan-blocking">
					This sequence cannot be exported with the {engine} engine:
				</p>
			) : null}
			{plan.blockers.length ? <BlockerList blockers={plan.blockers} sequence={sequence} /> : null}
			{plan.warnings.length ? (
				<ul className="flex flex-col gap-1" data-testid="plan-warnings">
					{plan.warnings.map((w) => (
						<li key={`${w.code}|${w.message}`} className="text-pr-warning">
							⚠ {w.message}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function BlockerList({ blockers, sequence }: { blockers: RenderPlan['blockers']; sequence?: Sequence }) {
	return (
		<ul className="flex flex-col gap-1" data-testid="plan-blockers">
			{blockers.map((b) => {
				const name = clipName(sequence, b.itemId);
				return (
					<li key={`${b.itemId ?? ''}|${b.path}|${b.reason}`} className="text-pr-muted">
						<span className="text-pr-text">{name ? `“${name}”` : 'Sequence'}</span> — not {b.path}: {b.reason}
					</li>
				);
			})}
		</ul>
	);
}
