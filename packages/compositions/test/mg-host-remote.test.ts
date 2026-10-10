// The sandboxed live frame host (security review MG-1): the host agent that runs inside a bundle's page
// (mg-host/agent.ts) driven over a real MessageChannel by the editor's remote (mg-host/remote.ts), against a
// stand-in for the Remotion 4.0.499 renderer-page globals; and what the editor accepts from a page it does not trust.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HOST_AGENT_SCRIPT,
	hostBootstrapScript,
	MG_HOST_CONNECT,
	MG_HOST_PORT_PROTOCOL,
	MG_HOST_SANDBOX,
	MgHostProtocolError,
	TEXT_PROBE_SCRIPT,
} from '../src/mg-host/protocol.ts';
import {
	isSafeFontSource,
	type MgHostPort,
	MgHostRemote,
	sanitizeFonts,
	sanitizeMeasurements,
	sanitizeMetadata,
} from '../src/mg-host/remote.ts';

type PageWindow = Window & Record<string, unknown>;
const W = window as unknown as PageWindow;
const REMOTION_GLOBALS = [
	'remotion_setBundleMode',
	'remotion_calculateComposition',
	'remotion_getCompositionNames',
	'remotion_setFrame',
	'remotion_renderReady',
	'remotion_cancelledError',
	'remotion_inputProps',
	'remotion_version',
	'siteVersion',
	'getStaticCompositions',
	'__jasperMgAgent',
	'__jasperTexts',
];

/** What a 4.0.499 bundle page exposes, recording what the agent does with it. */
function fakeRemotionPage(opts: { version?: string; failOn?: string } = {}) {
	const log: string[] = [];
	W.remotion_version = opts.version ?? '4.0.499';
	W.siteVersion = '11';
	W.getStaticCompositions = async () => [];
	W.remotion_renderReady = false;
	W.remotion_getCompositionNames = () => ['Title'];
	W.remotion_setBundleMode = (state: { type: string; compositionName?: string }) => {
		log.push(`mode:${state.type}${state.compositionName ? `:${state.compositionName}` : ''}`);
		if (state.type === 'composition')
			W.remotion_setFrame = (frame: number, id: string) => {
				log.push(`frame:${id}:${frame}`);
				W.remotion_renderReady = true;
			};
		W.remotion_renderReady = true;
	};
	W.remotion_calculateComposition = async (id: string) => {
		log.push(`calc:${id}:${String(W.remotion_inputProps)}`);
		if (opts.failOn === id) throw new Error(`No composition "${id}"\n  at stack`);
		return {
			width: 1920,
			height: 1080,
			fps: 25,
			durationInFrames: 75,
			serializedResolvedPropsWithCustomSchema: '{}',
		};
	};
	return log;
}

/** Hands the agent its port the way `connectMgHost` does, and returns the editor's end. */
async function connect(): Promise<{ remote: MgHostRemote; port: MessagePort }> {
	const channel = new MessageChannel();
	const hello = new Promise<unknown>((resolve) => {
		channel.port1.onmessage = (ev) => resolve(ev.data);
	});
	window.dispatchEvent(
		new MessageEvent('message', {
			data: { jasperMgHost: MG_HOST_CONNECT },
			source: window.parent,
			ports: [channel.port2],
		}),
	);
	expect(await hello).toEqual({ hello: MG_HOST_PORT_PROTOCOL });
	return { remote: new MgHostRemote(channel.port1, { timeoutMs: 1000 }), port: channel.port1 };
}

