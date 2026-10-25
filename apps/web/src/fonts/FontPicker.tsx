// wp fonts: the font menu of text styles (Properties ▸ Text, the Captions track style). Lists the project's fonts
// (missing ones marked: not installed, text falls back to the default family), the user's installed fonts and the
// bundled families, each drawn in its own font, with search; "Add Font…" installs files (also by dropping them on
// the menu), "Resolve Fonts…" and "Manage Fonts…" open the dialogs. Picking a catalog family the project does not
// register yet hands its name to `onPickFamily` (the caller registers it with `font.add`).
import { type FontCatalog, resolveCatalogFont } from '@jasper/api';
import { cx, popoverZClass, SearchField, useInDialog } from '@jasper/ui';
import { ChevronDown, Plus, TriangleAlert } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type DragEvent, useMemo, useState } from 'react';
import { addFontsWithFeedback } from './actions.ts';
import { useFonts } from './hooks.ts';
import { usePreviewFamily } from './preview.ts';
import { isFontFile } from './store.ts';

export type FontPickerProps = {
	/** The style's font id (`doc.fonts` key); null when the selection mixes fonts. */
	value: string | null;
	docFonts: Readonly<Record<string, { id: string; family: string }>>;
	onPickFont(fontId: string): void;
	/** A catalog family the project does not register yet. */
	onPickFamily(family: string): void;
	/** Opens Resolve Fonts (shown when the project has missing fonts). */
	onResolveFonts?(): void;
	/** Opens Preferences ▸ Fonts. */
	onManageFonts?(): void;
	label?: string;
	disabled?: boolean;
	className?: string;
	'data-testid'?: string;
};

type Row =
	| { kind: 'doc'; key: string; fontId: string; family: string; url: string | null }
	| { kind: 'catalog'; key: string; family: string; url: string | null; source: string };

function urlOf(catalog: FontCatalog | null, family: string): string | null {
	return resolveCatalogFont(catalog, family, 400, false)?.file.url ?? null;
}

function FamilyName(props: { family: string; url: string | null; missing?: boolean }) {
	const [el, setEl] = useState<HTMLSpanElement | null>(null);
	const preview = usePreviewFamily(props.missing ? null : props.url, el);
	return (
		<span
			ref={setEl}
			className="min-w-0 flex-1 truncate"
			style={preview ? { fontFamily: `"${preview}", var(--pr-font-ui, sans-serif)` } : undefined}
		>
			{props.family}
		</span>
	);
}

