import { defineProvider } from '@computesdk/provider';
import type {
  CommandResult,
  CreateSandboxOptions,
  FileEntry,
  RunCommandOptions,
  SandboxInfo,
} from '@computesdk/provider';
import { runSandboxdCommand } from './sandboxd-grpc';
import { createZeishApi, ZeishApiError } from './public-api';
import { createConnectSandboxApi } from './connect-sandbox-api';
import { createZeishSandboxClient } from './zeish-sandbox-client';
import type {
  ZeishCreateSandboxOptions,
  ZeishConfig,
  ZeishFileList,
  ZeishFileStat,
  ZeishManagedSandbox,
} from './zeish.types';

const ZEISH_REGION = 'bremen' as const;

type ZeishProviderCreateSandboxOptions = CreateSandboxOptions &
  Pick<ZeishCreateSandboxOptions, 'ingress'>;

async function access(
  sandbox: ZeishManagedSandbox
): Promise<NonNullable<ZeishManagedSandbox['access']>> {
  if (sandbox.access && new Date(sandbox.access.expiresAt).getTime() - Date.now() > 30_000) {
    return sandbox.access;
  }

  sandbox.access = await createConnectSandboxApi(sandbox.config).getExecAccess(sandbox.id);
  return sandbox.access;
}

async function fileRequest(
  sandbox: ZeishManagedSandbox,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const session = await access(sandbox);
  const fetchImpl = sandbox.config.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('A Fetch API implementation is required to use the Zeish filesystem API.');
  const response = await fetchImpl(`${session.sandboxUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session.token}`, ...init?.headers },
  });
  if (!response.ok) throw new Error(`Zeish sandbox filesystem ${response.status}: ${await response.text()}`);
  return response;
}

function managedSandbox(
  config: ZeishConfig,
  sandbox: Omit<ZeishManagedSandbox, 'config' | 'access'>
): ZeishManagedSandbox {
  return { ...sandbox, config };
}

async function listAllSandboxes(config: ZeishConfig): Promise<ZeishManagedSandbox[]> {
  const api = createConnectSandboxApi(config);
  const sandboxes: ZeishManagedSandbox[] = [];

  for await (const sandbox of api.iterateSandboxes({ limit: 100 })) {
    sandboxes.push(managedSandbox(config, sandbox));
  }

  return sandboxes;
}

