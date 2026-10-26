// WP7a: the social-comment Properties controls (social-comment-text, social-count, social-time, social-avatar) and the
// Randomize identity / Randomize stats actions, mounted in the real Properties and Effect Controls panels against a
// test template with the social-comment params schema and ui hints. Writes go through the session: undo/redo,
// coalescing, multi-selection, read-only and refusals are checked on the document.
import {
	createMgRegistry,
	generatedAvatar,
	MG_CATALOG,
	type SocialVariant,
	socialDefaults,
} from '@jasper/mg-templates';
import { type Clip, createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TemplateParamControlProps } from '../src/extensions/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { registerSocialCommentControls } from '../src/social-comments/register.ts';
import { SocialAvatarControl } from '../src/social-comments/SocialAvatarControl.tsx';
import { SocialCommentTextControl } from '../src/social-comments/SocialCommentTextControl.tsx';
import { SocialCountControl } from '../src/social-comments/SocialCountControl.tsx';
import { SocialTimeControl } from '../src/social-comments/SocialTimeControl.tsx';
import { PROJECT_ITEMS_MIME } from '../src/state/services.ts';
import { SOCIAL_TEST_TEMPLATE_ID, socialTestTemplate } from './social-test-template.ts';
import { videoAsset } from './timeline-helpers.ts';

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

async function openSession(clipParams: Record<string, unknown>[] = [socialDefaults('tiktok-comment')]) {
	const ids = createCounterIdSource(31);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Social', preset: 'hd-1080p-30' });
	store.put(doc);
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: {
			ids,
			now: () => 't',
			registries: defaultRegistries(createMgRegistry([...MG_CATALOG, socialTestTemplate])),
		},
	});
	const seqId = session.store.getState().activeSequenceId!;
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const r = apply(
		clipParams.map((params, i) => ({
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 120,
			track: `V${i + 1}`,
			template: { id: SOCIAL_TEST_TEMPLATE_ID, version: 1 },
			params,
			ref: `$c${i}`,
		})),
	);
	const clipIds = clipParams.map((_, i) => r.refs[`$c${i}`]!);
	act(() => {
		session.select('timeline', clipIds, 'replace');
		session.transport.seek(30);
	});
	const clip = (i = 0) => session.store.getState().document.sequences[seqId]!.clips[clipIds[i]!] as MgClip;
	const setParams = (patch: Record<string, unknown>, i = 0) =>
		act(() => {
			apply(
				Object.entries(patch).map(([name, value]) => ({
					type: 'param.set',
					target: ['clip', clipIds[i]!, 'params', name],
					value,
				})),
			);
		});
	return { session, seqId, clipIds, clip, setParams, apply };
}

const history = (s: EditorSession) => s.getState().history.entries.length;
const lastLabel = (s: EditorSession) => s.getState().history.entries.at(-1)?.label;

function properties(session: EditorSession) {
	return render(
		<SessionProvider session={session}>
			<PropertiesPanel instanceId="social-props" visible />
		</SessionProvider>,
	);
}

let off: (() => void) | null = null;
beforeEach(() => {
	off = registerSocialCommentControls();
});
afterEach(() => {
	off?.();
	cleanup();
	localStorage.clear();
});

const rowOf = (view: ReturnType<typeof render>, param: string) =>
	view.container.querySelector(`[data-row="params.${param}"]`) as HTMLElement | null;

describe('registration and layout', () => {
	it('renders the four controls on their rows, hides the merged time unit and adds the stats wand', async () => {
		const { session } = await openSession();
		const view = properties(session);
		expect(rowOf(view, 'text')).not.toBeNull();
		expect(view.container.querySelector('[data-row-block="params.text"] [data-social-text]')).not.toBeNull();
		expect(
			view.container.querySelector('[data-row-block="params.avatar"] [data-social-avatar]'),
		).not.toBeNull();
		expect(rowOf(view, 'likes')!.querySelector('[data-social-count="likes"]')).not.toBeNull();
		expect(rowOf(view, 'replies')!.querySelector('[data-social-count="replies"]')).not.toBeNull();
		expect(rowOf(view, 'timeValue')!.querySelector('[data-social-time]')).not.toBeNull();
		// timeUnit is edited by the time control: no row of its own
		expect(rowOf(view, 'timeUnit')).toBeNull();
		// X-only counts are hidden for TikTok
		expect(rowOf(view, 'views')).toBeNull();
		const stats = view.container.querySelector('[data-section$=".stats"]') as HTMLElement;
		expect(within(stats).getAllByTestId('social-randomize-stats')).toHaveLength(1);
		// only the stats group gets the wand
		expect(view.getAllByTestId('social-randomize-stats')).toHaveLength(1);
		await session.close();
	});
});