export function FontPicker(props: FontPickerProps) {
	const { catalog } = useFonts();
	const inDialog = useInDialog();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [dragging, setDragging] = useState(false);
	const current = props.value ? props.docFonts[props.value] : undefined;
	const currentUrl = current ? urlOf(catalog, current.family) : null;
	const currentMissing = !!current && !!catalog && currentUrl === null;

	const sections = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = (s: string) => !q || s.toLowerCase().includes(q);
		const docRows: Row[] = Object.values(props.docFonts)
			.filter((f) => match(f.family))
			.sort((a, b) => a.family.localeCompare(b.family))
			.map((f) => ({
				kind: 'doc',
				key: `doc:${f.id}`,
				fontId: f.id,
				family: f.family,
				url: urlOf(catalog, f.family),
			}));
		const inDoc = new Set(Object.values(props.docFonts).map((f) => f.family.toLowerCase()));
		const bundled = new Set(
			(catalog?.fonts ?? [])
				.filter((f) => f.source !== 'custom' && f.source !== 'remote')
				.map((f) => f.family.toLowerCase()),
		);
		const catalogRows = (source: 'custom' | 'bundled'): Row[] =>
			(catalog?.fonts ?? [])
				// remote platform fonts (social-comment templates) are template faces: not offered for text
				.filter((f) =>
					source === 'custom' ? f.source === 'custom' : f.source !== 'custom' && f.source !== 'remote',
				)
				// a library family with a bundled family's name renders with the bundled one: listed once
				.filter((f) => source !== 'custom' || !bundled.has(f.family.toLowerCase()))
				.filter((f) => !inDoc.has(f.family.toLowerCase()) && match(f.family))
				.map((f) => ({
					kind: 'catalog',
					key: `${source}:${f.family}`,
					family: f.family,
					url: urlOf(catalog, f.family),
					source: f.source,
				}));
		return [
			{ title: 'Project Fonts', rows: docRows },
			{ title: 'My Fonts', rows: catalogRows('custom') },
			{ title: 'Bundled Fonts', rows: catalogRows('bundled') },
		].filter((s) => s.rows.length > 0);
	}, [catalog, props.docFonts, query]);
	const anyMissing =
		!!catalog && Object.values(props.docFonts).some((f) => urlOf(catalog, f.family) === null);

	const pick = (r: Row) => {
		setOpen(false);
		setQuery('');
		if (r.kind === 'doc') props.onPickFont(r.fontId);
		else props.onPickFamily(r.family);
	};
	const onDrop = (e: DragEvent) => {
		setDragging(false);
		const files = Array.from(e.dataTransfer.files ?? []).filter(isFontFile);
		if (!files.length) return;
		e.preventDefault();
		void addFontsWithFeedback(files);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild disabled={props.disabled}>
				<button
					type="button"
					aria-label={props.label ?? 'Font'}
					data-testid={props['data-testid']}
					data-missing={currentMissing ? 'true' : undefined}
					title={
						currentMissing
							? `${current?.family}: not installed — text uses the default font`
							: current?.family
					}
					className={cx(
						'flex h-[20px] min-w-0 flex-1 items-center gap-1 rounded-pr-control bg-pr-field px-1 text-left font-pr text-pr-ui text-pr-text hover:bg-pr-hover disabled:text-pr-dim data-[state=open]:bg-pr-pressed',
						props.className,
					)}
				>
					{currentMissing ? (
						<TriangleAlert size={12} className="shrink-0 text-pr-warning" aria-hidden />
					) : null}
					{current ? (
						<FamilyName family={current.family} url={currentUrl} missing={currentMissing} />
					) : (
						<span className="min-w-0 flex-1 truncate text-pr-muted">–</span>
					)}
					<ChevronDown size={12} className="shrink-0 text-pr-muted" aria-hidden />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={2}
					collisionPadding={8}
					className={cx(
						popoverZClass(inDialog),
						'flex max-h-[min(440px,var(--radix-popover-content-available-height))] w-[280px] flex-col rounded-pr-menu border bg-pr-menu font-pr text-pr-ui text-pr-text shadow-pr-overlay',
						dragging ? 'border-pr-focus' : 'border-pr-menu-border',
					)}
					data-testid="font-picker"
					onDragOver={(e) => {
						if (Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) {
							e.preventDefault();
							setDragging(true);
						}
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
				>
					<div className="border-b border-pr-border-subtle p-1">
						<SearchField
							value={query}
							onValueChange={setQuery}
							placeholder="Search fonts"
							aria-label="Search fonts"
							className="w-full"
							autoFocus
						/>
					</div>
					<div className="min-h-0 flex-1 overflow-auto py-1" data-testid="font-picker-list">
						{sections.length === 0 ? (
							<p className="px-3 py-2 text-pr-muted">No fonts match.</p>
						) : (
							sections.map((s) => (
								<section key={s.title} aria-label={s.title}>
									<div className="px-3 pt-1 pb-0.5 text-pr-small font-semibold text-pr-muted">{s.title}</div>
									{s.rows.map((r) => {
										const missing = r.kind === 'doc' && !!catalog && r.url === null;
										const selected = r.kind === 'doc' && r.fontId === props.value;
										return (
											<button
												key={r.key}
												type="button"
												aria-pressed={selected}
												data-font-family={r.family}
												data-missing={missing ? 'true' : undefined}
												title={missing ? 'Not installed: text set in it uses the default font' : undefined}
												onClick={() => pick(r)}
												className={cx(
													'flex h-7 w-full items-center gap-1.5 px-3 text-left text-[13px] outline-none hover:bg-pr-accent-fill hover:text-pr-on-accent focus-visible:bg-pr-accent-fill focus-visible:text-pr-on-accent',
													selected && 'bg-pr-selected',
												)}
											>
												<FamilyName family={r.family} url={r.url} missing={missing} />
												{missing ? (
													<span className="flex shrink-0 items-center gap-0.5 text-pr-small text-pr-warning">
														<TriangleAlert size={11} aria-hidden />
														Missing
													</span>
												) : null}
											</button>
										);
									})}
								</section>
							))
						)}
					</div>
					<div className="flex flex-wrap items-center gap-1 border-t border-pr-border-subtle p-1">
						<button
							type="button"
							data-testid="font-picker-add"
							onClick={() => {
								setOpen(false);
								void addFontsWithFeedback();
							}}
							className="flex h-6 items-center gap-1 rounded-pr-control px-2 hover:bg-pr-hover"
						>
							<Plus size={12} aria-hidden />
							Add Font…
						</button>
						{anyMissing && props.onResolveFonts ? (
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									props.onResolveFonts?.();
								}}
								className="flex h-6 items-center gap-1 rounded-pr-control px-2 text-pr-warning hover:bg-pr-hover"
							>
								Resolve Fonts…
							</button>
						) : null}
						{props.onManageFonts ? (
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									props.onManageFonts?.();
								}}
								className="ml-auto flex h-6 items-center rounded-pr-control px-2 hover:bg-pr-hover"
							>
								Manage Fonts…
							</button>
						) : null}
					</div>
					{dragging ? (
						<p className="px-3 pb-2 text-pr-small text-pr-muted">Drop font files to install them</p>
					) : null}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