export const zeish = defineProvider<ZeishManagedSandbox, ZeishConfig>({
  name: 'zeish',
  methods: {
    sandbox: {
        create: async (config, options?: CreateSandboxOptions) => {
        const ingress = (options as ZeishProviderCreateSandboxOptions | undefined)?.ingress;
        const templateId = options?.templateId ?? config.defaultTemplateId;
          if (!templateId) {
          throw new Error('Zeish requires a templateId. Pass sandbox.create({ templateId }) or set defaultTemplateId in the Zeish config.');
          }
          if (options?.region && options.region !== ZEISH_REGION) {
            throw new Error(`Zeish supports only the ${ZEISH_REGION} region.`);
          }
          const sandbox = await createConnectSandboxApi(config).createSandbox({
          name: options?.name ?? 'Zeish sandbox',
          templateId,
          ...(options?.cpu !== undefined ? { cpu: options.cpu } : {}),
          ...(options?.memory !== undefined ? { memory: options.memory } : {}),
            region: options?.region ?? ZEISH_REGION,
          ...(options?.metadata ? { metadata: options.metadata } : {}),
          ...(ingress ? { ingress } : {}),
        });
        return { sandbox: managedSandbox(config, sandbox), sandboxId: sandbox.id };
      },
      getById: async (config, sandboxId) => {
        try {
          const sandbox = await createConnectSandboxApi(config).getSandbox(sandboxId);
          return { sandbox: managedSandbox(config, sandbox), sandboxId };
        } catch (error) {
          if (!(error instanceof ZeishApiError) || error.status !== 404) throw error;
          return null;
        }
      },
      list: async config =>
        (await listAllSandboxes(config)).map(sandbox => ({ sandbox, sandboxId: sandbox.id })),
      destroy: async (config, sandboxId) => {
        await createConnectSandboxApi(config).destroySandbox(sandboxId);
      },
      runCommand: async (sandbox, command, options?: RunCommandOptions): Promise<CommandResult> =>
        runSandboxdCommand({
          access: await access(sandbox),
          command,
          ...(options ? { options } : {}),
        }),
      getInfo: async sandbox => ({
        id: sandbox.id,
        provider: 'zeish',
        status:
          sandbox.status === 'failed'
            ? 'error'
            : sandbox.status === 'stopped' || sandbox.status === 'paused'
              ? 'stopped'
              : 'running',
        createdAt: new Date(sandbox.createdAt),
      }) as SandboxInfo,
      getUrl: async (sandbox, options) =>
        (await createConnectSandboxApi(sandbox.config).createPreviewCode(sandbox.id, { port: options.port }))
          .url,
      filesystem: {
        readFile: async (sandbox, path): Promise<string> =>
          (await fileRequest(sandbox, `/files/download?path=${encodeURIComponent(path)}`)).text(),
        writeFile: async (sandbox, path, content): Promise<void> => {
          await fileRequest(sandbox, `/files/write?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            body: content,
          });
        },
        mkdir: async (sandbox, path): Promise<void> => {
          await fileRequest(sandbox, `/files/mkdir?path=${encodeURIComponent(path)}`, {
            method: 'POST',
          });
        },
        readdir: async (sandbox, path): Promise<FileEntry[]> => {
          const response = await fileRequest(sandbox, `/files?path=${encodeURIComponent(path)}`);
          const payload = (await response.json()) as ZeishFileList;
          return payload.entries.map(entry => ({
            name: entry.name,
            type: entry.is_dir ? 'directory' : 'file',
            size: entry.size,
            modified: new Date(entry.modified),
          }));
        },
        exists: async (sandbox, path): Promise<boolean> => {
          const response = await fileRequest(sandbox, `/files/stat?path=${encodeURIComponent(path)}`);
          return ((await response.json()) as ZeishFileStat).exists;
        },
        remove: async (sandbox, path): Promise<void> => {
          await fileRequest(sandbox, `/files/remove?path=${encodeURIComponent(path)}`, {
            method: 'POST',
          });
        },
      },
      getInstance: sandbox => sandbox,
    },
    snapshot: {
      create: async (config, sandboxId, options) => {
        const snapshot = await createConnectSandboxApi(config).createSnapshot(
          sandboxId,
          options?.name ?? 'snapshot',
        );
        return {
          id: snapshot.id,
          provider: 'zeish',
          createdAt: new Date(snapshot.createdAt),
        };
      },
      list: async () => [],
      delete: async () => {
        throw new Error('Zeish snapshots are sandbox-scoped; delete them through the sandbox Connect RPC.');
      },
    },
  },
});

export { createZeishApi, ZeishApiError } from './public-api';
export { createConnectSandboxApi } from './connect-sandbox-api';
export { createConnectResourceApi } from './connect-resource-api';
export { createConnectSshApi } from './connect-ssh-api';
export { FetchZeishTransport, createZeishTransport, withTransientRetry } from './transport';
export { serializeSandboxAction } from './sandbox-actions';
export { createZeishSandboxClient } from './zeish-sandbox-client';
export type * from './zeish-sandbox-client.types';
export type * from './zeish.types';

export {
  CHROME_CDP_PORT,
  PREVIEW_CODE_TTL_AGENT,
  PREVIEW_CODE_TTL_DEFAULT,
  PREVIEW_CODE_TTL_MAX,
  PREVIEW_CODE_TTL_MIN,
  SANDBOX_ATTACH_MAX_ATTEMPTS,
  SANDBOX_READY_POLL_MS,
  SANDBOX_READY_TIMEOUT_MS,
  TUNNEL_ACCESS_TTL_AGENT,
  TUNNEL_ACCESS_TTL_DEFAULT,
  TUNNEL_ACCESS_TTL_MAX,
  TUNNEL_ACCESS_TTL_MIN,
  clampPreviewTtlSeconds,
  clampTunnelTtlSeconds,
} from './constants';

export {
  fetchPreviewJsonVersion,
  normalizePreviewCode,
  previewAuthHeaders,
  previewOriginFromHandoffUrl,
  resolveCdpEndpoint,
  rewriteCdpWebSocketUrl,
  withPreviewAccessToken,
} from './preview-access';
export type { ZeishPreviewCodeRaw } from './preview-access';

export { createCdpTunnelBridge, createTunnelBridge } from './tunnel-bridge';
export type { CdpTunnelBridge, TunnelBridge, TunnelBridgeOptions } from './tunnel-bridge';

export {
  isHealthySandboxStatus,
  assertSandboxTransition,
  canTransitionSandbox,
  isRunningSandboxStatus,
  isStartupSandboxStatus,
  isTerminalSandboxStatus,
  normalizeSandboxStatus,
} from './sandbox-status';

export {
  createAndStartSandbox,
  destroySandboxBestEffort,
  waitUntilRunning,
} from './sandbox-lifecycle';
export type {
  CreateAndStartOptions,
  WaitUntilRunningOptions,
} from './sandbox-lifecycle';
