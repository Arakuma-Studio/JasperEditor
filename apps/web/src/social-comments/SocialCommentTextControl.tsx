// `social-comment-text`: the comment editor of the social-comment template (design §7.5, §7.9). People edit the
// visible text in a native textarea (so caret, selection, IME composition, emoji input, spell check and accessibility
// are the browser's own); a backdrop drawn under the transparent textarea text shows the word marks styled —
// highlight pill, blur, removed words dimmed and struck through — plus @mentions and #hashtags. The stored markup
// (`==…==`, `||…||`, `~~…~~`) is shown only with "Show markup".
//
// Edits: every change of the visible text is mapped onto the markup (`replaceVisible`), so marks survive typing. A
// typing burst is one undo step (coalesced writes); each Highlight / Blur / Remove / Clear is its own step (a mark
// button on words that all carry it already removes it). Nothing is written while an IME composition is open. Ctrl+Z /
// Ctrl+Shift+Z (Cmd on macOS) in the editor undo/redo through the project History, not the textarea's own stack.
// Ctrl+Shift+1/2/3/0 apply Highlight/Blur/Remove/Clear unless the active keymap binds the chord.
import {
	applyMark,
	SOCIAL_TEXT_MARKUP_MAX,
	SOCIAL_TEXT_MAX,
	type SocialMark,
	stripMarks,
	tokenizeComment,
} from '@jasper/mg-templates';
import { useSessionOrNull } from '@jasper/session/react';
import { cx, Icon, type IconId } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	chordFromEvent,
	effectiveKey,
	getActiveKeymap,
	normalizeChord,
} from '../commands/keymap-defaults.ts';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { detectPlatform, detectRuntime } from '../runtime/platform.ts';
import { formatChord } from '../shell/keymap/format.ts';
import { MARK_HINT_TEXTS, markLabel } from './labels.ts';
import { countGraphemes, replaceVisible, selectionHas, selectionMarks } from './marks-edit.ts';
import { variantOf } from './params.ts';

type MarkAction = SocialMark | 'clear';

const ACTIONS: readonly { action: MarkAction; icon: IconId; chord: string }[] = [
	{ action: 'highlight', icon: 'text.highlight', chord: 'Ctrl+Shift+Digit1' },
	{ action: 'blur', icon: 'text.blur', chord: 'Ctrl+Shift+Digit2' },
	{ action: 'remove', icon: 'text.remove', chord: 'Ctrl+Shift+Digit3' },
	{ action: 'clear', icon: 'text.clearMarks', chord: 'Ctrl+Shift+Digit0' },
];

/** Whether the active keymap uses `chord` anywhere (then the editor leaves it to the app). */
function chordTaken(chord: string): boolean {
	const platform = detectPlatform();
	const runtime = detectRuntime();
	const target = normalizeChord(chord);
	return getActiveKeymap().some((k) => {
		const key = effectiveKey(k, platform, runtime);
		return key !== null && normalizeChord(key) === target;
	});
}

const MARK_CLASS: Readonly<Record<string, string>> = {
	none: '',
	highlight:
		'rounded-[3px] bg-[var(--pr-label-mango-tint)] text-[var(--pr-label-mango)] [box-decoration-break:clone] shadow-[0_0_0_1px_var(--pr-label-mango-tint)]',
	blur: 'blur-[2.5px]',
	remove: 'line-through opacity-45',
};

/** Shared box metrics of the textarea and its backdrop (they must wrap identically). */
const BOX =
	'm-0 w-full whitespace-pre-wrap break-words border border-transparent px-[6px] py-[4px] font-pr text-pr-ui leading-[18px]';

type Problem = 'too-long' | 'markup-too-long' | 'refused';

