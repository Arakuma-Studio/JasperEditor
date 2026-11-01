// Spec 18 AF-BRF-005 (spec 05 HD-020 "Start with the agent"): Home ▸ Describe your video — the description, platform,
// frame, target length and the footage (dropped or picked). Create makes the project with the sequence the brief
// implies; the editor then sets the brief and imports the files (start-brief.ts).
import { Button, IconButton } from '@jasper/ui';
import { useRef, useState } from 'react';
import { BriefFields } from '../brief/BriefFields.tsx';
import { type BriefForm, briefFormProblem, EMPTY_BRIEF_FORM } from '../brief/model.ts';
import { t } from '../i18n/runtime.ts';
import { getDesktopBridge } from '../import/desktop.ts';
import { Dialog } from '../import/ImportPromptHost.tsx';
import { startShape } from './start-brief.ts';

export type DescribeVideoResult = { form: BriefForm; files: File[]; paths: string[] };

const MEDIA_ACCEPT = 'video/*,audio/*,image/*';
/** At most this many files per start (the Project panel imports more at once). */
const MAX_FILES = 200;

function baseName(p: string): string {
	return p.split(/[\\/]/).pop() || p;
}

export function DescribeVideoDialog(props: {
	busy?: boolean;
	onCancel(): void;
	onCreate(r: DescribeVideoResult): void;
}) {
	const [form, setForm] = useState<BriefForm>(EMPTY_BRIEF_FORM);
	const [files, setFiles] = useState<File[]>([]);
	const [paths, setPaths] = useState<string[]>([]);
	const [over, setOver] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const desktop = getDesktopBridge();
	const problem = !form.text.trim() ? t('Describe the video first') : briefFormProblem(form);
	const shape = startShape(form);
	const count = files.length + paths.length;
	const addFiles = (list: Iterable<File>) =>
		setFiles((cur) => {
			const known = new Set(cur.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
			const next = [...cur];
			for (const f of list) {
				const key = `${f.name}:${f.size}:${f.lastModified}`;
				if (!known.has(key) && next.length + paths.length < MAX_FILES) {
					known.add(key);
					next.push(f);
				}
			}
			return next;
		});
	const pick = async () => {
		if (desktop) {
			const picked = await desktop.pickMedia().catch(() => []);
			setPaths((cur) => [...new Set([...cur, ...picked])].slice(0, MAX_FILES - files.length));
		} else input.current?.click();
	};
	const submit = () => {
		if (problem || props.busy) return;
		props.onCreate({ form, files, paths });
	};
	return (
		<Dialog
			title={t('Describe your video')}
			testId="dialog-describe-video"
			width={620}
			onEscape={props.onCancel}
			footer={
				<>
					<Button onClick={props.onCancel}>Cancel</Button>
					<Button
						variant="primary"
						data-testid="describe-video-create"
						disabled={props.busy || !!problem}
						title={problem ?? undefined}
						onClick={submit}
					>
						{props.busy ? t('Creating…') : t('Create Project')}
					</Button>
				</>
			}
		>
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<p className="text-pr-small text-pr-muted">
					Say what the video should be. JasperEditor makes the project, imports your footage and keeps the
					description as the sequence brief, where a connected AI agent reads it before it cuts. You can
					change it later in Sequence ▸ Brief….
				</p>
				<BriefFields form={form} onChange={setForm} idPrefix="describe" autoFocus rows={5} />
				<p className="text-pr-small text-pr-muted" data-testid="describe-sequence">
					{t('Sequence: {0}', shape.name)}
				</p>
				<section
					aria-label={t('Footage')}
					data-testid="describe-drop"
					className={
						over
							? 'flex flex-col gap-2 rounded-pr-frame border border-dashed border-pr-accent bg-pr-raised p-3'
							: 'flex flex-col gap-2 rounded-pr-frame border border-dashed border-pr-border-strong p-3'
					}
					onDragOver={(e) => {
						if (!e.dataTransfer.types.includes('Files')) return;
						e.preventDefault();
						setOver(true);
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setOver(false);
						addFiles(Array.from(e.dataTransfer.files));
					}}
				>
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 text-pr-small text-pr-muted">
							{count
								? count === 1
									? t('1 file to import')
									: t('{0} files to import', count)
								: t('Drop your footage here (video, audio, stills), or choose the files')}
						</span>
						<Button onClick={() => void pick()} data-testid="describe-pick">
							Choose Files…
						</Button>
						<input
							ref={input}
							type="file"
							multiple
							accept={MEDIA_ACCEPT}
							className="hidden"
							data-testid="describe-file-input"
							onChange={(e) => {
								addFiles(Array.from(e.target.files ?? []));
								e.target.value = '';
							}}
						/>
					</div>
					{count ? (
						<ul className="flex max-h-32 flex-col gap-0.5 overflow-auto" data-testid="describe-files">
							{files.map((f, i) => (
								<li key={`f:${f.name}:${f.size}:${f.lastModified}`} className="flex items-center gap-1">
									<span className="min-w-0 flex-1 truncate text-pr-small text-pr-text" title={f.name}>
										{f.name}
									</span>
									<IconButton
										icon="app.close"
										label={t('Remove {0}', f.name)}
										onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
									/>
								</li>
							))}
							{paths.map((p) => (
								<li key={`p:${p}`} className="flex items-center gap-1">
									<span className="min-w-0 flex-1 truncate text-pr-small text-pr-text" title={p}>
										{baseName(p)}
									</span>
									<IconButton
										icon="app.close"
										label={t('Remove {0}', baseName(p))}
										onClick={() => setPaths((cur) => cur.filter((x) => x !== p))}
									/>
								</li>
							))}
						</ul>
					) : null}
				</section>
			</form>
		</Dialog>
	);
}
