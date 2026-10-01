// Properties ▸ Template (S05:ECP-008/PRP-001 actions, S11:ATP-007/008/009; registered through `clipSections` by
// commands/mg.ts): the template's name, version and engine ("anime · Remotion" / "fframes" / not installed), and
// its actions — "Update template to vN" when the registry has an upgrade path (one undo step), Re-render (fframes
// only; hidden for anime templates, which jasper-mg never renders) and Open in Motion Templates. Mixed selections
// list every engine and offer the actions any selected clip supports. The params form stays in the built-in
// Parameters section.
import type { Clip, MgTemplateRegistry } from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { Button, toast } from '@jasper/ui';
import { templateUpgradeFor, updateTemplates } from '../../commands/mg.ts';
import type { ClipSectionProps } from '../../extensions/index.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

/** Engine label of a motion-graphic clip: the registry decides for installed templates, the stamp otherwise. */
export function templateEngineLabel(reg: MgTemplateRegistry, clip: MgClip): string {
	const info = reg.get(clip.template.id, clip.template.version);
	if (!info) return 'not installed';
	return info.renderer === 'anime' ? 'anime · Remotion' : 'fframes';
}

export function MgTemplateSection({ session, clips }: ClipSectionProps) {
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const runtime = useShellRuntimeOrNull();
	const reg = session.ctx.registries.mgTemplates;
	const mg = clips.filter((c): c is MgClip => c.kind === 'motion-graphic');
	const first = mg[0];
	if (!first) return null;
	const key = (c: MgClip) => `${c.template.id}@${c.template.version}`;
	const same = mg.every((c) => key(c) === key(first));
	const info = reg.get(first.template.id, first.template.version);
	// Mixed selections: every clip counts (not only the first) for the engines shown and the actions offered.
	const engines = [...new Set(mg.map((c) => templateEngineLabel(reg, c)))];
	const engine = templateEngineLabel(reg, first);
	const upgrades = [...new Set(mg.map((c) => templateUpgradeFor(reg, c)).filter((v) => v !== null))];
	const anime = info?.renderer === 'anime';
	// mg.rerender renders the fframes clips of the selection: offered when there is at least one.
	const hasFframes = engines.includes('fframes');
	const run = (id: string) => void runtime?.run(id);
	return (
		<div className="flex flex-col gap-1 px-2 py-1 text-pr-ui" data-testid="mg-template-section">
			{same ? (
				<>
					<div className="flex items-baseline gap-1">
						<span className="truncate text-pr-text">{info?.name ?? first.template.id}</span>
						<span className="text-pr-small text-pr-dim">
							{first.template.id}@{first.template.version}
						</span>
					</div>
					<div className="flex items-center gap-1 text-pr-small" data-testid="mg-template-engine">
						<span
							className={
								engine === 'not installed'
									? 'rounded-pr-pill bg-pr-danger px-1 text-pr-on-accent'
									: anime
										? 'rounded-pr-pill bg-pr-engine-anime px-1 text-pr-on-accent'
										: 'rounded-pr-pill bg-pr-engine-fframes px-1 text-pr-on-accent'
							}
						>
							{engine === 'not installed' ? '!' : anime ? 'R' : 'F'}
						</span>
						<span className="text-pr-muted">{engine}</span>
					</div>
					{engine === 'not installed' ? (
						<p className="text-pr-small text-pr-danger">
							This template is not installed: the clip shows a placeholder and cannot be exported.
						</p>
					) : info?.description ? (
						<p className="text-pr-small text-pr-dim">{info.description}</p>
					) : null}
				</>
			) : (
				<>
					<p className="text-pr-small text-pr-muted">Different templates selected.</p>
					<div className="text-pr-small text-pr-muted" data-testid="mg-template-engine">
						{engines.join(' / ')}
					</div>
				</>
			)}
			<div className="flex flex-wrap gap-1">
				{upgrades.length > 0 ? (
					<Button
						variant="primary"
						disabled={readOnly}
						data-testid="mg-template-update"
						onClick={() => {
							const r = updateTemplates(
								session,
								mg.map((c) => c.id),
							);
							if (!r.ok)
								toast({ kind: 'warning', title: 'Could not update the template', detail: r.message });
						}}
					>
						{upgrades.length === 1 ? `Update template to v${upgrades[0]}` : 'Update templates'}
					</Button>
				) : null}
				{hasFframes ? (
					<Button
						disabled={readOnly || !runtime}
						data-testid="mg-template-rerender"
						onClick={() => run('mg.rerender')}
					>
						Re-render
					</Button>
				) : null}
				<Button disabled={!runtime} onClick={() => run('panel.focus.motionTemplates')}>
					Open in Motion Templates
				</Button>
			</div>
		</div>
	);
}
