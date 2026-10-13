import { Hono } from "hono";
import type { Env } from "../types";
import { ConnectError, internal, unauthenticated, unimplemented } from "./connect";
import { authenticate, type AuthContext } from "./auth";

// 每个 RPC handler 收到解析后的请求 JSON 与上下文，返回响应 JSON。
export interface RpcContext {
  env: Env;
  req: Request;
  auth: AuthContext | null;
  /** 响应上的 Set-Cookie 等额外头，由 handler 按需写入 */
  responseHeaders: Headers;
}

export type RpcHandler = (request: any, ctx: RpcContext) => Promise<Record<string, unknown>>;

type AuthPolicy = "required" | "optional";

interface RpcRegistration {
  handler: RpcHandler;
  auth: AuthPolicy;
}

const registry = new Map<string, RpcRegistration>();

export function rpc(service: string, method: string, auth: AuthPolicy, handler: RpcHandler) {
  registry.set(`memos.api.v1.${service}/${method}`, { handler, auth });
}

/** 挂载 Connect JSON 路由。所有 RPC 都是 POST /memos.api.v1.<Service>/<Method> */
export function mountConnectRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/:service{memos\\.api\\.v1\\.[A-Za-z]+}/:method", async (c) => {
    const key = `${c.req.param("service")}/${c.req.param("method")}`;
    
    // 💡 强行拦截并打印：不管三七二十一，先看看进到网关的 UpdateUserSetting 长什么样
    if (key === "memos.api.v1.UserService/UpdateUserSetting") {
      const rawText = await c.req.text();
      console.log("=== 捕获到 UpdateUserSetting 请求 ===", rawText);
    }

    const registration = registry.get(key);

    try {
      if (!registration) {
        throw unimplemented(key);
      }

      let requestBody: any = {};
      const raw = await c.req.text();
      if (raw) {
        try {
          requestBody = JSON.parse(raw);
        } catch {
          throw new ConnectError("invalid_argument", "malformed JSON request body");
        }
      }

      const auth = await authenticate(c.req.raw, c.env);
      if (registration.auth === "required" && !auth) {
        throw unauthenticated();
      }

      const responseHeaders = new Headers();
      const result = await registration.handler(requestBody, {
        env: c.env,
        req: c.req.raw,
        auth,
        responseHeaders,
      });

      responseHeaders.set("Content-Type", "application/json");
      return new Response(JSON.stringify(result ?? {}), { status: 200, headers: responseHeaders });
    } catch (err) {
      const connectErr =
        err instanceof ConnectError ? err : internal(err instanceof Error ? err.message : "unknown error");
      if (!(err instanceof ConnectError)) {
        console.error(`RPC ${key} failed:`, err);
      }
      return new Response(JSON.stringify(connectErr.toBody()), {
        status: connectErr.httpStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
}