describe('without the controls registered', () => {
	it('falls back to default editors, and an object param shows its value read-only (never a blank row)', async () => {
		off?.();
		off = null;
		const { session, setParams } = await openSession();
		setParams({ avatar: { generated: 12 } });
		const view = properties(session);
		expect(view.getByTestId('prop-params.avatar').textContent).toBe('{"generated":12}');
		expect(rowOf(view, 'timeUnit')).not.toBeNull();
		expect(view.queryByTestId('social-randomize-stats')).toBeNull();
		await session.close();
	});
});

describe('social-comment-text', () => {
	it('shows the visible text with marks styled, never the markup', async () => {
		const { session, setParams } = await openSession();
		setParams({ text: 'This is ==so good== ||spoiler|| ~~gone~~ @luna #fyp' });
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		expect(input.value).toBe('This is so good spoiler gone @luna #fyp');
		const backdrop = screen.getByTestId('social-text-backdrop');
		expect(backdrop.querySelector('[data-mark="highlight"]')?.textContent).toBe('so good');
		expect(backdrop.querySelector('[data-mark="blur"]')?.textContent).toBe('spoiler');
		expect(backdrop.querySelector('[data-mark="remove"]')?.textContent).toBe('gone');
		expect(backdrop.querySelector('[data-role="mention"]')?.textContent).toBe('@luna');
		expect(backdrop.querySelector('[data-role="hashtag"]')?.textContent).toBe('#fyp');
		expect(backdrop.textContent).not.toContain('==');
		await session.close();
	});

	it('typing keeps marks and a burst is one undo step', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ text: 'so ==good==' });
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		const before = history(session);
		act(() => fireEvent.change(input, { target: { value: 'Wow so good' } }));
		act(() => fireEvent.change(input, { target: { value: 'Wow so goods' } }));
		act(() => fireEvent.change(input, { target: { value: 'Wow so goods!' } }));
		expect(clip().params.text).toBe('Wow so ==goods!==');
		expect(history(session)).toBe(before + 1);
		act(() => {
			session.undo();
		});
		expect(clip().params.text).toBe('so ==good==');
		expect(input.value).toBe('so good');
		act(() => {
			session.redo();
		});
		expect(clip().params.text).toBe('Wow so ==goods!==');
		await session.close();
	});

	it('Highlight / Blur / Remove / Clear apply to whole words, each as its own undo step', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ text: 'Write any comment here' });
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		const select = (s: number, e: number) =>
			act(() => {
				input.focus();
				input.setSelectionRange(s, e);
				fireEvent.mouseUp(input);
			});
		const before = history(session);
		select(11, 13); // inside "comment"
		expect((screen.getByTestId('social-text-highlight') as HTMLButtonElement).disabled).toBe(false);
		act(() => fireEvent.click(screen.getByTestId('social-text-highlight')));
		expect(clip().params.text).toBe('Write any ==comment== here');
		expect(lastLabel(session)).toBe('Highlight');
		expect(screen.getByTestId('social-text-highlight').getAttribute('aria-pressed')).toBe('true');
		select(0, 9); // "Write any"
		act(() => fireEvent.click(screen.getByTestId('social-text-blur')));
		expect(clip().params.text).toBe('||Write any|| ==comment== here');
		select(18, 22);
		act(() => fireEvent.click(screen.getByTestId('social-text-remove')));
		expect(clip().params.text).toBe('||Write any|| ==comment== ~~here~~');
		expect(history(session)).toBe(before + 3);
		// pressing a mark the words carry already removes it
		select(11, 12);
		act(() => fireEvent.click(screen.getByTestId('social-text-highlight')));
		expect(clip().params.text).toBe('||Write any|| comment ~~here~~');
		select(0, 22);
		act(() => fireEvent.click(screen.getByTestId('social-text-clear')));
		expect(clip().params.text).toBe('Write any comment here');
		expect(lastLabel(session)).toBe('Clear Marks');
		expect(history(session)).toBe(before + 5);
		// whitespace only: nothing to mark
		select(5, 6);
		expect((screen.getByTestId('social-text-highlight') as HTMLButtonElement).disabled).toBe(true);
		act(() => {
			session.undo();
		});
		expect(clip().params.text).toBe('||Write any|| comment ~~here~~');
		await session.close();
	});

	it('marks survive later typing, also typed right after a mark action', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ text: 'hello world' });
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		act(() => {
			input.focus();
			input.setSelectionRange(0, 2);
		});
		act(() => fireEvent.click(screen.getByTestId('social-text-blur')));
		const before = history(session);
		act(() => fireEvent.change(input, { target: { value: 'hello big world' } }));
		expect(clip().params.text).toBe('||hello|| big world');
		// the typing after the mark is a new step: undo leaves the mark
		expect(history(session)).toBe(before + 1);
		act(() => {
			session.undo();
		});
		expect(clip().params.text).toBe('||hello|| world');
		await session.close();
	});

	it('writes nothing during an IME composition and commits it when it ends', async () => {
		const { session, clip } = await openSession();
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		const before = history(session);
		act(() => {
			fireEvent.compositionStart(input);
			fireEvent.change(input, { target: { value: 'k' } });
			fireEvent.change(input, { target: { value: 'か' } });
		});
		expect(clip().params.text).toBe(socialDefaults('tiktok-comment').text);
		expect(input.value).toBe('か');
		act(() => fireEvent.compositionEnd(input));
		expect(clip().params.text).toBe('か');
		expect(history(session)).toBe(before + 1);
		await session.close();
	});

	it('counts graphemes, refuses text over the limit with a message and accepts emoji', async () => {
		const { session, clip } = await openSession();
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		act(() => fireEvent.change(input, { target: { value: 'hola 👍🏽🇪🇸' } }));
		expect(clip().params.text).toBe('hola 👍🏽🇪🇸');
		expect(screen.getByTestId('social-text-counter').textContent).toBe('7 / 2000');
		act(() => fireEvent.change(input, { target: { value: 'x'.repeat(2001) } }));
		expect(screen.getByTestId('social-text-problem').textContent).toContain('2000');
		expect(clip().params.text).toBe('hola 👍🏽🇪🇸');
		expect(input.getAttribute('aria-invalid')).toBe('true');
		await session.close();
	});

	it('Ctrl+Z in the editor undoes through the project History; Ctrl+Shift+1 highlights', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ text: 'one two' });
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		act(() => fireEvent.change(input, { target: { value: 'one two three' } }));
		act(() => {
			input.focus();
			input.setSelectionRange(0, 1);
			fireEvent.keyDown(input, { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });
		});
		expect(clip().params.text).toBe('==one== two three');
		act(() => {
			fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });
		});
		expect(clip().params.text).toBe('one two three');
		act(() => {
			fireEvent.keyDown(input, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
		});
		expect(clip().params.text).toBe('==one== two three');
		await session.close();
	});

	it('"Show markup" shows and edits the stored markup', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ text: 'a ==b==' });
		properties(session);
		act(() => fireEvent.click(screen.getByTestId('social-text-show-markup')));
		const raw = screen.getByTestId('social-text-markup') as HTMLTextAreaElement;
		expect(raw.value).toBe('a ==b==');
		act(() => fireEvent.change(raw, { target: { value: 'a ==b== ||c||' } }));
		expect(clip().params.text).toBe('a ==b== ||c||');
		expect((screen.getByTestId('social-text-highlight') as HTMLButtonElement).disabled).toBe(true);
		act(() => fireEvent.click(screen.getByTestId('social-text-show-markup')));
		expect((screen.getByTestId('social-text-input') as HTMLTextAreaElement).value).toBe('a b c');
		await session.close();
	});

	it('with several clips: mixed texts show a placeholder and typing replaces every text', async () => {
		const { session, clip } = await openSession([
			{ ...socialDefaults('tiktok-comment'), text: 'first' },
			{ ...socialDefaults('tiktok-comment'), text: 'second' },
		]);
		properties(session);
		const input = screen.getByTestId('social-text-input') as HTMLTextAreaElement;
		expect(input.value).toBe('');
		expect(input.placeholder).toContain('Multiple values');
		act(() => fireEvent.change(input, { target: { value: 'same' } }));
		expect(clip(0).params.text).toBe('same');
		expect(clip(1).params.text).toBe('same');
		await session.close();
	});
});

