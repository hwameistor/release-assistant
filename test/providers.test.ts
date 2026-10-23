import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CompatibleProvider, CopilotProvider } from '../src/providers.js';

test('compatible endpoint receives configured model, JSON schema and independent credential', async t => {
  let response: unknown = { choices: [{ finish_reason: 'stop', message: { content: '{"entries":[],"excluded":[]}' } }] };
  let status = 200;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer model-only-token');
    const body = JSON.parse(text); assert.equal(body.model, 'custom-model-v2'); assert.equal(body.response_format.type, 'json_schema');
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const provider = new CompatibleProvider({ provider: 'compatible', model: 'custom-model-v2', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, timeoutSeconds: 1 }, 'model-only-token');
  assert.deepEqual(await provider.generate('Analyze evidence', { type: 'object' }), { entries: [], excluded: [] });
  response = { choices: [{ finish_reason: 'length', message: { content: '{}' } }] };
  await assert.rejects(provider.generate('prompt', {}), /truncated/);
  response = { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] };
  await assert.rejects(provider.generate('prompt', {}), /invalid JSON/);
  response = { error: 'secret-model-only-token' }; status = 401;
  await assert.rejects(provider.generate('prompt', {}), error => error instanceof Error && error.message.includes('401') && !error.message.includes('secret'));
});

test('Copilot requires an explicit inference credential instead of falling back to publishing credentials', async () => {
  const provider = new CopilotProvider({ provider: 'copilot', model: 'configured', timeoutSeconds: 1 });
  await assert.rejects(provider.generate('prompt', {}), /COPILOT_GITHUB_TOKEN/);
});
