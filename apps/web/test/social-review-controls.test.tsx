// Store reviews (design §11): the `social-rating` and `social-date` controls and Randomize stats on the real
// `social-comment@1` template in Properties / Effect Controls — per-variant rows, undo / redo, keyboard, refusals,
// read-only and garbage values.
import { createMgRegistry, MG_CATALOG, socialDefaults } from '@jasper/mg-templates';
import { type Clip, createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TemplateParamControlProps } from '../src/extensions/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { statsPatch } from '../src/social-comments/params.ts';
import { registerSocialCommentControls } from '../src/social-comments/register.ts';
import { SocialDateControl } from '../src/social-comments/SocialDateControl.tsx';
import { SocialRatingControl } from '../src/social-comments/SocialRatingControl.tsx';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

async function openSession(clipParams: Record<string, unknown>[]) {
	const ids = createCounterIdSource(41);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Reviews', preset: 'hd-1080p-30' });
	store.put(doc);
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(createMgRegistry([...MG_CATALOG])) },
	});
	const seqId = session.store.getState().activeSequenceId!;
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: clipParams.map((params, i) => ({
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 120,
			track: `V${i + 1}`,
			template: { id: 'social-comment', version: 1 },
			params,
			ref: `$c${i}`,
		})) as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const clipIds = clipParams.map((_, i) => r.refs[`$c${i}`]!);
	act(() => {
		session.select('timeline', clipIds, 'replace');
		session.transport.seek(30);
	});
	const clip = (i = 0) => session.store.getState().document.sequences[seqId]!.clips[clipIds[i]!] as MgClip;
	return { session, clip };
}

const history = (s: EditorSession) => s.getState().history.entries.length;
const lastLabel = (s: EditorSession) => s.getState().history.entries.at(-1)?.label;
const properties = (session: EditorSession) =>
	render(
		<SessionProvider session={session}>
			<PropertiesPanel instanceId="review-props" visible />
		</SessionProvider>,
	);
let off: (() => void) | null = null;
beforeEach(() => {
	off = registerSocialCommentControls();
});
afterEach(() => {
	off?.();
	cleanup();
	localStorage.clear();
});

describe('controls per store variant', () => {
	it('Play exposes rating, date and avatar controls without comment counts or age', async () => {
		const { session } = await openSession([socialDefaults('play-store-review')]);
		properties(session);
		expect(screen.getByRole('group', { name: 'Rating' })).toBeTruthy();
		expect(screen.getByLabelText('Review date')).toBeTruthy();
		expect(screen.getByTestId('social-avatar')).toBeTruthy();
		expect(screen.queryByLabelText('Time ago')).toBeNull();
		expect(screen.queryByTestId('social-count-likes')).toBeNull();
		expect(screen.queryByTestId('social-count-replies')).toBeNull();
		await session.close();
	});

	it('App Store web edits a date, while iPhone edits the age without an avatar', async () => {
		const web = await openSession([socialDefaults('app-store-review')]);
		properties(web.session);
		expect(screen.getByLabelText('Review date')).toBeTruthy();
		expect(screen.getByTestId('social-date-preview').textContent).toBe('09/24/2025');
		expect(screen.queryByTestId('social-avatar')).toBeNull();
		expect(screen.queryByLabelText('Time ago')).toBeNull();
		await web.session.close();
		cleanup();
		const ios = await openSession([
			{
				...socialDefaults('app-store-review-ios'),
				timeValue: 2,
				timeUnit: 'day',
				edited: true,
			},
		]);
		properties(ios.session);
		expect(screen.getByLabelText('Time ago')).toBeTruthy();
		expect(screen.getByRole('group', { name: 'Rating' })).toBeTruthy();
		expect(screen.queryByLabelText('Review date')).toBeNull();
		expect(screen.queryByTestId('social-avatar')).toBeNull();
		expect(screen.getByTestId('social-time-preview').textContent).toBe('edited Fri');
		await ios.session.close();
	});
});

