import { z } from 'zod';

// Git URL pattern: supports HTTPS (https://...) and SSH (git@host:...)
const gitUrlPattern = /^(https?:\/\/|git@)[^\s]+$/;
const portSchema = z.number().int().min(1024).max(65535);

export const OrchestratorConfigSchema = z
  .object({
    repositoryUrl: z.string().regex(gitUrlPattern, { message: 'Repository URL must be a valid git URL (HTTPS or SSH)' }),
    branch: z.string().default('main'),
    logDirectory: z.string().min(1).optional(),
    model: z.string().optional(), // Claude model: 'haiku', 'sonnet', 'opus', or full model name
    authMode: z.enum(['oauth', 'api-keys-first', 'api-keys-only']).default('oauth'),
    engineerManagerGroupSize: z.number().int().min(1).max(8).default(4),
    cloneDepth: z.number().int().min(1).optional(), // shallow clone depth
    envFiles: z.array(z.string()).optional(), // Paths to env files to copy to each worker worktree (e.g., ["/path/to/.env.local"])
    workerCount: z.number().int().min(1).max(20),
    hookServerPort: portSchema.default(3000),
    serverPort: portSchema.optional(),
    timingBaseMs: z.number().int().min(5000).optional(),
    healthCheckIntervalMs: z.number().int().min(5000).optional(),
    rateLimitCheckIntervalMs: z.number().int().min(5000).optional(),
    stuckThresholdMs: z.number().int().min(60000).optional(),
    managerHeartbeatIntervalMs: z.number().int().min(60000).optional(),
    maxToolUsesPerInstance: z.number().int().min(100).default(500),
    maxTotalToolUses: z.number().int().min(500).default(2000),
    maxRunDurationMinutes: z.number().int().min(1).default(120), // min 1 minute for testing
  })
  .transform((config) => {
    const resolvedPort = config.serverPort ?? config.hookServerPort;
    const timingBaseMs = Math.round(config.timingBaseMs ?? config.healthCheckIntervalMs ?? 30000);
    const rateLimitCheckIntervalMs = config.rateLimitCheckIntervalMs ?? Math.max(5000, Math.round(timingBaseMs / 3));
    const stuckThresholdMs = config.stuckThresholdMs ?? Math.max(60000, Math.round(timingBaseMs * 6));
    const managerHeartbeatIntervalMs = config.managerHeartbeatIntervalMs ?? Math.max(60000, Math.round(timingBaseMs * 4));
    return {
      ...config,
      timingBaseMs,
      healthCheckIntervalMs: timingBaseMs,
      rateLimitCheckIntervalMs,
      stuckThresholdMs,
      managerHeartbeatIntervalMs,
      hookServerPort: resolvedPort,
      serverPort: resolvedPort,
    };
  });

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