describe('host agent + remote over a MessagePort (MG-1)', () => {
	beforeEach(() => {
		for (const k of REMOTION_GLOBALS) delete W[k];
		document.body.innerHTML = '';
		vi.stubGlobal('FontFace', function FontFace(family: string) {
			return { family, status: 'unloaded' };
		});
		new Function(TEXT_PROBE_SCRIPT)();
		new Function(HOST_AGENT_SCRIPT)();
	});
	afterEach(() => {
		for (const k of REMOTION_GLOBALS) delete W[k];
		vi.unstubAllGlobals();
	});

	it('the host iframe is sandboxed to scripts only, and the bootstrap installs the agent', () => {
		expect(MG_HOST_SANDBOX).toBe('allow-scripts');
		const boot = hostBootstrapScript();
		expect(boot).toContain('__jasperMgAgent');
		expect(boot).toContain('__jasperTexts');
		// Plain script: it must parse by itself in another document.
		expect(() => new Function(boot)).not.toThrow();
	});

	it('drives the renderer-page protocol: evaluate, calculate, mount with overrides, seek (clamped), re-seek on new props', async () => {
		const log = fakeRemotionPage();
		const { remote } = await connect();
		expect(await remote.check()).toEqual({
			ok: true,
			missing: [],
			remotionVersion: '4.0.499',
			siteVersion: '11',
		});
		const meta = await remote.configure({
			compositionId: 'Title',
			props: { title: 'Hi' },
			override: { width: 1280, height: 720, fps: 30, durationInFrames: 90 },
		});
		expect(meta).toEqual({ width: 1280, height: 720, fps: 30, durationInFrames: 90 });
		expect(log).toEqual(['mode:evaluation', 'calc:Title:{"title":"Hi"}', 'mode:composition:Title']);

		await remote.seek('Title', 45);
		await remote.seek('Title', 45); // the same frame is not drawn twice
		await remote.seek('Title', 1e9); // clamped to the composition
		expect(log.slice(3)).toEqual(['frame:Title:45', 'frame:Title:89']);

		// The same configuration again is free; new props remount and show the last frame again.
		await remote.configure({
			compositionId: 'Title',
			props: { title: 'Hi' },
			override: { width: 1280, height: 720, fps: 30, durationInFrames: 90 },
		});
		expect(log.length).toBe(5);
		await remote.configure({ compositionId: 'Title', props: { title: 'New' } });
		expect(log.slice(5)).toEqual(['calc:Title:{"title":"New"}', 'mode:composition:Title', 'frame:Title:74']);
	});

	it('reports page failures as typed errors, one line, never a stack', async () => {
		fakeRemotionPage({ failOn: 'Nope' });
		const { remote } = await connect();
		const e = await remote.configure({ compositionId: 'Nope', props: {} }).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(MgHostProtocolError);
		expect(e).toMatchObject({ code: 'MG_HOST_NO_COMPOSITION', message: 'No composition "Nope"' });

		for (const k of REMOTION_GLOBALS) if (k !== '__jasperMgAgent' && k !== '__jasperTexts') delete W[k];
		fakeRemotionPage({ version: '5.0.0' });
		const wrong = await remote.configure({ compositionId: 'Title', props: {} }).catch((x: unknown) => x);
		expect(wrong).toMatchObject({ code: 'MG_HOST_PROTOCOL' });
		expect((wrong as Error).message).toMatch(/Unsupported bundle/);
	});

	it('reaches the text probe through the port: locate, hide, restore, fonts', async () => {
		fakeRemotionPage();
		document.body.innerHTML = '<p id="a">Hello World</p><p id="b">Keep</p>';
		const { remote } = await connect();
		const [found, missing] = await remote.locateTexts(
			[
				{ id: 'title', text: 'hello world' },
				{ id: 'none', text: 'Not here' },
			],
			{ width: 1920, height: 1080 },
		);
		expect(found).toMatchObject({ id: 'title', found: true });
		expect(missing).toMatchObject({ id: 'none', found: false, rect: null });
		expect(await remote.hideText('Hello World')).toBe(true);
		expect(getComputedStyle(document.getElementById('a')!).visibility).toBe('hidden');
		await remote.restoreTexts();
		expect(getComputedStyle(document.getElementById('a')!).visibility).not.toBe('hidden');
		expect(await remote.hideText('nowhere')).toBe(false);
		expect(await remote.fonts()).toEqual([]);
	});

	it('the agent takes its port only from the embedding window, and knows no other operation', async () => {
		fakeRemotionPage();
		// A message from another window (a frame the bundle made, a window it opened) hands over nothing.
		const stranger = new MessageChannel();
		let answered = false;
		stranger.port1.onmessage = () => {
			answered = true;
		};
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { jasperMgHost: MG_HOST_CONNECT },
				source: {} as Window,
				ports: [stranger.port2],
			}),
		);
		window.dispatchEvent(
			new MessageEvent('message', { data: { jasperMgHost: 'other' }, source: window.parent }),
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(answered).toBe(false);

		const { port } = await connect();
		const reply = (msg: unknown) =>
			new Promise<Record<string, unknown>>((resolve) => {
				// Earlier tests left their agents listening on this window too: each greets the port once.
				port.onmessage = (ev) => {
					const d = ev.data as Record<string, unknown>;
					if (d.id === (msg as { id: number }).id) resolve(d);
				};
				port.postMessage(msg);
			});
		for (const op of ['eval', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ''])
			expect(await reply({ id: 7, op, args: {} })).toMatchObject({
				id: 7,
				ok: false,
				error: { code: 'MG_HOST_PROTOCOL', message: 'Unknown operation' },
			});
		expect(await reply({ id: 8 })).toMatchObject({ id: 8, ok: false });
	});
});

