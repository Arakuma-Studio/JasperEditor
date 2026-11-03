// An engine holding a user look library (TL-054) in memory, answering `/api/title-looks` like the real routes, behind the
// real client, so the web side's requests and the responses it reads are checked against the route schemas.
import { EngineClient } from '@jasper/engine-client';
import type { LookRecipe, UserLook } from '@jasper/project';

const recipe: LookRecipe = { layers: [{ type: 'face' }] };

let counter = 0;
const newId = () => `ulk_${String(++counter).padStart(16, '0')}`;
const now = '2026-11-03T00:00:00.000Z';
export const userLook = (name: string, extra: Partial<UserLook> = {}): UserLook => ({
	id: newId(),
	version: 1,
	name,
	recipe,
	createdAt: now,
	updatedAt: now,
	...extra,
});

export type Fake = {
	client: EngineClient;
	looks: UserLook[];
	calls: string[];
	readOnly: boolean;
	failSaves: boolean;
};

/** An engine holding a user look library in memory, answering `/api/title-looks` like the real routes. */
export function fakeEngine(initial: UserLook[] = []): Fake {
	const fake: Fake = { looks: [...initial], calls: [], readOnly: false, failSaves: false } as Fake;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const refuse = (status: number, code: string, message: string) =>
		json({ code, message, retryable: false }, status);
	fake.client = new EngineClient({
		baseUrl: 'http://127.0.0.1:9',
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			fake.calls.push(`${method} ${url.pathname}`);
			const one = url.pathname.match(/^\/api\/title-looks\/(ulk_[0-9A-Z]{16})$/);
			if (url.pathname === '/api/title-looks' && method === 'GET')
				return json({ revision: fake.calls.length, readOnly: fake.readOnly, looks: fake.looks });
			if (url.pathname === '/api/title-looks' && method === 'POST') {
				if (fake.failSaves) return refuse(500, 'DISK_FULL', 'The disk is full');
				if (fake.looks.some((l) => l.name.toLowerCase() === body.name.toLowerCase()))
					return refuse(409, 'LOOK_NAME_TAKEN', `A look named "${body.name}" already exists`);
				const l = userLook(body.name, {
					recipe: body.recipe,
					...(body.tags ? { tags: body.tags } : {}),
					...(body.category ? { category: body.category } : {}),
					...(body.colorways ? { colorways: body.colorways } : {}),
				});
				fake.looks.push(l);
				return json(l, 201);
			}
			if (one && method === 'PUT') {
				const l = fake.looks.find((x) => x.id === one[1]);
				if (!l) return refuse(404, 'LOOK_NOT_FOUND', 'Look not found');
				l.name = body.name ?? l.name;
				return json(l);
			}
			if (one && method === 'DELETE') {
				fake.looks = fake.looks.filter((x) => x.id !== one[1]);
				return json({ ok: true, removed: one[1] });
			}
			if (url.pathname === '/api/title-looks/import') {
				const entries = (body.file.looks ?? [body.file]) as { name?: string; recipe?: unknown }[];
				const looks: UserLook[] = [];
				const errors: { index: number; message: string }[] = [];
				entries.forEach((e, index) => {
					if (typeof e.name !== 'string' || !e.recipe) errors.push({ index, message: 'look: invalid' });
					else looks.push(userLook(e.name, { recipe: e.recipe as LookRecipe }));
				});
				if (!looks.length) return refuse(400, 'LOOK_INVALID', errors[0]?.message ?? 'no looks');
				fake.looks.push(...looks);
				return json({ looks, errors });
			}
			if (url.pathname === '/api/title-looks/export') {
				const ids = body.ids as string[] | undefined;
				return json({
					format: 'jasper-title-looks',
					version: 1,
					looks: ids ? fake.looks.filter((l) => ids.includes(l.id)) : fake.looks,
				});
			}
			return refuse(404, 'NOT_FOUND', 'no route');
		},
	});
	return fake;
}
