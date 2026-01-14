import express, { Request, Response, NextFunction } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';

export interface HookPayload {
  hook_name: string;
  instance_id: string;
  worker_id: number;
  instance_type: 'director' | 'em' | 'worker' | 'manager';
  data: Record<string, unknown>;
}

type HookHandler = (payload: HookPayload) => Promise<void>;

interface HookServerOptions {
  sessionProvider?: () => unknown;
  uiDir?: string | null;
}

interface ResolvedUiPaths {
  pageDir: string;
  assetsDir?: string | null;
}

export class HookServer {
  private app: express.Application;
  private handlers: Map<string, HookHandler[]> = new Map();
  private server: ReturnType<typeof this.app.listen> | null = null;
  private sessionProvider: (() => unknown) | null;
  private uiDir: string | null;
  private resolvedUi: ResolvedUiPaths | null = null;
  private readonly corsOrigin: string;

  constructor(private port: number = 3000, options: HookServerOptions = {}) {
    this.app = express();
    this.app.use(express.json());
    this.sessionProvider = options.sessionProvider ?? null;
    this.uiDir = options.uiDir ?? null;
    this.corsOrigin = process.env.ORCHESTRATOR_UI_CORS ?? '*';
    this.setupMiddleware();
    this.setupRoutes();
    this.setupUiRoutes();
  }

  private setupMiddleware(): void {
    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(`${req.method} ${req.path}`, { body: req.body });
      next();
    });

    // Error handling
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Server error', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
    // Main hook endpoint
    this.app.post('/hooks/:hookName', async (req: Request, res: Response) => {
      const hookNameParam = req.params.hookName;
      const hookName = Array.isArray(hookNameParam) ? hookNameParam[0] : hookNameParam;

      const workerId = Array.isArray(req.body.worker_id)
        ? req.body.worker_id[0]
        : req.body.worker_id;

      const payload: HookPayload = {
        hook_name: String(hookName),
        instance_id: String(req.body.instance_id || ''),
        worker_id: parseInt(String(workerId), 10) || 0,
        instance_type: (req.body.instance_type || 'worker') as HookPayload['instance_type'],
        data: req.body.data || {},
      };

      logger.info(`Received hook: ${hookName}`, {
        instanceId: payload.instance_id,
        type: payload.instance_type,
      });

      // Execute handlers
      const handlers = this.handlers.get(String(hookName)) || [];
      for (const handler of handlers) {
        try {
          await handler(payload);
        } catch (err) {
          logger.error(`Hook handler error: ${hookName}`, err);
        }
      }

      res.json({ status: 'ok', hook: hookName });
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Status endpoint - returns orchestrator status
    this.app.get('/status', (_req: Request, res: Response) => {
      res.json({
        status: 'running',
        uptime: process.uptime(),
        handlers: Array.from(this.handlers.keys()),
      });
    });

    this.app.get('/api/session/current', (_req: Request, res: Response) => {
      res.header('Access-Control-Allow-Origin', this.corsOrigin);
      res.header('Vary', 'Origin');

      if (!this.sessionProvider) {
        res.status(503).json({ error: 'Session snapshot unavailable' });
        return;
      }

      try {
        const payload = this.sessionProvider();
        res.json(payload);
      } catch (err) {
        logger.error('Failed to produce session snapshot', err);
        res.status(500).json({ error: 'Failed to read session state' });
      }
    });
  }

  private setupUiRoutes(): void {
    if (!this.uiDir || this.resolvedUi) {
      return;
    }

    const candidate = this.resolveUiDirectory(this.uiDir);
    if (!candidate) {
      logger.warn('Web UI directory not found or missing index.html', { uiDir: this.uiDir });
      return;
    }

    this.resolvedUi = candidate;
    logger.info('Serving web UI', { uiDir: candidate.pageDir, assetsDir: candidate.assetsDir });

    this.app.use('/ui', express.static(candidate.pageDir));

    if (candidate.assetsDir) {
      this.app.use('/ui/_next', express.static(candidate.assetsDir));
    }

    const root = candidate.pageDir;
    this.app.get(['/ui', '/ui/*'], (_req: Request, res: Response) => {
      res.sendFile(join(root as string, 'index.html'));
    });

    this.app.get('/', (_req: Request, res: Response) => {
      res.redirect('/ui');
    });
  }

  private resolveUiDirectory(baseDir: string): ResolvedUiPaths | null {
    const directIndex = join(baseDir, 'index.html');
    if (existsSync(baseDir) && existsSync(directIndex)) {
      return {
        pageDir: baseDir,
        assetsDir: this.findAssetsDir(baseDir),
      };
    }

    const nestedDir = join(baseDir, 'ui');
    const nestedIndex = join(nestedDir, 'index.html');
    if (existsSync(nestedDir) && existsSync(nestedIndex)) {
      return {
        pageDir: nestedDir,
        assetsDir: this.findAssetsDir(baseDir) ?? this.findAssetsDir(nestedDir),
      };
    }

    return null;
  }

  private findAssetsDir(baseDir: string): string | null {
    const direct = join(baseDir, '_next');
    if (existsSync(direct)) {
      return direct;
    }

    const parent = join(baseDir, '..', '_next');
    if (existsSync(parent)) {
      return parent;
    }

    const twoUp = join(baseDir, '..', '..', '_next');
    if (existsSync(twoUp)) {
      return twoUp;
    }

    return null;
  }

  /**
   * Register a handler for a specific hook.
   */
  on(hookName: string, handler: HookHandler): void {
    const handlers = this.handlers.get(hookName) || [];
    handlers.push(handler);
    this.handlers.set(hookName, handlers);
    logger.debug(`Registered handler for hook: ${hookName}`);
  }

  setSessionProvider(provider: (() => unknown) | null): void {
    this.sessionProvider = provider;
  }

  setUiDirectory(uiDir: string | null): void {
    this.uiDir = uiDir;
    this.resolvedUi = null;
    this.setupUiRoutes();
  }

  /**
   * Remove all handlers for a hook.
   */
  off(hookName: string): void {
    this.handlers.delete(hookName);
  }

  /**
   * Start the server.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(`Hook server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            logger.warn('Error stopping hook server', err);
          }
          this.server = null;
          logger.info('Hook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the express app instance (for testing).
   */
  getApp(): express.Application {
    return this.app;
  }
}
