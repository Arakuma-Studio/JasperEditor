// spec 13 AS-020: Save as Template… (a styled text clip → a template in the project, and optionally in the user
// library shared by every project) and Apply Template… (style, layout, animation and highlight of a template on a
// subtitle group or the selected text clips, one undo step).
import type { SubtitleTemplate } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Checkbox, Dialog, type HostedDialogProps, TextField, toast } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { availableTemplates } from './model.ts';
import type { ApplyTarget } from './open.ts';
import { saveToLibrary, useSubtitleLibrary } from './store.ts';
import { templateName } from './templates.ts';

export function SaveTemplateDialog(props: HostedDialogProps<{ session: EditorSession; clipId: string }>) {
	const { session, clipId } = props;
	const library = useSubtitleLibrary();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [effects, setEffects] = useState(true);
	const [toLibrary, setToLibrary] = useState(true);
	const offline = library.status === 'offline' || library.status === 'error';
	const save = async () => {
		const r = session.apply({
			label: 'Save as Template',
			origin: 'user',
			commands: [
				{
					type: 'subtitleTemplate.save',
					clipId,
					name: name.trim(),
					...(description.trim() ? { description: description.trim() } : {}),
					effects,
				},
			],
		});
		if (!r.ok) {
			toast({ kind: 'warning', title: t('Template not saved'), detail: r.errors[0]?.message });
			return false;
		}
		const tpl = (r.results[0] as { template: SubtitleTemplate }).template;
		if (toLibrary && !offline) {
			try {
				await saveToLibrary(tpl);
			} catch (e) {
				toast({
					kind: 'warning',
					title: t('Saved in the project only'),
					detail: (e as Error)?.message ?? String(e),
				});
			}
		}
		toast({ kind: 'info', title: t('Template "{0}" saved', tpl.name) });
		return true;
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Save as Template"
			size="small"
			primaryLabel="Save"
			primaryDisabled={!name.trim()}
			onPrimary={async () => {
				if (await save()) props.close(true);
				return false;
			}}
			data-testid="subtitles-save-template"
		>
			<div className="flex flex-col gap-2">
				<TextField
					value={name}
					placeholder={t('Template name')}
					onChange={(e) => setName(e.currentTarget.value.slice(0, 120))}
					aria-label="Template name"
					data-testid="subtitles-template-name"
				/>
				<TextField
					value={description}
					placeholder={t('Description (optional)')}
					onChange={(e) => setDescription(e.currentTarget.value.slice(0, 2000))}
					aria-label="Description"
				/>
				<Checkbox
					checked={effects}
					onCheckedChange={setEffects}
					label="Include the clip's effects and their keyframes (timed from each subtitle's In)"
				/>
				<Checkbox
					checked={toLibrary && !offline}
					disabled={offline}
					onCheckedChange={setToLibrary}
					label="Also save it in my template library (every project)"
				/>
			</div>
		</Dialog>
	);
}

export function ApplyTemplateDialog(props: HostedDialogProps<{ session: EditorSession; target: ApplyTarget }>) {
	const { session, target } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const library = useSubtitleLibrary();
	const entry = useMemo(
		() => availableTemplates(doc, library.templates).find((x) => x.template.id === target.templateId) ?? null,
		[doc, library.templates, target.templateId],
	);
	const [parts, setParts] = useState({ style: true, layout: true, animation: true, highlight: true });
	const set = (k: keyof typeof parts) => (v: boolean) => setParts({ ...parts, [k]: v });
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Apply Template"
			size="small"
			primaryLabel="Apply"
			primaryDisabled={!entry || !Object.values(parts).some(Boolean)}
			onPrimary={() => {
				if (!entry) return false;
				const tpl = entry.template;
				const ref = entry.origin === 'library' ? (tpl as unknown as Record<string, unknown>) : tpl.id;
				const r = session.apply({
					label: 'Apply Subtitle Template',
					origin: 'user',
					commands: [
						{
							type: 'subtitleTemplate.apply',
							template: ref,
							...('groupId' in target ? { groupId: target.groupId } : { clipIds: target.clipIds }),
							parts,
						},
					],
				});
				if (!r.ok) {
					toast({ kind: 'warning', title: t('Template not applied'), detail: r.errors[0]?.message });
					return false;
				}
				props.close(true);
				return false;
			}}
			data-testid="subtitles-apply-template"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-text">{entry ? templateName(entry.template) : t('The template is gone.')}</p>
				<Checkbox checked={parts.style} onCheckedChange={set('style')} label="Text style (linked project style)" />
				<Checkbox checked={parts.layout} onCheckedChange={set('layout')} label="Box and position" />
				<Checkbox checked={parts.animation} onCheckedChange={set('animation')} label="Animation and effects" />
				<Checkbox checked={parts.highlight} onCheckedChange={set('highlight')} label="Word highlight" />
			</div>
		</Dialog>
	);
}