describe('social-count', () => {
	it('parses typed counts and previews them in the platform format', async () => {
		const { session, clip } = await openSession();
		properties(session);
		const likes = screen.getByTestId('social-count-likes') as HTMLInputElement;
		expect(likes.value).toBe('1393');
		expect(screen.getByTestId('social-count-likes-preview').textContent).toBe('1,393');
		act(() => fireEvent.focus(likes));
		act(() => fireEvent.change(likes, { target: { value: '12.3K' } }));
		expect(screen.getByTestId('social-count-likes-preview').textContent).toBe('12.3K');
		act(() => fireEvent.keyDown(likes, { key: 'Enter' }));
		expect(clip().params.likes).toBe(12_300);
		act(() => fireEvent.blur(likes));
		expect(likes.value).toBe('12300');
		act(() => {
			session.undo();
		});
		expect(clip().params.likes).toBe(1393);
		expect(likes.value).toBe('1393');
		await session.close();
	});

	it('shows a visible error for invalid input and leaves the value alone; Escape restores', async () => {
		const { session, clip } = await openSession();
		properties(session);
		const likes = screen.getByTestId('social-count-likes') as HTMLInputElement;
		const before = history(session);
		act(() => fireEvent.focus(likes));
		act(() => fireEvent.change(likes, { target: { value: 'lots' } }));
		act(() => fireEvent.blur(likes));
		expect(screen.getByTestId('social-count-likes-error').getAttribute('role')).toBe('alert');
		expect(likes.getAttribute('aria-invalid')).toBe('true');
		expect(clip().params.likes).toBe(1393);
		expect(history(session)).toBe(before);
		act(() => fireEvent.focus(likes));
		act(() => fireEvent.change(likes, { target: { value: '-4' } }));
		act(() => fireEvent.keyDown(likes, { key: 'Enter' }));
		expect(screen.getByTestId('social-count-likes-error').textContent).toBe('Cannot be negative');
		act(() => fireEvent.keyDown(likes, { key: 'Escape' }));
		expect(likes.value).toBe('1393');
		expect(screen.queryByTestId('social-count-likes-error')).toBeNull();
		await session.close();
	});

	it('the wand draws a value consistent with the other counts, as one undo step', async () => {
		const { session, clip, setParams } = await openSession();
		setParams({ likes: 10_000 });
		properties(session);
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('social-count-replies-randomize')));
		const replies = clip().params.replies as number;
		expect(replies).toBeGreaterThanOrEqual(100);
		expect(replies).toBeLessThanOrEqual(500);
		expect(clip().params.likes).toBe(10_000);
		expect(history(session)).toBe(before + 1);
		expect(lastLabel(session)).toBe('Randomize Replies');
		await session.close();
	});

	it('mixed values show a dash; a typed value is written to every selected clip', async () => {
		const { session, clip } = await openSession([
			{ ...socialDefaults('tiktok-comment'), likes: 5 },
			{ ...socialDefaults('tiktok-comment'), likes: 9 },
		]);
		properties(session);
		const likes = screen.getByTestId('social-count-likes') as HTMLInputElement;
		expect(likes.value).toBe('');
		expect(likes.placeholder).toBe('–');
		expect(screen.getByTestId('social-count-likes-preview').textContent).toBe('–');
		act(() => fireEvent.focus(likes));
		act(() => fireEvent.change(likes, { target: { value: '1M' } }));
		act(() => fireEvent.keyDown(likes, { key: 'Enter' }));
		expect([clip(0).params.likes, clip(1).params.likes]).toEqual([1_000_000, 1_000_000]);
		await session.close();
	});
});

