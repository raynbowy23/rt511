/** A small router and static file server. Error bodies are `{"detail": "..."}` with the matching status, which the wall reads to tell an unpolled camera from one that publishes no stream. */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  res: ServerResponse;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

export class Router {
  private readonly routes: Route[] = [];
  private staticRoot: string | null = null;
  private fallback: (() => { status: number; body: string; type: string }) | null = null;

  get(path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([A-Za-z_]+)/g, (_match, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ pattern, keys, handler });
  }

  serveStatic(root: string): void {
    this.staticRoot = root;
  }

  onMissingStatic(fallback: () => { status: number; body: string; type: string }): void {
    this.fallback = fallback;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    try {
      for (const route of this.routes) {
        const match = route.pattern.exec(path);
        if (!match) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => (params[key] = match[i + 1] as string));
        const body = await route.handler({ params, query: url.searchParams, res });
        if (res.writableEnded) return;
        send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
        return;
      }
      if (this.staticRoot && this.sendStatic(path, res)) return;
      if (this.fallback && (path === '/' || path === '/index.html')) {
        const { status, body, type } = this.fallback();
        send(res, status, body, type);
        return;
      }
      send(res, 404, JSON.stringify({ detail: 'Not Found' }), 'application/json; charset=utf-8');
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, JSON.stringify({ detail: error.detail }), 'application/json; charset=utf-8');
        return;
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`${path}: ${message}`);
      send(res, 500, JSON.stringify({ detail: 'internal error' }), 'application/json; charset=utf-8');
    }
  }

  private sendStatic(path: string, res: ServerResponse): boolean {
    const root = this.staticRoot;
    if (!root) return false;
    // normalize before joining, so a ../ in the request cannot climb out of the build directory.
    const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, relative);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return false;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': relative === '/index.html' ? 'no-cache' : 'max-age=3600' });
    createReadStream(file).pipe(res);
    return true;
  }
}

export function send(res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}
