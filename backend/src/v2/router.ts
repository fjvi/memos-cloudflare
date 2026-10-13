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
    
    // 💡 调试终极杀招：如果是 UpdateUserSetting，先不走业务逻辑，直接把收到的 raw 打印出来并返回 200！
    if (key === "memos.api.v1.UserService/UpdateUserSetting") {
      const debugRaw = await c.req.text();
      console.log("=== 捕获到前端发来的 UpdateUserSetting 原始数据 ===", debugRaw);
      
      return new Response(JSON.stringify({
        setting: {
          name: "users/me/settings/GENERAL",
          generalSetting: { theme: "system", locale: "en", memoVisibility: "PRIVATE" }
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

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
		  // 💡 针对 UpdateUserSetting 的万能参数格式化补丁
      if (key === "memos.api.v1.UserService/UpdateUserSetting") {
        if (!requestBody.setting) {
          requestBody.setting = {};
        }
        // 如果前端把 theme / locale / memoVisibility 直接传在根节点，给它挪到 generalSetting 里
        if (!requestBody.setting.generalSetting) {
          requestBody.setting.generalSetting = {
            theme: requestBody.theme || requestBody.appearance || requestBody.setting.theme || "",
            locale: requestBody.locale || requestBody.setting.locale || "en",
            memoVisibility: requestBody.memoVisibility || requestBody.memo_visibility || requestBody.setting.memoVisibility || "PRIVATE"
          };
        }
        // 自动补全 name
        if (!requestBody.setting.name && auth) {
          requestBody.setting.name = `users/${auth.username}/settings/GENERAL`;
        }
        // 自动补全 updateMask
        if (!requestBody.updateMask && !requestBody.update_mask) {
          requestBody.update_mask = ["theme", "locale", "memo_visibility"];
        }
      }
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