import {
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import * as cloudSshKeys from "./gen/zeish/cloud/control/v1/ssh_keys_pb.js";
import { ZeishApiError } from "./public-api";
import type {
  ZeishConfig,
  ZeishCreateSshKeyInput,
  ZeishOperationResult,
  ZeishSshKey,
} from "./zeish.types";

function rpcBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/api\/v\d+\/?$/, "").replace(/\/+$/, "")}/rpc`;
}

function toError(error: unknown, method: string): never {
  if (error instanceof ConnectError) {
    const status =
      (
        { 3: 400, 16: 401, 7: 403, 5: 404, 10: 409, 8: 429, 14: 503 } as Record<
          number,
          number
        >
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

function clientFor(config: ZeishConfig) {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl)
    throw new Error(
      "A Fetch API implementation is required for Zeish Connect RPC.",
    );
  const auth: Interceptor = (next) => (req) => {
    req.header.set("X-API-Key", config.apiKey);
    return next(req);
  };
  return createClient(
    cloudSshKeys.SshKeysService,
    createConnectTransport({
      baseUrl: rpcBaseUrl(config.baseUrl ?? "https://api.dvito.cloud/api/v1"),
      fetch: fetchImpl,
      interceptors: [auth],
    }),
  );
}

function parse<T>(value: { json: string }): T {
  return JSON.parse(value.json) as T;
}

export function createConnectSshApi(config: ZeishConfig) {
  const client = clientFor(config);
  const call = <T>(promise: Promise<T>, method: string) =>
    promise.catch((error) => toError(error, method));
  return {
    listSshKeys: () =>
      call(client.listSshKeys({}), "ListSshKeys").then(parse<ZeishSshKey[]>),
    createSshKey: (input: ZeishCreateSshKeyInput) =>
      call(
        client.createSshKey({
          name: input.name,
          publicKey: input.publicKey,
          isManaged: false,
        }),
        "CreateSshKey",
      ).then(parse<ZeishSshKey>),
    deleteSshKey: (id: string) =>
      call(client.deleteSshKey({ id }), "DeleteSshKey").then(
        parse<ZeishOperationResult>,
      ),
  };
}
