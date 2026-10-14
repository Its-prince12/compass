/* Compass Coach API: server-side proxy to Groq's free tier.
   The GROQ_API_KEY lives in a Vercel environment variable and never reaches
   the browser. Only the anonymized data summary the app builds (numbers, tags,
   patterns - no name, no journal unless the user opts in) is forwarded. */
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
const clamp = (s, n) => String(s == null ? '' : s).slice(0, n);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'Cloud AI is not set up yet. Add GROQ_API_KEY in the Vercel project settings (Environment Variables), then redeploy.'
    });
  }
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const system = clamp(body && body.system, 6000);
  let messages = Array.isArray(body && body.messages) ? body.messages : [];
  messages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)
    .map(m => ({ role: m.role, content: clamp(m.content, 2000) }));
  if (!messages.length || !system) {
    return res.status(400).json({ error: 'Missing messages or context' });
  }

  const payload = {
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: 600,
    temperature: 0.7
  };

  let lastErr = 'unknown error';
  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, model })
      });
      if (r.status === 404 || r.status === 429 || r.status === 529 || r.status >= 500) {
        lastErr = r.status === 404 ? 'that AI model is not available right now' : 'free tier is busy right now';
        continue; // try the next model
      }
      if (!r.ok) {
        lastErr = 'Groq returned an error (' + r.status + ')';
        break;
      }
      const j = await r.json();
      const reply = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!reply) {
        lastErr = 'empty reply from Groq';
        break;
      }
      return res.status(200).json({ reply: reply.trim(), model });
    } catch (e) {
      lastErr = 'could not reach Groq';
      break;
    }
  }
  return res.status(502).json({ error: "Couldn't get an answer: " + lastErr + '. Try again in a minute.' });
}
