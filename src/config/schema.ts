import { z } from 'zod';

export const OrchestratorConfigSchema = z.object({
  repositoryUrl: z.string().url({ message: 'Repository URL must be a valid URL' }),
  branch: z.string().default('main'),
  cloneDepth: z.number().int().min(1).optional(), // shallow clone depth
  workerCount: z.number().int().min(1).max(20),
  hookServerPort: z.number().int().min(1024).max(65535).default(3000),
  healthCheckIntervalMs: z.number().int().min(5000).default(30000),
  rateLimitCheckIntervalMs: z.number().int().min(5000).default(10000),
  stuckThresholdMs: z.number().int().min(60000).default(300000), // 5 minutes
  maxToolUsesPerInstance: z.number().int().min(100).default(500),
  maxTotalToolUses: z.number().int().min(500).default(2000),
  maxRunDurationMinutes: z.number().int().min(10).default(120),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
