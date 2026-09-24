/** A small router and static file server. The service has nine routes and one static mount; a framework would be more code than this.
 *
 * Error bodies are `{"detail": "..."}` with the matching status, which is what FastAPI produced and what the wall reads to tell an unpolled camera from one that publishes no stream. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
export class HttpError extends Error {
    status;
    detail;
    constructor(status, detail) {
        super(detail);
        this.status = status;
        this.detail = detail;
    }
}
const MIME = {
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
    routes = [];
    staticRoot = null;
    fallback = null;
    get(path, handler) {
        const keys = [];
        const pattern = new RegExp(`^${path.replace(/:([A-Za-z_]+)/g, (_match, key) => {
            keys.push(key);
            return '([^/]+)';
        })}$`);
        this.routes.push({ pattern, keys, handler });
    }
    serveStatic(root) {
        this.staticRoot = root;
    }
    onMissingStatic(fallback) {
        this.fallback = fallback;
    }
    async handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = decodeURIComponent(url.pathname);
        try {
            for (const route of this.routes) {
                const match = route.pattern.exec(path);
                if (!match)
                    continue;
                const params = {};
                route.keys.forEach((key, i) => (params[key] = match[i + 1]));
                const body = await route.handler({ params, query: url.searchParams, res });
                if (res.writableEnded)
                    return;
                send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
                return;
            }
            if (this.staticRoot && this.sendStatic(path, res))
                return;
            if (this.fallback && (path === '/' || path === '/index.html')) {
                const { status, body, type } = this.fallback();
                send(res, status, body, type);
                return;
            }
            send(res, 404, JSON.stringify({ detail: 'Not Found' }), 'application/json; charset=utf-8');
        }
        catch (error) {
            if (error instanceof HttpError) {
                send(res, error.status, JSON.stringify({ detail: error.detail }), 'application/json; charset=utf-8');
                return;
            }
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            console.error(`${path}: ${message}`);
            send(res, 500, JSON.stringify({ detail: 'internal error' }), 'application/json; charset=utf-8');
        }
    }
    sendStatic(path, res) {
        const root = this.staticRoot;
        if (!root)
            return false;
        // normalize before joining, so a ../ in the request cannot climb out of the build directory.
        const relative = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
        const file = join(root, relative);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile())
            return false;
        const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': relative === '/index.html' ? 'no-cache' : 'max-age=3600' });
        createReadStream(file).pipe(res);
        return true;
    }
}
export function send(res, status, body, type, headers = {}) {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
}
//# sourceMappingURL=http.js.map