import { z } from 'zod';

// Git URL pattern: supports HTTPS (https://...) and SSH (git@host:...)
const gitUrlPattern = /^(https?:\/\/|git@)[^\s]+$/;

/**
 * V2 Orchestrator Configuration Schema
 *
 * This is the simplified configuration for the --print mode architecture.
 * No tmux, no hooks - just simple process-based execution.
 */
export const OrchestratorConfigSchema = z
  .object({
    // Repository settings
    repositoryUrl: z.string().regex(gitUrlPattern, {
      message: 'Repository URL must be a valid git URL (HTTPS or SSH)',
    }),
    branch: z.string().default('main'),
    cloneDepth: z.number().int().min(1).optional(), // shallow clone depth
    useRunBranch: z.boolean().default(false), // If true, creates a unique branch for each run

    // Workspace settings
    workspaceDir: z.string().min(1).optional(), // Path to the workspace directory
    logDirectory: z.string().min(1).optional(),

    // Worker settings
    workerCount: z.number().int().min(1).max(20),
    engineerManagerGroupSize: z.number().int().min(1).max(8).default(4),
    model: z.string().optional(), // Claude model: 'haiku', 'sonnet', 'opus', or full model name

    // Authentication
    authMode: z.enum(['oauth', 'api-keys-first', 'api-keys-only']).default('oauth'),

    // Timing settings (v2 simplified)
    taskTimeoutMs: z.number().int().min(60000).default(600000), // 10 minutes default
    pollIntervalMs: z.number().int().min(1000).default(5000), // 5 seconds default

    // Cost limits
    maxToolUsesPerInstance: z.number().int().min(100).default(500),
    maxTotalToolUses: z.number().int().min(500).default(2000),
    maxRunDurationMinutes: z.number().int().min(1).default(120), // min 1 minute for testing

    // Environment
    envFiles: z.array(z.string()).optional(), // Paths to env files to copy to each worker worktree

    // Legacy fields (kept for backward compatibility during migration)
    // These will be ignored by v2 but allow old configs to still parse
    hookServerPort: z.number().int().min(1024).max(65535).default(3000).optional(),
    serverPort: z.number().int().min(1024).max(65535).optional(),
    timingBaseMs: z.number().int().min(5000).optional(),
    healthCheckIntervalMs: z.number().int().min(5000).optional(),
    rateLimitCheckIntervalMs: z.number().int().min(5000).optional(),
    stuckThresholdMs: z.number().int().min(60000).optional(),
    managerHeartbeatIntervalMs: z.number().int().min(60000).optional(),
  })
  .transform((config) => {
    // Transform for backward compatibility
    // If old timing settings are provided, map them to new settings
    const taskTimeoutMs = config.taskTimeoutMs ??
      (config.stuckThresholdMs ? config.stuckThresholdMs * 3 : 600000);

    const pollIntervalMs = config.pollIntervalMs ??
      (config.timingBaseMs ? Math.round(config.timingBaseMs / 6) : 5000);

    return {
      repositoryUrl: config.repositoryUrl,
      branch: config.branch,
      cloneDepth: config.cloneDepth,
      useRunBranch: config.useRunBranch,
      workspaceDir: config.workspaceDir,
      logDirectory: config.logDirectory,
      workerCount: config.workerCount,
      engineerManagerGroupSize: config.engineerManagerGroupSize,
      model: config.model,
      authMode: config.authMode,
      taskTimeoutMs,
      pollIntervalMs,
      maxToolUsesPerInstance: config.maxToolUsesPerInstance,
      maxTotalToolUses: config.maxTotalToolUses,
      maxRunDurationMinutes: config.maxRunDurationMinutes,
      envFiles: config.envFiles,
    };
  });

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

/**
 * Auth configuration schema
 */
export const AuthConfigSchema = z.object({
  name: z.string().optional(),
  apiKey: z.string().optional(),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * API keys file schema
 */
export const ApiKeysFileSchema = z.array(AuthConfigSchema);
