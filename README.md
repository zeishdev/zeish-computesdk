# Zeish ComputeSDK provider

An open-source ComputeSDK provider for Zeish. It implements sandbox lifecycle,
preview URLs, streaming command execution, snapshot creation, and direct
sandboxd filesystem operations.

```ts
import { zeish } from '@zeish/computesdk-provider';
const compute = zeish({ apiKey: process.env.ZEISH_API_KEY! });
```

New `zeish_live_…` keys are standalone and need no extra identity headers.
The optional `externalIdentity` setting only supports legacy Arin-bound keys.

## Status

This is an early provider release. Control-plane sandbox operations use Zeish
Connect RPC; `runCommand()` streams sandboxd stdout and
stderr callbacks through `ExecStream`; the deployed data plane must include
the control plane's matching gRPC route before it can be used in production.

ComputeSDK's provider interface has no sandbox-scoped snapshot-list/delete
operation, while Zeish intentionally keeps those snapshot endpoints
sandbox-scoped. Those two methods therefore remain unavailable through the
provider; use the first-party `createZeishSandboxClient()` for them.

## First-party sandbox client

`createZeishSandboxClient()` is the provider-neutral integration interface for
agents such as Arin. It keeps the control plane and sandboxd data plane
together: create a sandbox, wait for scoped access, then use commands, files,
lifecycle operations, logs, events, previews, sandbox-scoped snapshots, and
guest display actions from one session object.

```ts
import { createZeishSandboxClient } from '@zeish/computesdk-provider';

const sandboxClient = createZeishSandboxClient({
  apiKey: process.env.ZEISH_API_KEY!,
  defaultTemplateId: process.env.ARIN_SANDBOX_TEMPLATE!,
});

const sandbox = await sandboxClient.create({
  name: `arin-run-${runId}`,
  templateId: process.env.ARIN_SANDBOX_TEMPLATE!,
  metadata: { arinRunId: runId, arinAgentId: agentId },
});

await sandbox.waitForAccess();
const result = await sandbox.run('node worker.js', {
  workingDirectory: '/workspace',
  onStdout: writeRunLog,
  onStderr: writeRunLog,
});
await sandbox.files.writeText('/workspace/input.json', JSON.stringify(input));
const png = await sandbox.desktop.screenshot();
await sandbox.desktop.move(340, 210);
await sandbox.desktop.click({ x: 340, y: 210 });
await sandbox.desktop.type('hello');
await sandbox.desktop.key('ENTER');
await sandbox.destroy();
```

Sandboxes are provisioned in the `bremen` region. The SDK supplies that
region when it is omitted and rejects other regions before making a request.
The created sandbox includes the user's active SSH keys, and its detail
response exposes the SSH command once the runtime is started.

`desktop` calls sandboxd's authenticated native Wayland display endpoints.
It supports screenshots plus move, click, scroll, text, and named key actions
through the desktop-agentd privilege boundary; X11 and Xwayland are not
required.

## Agent / CDP contracts (prevents common 400s)

Helpers encode control-plane rules so clients do not rediscover them:

```ts
import {
  createZeishApi,
  createAndStartSandbox,
  waitUntilRunning,
  isTerminalSandboxStatus,
  PREVIEW_CODE_TTL_AGENT,
  CHROME_CDP_PORT,
  clampPreviewTtlSeconds,
} from '@zeish/computesdk-provider';

const api = createZeishApi({ apiKey: process.env.ZEISH_API_KEY! });

// create → start → wait; destroy + retry on status failed
const sandbox = await createAndStartSandbox(api, {
  name: 'agent-run',
  templateId: process.env.ZEISH_TEMPLATE_ID!,
  ingress: [
    {
      mode: 'raw_l4',
      protocol: 'tcp',
      internalPort: CHROME_CDP_PORT,
    },
  ], // 9222 for Chromium CDP; ingress is org-scoped by default
  labels: { arin: '1' },
}, {
  // Share selected declared ports globally after the runtime is ready.
  publicPorts: [CHROME_CDP_PORT],
});

// ttl_seconds is clamped client-side to the control plane's max (1..3600)
const preview = await api.createPreviewCode(sandbox.id, {
  port: CHROME_CDP_PORT,
  ttl_seconds: PREVIEW_CODE_TTL_AGENT,
});

// The control plane returns base_url + handoff_url; SDK exposes baseUrl + headers.
// Agents / Playwright: never use preview.url as an HTTP base.
const version = await fetch(`${preview.baseUrl}/json/version`, {
  headers: preview.headers,
});
// or: fetchPreviewJsonVersion(preview)
// connectOverCDP(wsUrl, { headers: preview.headers })
```

