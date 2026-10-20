// Effect Controls ▸ right-click a key ▸ Apply Ease ▸ (recent curves and favourites), Copy Ease, Paste Ease, Open
// Easing Panel. The entries run the easing UI commands on the key selection (the menu selects the clicked key
// first); a disabled entry shows the command's reason as its tooltip.
import type { EaseCurve } from '@jasper/project';
import { cx } from '@jasper/ui';
import { useState } from 'react';
import { t } from '../../i18n/runtime.ts';
import { CurveThumb } from './CurveThumb.tsx';
import { BUILTIN_CATALOG, type EaseCatalog } from './catalog.ts';
import { useEaseDispatch } from './dispatch.tsx';
import { curveSummary } from './geometry.ts';
import { useEaseLibrary } from './library.ts';

const ITEM =
	'block w-full px-3 py-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent aria-disabled:pointer-events-none aria-disabled:text-pr-dim';

export function EaseKeyMenuItems(props: { onDone(): void; catalog?: EaseCatalog }) {
	const dispatch = useEaseDispatch();
	const lib = useEaseLibrary();
	const catalog = props.catalog ?? BUILTIN_CATALOG;
	const [open, setOpen] = useState(false);
	const all = new Map([...catalog.presets, ...lib.presets].map((p) => [p.id, p]));
	const favourites = lib.favourites.map((id) => all.get(id)).filter((p) => !!p);
	const named = (c: EaseCurve) => catalog.match(c, [...all.values()])?.name ?? curveSummary(c);
	const applyReason = dispatch.reason('ease.apply');
	const entry = (id: string, label: string, args?: unknown, testId?: string) => {
		const reason = dispatch.reason(id);
		return (
			<button
				key={testId ?? id}
				type="button"
				role="menuitem"
				aria-disabled={reason ? true : undefined}
				title={reason}
				className={ITEM}
				onClick={() => {
					if (reason) return;
					props.onDone();
					void dispatch.run(id, args);
				}}
				data-testid={testId ?? `ec-kf-${id}`}
			>
				{label}
			</button>
		);
	};
	const curveEntry = (key: string, label: string, curve: EaseCurve, name?: string) => (
		<button
			key={key}
			type="button"
			role="menuitem"
			aria-disabled={applyReason ? true : undefined}
			title={applyReason ?? label}
			className={cx(ITEM, 'flex items-center gap-2')}
			onClick={() => {
				if (applyReason) return;
				props.onDone();
				void dispatch.run('ease.apply', { curve, ...(name ? { name } : {}) });
			}}
			data-testid={`ec-kf-ease-${key}`}
		>
			<CurveThumb curve={curve} size={16} className="shrink-0 rounded-pr-control" />
			<span className="truncate">{label}</span>
		</button>
	);
	return (
		<div className="mt-1 border-pr-border-subtle border-t pt-1" data-testid="ec-kf-ease">
			<div className="relative" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
				<button
					type="button"
					role="menuitem"
					aria-haspopup="menu"
					aria-expanded={open}
					className={cx(ITEM, 'flex items-center justify-between gap-3')}
					onClick={() => setOpen(true)}
					data-testid="ec-kf-apply-ease"
				>
					<span>Apply Ease</span>
					<span aria-hidden>▸</span>
				</button>
				{open ? (
					<div
						role="menu"
						className="absolute top-0 left-full max-h-[320px] min-w-[200px] overflow-y-auto rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
						data-testid="ec-kf-apply-ease-menu"
					>
						{lib.recent.length ? (
							<div className="px-3 pt-1 text-pr-small text-pr-dim" role="presentation">
								Recent
							</div>
						) : null}
						{lib.recent.map((c, i) => curveEntry(`recent-${i}`, named(c), c))}
						{favourites.length ? (
							<div className="px-3 pt-1 text-pr-small text-pr-dim" role="presentation">
								Favourites
							</div>
						) : null}
						{favourites.map((p) => curveEntry(`fav-${p.id}`, t(p.name), p.curve, p.name))}
						{lib.recent.length === 0 && favourites.length === 0 ? (
							<div className="px-3 py-[3px] text-pr-small text-pr-dim" role="presentation">
								No recent or favourite curves yet
							</div>
						) : null}
						<div className="mt-1 border-pr-border-subtle border-t pt-1">
							{entry('ease.easyEase', t('Easy Ease'))}
							{entry('ease.easyEaseIn', t('Easy Ease In'))}
							{entry('ease.easyEaseOut', t('Easy Ease Out'))}
						</div>
					</div>
				) : null}
			</div>
			{entry('ease.copy', t('Copy Ease'))}
			{entry('ease.paste', t('Paste Ease'))}
			{entry('panel.open.easing', t('Open Easing Panel'), undefined, 'ec-kf-open-easing')}
		</div>
	);
}
