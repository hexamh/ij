import { Hono } from 'hono';

type Bindings = {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Endpoint to trigger a new URL scan
app.post('/api/scan', async (c) => {
	try {
		const { url } = await c.req.json();
		if (!url) return c.json({ error: 'URL is required' }, 400);

		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/v2/scan`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
			},
			body: JSON.stringify({ url, visibility: 'Public' })
		});

		if (!response.ok) {
			const errorText = await response.text();
			return c.json({ error: 'Failed to initiate scan', details: errorText }, response.status);
		}

		return c.json(await response.json());
	} catch (error) {
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// Endpoint to fetch scan results by UUID
app.get('/api/scan/:uuid', async (c) => {
	const uuid = c.req.param('uuid');
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/v2/result/${uuid}`, {
		headers: {
			'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
		}
	});
	return c.json(await response.json());
});

// Endpoint for Live Screenshots using Cloudflare Browser Rendering API
app.post('/api/screenshot', async (c) => {
	const { url } = await c.req.json();
	if (!url) return c.json({ error: 'URL is required' }, 400);

	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/screenshot`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
		},
		body: JSON.stringify({ 
			url: url,
			screenshotOptions: { fullPage: false },
			viewport: { width: 1280, height: 720 }
		})
	});

	if (!response.ok) {
		return c.json({ error: 'Failed to capture screenshot' }, response.status);
	}

	// Browser Rendering returns the image as a binary stream
	const imageBuffer = await response.arrayBuffer();
	return new Response(imageBuffer, {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=3600'
		}
	});
});

export default app;
