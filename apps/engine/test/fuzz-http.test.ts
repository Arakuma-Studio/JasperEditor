// Discover routes from the server so new endpoints inherit fuzzing; streaming endpoints and web fallback are excluded.
import { describeFuzz, jsonTarget } from '@jasper/testkit/fuzz';
import { afterAll } from 'vitest';
import { closeApps, JSON_H, makeApp, type TestApp } from './helpers.ts';

/** `printRoutes({commonPrefix: false})` tree → [path, methods][] (HEAD left out: GET covers it). */
function parseRouteTree(tree: string): [string, string[]][] {
	const out: [string, string[]][] = [];
	const stack: string[] = [];
	for (const line of tree.split('\n')) {
		const m = /^((?:│ {3}| {4})*)[├└]── (.+?) \(([A-Z, ]+)\)$/.exec(line);
		if (!m) continue;
		const depth = m[1]!.length / 4;
		stack.length = depth;
		stack.push(m[2]!);
		out.push([stack.join(''), m[3]!.split(', ').filter((x) => x !== 'HEAD')]);
	}
	return out;
}

const SKIP = [/^\/events$/, /^\/agent$/, /^\/mcp$/, /^\*$/];
const PARAMS = [
	'x',
	'prj_0000000000000001',
	'..%2F..%2Fetc%2Fpasswd',
	'%00',
	'__proto__',
	'a'.repeat(300),
	'😀',
];

let app: TestApp | null = null;
const engine = async () => {
	app ??= await makeApp();
	return app;
};
afterAll(async () => {
	await closeApps();
});

const wellFormed = (s: string) =>
	s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

async function request(method: string, path: string, input: unknown): Promise<void> {
	const a = await engine();
	const { params, body, query } = (input && typeof input === 'object' ? input : {}) as {
		params?: unknown;
		body?: unknown;
		query?: unknown;
	};
	const ps = Array.isArray(params) ? params : [];
	let i = 0;
	const url =
		path.replace(/:[A-Za-z]+(?:\|:[A-Za-z]+)?/g, () =>
			// encodeURIComponent rejects lone UTF-16 surrogates; URL encoding replaces them with U+FFFD.
			encodeURIComponent(wellFormed(String(ps[i++] ?? 'x'))).slice(0, 2000),
		) + (typeof query === 'string' ? `?${query.slice(0, 2000)}` : '');
	const r = await a.inject({
		method: method as 'GET',
		url,
		headers: JSON_H,
		...(method === 'GET' || method === 'DELETE' ? {} : { payload: JSON.stringify(body ?? null) }),
	});
	if (r.statusCode < 500) return;
	let code = '';
	try {
		code = String((JSON.parse(r.body) as { code?: unknown }).code ?? '');
	} catch {
		// not JSON
	}
	if (!code || code === 'INTERNAL')
		throw new Error(
			`${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)} (body ${JSON.stringify(body)?.slice(0, 200)})`,
		);
}

const a0 = await makeApp();
const routes = parseRouteTree(a0.printRoutes({ commonPrefix: false })).filter(
	([p]) => !SKIP.some((re) => re.test(p)),
);
app = a0;

describeFuzz(
	'@jasper/engine HTTP routes',
	routes.flatMap(([path, methods]) =>
		methods.map((method) =>
			jsonTarget(
				`${method} ${path}`,
				[
					{ params: PARAMS.slice(0, 3), body: {}, query: '' },
					{
						params: [PARAMS[3], PARAMS[4]],
						body: { projectId: 'prj_0000000000000001', id: 'x', path: '/tmp' },
						query: 'a=1&b=',
					},
					{ params: [PARAMS[5], PARAMS[6]], body: [1, 'x', null], query: 'x=%ZZ' },
				],
				(input) => request(method, path, input),
				undefined,
				{ iterations: 25, properties: 8, slowMs: 10_000 },
			),
		),
	),
	600_000,
);
