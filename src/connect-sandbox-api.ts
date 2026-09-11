import {
  Code,
  ConnectError,
  createClient,
  type CallOptions,
  type Client,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import * as sandboxControl from "./gen/zeish/sandbox/control/v1/control_pb.js";
import { clampPreviewTtlSeconds, clampTunnelTtlSeconds } from "./constants";
import { normalizePreviewCode } from "./preview-access";
import { ZeishApiError } from "./public-api";
import type {
  ZeishAccess,
  ZeishAddSandboxPortInput,
  ZeishConfig,
  ZeishCreatePreviewCodeInput,
  ZeishCreateSandboxInput,
  ZeishCreateTunnelAccessInput,
  ZeishListEventsOptions,
  ZeishListLogsOptions,
  ZeishLogEntry,
  ZeishPreviewCode,
  ZeishSandbox,
  ZeishSandboxEvent,
  ZeishSandboxPage,
  ZeishSnapshot,
  ZeishTerminalUrlResponse,
  ZeishTunnelAccess,
  ZeishPublicApiErrorCode,
  ZeishUpdateSandboxInput,
} from "./zeish.types";

type SandboxRpcClient = Client<typeof sandboxControl.SandboxControlService>;

function rpcBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/api\/v\d+\/?$/, "").replace(/\/+$/, "")}/rpc`;
}

function connectStatus(error: ConnectError): number {
  const statuses: Record<number, number> = {
    [Code.InvalidArgument]: 400,
    [Code.Unauthenticated]: 401,
    [Code.PermissionDenied]: 403,
    [Code.NotFound]: 404,
    [Code.Aborted]: 409,
    [Code.ResourceExhausted]: 429,
    [Code.Unavailable]: 503,
    [Code.DeadlineExceeded]: 504,
  };
  return statuses[error.code] ?? 500;
}

function callOptions(idempotencyKey?: string): CallOptions | undefined {
  return idempotencyKey
    ? { headers: { "Idempotency-Key": idempotencyKey } }
    : undefined;
}

function unwrap<T>(call: Promise<T>, method: string): Promise<T> {
  return call.catch((error) => {
    if (error instanceof ConnectError) {
      const code: Record<number, ZeishPublicApiErrorCode> = {
        [Code.InvalidArgument]: "invalid_request",
        [Code.Unauthenticated]: "authentication_required",
        [Code.PermissionDenied]: "permission_denied",
        [Code.NotFound]: "not_found",
        [Code.Aborted]: "conflict",
        [Code.ResourceExhausted]: "rate_limited",
      };
      throw new ZeishApiError(
        connectStatus(error),
        error.rawMessage,
        "POST",
        `/rpc/${method}`,
        {
          code: code[error.code] ?? "internal_error",
          message: error.rawMessage,
        },
      );
    }
    throw error;
  });
}

function sandboxFromProto(value: sandboxControl.Sandbox): ZeishSandbox {
  const status = value.statusRaw || "failed";
  return {
    id: value.id,
    organizationId: value.organizationId,
    name: value.name,
    slug: value.slug,
    labels: value.labels,
    status: status as ZeishSandbox["status"],
    ...(value.desiredStatusRaw
      ? { desiredStatus: value.desiredStatusRaw as ZeishSandbox["status"] }
      : {}),
    ...(value.templateId ? { templateId: value.templateId } : {}),
    ...(value.ingress.length
      ? {
          ingress: value.ingress.map((entry) => ({
            mode: entry.mode as "raw_l4",
            protocol:
              entry.protocol === sandboxControl.IngressProtocol.UDP
                ? "udp"
                : "tcp",
            internalPort: entry.internalPort,
            ...(entry.externalPort ? { externalPort: entry.externalPort } : {}),
            accessPolicy:
              entry.accessPolicy === sandboxControl.IngressAccessPolicy.PUBLIC
                ? "public"
                : "org",
          })),
        }
      : {}),
    driver:
      value.driver === sandboxControl.SandboxDriver.CLOUD_HYPERVISOR
        ? "cloud-hypervisor"
        : "firecracker",
    region: value.region,
    ...(value.previewUrl ? { previewUrl: value.previewUrl } : {}),
    ...(value.primaryDnsName ? { primaryDnsName: value.primaryDnsName } : {}),
    ...(value.lastError ? { lastError: value.lastError } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.runtime
      ? { runtime: { id: value.runtime.id, state: value.runtime.state } }
      : {}),
  };
}

function createClientFor(config: ZeishConfig): SandboxRpcClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl)
    throw new Error(
      "A Fetch API implementation is required for Zeish Connect RPC.",
    );
  const authInterceptor: Interceptor = (next) => (req) => {
    req.header.set("X-API-Key", config.apiKey);
    return next(req);
  };
  return createClient(
    sandboxControl.SandboxControlService,
    createConnectTransport({
      baseUrl: rpcBaseUrl(config.baseUrl ?? "https://api.dvito.cloud/api/v1"),
      fetch: fetchImpl,
      interceptors: [authInterceptor],
    }),
  );
}

export function createConnectSandboxApi(config: ZeishConfig) {
  const client = createClientFor(config);
  const listSandboxes = (options: { limit?: number; cursor?: string } = {}) =>
    unwrap(client.listSandboxes(options), "ListSandboxes").then(
      (response) =>
        ({
          data: response.sandboxes.map(sandboxFromProto),
          nextCursor: response.nextCursor || null,
        }) satisfies ZeishSandboxPage,
    );
  const lifecycle = (
    method:
      | "startSandbox"
      | "pauseSandbox"
      | "resumeSandbox"
      | "stopSandbox"
      | "killSandbox",
    id: string,
  ) => {
    switch (method) {
      case "startSandbox":
        return unwrap(client.startSandbox({ id }), method).then((response) =>
          sandboxFromProto(response.sandbox!),
        );
      case "pauseSandbox":
        return unwrap(client.pauseSandbox({ id }), method).then((response) =>
          sandboxFromProto(response.sandbox!),
        );
      case "resumeSandbox":
        return unwrap(client.resumeSandbox({ id }), method).then((response) =>
          sandboxFromProto(response.sandbox!),
        );
      case "stopSandbox":
        return unwrap(client.stopSandbox({ id }), method).then((response) =>
          sandboxFromProto(response.sandbox!),
        );
      case "killSandbox":
        return unwrap(client.killSandbox({ id }), method).then((response) =>
          sandboxFromProto(response.sandbox!),
        );
    }
  };

  return {
    createSandbox: (input: ZeishCreateSandboxInput, idempotencyKey?: string) =>
      unwrap(
        client.createSandbox(
          {
            name: input.name,
            templateId: input.templateId ?? input.template ?? "",
            region: input.region ?? "bremen",
            cpu: input.cpu ?? 0,
            memory: input.memory ?? 0,
            networkId: input.networkId ?? "",
            volumeIds: input.volumeIds ?? [],
            labels: input.labels ?? input.metadata ?? {},
            ingress: (input.ingress ?? []).map((entry) => ({
              mode: entry.mode,
              protocol:
                entry.protocol === "udp"
                  ? sandboxControl.IngressProtocol.UDP
                  : sandboxControl.IngressProtocol.TCP,
              internalPort: entry.internalPort,
              externalPort: entry.externalPort ?? 0,
              accessPolicy:
                entry.accessPolicy === "public"
                  ? sandboxControl.IngressAccessPolicy.PUBLIC
                  : sandboxControl.IngressAccessPolicy.ORG,
            })),
          },
          callOptions(idempotencyKey),
        ),
        "CreateSandbox",
      ).then((response) => sandboxFromProto(response.sandbox!)),
    getSandbox: (id: string) =>
      unwrap(client.getSandbox({ id }), "GetSandbox").then((response) =>
        sandboxFromProto(response.sandbox!),
      ),
    listSandboxes,
    async *iterateSandboxes(options: { limit?: number; cursor?: string } = {}) {
      let cursor = options.cursor;
      do {
        const page = await listSandboxes({
          ...options,
          ...(cursor ? { cursor } : {}),
        });
        yield* page.data;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    },
    updateSandbox: (id: string, input: ZeishUpdateSandboxInput) =>
      unwrap(
        client.updateSandbox({
          id,
          name: input.name ?? "",
          templateId: input.templateId ?? "",
          region: input.region ?? "",
          cpu: input.cpu ?? 0,
          memory: input.memory ?? 0,
          networkId: input.networkId ?? "",
          clearNetworkId: input.networkId === null,
          volumeIds: input.volumeIds ?? [],
          setVolumeIds: input.volumeIds !== undefined,
          labels: input.labels ?? {},
          setLabels: input.labels !== undefined,
        }),
        "UpdateSandbox",
      ).then((response) => sandboxFromProto(response.sandbox!)),
    syncSandboxSshKeys: (id: string) =>
      unwrap(client.syncSshKeys({ id }), "SyncSshKeys").then((response) =>
        sandboxFromProto(response.sandbox!),
      ),
    destroySandbox: (id: string) =>
      unwrap(client.deleteSandbox({ id }), "DeleteSandbox").then((response) =>
        sandboxFromProto(response.sandbox!),
      ),
    startSandbox: (id: string) => lifecycle("startSandbox", id),
    pauseSandbox: (id: string) => lifecycle("pauseSandbox", id),
    resumeSandbox: (id: string) => lifecycle("resumeSandbox", id),
    stopSandbox: (id: string) => lifecycle("stopSandbox", id),
    killSandbox: (id: string) => lifecycle("killSandbox", id),
    getExecAccess: (id: string) =>
      unwrap(client.getSandboxAccess({ id }), "GetSandboxAccess").then(
        (response) =>
          ({
            sandboxRpcUrl: response.sandboxRpcUrl,
            sandboxUrl: response.sandboxRpcUrl,
            token: response.token,
            expiresAt: response.expiresAt,
          }) satisfies ZeishAccess,
      ),
    getTerminalUrl: (id: string) =>
      unwrap(client.getTerminalUrl({ id }), "GetTerminalUrl").then(
        (response) =>
          ({ url: response.url || null }) satisfies ZeishTerminalUrlResponse,
      ),
    createPreviewCode: (id: string, input: ZeishCreatePreviewCodeInput = {}) =>
      unwrap(
        client.createPreviewCode({
          id,
          port: input.port ?? 0,
          path: input.path ?? "",
          ttlSeconds: clampPreviewTtlSeconds(input.ttl_seconds),
        }),
        "CreatePreviewCode",
      ).then((response) =>
        normalizePreviewCode({
          url: response.url,
          code: response.code,
          expires_at: response.expiresAt,
          base_url: response.baseUrl,
          handoff_url: response.handoffUrl,
        }),
      ),
    createTunnelAccess: (
      id: string,
      input: ZeishCreateTunnelAccessInput = {},
    ) =>
      unwrap(
        client.createTunnelAccess({
          id,
          ttlSeconds: clampTunnelTtlSeconds(input.ttl_seconds),
        }),
        "CreateTunnelAccess",
      ).then(
        (response) =>
          ({
            wsUrl: response.wsUrl,
            token: response.token,
            expiresAt: response.expiresAt,
          }) satisfies ZeishTunnelAccess,
      ),
    addPort: (id: string, input: ZeishAddSandboxPortInput) =>
      unwrap(
        client.addPort({
          id,
          internalPort: input.internalPort,
          externalPort: input.externalPort ?? 0,
          protocol:
            input.protocol === "udp"
              ? sandboxControl.IngressProtocol.UDP
              : sandboxControl.IngressProtocol.TCP,
          accessPolicy:
            input.accessPolicy === "public"
              ? sandboxControl.IngressAccessPolicy.PUBLIC
              : sandboxControl.IngressAccessPolicy.ORG,
        }),
        "AddPort",
      ).then((response) => sandboxFromProto(response.sandbox!)),
    sharePort: (id: string, port: number, policy: "org" | "public") =>
      unwrap(client.sharePort({ id, port, policy }), "SharePort").then(
        (response) => sandboxFromProto(response.sandbox!),
      ),
    listLogs: (id: string, options: ZeishListLogsOptions = {}) =>
      unwrap(
        client.listLogs({
          id,
          limit: options.limit ?? 0,
          service: options.service ?? "",
          source: options.source ?? "",
        }),
        "ListLogs",
      ).then((response) => response.entries as ZeishLogEntry[]),
    listEvents: (id: string, options: ZeishListEventsOptions = {}) =>
      unwrap(
        client.listEvents({ id, limit: options.limit ?? 0 }),
        "ListEvents",
      ).then((response) => response.events as ZeishSandboxEvent[]),
    createSnapshot: (id: string, displayName: string) =>
      unwrap(client.createSnapshot({ id, displayName }), "CreateSnapshot").then(
        (response) => response.snapshot as unknown as ZeishSnapshot,
      ),
    listSnapshots: (id: string) =>
      unwrap(client.listSnapshots({ id }), "ListSnapshots").then(
        (response) => response.snapshots as unknown as ZeishSnapshot[],
      ),
    deleteSnapshot: (id: string, snapshotId: string) =>
      unwrap(client.deleteSnapshot({ id, snapshotId }), "DeleteSnapshot").then(
        () => ({ ok: true as const }),
      ),
  };
}