describe('social-time', () => {
	it('edits value and unit in one row; months stay months (YouTube "3 months ago")', async () => {
		const { session, clip } = await openSession([socialDefaults('youtube-comment')]);
		properties(session);
		const value = screen.getByTestId('social-time-value') as HTMLInputElement;
		const unit = screen.getByTestId('social-time-unit') as HTMLSelectElement;
		expect(value.value).toBe('10');
		expect(unit.value).toBe('month');
		expect(screen.getByTestId('social-time-preview').textContent).toBe('10 months ago');
		const before = history(session);
		act(() => fireEvent.focus(value));
		act(() => fireEvent.change(value, { target: { value: '3' } }));
		act(() => fireEvent.keyDown(value, { key: 'Enter' }));
		expect(clip().params.timeValue).toBe(3);
		expect(clip().params.timeUnit).toBe('month');
		expect(screen.getByTestId('social-time-preview').textContent).toBe('3 months ago');
		act(() => fireEvent.change(unit, { target: { value: 'hour' } }));
		expect(clip().params.timeUnit).toBe('hour');
		expect(screen.getByTestId('social-time-preview').textContent).toBe('3 hours ago');
		expect(history(session)).toBe(before + 2);
		act(() => fireEvent.change(unit, { target: { value: 'month' } }));
		expect(clip().params.timeUnit).toBe('month');
		expect(screen.getByTestId('social-time-preview').textContent).toBe('3 months ago');
		await session.close();
	});

	it('uses the compact form on TikTok and refuses values out of range', async () => {
		const { session, clip } = await openSession();
		properties(session);
		expect(screen.getByTestId('social-time-preview').textContent).toBe('1d');
		const value = screen.getByTestId('social-time-value') as HTMLInputElement;
		act(() => fireEvent.focus(value));
		act(() => fireEvent.change(value, { target: { value: '20000' } }));
		act(() => fireEvent.keyDown(value, { key: 'Enter' }));
		expect(screen.getByTestId('social-time-error').textContent).toBe('At most 10,000');
		expect(clip().params.timeValue).toBe(1);
		await session.close();
	});

	it('shows a dash for a unit that differs between selected clips', async () => {
		const { session } = await openSession([
			{ ...socialDefaults('tiktok-comment'), timeValue: 2, timeUnit: 'day' },
			{ ...socialDefaults('tiktok-comment'), timeValue: 2, timeUnit: 'week' },
		]);
		properties(session);
		expect((screen.getByTestId('social-time-unit') as HTMLSelectElement).value).toBe('');
		expect(screen.getByTestId('social-time-preview').textContent).toBe('–');
		await session.close();
	});
});

