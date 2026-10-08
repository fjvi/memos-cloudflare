import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/user';
import { memoRoutes } from './routes/memo';
import { tagRoutes } from './routes/tag';
import { resourceRoutes } from './routes/resource';
import { workspaceRoutes } from './routes/workspace';
import { webhookRoutes } from './routes/webhook';
import { authMiddleware } from './middleware/auth';
import { mountConnectRoutes } from './v2/router';
import { mountFileServer } from './v2/fileserver';
import './v2/services';

// 导入环境类型
import { Env } from './types';

// 创建 Hono 应用实例
const app = new Hono<{ Bindings: Env }>();

// 全局中间件
// ===== 增强版中间件：彻底拦截并修复 UpdateUser / ChangePassword 的 update_mask 问题 =====
app.use('*', async (c, next) => {
  const method = c.req.method;
  const contentType = c.req.header('content-type') || '';

  // 匹配所有 JSON 和 Connect-RPC 的 POST/PATCH 请求
  if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && 
      (contentType.includes('json') || contentType.includes('connect'))) {
    try {
      const rawBody = await c.req.text();
      if (rawBody && rawBody.trim().startsWith('{')) {
        const body = JSON.parse(rawBody);
        let modified = false;

        // 1. 字段名转换：把驼峰 updateMask 转换为 蛇形 update_mask
        if (body.updateMask && !body.update_mask) {
          body.update_mask = Array.isArray(body.updateMask) 
            ? body.updateMask 
            : String(body.updateMask).split(',');
          modified = true;
        }

        // 2. 检查 update_mask 是否为空或者未设置
        const hasValidMask = body.update_mask && 
          (Array.isArray(body.update_mask) ? body.update_mask.length > 0 : String(body.update_mask).trim() !== '');

        if (!hasValidMask) {
          // A. 针对 UpdateUser / ChangePassword 请求（修改密码/更新用户）
          if (body.user && typeof body.user === 'object') {
            const keys = Object.keys(body.user)
              .filter(k => k !== 'name' && body.user[k] !== undefined && body.user[k] !== null)
              .map(k => k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)); // 驼峰转蛇形（如 displayName -> display_name）
            
            // 如果检测到包含 password，确保 password / password_hash 被加入 mask
            if (keys.length > 0) {
              body.update_mask = keys;
              modified = true;
            } else if (body.user.password) {
              body.update_mask = ['password'];
              modified = true;
            }
          } 
          // B. 针对 UpdateMemo 请求
          else if (body.memo && typeof body.memo === 'object') {
            const keys = Object.keys(body.memo)
              .filter(k => k !== 'name' && body.memo[k] !== undefined && body.memo[k] !== null)
              .map(k => k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`));
            if (keys.length > 0) {
              body.update_mask = keys;
              modified = true;
            }
          } 
          // C. 针对系统设置请求
          else if (body.setting || body.value) {
            body.update_mask = ['value'];
            modified = true;
          }
        }

        // 如果 `update_mask` 是数组，部分 Protocol Buffers 解析器要求用 comma-separated string（或保持数组）
        if (modified) {
          const modifiedRequest = new Request(c.req.raw, {
            body: JSON.stringify(body),
            headers: c.req.raw.headers
          });
          c.req.raw = modifiedRequest;
        }
      }
    } catch (e) {
      // 遇到非合法 JSON 则忽略，继续向下传递
    }
  }

  await next();
});
app.use('*', logger());
app.use('/api/*', prettyJSON());

// ===== 关键补丁中间件：自动修复 update_mask 映射和缺失问题 =====
app.use('*', async (c, next) => {
  const method = c.req.method;
  const contentType = c.req.header('content-type') || '';

  if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && contentType.includes('application/json')) {
    try {
      const rawBody = await c.req.text();
      if (rawBody && rawBody.trim().startsWith('{')) {
        const body = JSON.parse(rawBody);

        let modified = false;

        // 1. 兼容转换：把驼峰 updateMask 转换为 蛇形 update_mask
        if (body.updateMask && !body.update_mask) {
          body.update_mask = body.updateMask;
          modified = true;
        }

        // 2. 智能补全：当两者均缺失时，根据请求的 payload 主体自动推导 update_mask 字段
        if (!body.update_mask && !body.updateMask) {
          if (body.user && typeof body.user === 'object') {
            // 匹配 UpdateUser 接口
            const keys = Object.keys(body.user)
              .filter(k => k !== 'name' && body.user[k] !== undefined)
              .map(k => k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)); // 驼峰转蛇形
            if (keys.length > 0) {
              body.update_mask = keys;
              modified = true;
            }
          } else if (body.memo && typeof body.memo === 'object') {
            // 匹配 UpdateMemo 接口
            const keys = Object.keys(body.memo)
              .filter(k => k !== 'name' && body.memo[k] !== undefined)
              .map(k => k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`));
            if (keys.length > 0) {
              body.update_mask = keys;
              modified = true;
            }
          } else if (body.setting || body.value) {
            // 匹配 UpdateInstanceSetting 接口
            body.update_mask = ['value'];
            modified = true;
          }
        }

        if (modified) {
          // 重新将修补后的 Request 注入到 c.req.raw 中
          const modifiedRequest = new Request(c.req.raw, {
            body: JSON.stringify(body)
          });
          c.req.raw = modifiedRequest;
        }
      }
    } catch (e) {
      // JSON 解析异常忽略，放行原请求处理
    }
  }

  await next();
});