describe('social-rating', () => {
	it('a click picks the rating as one undo step; undo / redo restore it', async () => {
		const { session, clip } = await openSession([socialDefaults('play-store-review')]);
		properties(session);
		const radios = within(screen.getByTestId('social-rating')).getAllByRole('radio');
		expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([false, false, false, true, false]);
		expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
			'1 star',
			'2 stars',
			'3 stars',
			'4 stars',
			'5 stars',
		]);
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('social-rating-2')));
		expect(clip().params.rating).toBe(2);
		expect(history(session)).toBe(before + 1);
		// clicking the current rating writes nothing
		act(() => fireEvent.click(screen.getByTestId('social-rating-2')));
		expect(history(session)).toBe(before + 1);
		act(() => session.undo());
		expect(clip().params.rating).toBe(4);
		act(() => session.redo());
		expect(clip().params.rating).toBe(2);
		await session.close();
	});

	it('works from the keyboard: arrows, Home / End and digits; native radios named per star', async () => {
		const { session, clip } = await openSession([socialDefaults('app-store-review')]);
		properties(session);
		const group = screen.getByTestId('social-rating');
		const checked = (within(group).getAllByRole('radio') as HTMLInputElement[]).filter((r) => r.checked);
		expect(checked.map((r) => r.getAttribute('aria-label'))).toEqual(['4 stars']);
		// a fieldset named by its legend, one radio name for the five stars
		expect(screen.getByRole('group', { name: 'Rating' })).toBe(group);
		expect(
			new Set(
				within(group)
					.getAllByRole('radio')
					.map((r) => (r as HTMLInputElement).name),
			).size,
		).toBe(1);
		act(() => fireEvent.keyDown(group, { key: 'ArrowRight' }));
		expect(clip().params.rating).toBe(5);
		act(() => fireEvent.keyDown(group, { key: 'ArrowRight' }));
		expect(clip().params.rating).toBe(5); // clamped
		act(() => fireEvent.keyDown(group, { key: 'Home' }));
		expect(clip().params.rating).toBe(1);
		act(() => fireEvent.keyDown(group, { key: 'ArrowLeft' }));
		expect(clip().params.rating).toBe(1);
		act(() => fireEvent.keyDown(group, { key: 'End' }));
		expect(clip().params.rating).toBe(5);
		act(() => fireEvent.keyDown(group, { key: '3' }));
		expect(clip().params.rating).toBe(3);
		act(() => fireEvent.keyDown(group, { key: '9' }));
		expect(clip().params.rating).toBe(3);
		expect(document.activeElement?.getAttribute('aria-label')).toBe('3 stars');
		await session.close();
	});

	it('writes to every selected clip and shows a dash for mixed ratings', async () => {
		const { session, clip } = await openSession([
			{ ...socialDefaults('play-store-review'), rating: 2 },
			{ ...socialDefaults('play-store-review'), rating: 5 },
		]);
		properties(session);
		expect(screen.getByTestId('social-rating-value').textContent).toBe('–');
		act(() => fireEvent.click(screen.getByTestId('social-rating-3')));
		expect([clip(0).params.rating, clip(1).params.rating]).toEqual([3, 3]);
		await session.close();
	});
});

describe('social-date', () => {
	it('writes real dates only, previews the store form and restores on Escape', async () => {
		const { session, clip } = await openSession([socialDefaults('play-store-review')]);
		properties(session);
		const input = screen.getByTestId('social-date-input') as HTMLInputElement;
		expect(input.value).toBe('2025-09-24');
		expect(input.min).toBe('1970-01-01');
		expect(input.max).toBe('2099-12-31');
		const before = history(session);
		act(() => fireEvent.focus(input));
		act(() => fireEvent.change(input, { target: { value: '2018-11-06' } }));
		expect(clip().params.date).toBe('2018-11-06');
		expect(screen.getByTestId('social-date-preview').textContent).toBe('11/6/18');
		expect(history(session)).toBe(before + 1);
		// an incomplete date (the field reports '' meanwhile) is not written; blur shows the error
		act(() => fireEvent.change(input, { target: { value: '' } }));
		expect(clip().params.date).toBe('2018-11-06');
		act(() => fireEvent.blur(input));
		expect(screen.getByTestId('social-date-error').textContent).toMatch(/real date between 1970 and 2099/);
		act(() => fireEvent.focus(input));
		act(() => fireEvent.keyDown(input, { key: 'Escape' }));
		expect(input.value).toBe('2018-11-06');
		expect(screen.queryByTestId('social-date-error')).toBeNull();
		act(() => session.undo());
		expect(clip().params.date).toBe('2025-09-24');
		await session.close();
	});

	it('the wand draws a recent date as one undo step', async () => {
		const { session, clip } = await openSession([socialDefaults('app-store-review')]);
		properties(session);
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('social-date-randomize')));
		expect(clip().params.date).toMatch(/^20(2[4-6])-\d\d-\d\d$/);
		expect(history(session)).toBe(before + 1);
		expect(lastLabel(session)).toBe('Randomize Date');
		await session.close();
	});
});

