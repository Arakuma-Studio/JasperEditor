// Right-click key ▸ Rove Across Time (keyframes-blend; After Effects' keyframe menu item): a checkable item for the
// selected keys. Checked when they all rove; choosing it makes them all rove (or all stop roving when checked). The
// first and last keys of a property and hold keys cannot rove: the command skips them with a warning.
import type { Command } from '@jasper/project';
import { isHoldOnlyValue } from '@jasper/project';
import type { buildGroups } from './items.ts';

type EcGroup = ReturnType<typeof buildGroups>[number];

/** The keys among `ids` that could rove, and whether every one of them roves. */
export function rovingKeys(
	groups: readonly EcGroup[],
	ids: readonly string[],
): { ids: string[]; all: boolean } {
	const want = new Set(ids);
	const out: string[] = [];
	let all = true;
	const seen = new Set<string>();
	for (const g of groups)
		for (const s of g.sections)
			for (const r of s.rows)
				for (const b of r.bindings) {
					const kfs = b.resolved.anim?.keyframes ?? [];
					kfs.forEach((k, i) => {
						if (!want.has(k.id) || seen.has(k.id)) return;
						seen.add(k.id);
						if (i === 0 || i === kfs.length - 1) return;
						if (k.interpolation === 'hold' || isHoldOnlyValue(k.value)) return;
						out.push(k.id);
						if (!k.roving) all = false;
					});
				}
	return { ids: out, all: all && out.length > 0 };
}

export function rovingCommand(keyframeIds: string[], roving: boolean): Command {
	return { type: 'keyframe.setRoving', keyframeIds, roving } as Command;
}

const ITEM =
	'flex w-full items-center gap-2 px-3 py-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent';

export function RoveAcrossTimeItem(props: {
	groups: readonly EcGroup[];
	ids: readonly string[];
	onApply(label: string, commands: Command[]): void;
}) {
	const { ids, all } = rovingKeys(props.groups, props.ids);
	if (ids.length === 0) return null;
	return (
		<div className="mt-1 border-t border-pr-border-subtle pt-1">
			<button
				type="button"
				role="menuitemcheckbox"
				aria-checked={all}
				className={ITEM}
				data-testid="ec-kf-rove"
				onClick={() => props.onApply('Rove Across Time', [rovingCommand(ids, !all)])}
			>
				<span aria-hidden className="inline-block w-3">
					{all ? '✓' : ''}
				</span>
				Rove Across Time
			</button>
		</div>
	);
}