export function SocialCommentTextControl(p: TemplateParamControlProps) {
	const session = useSessionOrNull();
	const variant = variantOf(p.params);
	const external = p.mixed ? '' : typeof p.value === 'string' ? p.value : '';
	const [markup, setMarkup] = useState(external);
	const markupRef = useRef(markup);
	markupRef.current = markup;
	/** The value last written or received; an incoming value that differs came from elsewhere (undo, agent). */
	const committed = useRef(external);
	const composing = useRef(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const restoreSelection = useRef<{ start: number; end: number } | null>(null);
	const [sel, setSel] = useState({ start: 0, end: 0 });
	const [showMarkup, setShowMarkup] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);
	const ids = { area: useId(), counter: useId(), help: useId(), problem: useId() };

	useEffect(() => {
		if (external === committed.current) return;
		committed.current = external;
		if (composing.current) return;
		const el = area.current;
		if (el && document.activeElement === el) {
			const n = stripMarks(external).length;
			restoreSelection.current = { start: Math.min(el.selectionStart, n), end: Math.min(el.selectionEnd, n) };
		}
		setMarkup(external);
		setProblem(null);
	}, [external]);
	useLayoutEffect(() => {
		const r = restoreSelection.current;
		const el = area.current;
		if (!r || !el) return;
		restoreSelection.current = null;
		el.focus();
		el.setSelectionRange(r.start, r.end);
		setSel(r);
	});

	const visible = useMemo(() => stripMarks(markup), [markup]);
	const spans = useMemo(() => tokenizeComment(markup, variant), [markup, variant]);
	const graphemes = useMemo(() => countGraphemes(visible), [visible]);
	const info = useMemo(() => selectionMarks(markup, sel.start, sel.end), [markup, sel]);
	const canMark = !p.disabled && !showMarkup && info.range !== null;

	/** Writes `next`; a typing write coalesces, a labelled one is its own History entry. */
	const commit = (next: string, label?: string) => {
		if (next === committed.current) return;
		const before = committed.current;
		committed.current = next;
		const ok = label
			? p.onChangeParams({ [p.paramName]: next }, { label })
			: p.onChange(next, { coalesce: true });
		if (!ok) {
			committed.current = before;
			setMarkup(before);
			setProblem('refused');
		}
	};

	const onVisibleChange = (v: string, caret?: number) => {
		if (v.length > SOCIAL_TEXT_MAX) {
			setProblem('too-long');
			return;
		}
		const next = replaceVisible(markupRef.current, v, caret);
		if (next.length > SOCIAL_TEXT_MARKUP_MAX) {
			setProblem('markup-too-long');
			return;
		}
		setProblem(null);
		setMarkup(next);
		markupRef.current = next;
		if (!composing.current) commit(next);
	};

	const onMarkupChange = (v: string) => {
		if (v.length > SOCIAL_TEXT_MARKUP_MAX) {
			setProblem('markup-too-long');
			return;
		}
		if (stripMarks(v).length > SOCIAL_TEXT_MAX) {
			setProblem('too-long');
			return;
		}
		setProblem(null);
		setMarkup(v);
		markupRef.current = v;
		if (!composing.current) commit(v);
	};

	const runMark = (action: MarkAction) => {
		const el = area.current;
		if (p.disabled || showMarkup || !el) return;
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const current = selectionMarks(markupRef.current, start, end);
		if (!current.range) return;
		const mark: SocialMark | null = action === 'clear' || selectionHas(current, action) ? null : action;
		const next = applyMark(markupRef.current, { start, end }, mark);
		if (next === markupRef.current) return;
		if (next.length > SOCIAL_TEXT_MARKUP_MAX) {
			setProblem('markup-too-long');
			return;
		}
		// the visible text is unchanged: keep the selection (and the focus) in the editor
		restoreSelection.current = { start, end };
		setProblem(null);
		setMarkup(next);
		markupRef.current = next;
		commit(next, markLabel(mark ?? 'clear'));
	};

	const trackSelection = () => {
		const el = area.current;
		if (el) setSel({ start: el.selectionStart, end: el.selectionEnd });
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing || composing.current) return;
		const primary = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		if (primary && !e.altKey && (key === 'z' || key === 'y')) {
			// the project History is the undo stack of this field (a typing burst = one step)
			e.preventDefault();
			if (!session || p.disabled) return;
			if (key === 'z' && !e.shiftKey) session.undo();
			else session.redo();
			return;
		}
		if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
			const chord = chordFromEvent(e.nativeEvent, detectPlatform());
			const hit = ACTIONS.find((a) => normalizeChord(a.chord) === normalizeChord(chord));
			if (hit && !chordTaken(hit.chord)) {
				e.preventDefault();
				runMark(hit.action);
			}
		}
	};

	const platform = detectPlatform();
	const tooltip = (a: (typeof ACTIONS)[number]) =>
		chordTaken(a.chord)
			? MARK_HINT_TEXTS[a.action]
			: `${MARK_HINT_TEXTS[a.action]} (${formatChord(a.chord, platform)})`;
	const problemText =
		problem === 'too-long'
			? t('The comment can have at most {0} characters', SOCIAL_TEXT_MAX)
			: problem === 'markup-too-long'
				? t('Too many marks for this comment')
				: problem === 'refused'
					? t('The change was refused')
					: null;
	const nearLimit = visible.length > SOCIAL_TEXT_MAX * 0.9;

	return (
		<div className="flex w-full min-w-0 flex-col gap-1" data-social-text data-testid="social-text">
			<div className="flex items-center gap-[2px]">
				<div
					role="toolbar"
					aria-label={t('Word marks')}
					aria-controls={ids.area}
					className="flex items-center gap-[2px]"
				>
					{ACTIONS.map((a) => {
						const pressed = a.action !== 'clear' && info.range !== null && selectionHas(info, a.action);
						const enabled = canMark && (a.action !== 'clear' || [...info.marks].some((m) => m !== 'none'));
						return (
							<button
								key={a.action}
								type="button"
								aria-label={markLabel(a.action)}
								title={tooltip(a)}
								aria-pressed={a.action === 'clear' ? undefined : pressed}
								disabled={!enabled}
								// keep the focus (and the selection) in the editor
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => runMark(a.action)}
								className={cx(
									'inline-flex h-[20px] items-center gap-1 whitespace-nowrap rounded-pr-control px-[5px] text-pr-small',
									'disabled:pointer-events-none disabled:text-pr-dim',
									pressed
										? 'bg-pr-selected text-pr-strong'
										: 'text-pr-muted hover:bg-pr-hover hover:text-pr-text',
								)}
								data-testid={`social-text-${a.action}`}
							>
								<Icon id={a.icon} size={13} />
								{a.action === 'clear' ? null : <span>{markLabel(a.action)}</span>}
							</button>
						);
					})}
				</div>
				<button
					type="button"
					aria-pressed={showMarkup}
					aria-label={t('Show markup')}
					title={t('Show the stored text with its mark syntax')}
					onClick={() => setShowMarkup(!showMarkup)}
					className={cx(
						'ml-auto inline-flex h-[20px] items-center gap-1 rounded-pr-control px-[5px] text-pr-small',
						showMarkup
							? 'bg-pr-selected text-pr-strong'
							: 'text-pr-muted hover:bg-pr-hover hover:text-pr-text',
					)}
					data-testid="social-text-show-markup"
				>
					<Icon id="text.markup" size={13} />
				</button>
			</div>
			<div className="max-h-[240px] min-h-[62px] overflow-y-auto rounded-pr-control bg-pr-field">
				{showMarkup ? (
					<textarea
						id={ids.area}
						aria-label={t('Comment text with mark syntax')}
						aria-describedby={`${ids.counter} ${ids.help}${problemText ? ` ${ids.problem}` : ''}`}
						aria-invalid={problemText ? true : undefined}
						readOnly={p.disabled}
						spellCheck={false}
						rows={3}
						value={markup}
						maxLength={SOCIAL_TEXT_MARKUP_MAX}
						className={cx(BOX, 'block resize-y bg-transparent font-pr-mono text-pr-text outline-none')}
						onChange={(e) => onMarkupChange(e.target.value)}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
							commit(markupRef.current);
						}}
						onKeyDown={onKeyDown}
						data-testid="social-text-markup"
					/>
				) : (
					<div className="relative min-h-[60px]">
						<div
							aria-hidden
							className={cx(BOX, 'pointer-events-none min-h-[60px] text-pr-text')}
							data-testid="social-text-backdrop"
						>
							{spans.map((s, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
									key={i}
									className={cx(
										MARK_CLASS[s.mark],
										s.role !== 'plain' && s.mark !== 'highlight' && 'text-pr-accent',
									)}
									data-mark={s.mark === 'none' ? undefined : s.mark}
									data-role={s.role === 'plain' ? undefined : s.role}
								>
									{s.text}
								</span>
							))}
							{/* keeps the height of a trailing empty line */}
							<span>{'​'}</span>
						</div>
						<textarea
							ref={area}
							id={ids.area}
							aria-label={t('Comment text')}
							aria-describedby={`${ids.counter} ${ids.help}${problemText ? ` ${ids.problem}` : ''}`}
							aria-invalid={problemText ? true : undefined}
							readOnly={p.disabled}
							value={visible}
							maxLength={SOCIAL_TEXT_MAX}
							placeholder={
								p.mixed
									? t('Multiple values: typing replaces the text of every selected clip')
									: t('Write the comment…')
							}
							className={cx(
								BOX,
								'absolute inset-0 block h-full resize-none overflow-hidden bg-transparent text-transparent caret-pr-text outline-none',
								'placeholder:text-pr-dim selection:bg-pr-accent-fill/40',
							)}
							onChange={(e) => onVisibleChange(e.target.value, e.target.selectionEnd)}
							onSelect={trackSelection}
							onKeyUp={trackSelection}
							onMouseUp={trackSelection}
							onCompositionStart={() => {
								composing.current = true;
							}}
							onCompositionEnd={() => {
								composing.current = false;
								commit(markupRef.current);
							}}
							onKeyDown={onKeyDown}
							data-testid="social-text-input"
						/>
					</div>
				)}
			</div>
			<div className="flex items-start gap-2 text-pr-small">
				<span id={ids.help} className="min-w-0 flex-1 text-pr-dim">
					{showMarkup
						? t('==highlight== ||blur|| ~~remove~~; a backslash before = | ~ or \\ types it literally')
						: t('Select words, then Highlight, Blur or Remove')}
				</span>
				<span
					id={ids.counter}
					className={cx('shrink-0 tabular-nums', nearLimit ? 'text-pr-warning' : 'text-pr-muted')}
					title={t('Characters (emoji count as one; the limit counts some emoji as two)')}
					data-testid="social-text-counter"
				>
					{`${graphemes} / ${SOCIAL_TEXT_MAX}`}
				</span>
			</div>
			{problemText ? (
				<span
					id={ids.problem}
					role="alert"
					className="text-pr-small text-pr-danger"
					data-testid="social-text-problem"
				>
					{problemText}
				</span>
			) : null}
		</div>
	);
}
