import { z } from 'zod';

// Git URL pattern: supports HTTPS (https://...) and SSH (git@host:...)
const gitUrlPattern = /^(https?:\/\/|git@)[^\s]+$/;

export const OrchestratorConfigSchema = z.object({
  repositoryUrl: z.string().regex(gitUrlPattern, { message: 'Repository URL must be a valid git URL (HTTPS or SSH)' }),
  branch: z.string().default('main'),
  model: z.string().optional(), // Claude model: 'haiku', 'sonnet', 'opus', or full model name
  cloneDepth: z.number().int().min(1).optional(), // shallow clone depth
  envFiles: z.array(z.string()).optional(), // Paths to env files to copy to each worker worktree (e.g., ["/path/to/.env.local"])
  workerCount: z.number().int().min(1).max(20),
  hookServerPort: z.number().int().min(1024).max(65535).default(3000),
  healthCheckIntervalMs: z.number().int().min(5000).default(30000),
  rateLimitCheckIntervalMs: z.number().int().min(5000).default(10000),
  stuckThresholdMs: z.number().int().min(60000).default(300000), // 5 minutes
  managerHeartbeatIntervalMs: z.number().int().min(60000).default(600000), // 10 minutes
  maxToolUsesPerInstance: z.number().int().min(100).default(500),
  maxTotalToolUses: z.number().int().min(500).default(2000),
  maxRunDurationMinutes: z.number().int().min(1).default(120), // min 1 minute for testing
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
