import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes/api.js';
import { webhookRouter } from './routes/webhook.js';
import { HttpError } from './utils/httpError.js';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = existsSync(path.join(runtimeDir, 'public'))
  ? path.join(runtimeDir, 'public')
  : path.join(path.dirname(runtimeDir), 'public');

export function createApp() {
  const app = express();

  app.use(
    express.json({
      limit: '8mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      }
    })
  );

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'line-group-archive-dashboard' });
  });

  app.use('/webhook', webhookRouter);
  app.use('/api', apiRouter);
  app.use(express.static(publicDir, { index: 'index.html' }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: err.message || 'Internal Server Error'
    });
  });

  return app;
}
