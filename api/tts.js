// In-memory rate limiter (resets on cold starts, which is fine for serverless)
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 10; // max 10 requests per window per IP

function getRateLimitInfo(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);

  // Clean up expired entries periodically
  if (rateLimit.size > 1000) {
    for (const [key, val] of rateLimit) {
      if (now - val.windowStart > RATE_LIMIT_WINDOW) rateLimit.delete(key);
    }
  }

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    const newEntry = { count: 1, windowStart: now };
    rateLimit.set(ip, newEntry);
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// Whitelist of allowed fields in the request body
const ALLOWED_FIELDS = new Set([
  'inputs', 'target_language_code', 'speaker',
  'pace', 'pitch', 'loudness', 'speech_sample_rate',
  'enable_preprocessing', 'model', 'sampleRate'
]);

// Allowed speakers
const ALLOWED_SPEAKERS = new Set([
  'anushka', 'arvind', 'meera', 'amol',
  'kore', 'diya', 'neel', 'maitreyi',
  'advika', 'abhilash'
]);

function sanitizeBody(body) {
  const sanitized = {};

  for (const key of Object.keys(body)) {
    if (ALLOWED_FIELDS.has(key)) {
      sanitized[key] = body[key];
    }
  }

  // Force Malayalam language — no overrides allowed
  sanitized.target_language_code = 'ml-IN';

  // Validate speaker
  if (!ALLOWED_SPEAKERS.has(sanitized.speaker)) {
    sanitized.speaker = 'anushka';
  }

  // Validate inputs is an array of strings
  if (!Array.isArray(sanitized.inputs) || sanitized.inputs.length === 0) {
    return null;
  }
  if (sanitized.inputs.some(i => typeof i !== 'string' || i.length > 5000)) {
    return null;
  }

  return sanitized;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  const limit = getRateLimitInfo(ip);

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
  res.setHeader('X-RateLimit-Remaining', limit.remaining);

  if (!limit.allowed) {
    res.setHeader('Retry-After', limit.retryAfter);
    return res.status(429).json({
      error: 'Too many requests. Please wait before trying again.',
      retryAfter: limit.retryAfter
    });
  }

  // Validate and sanitize input
  const sanitizedBody = sanitizeBody(req.body || {});
  if (!sanitizedBody) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': process.env.SARVAM_API_KEY,
      },
      body: JSON.stringify(sanitizedBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