describe('Randomize stats', () => {
	it('fills every stat the variant draws in one undo step and leaves the hidden ones', async () => {
		const { session, clip } = await openSession();
		properties(session);
		const before = history(session);
		const old = { ...clip().params };
		act(() => fireEvent.click(screen.getByTestId('social-randomize-stats')));
		expect(history(session)).toBe(before + 1);
		expect(lastLabel(session)).toBe('Randomize Stats');
		const now = clip().params;
		// X-only stats are untouched on TikTok
		expect(now.reposts).toBe(old.reposts);
		expect(now.views).toBe(old.views);
		expect(now.text).toBe(old.text);
		const likes = now.likes as number;
		expect((now.replies as number) <= Math.round(likes * 0.05)).toBe(true);
		act(() => {
			session.undo();
		});
		expect(clip().params).toEqual(old);
		await session.close();
	});

	it('gives each selected clip its own stats (by its own variant)', async () => {
		const { session, clip } = await openSession([socialDefaults('x-post'), socialDefaults('tiktok-comment')]);
		properties(session);
		const x = { ...clip(0).params };
		const tt = { ...clip(1).params };
		act(() => fireEvent.click(screen.getByTestId('social-randomize-stats')));
		expect(clip(0).params.views).not.toBe(x.views);
		expect(clip(1).params.views).toBe(tt.views);
		expect(clip(0).params.likes).not.toBe(clip(1).params.likes);
		await session.close();
	});
});

