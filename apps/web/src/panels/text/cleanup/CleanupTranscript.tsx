// Clean Up transcript view (spec 14 TC-041): the analysed words with what the plan does to them — struck through in
// the colour of why they go (what Apply will cut, exactly: the plan's removed ranges), a dotted underline for
// findings left for review, lexical fillers lighter, pauses / breaths / voice without words as small chips where
// they sit. A click selects the finding (and seeks). Virtualised: the words are cut into blocks (paragraphs of at
// most 80 words) and only the blocks in view are rendered, measured as they come into view.
import {
	type CleanupFinding,
	flicksPerFrame,
	paragraphs,
	readSequenceCleanup,
	type Sequence,
	sequenceWords,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { type CleanupUiState, cleanupFor } from './controller.ts';
import {
	findingAccepted,
	inlineFindings,
	KIND_COLOR,
	KIND_LABELS,
	mediaOfFinding,
	wordMarks,
} from './model.ts';

const S = 705_600_000;
const BLOCK_WORDS = 80;

export function CleanupTranscript({ session, st }: { session: EditorSession; st: CleanupUiState }) {
	const c = cleanupFor(session);
	const a = st.analysis!;
	const base = st.base!;
	const seq = base.sequences[st.sequenceId!] as Sequence;
	const words = useMemo(() => {
		const clips = new Set(a.plan.clipIds);
		return sequenceWords(base, seq).filter((w) => clips.has(w.clipId));
	}, [base, seq, a.plan.clipIds]);
	const live = session.getCommitted().sequences[seq.id] as Sequence | undefined;
	const remembered = useMemo(() => new Set(live ? (readSequenceCleanup(live).rejected ?? []) : []), [live]);
	const marks = useMemo(
		() => wordMarks(words, seq, a, st.decisions, remembered),
		[words, seq, a, st.decisions, remembered],
	);
	const inline = useMemo(() => inlineFindings(words, seq, a), [words, seq, a]);
	const blocks = useMemo(() => {
		const out: Array<[number, number]> = [];
		for (const [p0, p1] of paragraphs(words, Math.round(1.5 * S)))
			for (let i = p0; i < p1; i += BLOCK_WORDS) out.push([i, Math.min(p1, i + BLOCK_WORDS)]);
		return out;
	}, [words]);
	const currentWords = useMemo(() => {
		const f = a.findings.find((x) => x.id === st.current);
		const out = new Set<number>();
		if (!f?.words) return out;
		const m = mediaOfFinding(a, f);
		if (!m) return out;
		words.forEach((w, i) => {
			if (w.transcriptId === m.transcriptId && w.index >= f.words![0] && w.index <= f.words![1]) out.add(i);
		});
		return out;
	}, [a, st.current, words]);
	const currentBlock = useMemo(() => {
		const f = a.findings.find((x) => x.id === st.current);
		if (!f) return -1;
		let first = currentWords.size ? Math.min(...currentWords) : -1;
		if (first < 0) for (const [i, fs] of inline.before) if (fs.some((x) => x.id === f.id)) first = i;
		if (first < 0) return -1;
		return blocks.findIndex(([b0, b1]) => first >= b0 && first < b1);
	}, [a, st.current, currentWords, inline, blocks]);

	const chip = (f: CleanupFinding) => {
		const on = findingAccepted(f, st.decisions, remembered);
		const secs = typeof f.reason.params.seconds === 'number' ? f.reason.params.seconds : 0;
		const glyph = f.kind === 'pause' ? '⏸' : f.kind === 'breath' ? '≈' : '♪';
		return (
			<button
				key={f.id}
				type="button"
				className={`mx-[2px] inline-flex items-center rounded-pr-pill border px-1 align-baseline text-pr-small leading-none ${st.current === f.id ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted'} ${on ? 'line-through' : ''}`}
				style={{ borderColor: KIND_COLOR[f.kind], textDecorationColor: KIND_COLOR[f.kind] }}
				onClick={() => c.select(f.id)}
				title={`${KIND_LABELS[f.kind]} · ${secs.toFixed(2)} s · ${on ? t('Cut') : t('Kept')}`}
				data-testid={`text.cleanup.chip.${f.id}`}
			>
				{glyph} {secs.toFixed(1)}
			</button>
		);
	};

	const renderBlock = (bi: number): ReactNode => {
		const [b0, b1] = blocks[bi]!;
		const parts: ReactNode[] = [];
		for (let i = b0; i < b1; i++) {
			for (const f of inline.before.get(i) ?? []) parts.push(chip(f));
			const w = words[i]!;
			const mk = marks[i]!;
			const color = mk.removed ? (mk.kind ? KIND_COLOR[mk.kind] : 'var(--pr-danger)') : undefined;
			parts.push(
				<span key={i}>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: words are click targets; the findings list and the keyboard commands reach the same findings */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
					<span
						className={`cursor-pointer rounded-[2px] px-[1px] ${currentWords.has(i) ? 'bg-pr-selected text-pr-strong' : ''} ${mk.removed ? 'text-pr-muted' : mk.lexical ? 'text-pr-muted opacity-70' : 'text-pr-text'}`}
						style={
							mk.removed
								? {
										textDecorationLine: 'line-through',
										textDecorationColor: color,
										textDecorationThickness: '2px',
									}
								: mk.review
									? {
											textDecorationLine: 'underline',
											textDecorationStyle: 'dotted',
											textDecorationColor: 'var(--pr-warning)',
											textUnderlineOffset: '3px',
										}
									: undefined
						}
						title={`${(w.start / S).toFixed(2)} s${mk.kind ? ` · ${KIND_LABELS[mk.kind]}` : ''}${mk.review ? ` · ${t('for review')}` : ''}`}
						onClick={() => {
							if (mk.findingId) c.select(mk.findingId);
							else session.transport.seek(Math.floor(w.start / flicksPerFrame(seq.settings.frameRate)));
						}}
						data-testid={`text.cleanup.word.${i}`}
						data-removed={mk.removed ? 'true' : undefined}
						data-kind={mk.kind ?? undefined}
						data-review={mk.review ? 'true' : undefined}
					>
						{w.text}
					</span>{' '}
				</span>,
			);
		}
		if (bi === blocks.length - 1) for (const f of inline.after) parts.push(chip(f));
		return <p className="m-0 mb-2">{parts}</p>;
	};

	if (!words.length)
		return (
			<p className="m-0 px-2 py-2 text-pr-small text-pr-muted">{t('No transcribed words in the scope')}</p>
		);
	return (
		<VirtualBlocks
			count={blocks.length}
			estimate={72}
			render={renderBlock}
			reveal={currentBlock}
			className="min-h-0 flex-1 overflow-auto px-2 py-1 font-pr text-pr-ui leading-[1.7]"
			testId="text.cleanup.transcript"
		/>
	);
}

/**
 * A vertically stacked list of variable-height blocks where only the blocks in view (plus overscan) are rendered;
 * heights are measured with a ResizeObserver as blocks render and estimated before.
 */
function VirtualBlocks(p: {
	count: number;
	estimate: number;
	render(i: number): ReactNode;
	/** A block to scroll into view when it changes (−1: none). */
	reveal: number;
	className?: string;
	testId?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const heights = useRef<number[]>([]);
	const [, setVersion] = useState(0);
	const [view, setView] = useState({ top: 0, height: 0 });
	const ro = useRef<ResizeObserver | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setView({ top: el.scrollTop, height: el.clientHeight });
		if (typeof ResizeObserver === 'undefined') return;
		const outer = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
		outer.observe(el);
		ro.current = new ResizeObserver((entries) => {
			let changed = false;
			for (const e of entries) {
				const i = Number((e.target as HTMLElement).dataset.block);
				const h = Math.ceil((e.target as HTMLElement).offsetHeight);
				if (Number.isInteger(i) && h > 0 && heights.current[i] !== h) {
					heights.current[i] = h;
					changed = true;
				}
			}
			if (changed) setVersion((v) => v + 1);
		});
		return () => {
			outer.disconnect();
			ro.current?.disconnect();
			ro.current = null;
		};
	}, []);
	if (heights.current.length > p.count) heights.current.length = p.count;
	const tops: number[] = new Array(p.count + 1);
	tops[0] = 0;
	for (let i = 0; i < p.count; i++) tops[i + 1] = tops[i]! + (heights.current[i] ?? p.estimate);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new block to reveal scrolls
	useEffect(() => {
		const el = ref.current;
		if (!el || p.reveal < 0 || p.reveal >= p.count) return;
		const top = tops[p.reveal]!;
		const bottom = tops[p.reveal + 1]!;
		if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight)
			el.scrollTop = Math.max(0, top - el.clientHeight / 3);
	}, [p.reveal]);
	const overscan = 400;
	const from = view.top - overscan;
	const to = view.top + (view.height || 600) + overscan;
	const items: ReactNode[] = [];
	for (let i = 0; i < p.count; i++) {
		if (tops[i + 1]! < from) continue;
		if (tops[i]! > to) break;
		items.push(
			<div
				key={i}
				data-block={i}
				ref={(el) => {
					if (!el) return;
					const obs = ro.current;
					obs?.observe(el);
					return () => obs?.unobserve(el);
				}}
				className="absolute inset-x-0"
				style={{ top: tops[i] }}
			>
				{p.render(i)}
			</div>,
		);
	}
	return (
		<div
			ref={ref}
			className={p.className}
			onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
			data-testid={p.testId}
		>
			<div className="relative" style={{ height: tops[p.count] }}>
				{items}
			</div>
		</div>
	);
}
