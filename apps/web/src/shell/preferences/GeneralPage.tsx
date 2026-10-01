// Preferences ▸ General: the window's UI preferences (theme, contrast, density, label colours, tooltips).
// They apply immediately (`prefsStore`, S05:DT-003) — the same values as View ▸ Theme / Density.
import { Checkbox, Select } from '@jasper/ui';
import type { ReactNode } from 'react';
import { prefsStore, type UiPrefs, useUiPrefs } from '../prefs.ts';

export function PrefRow(props: { label: ReactNode; children: ReactNode; htmlFor?: string }) {
	return (
		<div className="grid min-h-[28px] grid-cols-[160px_minmax(0,1fr)] items-center gap-3">
			<label htmlFor={props.htmlFor} className="text-pr-muted">
				{props.label}
			</label>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}

export function PrefGroup(props: {
	title: string;
	children: ReactNode;
	actions?: ReactNode;
	testId?: string;
}) {
	return (
		<section className="flex flex-col gap-1 pb-4" data-testid={props.testId}>
			<header className="mb-1 flex h-6 items-center gap-2 border-b border-pr-border-subtle">
				<h3 className="font-semibold text-pr-strong">{props.title}</h3>
				{props.actions ? <div className="ml-auto flex items-center gap-2">{props.actions}</div> : null}
			</header>
			{props.children}
		</section>
	);
}

export function GeneralPreferencesPage() {
	const prefs = useUiPrefs();
	const set = (patch: Partial<UiPrefs>) => prefsStore.set(patch);
	return (
		<div data-testid="prefs-general">
			<PrefGroup title="Appearance">
				<PrefRow label="Theme">
					<Select
						label="Theme"
						className="w-40"
						value={prefs.theme}
						onValueChange={(v) => set({ theme: v as UiPrefs['theme'] })}
						options={[
							{ value: 'darkest', label: 'Darkest' },
							{ value: 'dark', label: 'Dark' },
						]}
					/>
				</PrefRow>
				<PrefRow label="Contrast">
					<Checkbox
						checked={prefs.contrast === 'high'}
						onCheckedChange={(c) => set({ contrast: c ? 'high' : 'normal' })}
						label="High contrast"
					/>
				</PrefRow>
				<PrefRow label="Density">
					<Checkbox
						checked={prefs.density === 'touch'}
						onCheckedChange={(c) => set({ density: c ? 'touch' : 'normal' })}
						label="Touch density"
					/>
				</PrefRow>
				<PrefRow label="Label colors">
					<Select
						label="Label colors"
						className="w-40"
						value={prefs.labels}
						onValueChange={(v) => set({ labels: v as UiPrefs['labels'] })}
						options={[
							{ value: 'default', label: 'Default' },
							{ value: 'classic', label: 'Classic' },
							{ value: 'vibrant', label: 'Vibrant' },
						]}
					/>
				</PrefRow>
			</PrefGroup>
			<PrefGroup title="Interface">
				<PrefRow label="Tooltips">
					<Checkbox
						checked={prefs.tooltips}
						onCheckedChange={(c) => set({ tooltips: c })}
						label="Show tooltips"
					/>
				</PrefRow>
				<PrefRow label="Workspace tabs">
					<Checkbox
						checked={prefs.showWorkspaceTabs}
						onCheckedChange={(c) => set({ showWorkspaceTabs: c })}
						label="Show workspace tabs in header"
					/>
				</PrefRow>
			</PrefGroup>
		</div>
	);
}