describe('social-avatar', () => {
	it('switches between generated, default and project images; Reshuffle draws a new seed', async () => {
		const { session, clip, apply } = await openSession();
		const reg = apply([
			{ type: 'media.register', asset: { ...videoAsset(1, false), kind: 'image', originalName: 'face.png' } },
			{ type: 'media.register', asset: { ...videoAsset(5, false), originalName: 'clip.mp4' } },
		]);
		const imageId = (reg.results[0] as { mediaId: string }).mediaId;
		properties(session);
		expect(screen.getByTestId('social-avatar-preview').getAttribute('data-avatar-kind')).toBe('default');
		act(() => fireEvent.click(screen.getByTestId('social-avatar-mode-generated')));
		const g = clip().params.avatar as { generated: number };
		expect(g).toEqual({ generated: expect.any(Number) });
		expect(screen.getByTestId('social-avatar-preview').getAttribute('data-avatar-kind')).toBe('generated');
		act(() => fireEvent.click(screen.getByTestId('social-avatar-reshuffle')));
		expect((clip().params.avatar as { generated: number }).generated).not.toBe(g.generated);
		act(() => fireEvent.click(screen.getByTestId('social-avatar-mode-image')));
		const picker = screen.getByTestId('social-avatar-media') as HTMLSelectElement;
		// images only
		const names = [...picker.options].map((o) => o.textContent);
		expect(names).toContain('face.png');
		expect(names).not.toContain('clip.mp4');
		act(() => fireEvent.change(picker, { target: { value: imageId } }));
		expect(clip().params.avatar).toEqual({ mediaId: imageId });
		act(() => fireEvent.click(screen.getByTestId('social-avatar-mode-default')));
		expect(clip().params.avatar).toBeNull();
		await session.close();
	});

	it('accepts a still image dragged from the Project panel and refuses a video', async () => {
		const { session, clip, apply } = await openSession();
		apply([
			{ type: 'media.register', asset: { ...videoAsset(1, false), kind: 'image', originalName: 'face.png' } },
			{ type: 'media.register', asset: { ...videoAsset(5, false), originalName: 'clip.mp4' } },
		]);
		const doc = session.store.getState().document;
		const itemFor = (name: string) =>
			Object.values(doc.items).find(
				(i) => i.kind === 'media' && doc.media[(i as { mediaId: string }).mediaId]?.originalName === name,
			)!;
		properties(session);
		const zone = screen.getByTestId('social-avatar');
		const drop = (itemId: string) => {
			const data: Record<string, string> = { [PROJECT_ITEMS_MIME]: JSON.stringify({ itemIds: [itemId] }) };
			const dataTransfer = {
				types: [PROJECT_ITEMS_MIME],
				getData: (k: string) => data[k] ?? '',
				files: [],
				dropEffect: 'none',
			};
			act(() => {
				fireEvent.dragOver(zone, { dataTransfer });
				fireEvent.drop(zone, { dataTransfer });
			});
		};
		drop(itemFor('clip.mp4').id);
		expect(screen.getByTestId('social-avatar-message').textContent).toBe('Only still images can be avatars');
		expect(clip().params.avatar).toBeNull();
		const image = itemFor('face.png') as { id: string; mediaId: string };
		drop(image.id);
		expect(clip().params.avatar).toEqual({ mediaId: image.mediaId });
		expect(screen.queryByTestId('social-avatar-message')).toBeNull();
		await session.close();
	});

	it('Randomize identity writes name, handle and avatar in one step, different per clip', async () => {
		const { session, clip } = await openSession([socialDefaults('x-post'), socialDefaults('x-post')]);
		properties(session);
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('social-randomize-identity')));
		expect(history(session)).toBe(before + 1);
		expect(lastLabel(session)).toBe('Randomize Identity');
		for (const i of [0, 1]) {
			expect(clip(i).params.displayName).not.toBe('Display Name');
			expect(clip(i).params.handle).not.toBe('username');
			expect(clip(i).params.avatar).toEqual({ generated: expect.any(Number) });
		}
		expect(clip(0).params.avatar).not.toEqual(clip(1).params.avatar);
		act(() => {
			session.undo();
		});
		expect(clip(0).params.displayName).toBe('Display Name');
		expect(clip(1).params.avatar).toBeNull();
		await session.close();
	});

	it('marks an image that is no longer in the project (e.g. a document loaded with a broken reference)', async () => {
		const { session, clipIds } = await openSession();
		// commands refuse unknown media ids (WP1), so the stale value is handed to the control directly
		render(
			<SessionProvider session={session}>
				<SocialAvatarControl
					clipId={clipIds[0]!}
					clipIds={clipIds}
					paramName="avatar"
					value={{ mediaId: 'gone' }}
					params={socialDefaults('tiktok-comment')}
					onChange={() => true}
					onChangeParams={() => true}
					disabled={false}
					mixed={false}
				/>
			</SessionProvider>,
		);
		expect(screen.getByTestId('social-avatar-missing')).toBeTruthy();
		expect((screen.getByTestId('social-avatar-media') as HTMLSelectElement).value).toBe('__missing__');
		await session.close();
	});
});

