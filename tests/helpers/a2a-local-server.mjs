/**
 * A local HTTP server for driving /api/a2a with the official A2A SDK clients
 * (tests/a2a-official-sdk.test.mjs, scripts/a2a-sdk-check). It serves:
 *   GET  /.well-known/agent-card.json  the real card, with every
 *        https://pg1-ai-agent.vercel.app URL pointed at this server
 *   POST /api/a2a                      the real handler (api/a2a.mjs)
 * through a minimal Vercel-style req/res adapter (parsed JSON body,
 * res.status().json(), res.setHeader(), res.end()).
 *
 * Usage: const srv = await startA2aServer(); ...; await srv.close();
 * Run standalone: node tests/helpers/a2a-local-server.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_ORIGIN = 'https://pg1-ai-agent.vercel.app';

function adaptResponse(nodeRes) {
  const res = {
    statusCode: 200,
    setHeader(name, value) { nodeRes.setHeader(name, value); return res; },
    getHeader(name) { return nodeRes.getHeader(name); },
    status(code) { res.statusCode = code; return res; },
    json(body) {
      nodeRes.statusCode = res.statusCode;
      nodeRes.setHeader('Content-Type', 'application/json');
      nodeRes.end(JSON.stringify(body));
      return res;
    },
    send(body) { nodeRes.statusCode = res.statusCode; nodeRes.end(body); return res; },
    end(body) { nodeRes.statusCode = res.statusCode; nodeRes.end(body); return res; }
  };
  return res;
}

// A local stand-in for the x402 facilitator (production uses CDP, which needs
// credentials): it only lists the supported kind, so the gate can build the
// real x402 v2 PaymentRequired. Nothing is ever verified or settled here.
const LOCAL_FACILITATOR = () => ({
  getSupported: async () => ({ kinds: [{ x402Version: 2, network: 'eip155:8453', scheme: 'exact' }] }),
  verify: async () => ({ isValid: false, invalidReason: 'local_test_server' }),
  settle: async () => ({ success: false, errorReason: 'local_test_server' })
});

export const LOCAL_PAY_TO = '0x000000000000000000000000000000000000dEaD';

export async function startA2aServer({ port = 0, host = '127.0.0.1' } = {}) {
  // Read once when api/mcp.mjs loads, so it is set before the import.
  if (!process.env.X402_PAY_TO_ADDRESS) process.env.X402_PAY_TO_ADDRESS = LOCAL_PAY_TO;
  const mcp = await import('../../api/mcp.mjs');
  mcp.__setX402FacilitatorForTests(LOCAL_FACILITATOR);
  const { default: handler } = await import('../../api/a2a.mjs');
  const cardText = fs.readFileSync(path.join(ROOT, 'public/.well-known/agent-card.json'), 'utf8');
  let base = '';
  const server = http.createServer(async (nodeReq, nodeRes) => {
    try {
      const url = new URL(nodeReq.url, base);
      if (nodeReq.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
        nodeRes.setHeader('Content-Type', 'application/json');
        nodeRes.end(cardText.split(PUBLIC_ORIGIN).join(base));
        return;
      }
      if (url.pathname !== '/api/a2a') {
        nodeRes.statusCode = 404;
        nodeRes.end('not found');
        return;
      }
      const chunks = [];
      for await (const chunk of nodeReq) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      const req = {
        method: nodeReq.method,
        url: nodeReq.url,
        headers: nodeReq.headers,
        query: Object.fromEntries(url.searchParams),
        body,
        socket: nodeReq.socket,
        connection: nodeReq.socket
      };
      await handler(req, adaptResponse(nodeRes));
    } catch (err) {
      nodeRes.statusCode = 500;
      nodeRes.end(String(err && err.message));
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  base = `http://${host}:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const srv = await startA2aServer({ port: Number(process.argv[2] || 0) });
  console.log(srv.base);
}
