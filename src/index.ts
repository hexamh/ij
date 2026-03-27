import { Hono } from 'hono';

type Bindings = {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	KV: KVNamespace;
};

interface ScanRecord {
	url: string;
	uuid: string;
	status: 'pending' | 'completed' | 'failed';
	timestamp: number;
	visibility?: string;
	result?: any;
}

const app = new Hono<{ Bindings: Bindings }>();

const cfBase = (id: string) =>
	`https://api.cloudflare.com/client/v4/accounts/${id}/urlscanner/v2`;

const authH = (token: string): Record<string, string> => ({
	Authorization: `Bearer ${token}`,
	'Content-Type': 'application/json',
});

const kvKey = (url: string) => `scan:${btoa(url).replace(/[^a-zA-Z0-9]/g, '')}`;

// POST /api/scan/submit
app.post('/api/scan/submit', async (c) => {
	try {
		const { url, visibility = 'Public', screenshotsResolutions, customagent, referer, skipCache = false } =
			await c.req.json() as any;

		if (!url) return c.json({ error: 'URL is required' }, 400);

		let targetUrl: string;
		try { targetUrl = new URL(url).href; }
		catch { return c.json({ error: 'Invalid URL format' }, 400); }

		const key = kvKey(targetUrl);

		if (!skipCache) {
			const cached = await c.env.KV.get<ScanRecord>(key, 'json');
			if (cached) {
				return c.json({
					message: cached.status === 'completed' ? 'Retrieved from cache' : 'Scan already in progress',
					data: cached, cached: true,
				});
			}
		}

		const payload: Record<string, unknown> = { url: targetUrl, visibility };
		if (screenshotsResolutions?.length) payload.screenshotsResolutions = screenshotsResolutions;
		if (customagent) payload.customagent = customagent;
		if (referer) payload.referer = referer;

		const res = await fetch(`${cfBase(c.env.CLOUDFLARE_ACCOUNT_ID)}/scan`, {
			method: 'POST',
			headers: authH(c.env.CLOUDFLARE_API_TOKEN),
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: 'Submission failed', details: err }, 502);
		}

		const cfData = await res.json() as any;
		const uuid = cfData.result?.uuid ?? cfData.uuid ?? '';

		const record: ScanRecord = { url: targetUrl, uuid, status: 'pending', timestamp: Date.now(), visibility };
		await c.env.KV.put(key, JSON.stringify(record), { expirationTtl: 86400 });
		return c.json({ message: 'Scan initiated', data: record, cached: false });
	} catch (err) {
		console.error('Submit:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// GET /api/scan/check?url=...
app.get('/api/scan/check', async (c) => {
	try {
		const rawUrl = c.req.query('url');
		if (!rawUrl) return c.json({ error: 'url param required' }, 400);

		let targetUrl: string;
		try { targetUrl = new URL(rawUrl).href; }
		catch { return c.json({ error: 'Invalid URL format' }, 400); }

		const key = kvKey(targetUrl);
		const record = await c.env.KV.get<ScanRecord>(key, 'json');
		if (!record) return c.json({ error: 'No scan found. Submit first.' }, 404);
		if (record.status === 'completed') return c.json({ message: 'Scan completed', data: record });

		const upstream = await fetch(`${cfBase(c.env.CLOUDFLARE_ACCOUNT_ID)}/result/${record.uuid}`, {
			headers: authH(c.env.CLOUDFLARE_API_TOKEN),
		});

		// CF API returns 404 while scanning, 200 when done (per docs)
		if (upstream.status === 404) return c.json({ message: 'Scan is still processing…', data: record }, 202);
		if (!upstream.ok) return c.json({ error: 'Upstream error', status: upstream.status }, 502);

		const cfResult = await upstream.json() as any;
		record.status = 'completed';
		record.result = cfResult.result ?? cfResult;
		await c.env.KV.put(key, JSON.stringify(record), { expirationTtl: 86400 });
		return c.json({ message: 'Scan completed', data: record });
	} catch (err) {
		console.error('Check:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// GET /api/scan/uuid/:uuid — fetch result directly (for search results)
app.get('/api/scan/uuid/:uuid', async (c) => {
	try {
		const { uuid } = c.req.param();
		const upstream = await fetch(`${cfBase(c.env.CLOUDFLARE_ACCOUNT_ID)}/result/${uuid}`, {
			headers: authH(c.env.CLOUDFLARE_API_TOKEN),
		});

		if (upstream.status === 404) return c.json({ message: 'Still processing or not found' }, 202);
		if (!upstream.ok) return c.json({ error: 'Upstream error' }, 502);

		const cfResult = await upstream.json() as any;
		const result = cfResult.result ?? cfResult;
		return c.json({
			message: 'Scan loaded',
			data: { uuid, status: 'completed', url: result?.task?.url ?? result?.page?.url ?? '', timestamp: Date.now(), result },
		});
	} catch (err) {
		console.error('UUID fetch:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// GET /api/scan/search?q=...&limit=10&page=1
app.get('/api/scan/search', async (c) => {
	try {
		const q = c.req.query('q') ?? '';
		const limit = c.req.query('limit') ?? '10';
		const page = c.req.query('page') ?? '1';

		const params = new URLSearchParams();
		if (q) params.set('q', q);
		params.set('limit', limit);
		params.set('page', page);

		const res = await fetch(`${cfBase(c.env.CLOUDFLARE_ACCOUNT_ID)}/search?${params}`, {
			headers: authH(c.env.CLOUDFLARE_API_TOKEN),
		});

		if (!res.ok) {
			const err = await res.text();
			return c.json({ error: 'Search failed', details: err }, 502);
		}

		return c.json(await res.json());
	} catch (err) {
		console.error('Search:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// GET /api/scan/screenshot/:uuid?resolution=desktop
app.get('/api/scan/screenshot/:uuid', async (c) => {
	try {
		const { uuid } = c.req.param();
		const resolution = c.req.query('resolution') ?? 'desktop';

		const res = await fetch(
			`${cfBase(c.env.CLOUDFLARE_ACCOUNT_ID)}/screenshots/${uuid}?resolution=${resolution}`,
			{ headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` } }
		);

		if (!res.ok) return c.json({ error: 'Screenshot not available' }, 404);
		const buf = await res.arrayBuffer();
		return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
	} catch (err) {
		console.error('Screenshot:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// POST /api/screenshot — Browser Rendering fallback
app.post('/api/screenshot', async (c) => {
	try {
		const { url } = await c.req.json() as { url?: string };
		if (!url) return c.json({ error: 'URL is required' }, 400);

		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/screenshot`,
			{
				method: 'POST',
				headers: authH(c.env.CLOUDFLARE_API_TOKEN),
				body: JSON.stringify({ url, screenshotOptions: { fullPage: false }, viewport: { width: 1280, height: 720 } }),
			}
		);

		if (!res.ok) return c.json({ error: 'Capture failed' }, res.status as any);
		const buf = await res.arrayBuffer();
		return new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
	} catch (err) {
		console.error('Browser rendering:', err);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

export default app;