// 健康检查端点
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'memos-cloudflare',
    version: '0.2.0'
  });
});

// ===== v2: Connect JSON API（对齐上游 Memos v0.29，前端 v0.29.1 使用） =====
mountConnectRoutes(app);
mountFileServer(app);

// ===== v1 legacy REST 路由（对应旧版 v0.24 前端，过渡期保留） =====
// 先注册公开的路由
app.route('/api/auth', authRoutes);

// workspace 路由 - /profile 和 /setting GET 端点是公开的
app.route('/api/workspace', workspaceRoutes);

// 需要认证的路由
app.use('/api/user/*', authMiddleware);
app.use('/api/tag/*', authMiddleware);
app.use('/api/resource/*', authMiddleware);
app.use('/api/webhook/*', authMiddleware);

// memo 路由需要部分认证
app.use('/api/memo', authMiddleware);
app.post('/api/memo/*', authMiddleware);
app.patch('/api/memo/*', authMiddleware);
app.delete('/api/memo/*', authMiddleware);

app.route('/api/user', userRoutes);
app.route('/api/memo', memoRoutes);
app.route('/api/tag', tagRoutes);
app.route('/api/resource', resourceRoutes);
app.route('/api/webhook', webhookRoutes);

// 文件下载路由 (不在 /api 下)
app.get('/o/r/:uid/:filename', async (c) => {
  try {
    const { uid, filename } = c.req.param();
    
    // 查询资源信息
    const resource = await c.env.DB.prepare(
      'SELECT * FROM resource WHERE uid = ?'
    ).bind(uid).first();

    if (!resource) {
      return c.json({ message: 'Resource not found' }, 404);
    }

    // 检查 R2 绑定是否存在
    if (!c.env.R2) {
      // 提示用户去系统后台切换存储方式
      return c.json({ message: '存储尚未配置，请先登录管理员账号在 Memos 设置中将存储类型切换至 Database' }, 400);
    }
    // 从 R2 获取文件
    const r2Key = `${uid}/${filename}`;
    const object = await c.env.R2.get(r2Key);

    if (!object) {
      return c.json({ message: 'File not found in storage' }, 404);
    }

    // 返回文件内容
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': object.size.toString(),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  } catch (error: any) {
    console.error('File download error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

// 404 处理：单 Worker 同源部署时回退到静态前端（SPA 路由如 /explore 返回 index.html）
app.notFound(async (c) => {
  if (c.env.ASSETS && c.req.method === 'GET') {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
    return c.env.ASSETS.fetch(new URL('/', c.req.url).toString());
  }
  return c.json({ message: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ 
    message: 'Internal Server Error',
    ...(c.env.LOG_LEVEL === 'debug' && { error: err.message })
  }, 500);
});

export default app;
