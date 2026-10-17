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

/** The plan's sound warnings (spec 12 §2.11: W_SOUND_CREDITS, W_SOUND_LICENSE_NC, W_SOUND_CHECK_STALE as info). */
export function soundWarningsOf(state: PlanState): RenderPlan['warnings'] {
	return state.status === 'ok' ? state.plan.warnings.filter((w) => w.code.startsWith('W_SOUND_')) : [];
}

export function PlanSummary(props: {
	state: PlanState;
	engine: ExportEngineChoice;
	sequence?: Sequence;
	/** Leave out the sound warnings (Export mode shows them in its SOUND section). */
	hideSoundWarnings?: boolean;
}) {
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
	const warnings = props.hideSoundWarnings
		? plan.warnings.filter((w) => !w.code.startsWith('W_SOUND_'))
		: plan.warnings;
	return (
		<div data-testid="plan-summary" className="flex flex-col gap-2 text-pr-small">
			<p className="text-pr-strong" data-testid="plan-path">
				Engine: {planChoiceSummary(plan, engine)}
			</p>
			<p className="text-pr-muted">
				{plan.segments.length} {plan.segments.length === 1 ? 'segment' : 'segments'} · audio {plan.audio.mode}{' '}
				· ~{formatDuration(plan.estimate.seconds)} to render · {sizeEstimateText(plan)}
			</p>
			{plan.smart ? (
				<p className={plan.smart.used ? 'text-pr-success' : 'text-pr-muted'} data-testid="plan-smart">
					{plan.smart.used
						? `Smart render: ${plan.smart.copiedFrames} frames copied from the sources`
						: `Smart render not used: ${plan.smart.reasons.slice(0, 2).join('; ') || 'nothing to copy'}`}
				</p>
			) : null}
			{blocking.length ? (
				<p className="text-pr-danger" data-testid="plan-blocking">
					This sequence cannot be exported with the {engine} engine:
				</p>
			) : null}
			{plan.blockers.length ? <BlockerList blockers={plan.blockers} sequence={sequence} /> : null}
			{warnings.length ? (
				<ul className="flex flex-col gap-1" data-testid="plan-warnings">
					{warnings.map((w) => (
						<li
							key={`${w.code}|${w.message}`}
							className={w.level === 'info' ? 'text-pr-muted' : 'text-pr-warning'}
							data-code={w.code}
						>
							{w.level === 'info' ? 'ⓘ' : '⚠'} {w.message}
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
