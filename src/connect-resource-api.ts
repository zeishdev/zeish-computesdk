import {
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import * as cloudResources from "./gen/zeish/cloud/control/v1/resources_pb.js";
import * as cloudTemplates from "./gen/zeish/cloud/control/v1/templates_pb.js";
import { ZeishApiError } from "./public-api";
import type {
  ZeishConfig,
  ZeishCreateNetworkInput,
  ZeishCreateVolumeInput,
  ZeishNetwork,
  ZeishPage,
  ZeishPageOptions,
  ZeishTemplate,
  ZeishVolume,
} from "./zeish.types";

function rpcBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/api\/v\d+\/?$/, "").replace(/\/+$/, "")}/rpc`;
}

function toError(error: unknown, method: string): never {
  if (error instanceof ConnectError) {
    const status =
      (
        {
          3: 400,
          16: 401,
          7: 403,
          5: 404,
          10: 409,
          8: 429,
          14: 503,
        } as Record<number, number>
      )[error.code] ?? 500;
    throw new ZeishApiError(
      status,
      error.rawMessage,
      "POST",
      `/rpc/${method}`,
      {
        code:
          status === 400
            ? "invalid_request"
            : status === 401
              ? "authentication_required"
              : status === 403
                ? "permission_denied"
                : status === 404
                  ? "not_found"
                  : status === 409
                    ? "conflict"
                    : status === 429
                      ? "rate_limited"
                      : "internal_error",
        message: error.rawMessage,
      },
    );
  }
  throw error;
}

function clients(config: ZeishConfig) {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl)
    throw new Error(
      "A Fetch API implementation is required for Zeish Connect RPC.",
    );
  const auth: Interceptor = (next) => (req) => {
    req.header.set("X-API-Key", config.apiKey);
    return next(req);
  };
  const transport = createConnectTransport({
    baseUrl: rpcBaseUrl(config.baseUrl ?? "https://api.dvito.cloud/api/v1"),
    fetch: fetchImpl,
    useBinaryFormat: false,
    interceptors: [auth],
  });
  return {
    resources: createClient(cloudResources.ResourceService, transport),
    templates: createClient(cloudTemplates.TemplateService, transport),
  };
}

function network(value: cloudResources.Network): ZeishNetwork {
  return {
    id: value.id,
    organizationId: value.organizationId,
    name: value.name,
    slug: value.slug,
    region: value.region,
    createdAt: value.createdAt,
  };
}

function volume(value: cloudResources.Volume): ZeishVolume {
  return {
    id: value.id,
    organizationId: value.organizationId,
    name: value.name,
    slug: value.slug,
    region: value.region,
    sizeGb: value.sizeGb,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function template(value: cloudTemplates.Template): ZeishTemplate {
  return {
    id: value.id,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    registryPath: value.registryPath,
    cpuCores: value.cpuCores,
    memoryMb: value.memoryMb,
    machineKind:
      value.machineKind === cloudTemplates.MachineKind.DEDICATED
        ? "dedicated"
        : "shared",
    ingress: value.ingress.map((entry) => ({
      mode: entry.mode as "raw_l4",
      protocol: entry.protocol as "tcp" | "udp",
      internalPort: entry.internalPort,
      ...(entry.externalPort ? { externalPort: entry.externalPort } : {}),
      ...(entry.accessPolicy
        ? { accessPolicy: entry.accessPolicy as "org" | "public" }
        : {}),
    })),
    ...(value.iconUrl ? { iconUrl: value.iconUrl } : {}),
    isPublic: value.isPublic,
    scope:
      value.scope === cloudTemplates.TemplateScope.GLOBAL
        ? "global"
        : "organization",
    organizationId: value.organizationId || null,
    sourceTemplateId: value.sourceTemplateId || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createConnectResourceApi(config: ZeishConfig) {
  const { resources, templates } = clients(config);
  const call = <T>(promise: Promise<T>, method: string) =>
    promise.catch((error) => toError(error, method));
  const networkInput = (value: ZeishCreateNetworkInput) => ({
    name: value.name,
    slug: value.slug ?? "",
    region: value.region,
  });
  const volumeInput = (value: ZeishCreateVolumeInput) => ({
    name: value.name,
    slug: value.slug ?? "",
    region: value.region ?? "bremen",
    sizeGb: value.sizeGb,
  });
  return {
    listNetworks: (options: ZeishPageOptions = {}) =>
      call(resources.listNetworks({}), "ListNetworks").then(
        (response) =>
          ({
            data: response.networks.map(network),
            nextCursor: null,
          }) satisfies ZeishPage<ZeishNetwork>,
      ),
    createNetwork: (value: ZeishCreateNetworkInput) =>
      call(
        resources.createNetwork({ input: networkInput(value) }),
        "CreateNetwork",
      ).then((response) => network(response.network!)),
    getNetwork: (id: string) =>
      call(resources.getNetwork({ id }), "GetNetwork").then((response) =>
        network(response.network!),
      ),
    deleteNetwork: (id: string) =>
      call(resources.deleteNetwork({ id }), "DeleteNetwork").then((response) =>
        network(response.network!),
      ),
    listVolumes: (options: ZeishPageOptions = {}) =>
      call(resources.listVolumes({}), "ListVolumes").then(
        (response) =>
          ({
            data: response.volumes.map(volume),
            nextCursor: null,
          }) satisfies ZeishPage<ZeishVolume>,
      ),
    createVolume: (value: ZeishCreateVolumeInput) =>
      call(
        resources.createVolume({ input: volumeInput(value) }),
        "CreateVolume",
      ).then((response) => volume(response.volume!)),
    getVolume: (id: string) =>
      call(resources.getVolume({ id }), "GetVolume").then((response) =>
        volume(response.volume!),
      ),
    deleteVolume: (id: string) =>
      call(resources.deleteVolume({ id }), "DeleteVolume").then((response) =>
        volume(response.volume!),
      ),
    listTemplates: (options: ZeishPageOptions = {}) =>
      call(templates.listTemplates({}), "ListTemplates").then(
        (response) =>
          ({
            data: response.templates.map(template),
            nextCursor: null,
          }) satisfies ZeishPage<ZeishTemplate>,
      ),
    getTemplate: (id: string) =>
      call(templates.getTemplate({ id }), "GetTemplate").then((response) =>
        template(response.template!),
      ),
  };
}
