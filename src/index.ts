import { Hono } from 'hono';

type Bindings = {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	KV: KVNamespace; // Bind the KV namespace
};

// Define our KV record structure
interface ScanRecord {
	url: string;
	uuid: string;
	status: 'pending' | 'completed';
	timestamp: number;
	result?: any;
}

const app = new Hono<{ Bindings: Bindings }>();

// Helper to safely encode URLs for KV keys
const getKvKey = (url: string) => `scan_data:${btoa(url)}`;

/**
 * 1. SUBMIT ENDPOINT
 * Initiates a new scan or returns an existing cached/pending scan.
 */
app.post('/api/scan/submit', async (c) => {
	try {
		const { url } = await c.req.json();
		if (!url) return c.json({ error: 'URL is required' }, 400);

		// Normalize URL
		let targetUrl: string;
		try {
			targetUrl = new URL(url).href;
		} catch {
			return c.json({ error: 'Invalid URL format' }, 400);
		}

		const kvKey = getKvKey(targetUrl);

		// 1a. Check KV for existing recent scan (Cache hit)
		const existingRecord = await c.env.KV.get<ScanRecord>(kvKey, 'json');
		if (existingRecord) {
			// If it's already there (either pending or completed), return it immediately
			return c.json({ 
				message: existingRecord.status === 'completed' ? 'Retrieved from cache' : 'Scan already in progress',
				data: existingRecord 
			});
		}

		// 1b. Initiate new scan via Cloudflare API
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/v2/scan`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`
			},
			body: JSON.stringify({ url: targetUrl, visibility: 'Public' })
		});

		if (!response.ok) {
			const errorText = await response.text();
			return c.json({ error: 'Failed to initiate scan', details: errorText }, response.status);
		}

		const data = await response.json() as any;
		
		// 1c. Create new record and store in KV (Expires in 24 hours to keep data fresh)
		const scanRecord: ScanRecord = {
			url: targetUrl,
			uuid: data.result.uuid,
			status: 'pending',
			timestamp: Date.now()
		};

		await c.env.KV.put(kvKey, JSON.stringify(scanRecord), { expirationTtl: 86400 });

		return c.json({ message: 'Scan initiated successfully', data: scanRecord });
	} catch (error) {
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

/**
 * 2. CHECK ENDPOINT
 * Retrieves the scan result from KV. If pending, checks upstream API and updates KV if completed.
 */
app.get('/api/scan/check', async (c) => {
	try {
		const rawUrl = c.req.query('url');
		if (!rawUrl) return c.json({ error: 'URL query parameter is required' }, 400);

		let targetUrl: string;
		try { targetUrl = new URL(rawUrl).href; } catch { return c.json({ error: 'Invalid URL format' }, 400); }

		const kvKey = getKvKey(targetUrl);
		const record = await c.env.KV.get<ScanRecord>(kvKey, 'json');

		// 2a. Handle not found
		if (!record) {
			return c.json({ error: 'No scan record found for this URL. Please submit it first.' }, 404);
		}

		// 2b. If already completed in KV, return immediately (Zero-latency cache hit)
		if (record.status === 'completed') {
			return c.json({ message: 'Scan completed', data: record });
		}

		// 2c. If still pending, check Cloudflare upstream
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/urlscanner/v2/result/${record.uuid}`, {
			headers: { 'Authorization': `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` }
		});

		if (!response.ok) {
			return c.json({ error: 'Upstream provider error fetching result' }, 502);
		}

		const resultData = await response.json() as any;

		// 2d. Determine if Cloudflare has finished processing
		// (Cloudflare URL scanner returns a specific payload when done, usually containing 'page' details)
		if (resultData.success && resultData.result && resultData.result.page) {
			record.status = 'completed';
			record.result = resultData.result; // Store the heavy payload
			
			// Persist the completed report to KV
			await c.env.KV.put(kvKey, JSON.stringify(record), { expirationTtl: 86400 });
			
			return c.json({ message: 'Scan completed', data: record });
		} else {
			// Still processing upstream
			return c.json({ message: 'Scan is still processing. Try again shortly.', data: record }, 202);
		}
	} catch (error) {
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});


// Endpoint for Live Screenshots (Unchanged)
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

	if (!response.ok) return c.json({ error: 'Failed to capture screenshot' }, response.status);
	const imageBuffer = await response.arrayBuffer();
	return new Response(imageBuffer, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }});
});

export default app;
