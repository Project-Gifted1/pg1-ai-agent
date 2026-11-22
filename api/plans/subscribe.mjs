// GET /api/plans/subscribe?plan=builder|team (1.23.0): sends the browser to
// the card checkout for that plan. The checkout pages are set in Vercel
// (PG1_CHECKOUT_URL_BUILDER, PG1_CHECKOUT_URL_TEAM; docs/pricing-setup.md),
// so /pricing never hard-codes a payment provider. Without one set, a plain
// "not open yet" page.

export const CHECKOUT_ENV = Object.freeze({ builder: 'PG1_CHECKOUT_URL_BUILDER', team: 'PG1_CHECKOUT_URL_TEAM' });

export function checkoutUrl(plan, env = process.env) {
  const name = CHECKOUT_ENV[plan];
  if (!name) return null;
  const raw = String(env[name] || '').trim();
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch (e) {
    return null;
  }
}

export default function subscribeHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams);
  const plan = String(q.plan || '').toLowerCase();
  if (!CHECKOUT_ENV[plan]) return res.status(400).json({ error: 'invalid_plan', message: 'plan must be builder or team.', pricing_url: 'https://pg1-ai-agent.vercel.app/pricing' });
  const url = checkoutUrl(plan);
  if (!url) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not open yet</title><body style="background:#0a0a0b;color:#ececee;font-family:system-ui,sans-serif;padding:1rem;line-height:1.6"><p>Card payment for this plan is not open yet. Meanwhile, <a style="color:#ffd84d" href="/keys">get a free key</a> (500 checks a day) or see <a style="color:#ffd84d" href="/pricing">pricing</a>.</p></body>');
  }
  res.setHeader('Location', url);
  return res.status(302).end();
}
