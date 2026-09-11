import { describe, expect, it, vi } from 'vitest';
import { createZeishSandboxClient } from './zeish-sandbox-client';

const sandbox = {
  id: 'sandbox-1',
  organizationId: 'org-1',
  name: 'Arin run',
  slug: 'arin-run',
  labels: { arin_run_id: 'run-1' },
  status: 'running' as const,
  driver: 'firecracker' as const,
  region: 'bremen',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};
const rpcSandbox = { ...sandbox, statusRaw: 'running' };

const rpcResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('createZeishSandboxClient', () => {
  it('uses the control plane and scoped data-plane credentials for an agent run', async () => {
    const actions: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url, init) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/CreateSandbox')) {
        expect(init).toMatchObject({ method: 'POST' });
        return Promise.resolve(rpcResponse({ sandbox: rpcSandbox }));
      }
      if (requestUrl.includes('/GetSandboxAccess')) {
        return Promise.resolve(
          rpcResponse({
              sandboxRpcUrl: 'https://sandbox-rpc.example',
              token: 'session-token',
              expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        );
      }
      if (requestUrl === 'https://sandbox-rpc.example/files/write?path=work%2Finput.txt') {
        expect(init).toMatchObject({
          method: 'PUT',
          body: 'hello',
          headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (requestUrl === 'https://sandbox-rpc.example/files/download?path=work%2Finput.txt') {
        return Promise.resolve(new Response('hello', { status: 200 }));
      }
      if (requestUrl === 'https://sandbox-rpc.example/screenshot') {
        return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }));
      }
      if (requestUrl === 'https://sandbox-rpc.example/action') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        });
        actions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });
    const client = createZeishSandboxClient({
      apiKey: 'zeish_live_test',
      baseUrl: 'https://cloud.example/api/v1',
      createIdempotencyKey: () => 'request-1',
      fetch,
    });

    const session = await client.create({
      name: 'Arin run',
      templateId: 'arin-browser-template',
      metadata: { arinRunId: 'run-1' },
    });

    await session.files.writeText('work/input.txt', 'hello');
    await expect(session.files.readText('work/input.txt')).resolves.toBe('hello');
    await expect(session.desktop.screenshot()).resolves.toEqual(Buffer.from([137, 80, 78, 71]));
    await session.desktop.move(32, 48);
    await session.desktop.click({ x: 32, y: 48, button: 'left', clicks: 2 });
    await session.desktop.scroll({ x: 32, y: 48, deltaX: 1, deltaY: -2 });
    await session.desktop.type('hello');
    await session.desktop.key('ENTER');

    expect(session.details()).toEqual(sandbox);
    expect(actions).toEqual([
      { type: 'move', x: 32, y: 48 },
      { type: 'click', x: 32, y: 48, button: 'left', clicks: 2 },
      { type: 'scroll', x: 32, y: 48, delta_x: 1, delta_y: -2 },
      { type: 'type', text: 'hello' },
      { type: 'key', key: 'ENTER' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('rejects an unsuccessful desktop action response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/GetSandboxAccess')) {
        return Promise.resolve(rpcResponse({
          sandboxRpcUrl: 'https://sandbox-rpc.example',
          token: 'session-token', expiresAt: '2099-01-01T00:00:00.000Z',
        }));
      }
      if (requestUrl.includes('/GetSandbox')) {
        return Promise.resolve(rpcResponse({ sandbox: rpcSandbox }));
      }
      if (requestUrl === 'https://sandbox-rpc.example/action') {
        return Promise.resolve(new Response(JSON.stringify({ success: false }), { status: 200 }));
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });
    const session = await createZeishSandboxClient({ apiKey: 'zeish_live_test', fetch }).get('sandbox-1');

    await expect(session.desktop.key('ESC')).rejects.toThrow('unsuccessful response');
  });

  it('keeps sandbox-scoped lifecycle and snapshot actions on the session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/StartSandbox')) {
        return Promise.resolve(rpcResponse({ sandbox }));
      }
      if (requestUrl.includes('/GetSandbox')) {
        return Promise.resolve(rpcResponse({ sandbox: rpcSandbox }));
      }
      if (requestUrl.includes('/CreateSnapshot')) {
        return Promise.resolve(
          rpcResponse({
              snapshot: {
                id: 'snapshot-1',
                sandboxId: 'sandbox-1',
                displayName: 'before-run',
                status: 'ready',
                createdAt: '2026-08-06T00:00:00.000Z',
              },
          }),
        );
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });
    const client = createZeishSandboxClient({
      apiKey: 'zeish_live_test',
      createIdempotencyKey: () => 'request-1',
      fetch,
    });
    const session = await client.get('sandbox-1');

    await session.start();
    await expect(session.createSnapshot('before-run')).resolves.toMatchObject({
      id: 'snapshot-1',
      sandboxId: 'sandbox-1',
    });
  });
});
