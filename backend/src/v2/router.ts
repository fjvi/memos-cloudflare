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
    const registration = registry.get(key);

    try {
      if (!registration) {
        console.error(`[Router] Unimplemented RPC requested: ${key}`); // 打印未注册的路由
        throw unimplemented(key);
      }

      let requestBody: any = {};
      const raw = await c.req.text();
      if (raw) {
        try {
          requestBody = JSON.parse(raw);
        } catch {
          console.error(`[Router] Malformed JSON in RPC ${key}`);
          throw new ConnectError("invalid_argument", "malformed JSON request body");
        }
      }

      const auth = await authenticate(c.req.raw, c.env);
      if (registration.auth === "required" && !auth) {
        console.error(`[Router] Unauthenticated access attempt to protected RPC: ${key}`);
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
      // 💡 关键：在这里把真正导致 400 的底层错误日志完整打印到 Cloudflare 控制台
      console.error(`[Router Error] RPC ${key} failed with error:`, err);

      const connectErr =
        err instanceof ConnectError ? err : internal(err instanceof Error ? err.message : "unknown error");
      return new Response(JSON.stringify(connectErr.toBody()), {
        status: connectErr.httpStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
}