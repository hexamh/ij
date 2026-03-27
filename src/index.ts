import { Hono } from 'hono';

type Bindings = {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	BROWSER: Fetcher; // For the Live Screenshot Browser Rendering feature
};

const app = new Hono<{ Bindings: Bindings }>();

// Endpoint to trigger a new URL scan
app.post('/api/scan', async (c) => {
	const { url } = await c.req.json();
	
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/scan`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
		},
		body: JSON.stringify({ url })
	});

	if (!response.ok) {
		return c.json({ error: 'Failed to initiate scan' }, 500);
	}

	const data = await response.json();
	return c.json(data);
});

// Endpoint to fetch scan results by UUID
app.get('/api/scan/:uuid', async (c) => {
	const uuid = c.req.param('uuid');
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/scan/${uuid}`, {
		headers: {
			'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
		}
	});
	const data = await response.json();
	return c.json(data);
});

export default app;
