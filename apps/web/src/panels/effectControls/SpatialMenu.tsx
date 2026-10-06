// Right-click key ▸ Spatial Interpolation ▸ Linear / Bezier / Auto Bezier / Continuous Bezier (S03:KF-021) for
// keys of vec2 point properties (Position, Anchor Point, point params). Offered when at least one of the keys is
// on such a property; the command touches only those keys. A check marks the mode they all share.
import type { Command, SpatialInterpolation } from '@jasper/project';
import { spatialModeOf } from '@jasper/project';
import { cx } from '@jasper/ui';
import { useState } from 'react';
import type { buildGroups } from './items.ts';

type EcGroup = ReturnType<typeof buildGroups>[number];

export const SPATIAL_MENU: { mode: SpatialInterpolation; label: string }[] = [
	{ mode: 'linear', label: 'Linear' },
	{ mode: 'bezier', label: 'Bezier' },
	{ mode: 'auto-bezier', label: 'Auto Bezier' },
	{ mode: 'continuous-bezier', label: 'Continuous Bezier' },
];

/** The keys among `ids` that belong to point properties, with their current spatial modes. */
export function spatialKeys(
	groups: readonly EcGroup[],
	ids: readonly string[],
): { ids: string[]; modes: Set<SpatialInterpolation> } {
	const want = new Set(ids);
	const out: string[] = [];
	const modes = new Set<SpatialInterpolation>();
	for (const g of groups)
		for (const s of g.sections)
			for (const r of s.rows)
				for (const b of r.bindings) {
					if (!b.spec.spatial || !b.path) continue;
					for (const k of b.resolved.anim?.keyframes ?? [])
						if (want.has(k.id)) {
							out.push(k.id);
							modes.add(spatialModeOf(k));
						}
				}
	return { ids: out, modes };
}

export function spatialCommand(keyframeIds: string[], mode: SpatialInterpolation): Command {
	return { type: 'keyframe.setSpatialInterpolation', keyframeIds, mode } as Command;
}

const ITEM =
	'block w-full px-3 py-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent';

export function SpatialInterpolationSubmenu(props: {
	groups: readonly EcGroup[];
	ids: readonly string[];
	onApply(label: string, commands: Command[]): void;
}) {
	const [open, setOpen] = useState(false);
	const { ids, modes } = spatialKeys(props.groups, props.ids);
	if (ids.length === 0) return null;
	const only = modes.size === 1 ? [...modes][0] : null;
	return (
		<div
			className="relative mt-1 border-t border-pr-border-subtle pt-1"
			onPointerEnter={() => setOpen(true)}
			onPointerLeave={() => setOpen(false)}
		>
			<button
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={open}
				className={cx(ITEM, 'flex items-center justify-between gap-3')}
				data-testid="ec-kf-spatial"
				onClick={() => setOpen(true)}
			>
				<span>Spatial Interpolation</span>
				<span aria-hidden>▸</span>
			</button>
			{open ? (
				<div
					role="menu"
					className="absolute top-0 left-full min-w-[150px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
					data-testid="ec-kf-spatial-menu"
				>
					{SPATIAL_MENU.map((m) => (
						<button
							key={m.mode}
							type="button"
							role="menuitemradio"
							aria-checked={only === m.mode}
							className={cx(ITEM, 'flex items-center gap-2')}
							data-spatial={m.mode}
							onClick={() =>
								props.onApply(`Spatial Interpolation: ${m.label}`, [spatialCommand(ids, m.mode)])
							}
						>
							<span className="inline-block w-3" aria-hidden>
								{only === m.mode ? '✓' : ''}
							</span>
							{m.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