describe('social-avatar initials', () => {
	it('come from the name the card shows: the handle on Instagram / YouTube, the display name on TikTok / X', async () => {
		const { session, clipIds } = await openSession();
		// a seed whose generated avatar draws initials for both names
		const seed = Array.from({ length: 200 }, (_, i) => i + 1).find(
			(n) =>
				generatedAvatar(n, 'luna.park').style === 'initials' &&
				generatedAvatar(n, 'Zed Alpha').style === 'initials',
		)!;
		const initials = (variant: SocialVariant) => {
			const view = render(
				<SessionProvider session={session}>
					<SocialAvatarControl
						clipId={clipIds[0]!}
						clipIds={clipIds}
						paramName="avatar"
						value={{ generated: seed }}
						params={{
							...socialDefaults(variant),
							displayName: 'Zed Alpha',
							handle: 'luna.park',
							avatar: { generated: seed },
						}}
						onChange={() => true}
						onChangeParams={() => true}
						disabled={false}
						mixed={false}
					/>
				</SessionProvider>,
			);
			const text = view.getByTestId('social-avatar-preview').textContent;
			view.unmount();
			return text;
		};
		for (const v of [
			'instagram-post',
			'instagram-reel-reply',
			'youtube-comment',
			'youtube-shorts-reply',
		] as const)
			expect(initials(v), v).toBe('L');
		for (const v of ['tiktok-reply', 'tiktok-comment', 'x-post'] as const) expect(initials(v), v).toBe('ZA');
		await session.close();
	});
});

describe('read-only projects', () => {
	it('disables every control and action', async () => {
		const { session } = await openSession();
		act(() => session.store.setState({ readOnly: true } as never));
		properties(session);
		expect((screen.getByTestId('social-text-input') as HTMLTextAreaElement).readOnly).toBe(true);
		expect((screen.getByTestId('social-count-likes') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId('social-count-likes-randomize') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('social-time-unit') as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByTestId('social-randomize-stats') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('social-randomize-identity') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('social-avatar-mode-generated') as HTMLButtonElement).disabled).toBe(true);
		await session.close();
	});
});

describe('Effect Controls', () => {
	it('hides the merged time unit and puts the stats wand on the Stats group header', async () => {
		const { session, clip } = await openSession();
		const view = render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="social-ec" visible />
			</SessionProvider>,
		);
		const stats = view.container.querySelector('[data-ec-param-group="stats"]') as HTMLElement;
		expect(stats.querySelector('[data-row="params.timeUnit"]')).toBeNull();
		expect(stats.querySelector('[data-row="params.timeValue"] [data-social-time]')).not.toBeNull();
		const old = clip().params.likes;
		act(() => fireEvent.click(within(stats).getByTestId('social-randomize-stats')));
		expect(clip().params.likes).not.toBe(old);
		await session.close();
	});
});

describe('robustness against unexpected values (rendered directly)', () => {
	const props = (over: Partial<TemplateParamControlProps>): TemplateParamControlProps => ({
		clipId: 'c1',
		paramName: 'likes',
		value: undefined,
		params: {},
		onChange: () => true,
		onChangeParams: () => true,
		disabled: false,
		clipIds: ['c1'],
		mixed: false,
		...over,
	});
	it('never crashes on wrong types', () => {
		const garbage: unknown[] = [
			undefined,
			null,
			42,
			'text',
			{},
			[],
			{ mediaId: 7 },
			{ generated: -1 },
			Number.NaN,
		];
		for (const value of garbage) {
			const params = { variant: 12, displayName: {}, timeUnit: 'fortnight', likes: 'many' };
			const view = render(
				<>
					<SocialCommentTextControl {...props({ paramName: 'text', value, params })} />
					<SocialCountControl {...props({ paramName: 'likes', value, params })} />
					<SocialCountControl {...props({ paramName: 'bogus', value, params })} />
					<SocialTimeControl {...props({ paramName: 'timeValue', value, params })} />
					<SocialAvatarControl {...props({ paramName: 'avatar', value, params })} />
				</>,
			);
			expect(view.getByTestId('social-text')).toBeTruthy();
			cleanup();
		}
	});

	it('reports a refused write and restores the stored text', () => {
		let calls = 0;
		const view = render(
			<SocialCommentTextControl
				{...props({
					paramName: 'text',
					value: 'stored',
					onChange: () => {
						calls++;
						return false;
					},
				})}
			/>,
		);
		const input = view.getByTestId('social-text-input') as HTMLTextAreaElement;
		act(() => fireEvent.change(input, { target: { value: 'stored!' } }));
		expect(calls).toBe(1);
		expect(input.value).toBe('stored');
		expect(view.getByTestId('social-text-problem').textContent).toBe('The change was refused');
	});
});