| Rule | Helper / constant |
|---|---|
| `ttl_seconds` 1..3600 | `clampPreviewTtlSeconds`, auto-clamp in `createPreviewCode` |
| Terminal includes **`failed`** | `isTerminalSandboxStatus` |
| Flaky create | `createAndStartSandbox` (destroy + retry) |
| Generic ingress | `ingress: [{ mode: 'raw_l4', protocol: 'tcp', internalPort: CHROME_CDP_PORT }]` |
| Preview auth | Control plane `base_url` + `code` → SDK `baseUrl` + `headers` |

Runtime services expose protocol-aware endpoints. HTTP/WebSocket services have
`url`; native UDP services have `transport: 'udp'`, `host`, and `port` instead
of an `https://...-udp...` URL.

### Public ports

Public port exposure is independent of preview-code TTL. Declare it while
creating a sandbox with `ingress`, or add it after the sandbox is running:

```ts
const sandbox = await api.createSandbox({
  name: 'web-app',
  templateId: process.env.ZEISH_TEMPLATE_ID!,
  ingress: [
    { mode: 'raw_l4', protocol: 'tcp', internalPort: 3000 }, // org-scoped (default)
    { mode: 'raw_l4', protocol: 'tcp', internalPort: 8080, accessPolicy: 'public' },
  ],
});

// For an already-running sandbox - org-scoped by default, or public in the
// same call:
await api.addPort(sandbox.id, { internalPort: 8081, protocol: 'tcp' });
await api.addPort(sandbox.id, { internalPort: 8082, protocol: 'tcp', accessPolicy: 'public' });

// To change an existing port's tier:
await api.sharePort(sandbox.id, 8081, 'public');
```

The resulting service metadata is returned by the control plane in the sandbox response.
There are exactly two access tiers, set per port via `ingress[].accessPolicy`,
`addPort`, or `sharePort`:

- **`org`** (the default): the service URL carries a short-lived signed
  handoff token, opens without an interactive login, and **rejects tokens
  from other organizations**. There is no separate cross-org "private" tier -
  a bare private route in proxyd is reachable by any valid fleet JWT, so a
  legacy `'private'` is normalized to `'org'`.
- **`public`**: no authentication at all - reachable by anyone who knows the
  URL.

### Preview auth (control-plane public API + proxyd)

Contract source of truth: the control plane's `PreviewCode` (`base_url`, `handoff_url`, `code`).

| Field / helper | Use |
|---|---|
| `preview.url` / `handoffUrl` | Open in a **browser** (single-use cookie handoff) |
| `preview.baseUrl` | From the control plane's `base_url` — `/json/version` and other HTTP paths |
| `preview.headers` / `token` | `Authorization: Bearer` (HTTP) or `?token=` (WebSocket) |
| `fetchPreviewJsonVersion(preview)` | Authenticated GET of Chrome `/json/version` |
| `resolveCdpEndpoint({ preview, webSocketDebuggerUrl })` | Ready `wsUrl` + `headers` for Playwright |

`ZeishApiError` exposes `code`, `details`, and `isValidationError` for structured control-plane envelopes.

## License

MIT
