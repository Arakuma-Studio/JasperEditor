// Spec 18 AF-BRF-005 / AF-BRF-006: the brief's form fields (description, platform, frame shape, target length), shared
// by Home ▸ Describe your video and Sequence ▸ Brief….
import {
	BRIEF_LIMITS,
	DELIVERY_ASPECTS,
	DELIVERY_TARGETS,
	type DeliveryAspect,
	isDeliveryTargetId,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';
import { ASPECT_NAMES, type BriefForm, formatDuration, parseDuration } from './model.ts';

const FIELD = 'rounded-pr-control bg-pr-field px-2 text-pr-text disabled:text-pr-dim';

export function BriefFields(props: {
	form: BriefForm;
	onChange(f: BriefForm): void;
	disabled?: boolean;
	/** Rows of the description box. */
	rows?: number;
	autoFocus?: boolean;
	idPrefix: string;
}) {
	const { form, onChange, disabled } = props;
	const set = (patch: Partial<BriefForm>) => onChange({ ...form, ...patch });
	const platformAspect = form.platform
		? DELIVERY_TARGETS.find((x) => x.id === form.platform)?.aspect
		: undefined;
	const parsed = form.duration.trim() ? parseDuration(form.duration) : null;
	const durationBad = !!form.duration.trim() && parsed === null;
	const long = form.text.length > BRIEF_LIMITS.maxText;
	return (
		<div className="flex flex-col gap-3">
			<label className="flex flex-col gap-1" htmlFor={`${props.idPrefix}-text`}>
				<span className="text-pr-small text-pr-muted">Describe your video</span>
				<textarea
					id={`${props.idPrefix}-text`}
					data-testid={`${props.idPrefix}-text`}
					{...(props.autoFocus ? { 'data-autofocus': true } : {})}
					className={`${FIELD} min-h-16 resize-y py-1`}
					rows={props.rows ?? 5}
					disabled={disabled}
					value={form.text}
					placeholder={t(
						'What is it for, who is it for, the tone, what must stay in… e.g. "A 45-second Reel teasing the interview: open on the strongest line, end on the laugh."',
					)}
					onChange={(e) => set({ text: e.target.value })}
				/>
				<span className={long ? 'text-pr-small text-pr-warning' : 'text-pr-small text-pr-dim'}>
					{t('{0} / {1} characters', form.text.length, BRIEF_LIMITS.maxText)}
				</span>
			</label>
			<div className="grid grid-cols-3 gap-3">
				<label className="flex flex-col gap-1" htmlFor={`${props.idPrefix}-platform`}>
					<span className="text-pr-small text-pr-muted">Platform</span>
					<select
						id={`${props.idPrefix}-platform`}
						data-testid={`${props.idPrefix}-platform`}
						className={`${FIELD} h-[var(--pr-control-h)]`}
						disabled={disabled}
						value={form.platform ?? ''}
						onChange={(e) => set({ platform: isDeliveryTargetId(e.target.value) ? e.target.value : null })}
					>
						<option value="">{t('Not decided')}</option>
						{DELIVERY_TARGETS.map((x) => (
							<option key={x.id} value={x.id}>
								{x.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1" htmlFor={`${props.idPrefix}-aspect`}>
					<span className="text-pr-small text-pr-muted">Frame</span>
					<select
						id={`${props.idPrefix}-aspect`}
						data-testid={`${props.idPrefix}-aspect`}
						className={`${FIELD} h-[var(--pr-control-h)]`}
						disabled={disabled}
						value={form.aspect ?? ''}
						onChange={(e) =>
							set({
								aspect: (DELIVERY_ASPECTS as readonly string[]).includes(e.target.value)
									? (e.target.value as DeliveryAspect)
									: null,
							})
						}
					>
						<option value="">
							{platformAspect
								? t("Platform's ({0})", ASPECT_NAMES[platformAspect])
								: t('Not decided (landscape)')}
						</option>
						{DELIVERY_ASPECTS.map((a) => (
							<option key={a} value={a}>
								{ASPECT_NAMES[a]}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1" htmlFor={`${props.idPrefix}-duration`}>
					<span className="text-pr-small text-pr-muted">Target length</span>
					<input
						id={`${props.idPrefix}-duration`}
						data-testid={`${props.idPrefix}-duration`}
						className={`${FIELD} h-[var(--pr-control-h)]`}
						disabled={disabled}
						value={form.duration}
						placeholder={t('e.g. 45 s or 1:30')}
						onChange={(e) => set({ duration: e.target.value })}
						onBlur={() => {
							if (parsed !== null) set({ duration: formatDuration(parsed) });
						}}
						aria-invalid={durationBad}
					/>
				</label>
			</div>
			{durationBad ? (
				<p
					className="text-pr-small text-pr-warning"
					role="alert"
					data-testid={`${props.idPrefix}-duration-problem`}
				>
					{t(
						'Target length: type seconds (45), minutes and seconds (1:30) or minutes (2 min), up to 10 hours',
					)}
				</p>
			) : null}
		</div>
	);
}