/** A port whose other end is a hostile page: it answers whatever the test says. */
function hostilePort(answer: (msg: { id: number; op: string }) => unknown): MgHostPort {
	const port: MgHostPort = {
		onmessage: null,
		postMessage(message: unknown) {
			const m = message as { id: number; op: string };
			const reply = answer(m);
			if (reply !== undefined) queueMicrotask(() => port.onmessage?.({ data: reply }));
		},
		close() {},
	};
	return port;
}

describe('the editor trusts nothing a bundle page says (MG-1)', () => {
	it('refuses metadata that would size layers and buffers by the page’s word', () => {
		const ok = { width: 1920, height: 1080, fps: 30, durationInFrames: 90 };
		expect(sanitizeMetadata({ ...ok, extra: 'ignored', defaultCodec: { evil: true } })).toEqual(ok);
		for (const bad of [
			null,
			'x',
			{ ...ok, width: 1e9 },
			{ ...ok, height: 0 },
			{ ...ok, width: Number.NaN },
			{ ...ok, width: Number.POSITIVE_INFINITY },
			{ ...ok, width: '1920' },
			{ ...ok, fps: 0 },
			{ ...ok, fps: -30 },
			{ ...ok, durationInFrames: 1e12 },
			{ ...ok, durationInFrames: -1 },
		])
			expect(() => sanitizeMetadata(bad)).toThrow(MgHostProtocolError);
	});

	it('a page that answers configure with garbage is a protocol error, not a crash', async () => {
		const remote = new MgHostRemote(
			hostilePort((m) => ({ id: m.id, ok: true, result: { width: 1e12, height: -1 } })),
		);
		await expect(remote.configure({ compositionId: 'X', props: {} })).rejects.toMatchObject({
			code: 'MG_HOST_PROTOCOL',
		});
	});

	it('error codes and messages from the page are bounded and mapped to known codes', async () => {
		const remote = new MgHostRemote(
			hostilePort((m) => ({
				id: m.id,
				ok: false,
				error: { code: '__proto__', message: 'x'.repeat(100_000) },
			})),
		);
		const e = (await remote.seek('X', 0).catch((x: unknown) => x)) as MgHostProtocolError;
		expect(e.code).toBe('MG_HOST_PROTOCOL');
		expect(e.message.length).toBeLessThanOrEqual(500);
	});

	it('a page that never answers times out; replies to unknown or reused ids are ignored', async () => {
		const silent = new MgHostRemote(
			hostilePort(() => undefined),
			{ timeoutMs: 1 },
		);
		vi.useFakeTimers();
		const p = silent.seek('X', 0).catch((x: unknown) => x);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await p).toMatchObject({ code: 'MG_HOST_TIMEOUT' });
		vi.useRealTimers();

		let port: MgHostPort | null = null;
		port = hostilePort((m) => {
			// Unsolicited and malformed messages first, then the real reply twice.
			for (const junk of [
				null,
				5,
				'x',
				{ id: 'not-a-number', ok: true },
				{ id: 999_999, ok: true, result: 1 },
			])
				port!.onmessage?.({ data: junk });
			queueMicrotask(() => port!.onmessage?.({ data: { id: m.id, ok: true, result: true } }));
			return { id: m.id, ok: true, result: true };
		});
		const remote = new MgHostRemote(port);
		expect(await remote.hideText('x')).toBe(true);
		remote.dispose();
		await expect(remote.seek('X', 0)).rejects.toMatchObject({ code: 'MG_HOST_PROTOCOL' });
	});

	it('measurements are matched to what was asked and scrubbed', () => {
		const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const out = sanitizeMeasurements(items, [
			{
				id: 'a',
				found: true,
				visible: true,
				rect: { x: 1, y: 2, width: 3, height: 4 },
				lines: [
					{ x: 1, y: 2, width: 3, height: 4 },
					{ x: 'NaN' },
					null,
					{ x: 0, y: 0, width: -1, height: 1 },
				],
				clippedBy: { x: Number.NaN, y: 0, width: 1, height: 1 },
				truncated: 'yes',
				style: { fontFamily: 'f'.repeat(5000), fontSize: -3, color: 7, lineHeight: 'x', letterSpacing: null },
			},
			{ id: 'injected', found: true, rect: { x: 0, y: 0, width: 1, height: 1 } },
			{ id: 'b', found: 'true' },
			'garbage',
		]);
		expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(out[0]).toMatchObject({
			found: true,
			visible: true,
			rect: { x: 1, y: 2, width: 3, height: 4 },
			lines: [{ x: 1, y: 2, width: 3, height: 4 }],
			clippedBy: null,
			truncated: false,
		});
		expect(out[0]!.style).toMatchObject({
			fontSize: 16,
			color: 'rgb(0, 0, 0)',
			lineHeight: null,
			letterSpacing: 0,
		});
		expect(out[0]!.style!.fontFamily.length).toBe(1024);
		expect(out[1]).toMatchObject({ id: 'b', found: false, rect: null });
		expect(out[2]).toMatchObject({ id: 'c', found: false });
		// Not an array, a huge array, a visible text without a box.
		expect(sanitizeMeasurements(items, { length: 1e9 }).every((m) => !m.found)).toBe(true);
		expect(
			sanitizeMeasurements([{ id: 'a' }], [{ id: 'a', found: true, visible: true, rect: null }])[0],
		).toMatchObject({
			found: true,
			visible: false,
		});
	});

	it('font sources may only point at bundle files of the editor’s origin, data: or https:', () => {
		const origin = 'http://127.0.0.1:47900';
		const ok = [
			`url("${origin}/mg/sandbox/CAP_abc-123/mk_1/public/brand.woff2") format("woff2")`,
			`url(${origin}/mg/bundles/mk_1/public/brand.woff2)`,
			'url("data:font/woff2;base64,AAAA")',
			'url("https://fonts.gstatic.com/s/inter/v1/inter.woff2") format("woff2")',
			'local("Inter"), local(Inter-Regular)',
		];
		for (const s of ok) expect([s, isSafeFontSource(s, origin)]).toEqual([s, true]);
		const bad = [
			// The engine's API and other paths of the editor's origin (requests would carry the editor's session).
			`url("${origin}/api/projects")`,
			`url("${origin}/media/mk_1")`,
			`url("${origin}/mg/sandboxes/x")`,
			`url("${origin}/mg/sandbox/cap/")`,
			// Other loopback ports, plain http, files, relative and scheme-relative URLs, javascript.
			'url("http://127.0.0.1:9229/json")',
			'url("http://192.168.1.1/admin")',
			'url("file:///etc/passwd")',
			'url("/api/projects")',
			'url("//evil.example/x.woff2")',
			'url("javascript:alert(1)")',
			// One good URL does not launder a bad one.
			`url("https://fonts.gstatic.com/a.woff2"), url("${origin}/api/projects")`,
			'',
			'expression(alert(1))',
			`url("${'a'.repeat(20_000)}")`,
		];
		for (const s of bad)
			expect([s.slice(0, 60), isSafeFontSource(s, origin)]).toEqual([s.slice(0, 60), false]);
		// Without a known origin nothing same-origin is accepted.
		expect(isSafeFontSource(ok[0]!, '')).toBe(false);
	});

	it('fonts are bounded in count and bytes, and unsafe faces are dropped', () => {
		const origin = 'http://127.0.0.1:47900';
		const out = sanitizeFonts(
			[
				{
					family: 'Good',
					source: 'url("data:font/woff2;base64,AAAA")',
					weight: '700',
					style: 'italic',
					loaded: true,
				},
				{ family: 'Api', source: `url("${origin}/api/projects")` },
				{ family: '', source: 'url("data:x")' },
				{ family: 'Buffer', buffer: new ArrayBuffer(8) },
				{ family: 'Huge', buffer: { byteLength: 1e12 } },
				{ family: 'NoSource' },
				null,
				'x',
			],
			origin,
		);
		expect(out.map((f) => f.family)).toEqual(['Good', 'Buffer']);
		expect(out[0]).toMatchObject({ weight: '700', style: 'italic', loaded: true });
		expect(sanitizeFonts('nope', origin)).toEqual([]);
		const many = Array.from({ length: 5000 }, (_, i) => ({ family: `F${i}`, source: 'url("data:x")' }));
		expect(sanitizeFonts(many, origin).length).toBe(512);
		const big = Array.from({ length: 10 }, (_, i) => ({
			family: `B${i}`,
			buffer: new ArrayBuffer(30 * 1024 * 1024),
		}));
		expect(sanitizeFonts(big, origin).length).toBe(4); // 128 MiB in total
	});
});