describe('Randomize stats on store reviews', () => {
	it('writes the rating and date (Play) or the rating and age (iPhone) in one step, never the hidden counts', async () => {
		const play = await openSession([socialDefaults('play-store-review')]);
		properties(play.session);
		const old = play.clip().params;
		const before = history(play.session);
		act(() => fireEvent.click(screen.getByTestId('social-randomize-stats')));
		expect(history(play.session)).toBe(before + 1);
		expect(lastLabel(play.session)).toBe('Randomize Stats');
		expect(play.clip().params.likes).toBe(old.likes);
		expect(play.clip().params.timeValue).toBe(old.timeValue);
		await play.session.close();
		cleanup();
		// the patch itself: every review stat the variant draws, and only those
		expect(Object.keys(statsPatch({ variant: 'play-store-review' }, 3)).sort()).toEqual(['date', 'rating']);
		expect(Object.keys(statsPatch({ variant: 'app-store-review' }, 3)).sort()).toEqual(['date', 'rating']);
		expect(Object.keys(statsPatch({ variant: 'app-store-review-ios' }, 3)).sort()).toEqual([
			'rating',
			'timeUnit',
			'timeValue',
		]);
		expect(Object.keys(statsPatch({ variant: 'tiktok-comment' }, 3)).sort()).toEqual([
			'likes',
			'replies',
			'timeUnit',
			'timeValue',
		]);
	});

	it('Effect Controls shows the stars and the wand on the Stats group', async () => {
		const { session, clip } = await openSession([socialDefaults('app-store-review-ios')]);
		const view = render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="review-ec" visible />
			</SessionProvider>,
		);
		const stats = view.container.querySelector('[data-ec-param-group="stats"]') as HTMLElement;
		expect(stats.querySelector('[data-row="params.rating"] [data-social-rating]')).not.toBeNull();
		act(() => fireEvent.click(within(stats).getByTestId('social-rating-1')));
		expect(clip().params.rating).toBe(1);
		await session.close();
	});
});

describe('read-only and robustness', () => {
	it('disables the stars, the date and the wands in a read-only project', async () => {
		const { session } = await openSession([socialDefaults('play-store-review')]);
		act(() => session.store.setState({ readOnly: true } as never));
		properties(session);
		for (const r of within(screen.getByTestId('social-rating')).getAllByRole('radio'))
			expect((r as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId('social-date-input') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId('social-date-randomize') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('social-randomize-stats') as HTMLButtonElement).disabled).toBe(true);
		await session.close();
	});

	const props = (over: Partial<TemplateParamControlProps>): TemplateParamControlProps => ({
		clipId: 'c1',
		paramName: 'rating',
		value: undefined,
		params: {},
		onChange: () => true,
		onChangeParams: () => true,
		disabled: false,
		clipIds: ['c1'],
		mixed: false,
		...over,
	});

	it('never crashes on wrong types and shows no rating / date for them', () => {
		for (const value of [undefined, null, 0, 6, 2.5, '4', {}, [], Number.NaN, '2023-02-29', 20250101]) {
			const params = { variant: 99, rating: 'many', date: {} };
			const view = render(
				<>
					<SocialRatingControl {...props({ value, params })} />
					<SocialDateControl {...props({ paramName: 'date', value, params })} />
				</>,
			);
			expect(view.getByTestId('social-rating-value').textContent).toBe('–');
			expect(view.getByTestId('social-date-preview').textContent).toBe('–');
			cleanup();
		}
	});

	it('reports a refused write', () => {
		const view = render(<SocialRatingControl {...props({ value: 4, onChange: () => false })} />);
		act(() => fireEvent.click(view.getByTestId('social-rating-1')));
		expect(view.getByTestId('social-rating-error').textContent).toBe('The change was refused');
		cleanup();
		const d = render(
			<SocialDateControl {...props({ paramName: 'date', value: '2025-01-01', onChange: () => false })} />,
		);
		const input = d.getByTestId('social-date-input') as HTMLInputElement;
		act(() => fireEvent.change(input, { target: { value: '2025-01-02' } }));
		expect(d.getByTestId('social-date-error').textContent).toBe('The change was refused');
	});
});
