/**
 * Claude Code Orchestrator (V2)
 *
 * Main module export - re-exports the V2 orchestrator for programmatic use.
 * For CLI usage, run via `cco` command or `npm start`.
 */

// Re-export V2 orchestrator and all components
export {
  V2Orchestrator,
  WorkerExecutor,
  TaskQueue,
  TeamManager,
  buildWorkerPrompt,
  buildMergePrompt,
  buildConflictResolutionPrompt,
  getTaskFileName,
  getEmTaskFileName,
  generateWorkerTaskContent,
  generateEmTaskContent,
  generateDirectorTaskContent,
  generateManagerTaskContent,
  writeTaskFile,
  readTaskFile,
  deleteTaskFile,
  DIRECTOR_TASK_FILE,
  MANAGER_TASK_FILE,
} from './v2/index.js';

// Re-export types
export type {
  TaskResult,
  TaskStatus,
  TaskPriority,
  Task,
  WorkerStatus,
  Worker,
  InstanceType,
  Team,
  OrchestratorMode,
  OrchestratorStatus,
  WorkerStatusInfo,
  TeamStatusInfo,
  AuthConfig,
  V2OrchestratorConfig,
  MergeResult,
  CommitInfo,
  WorkerConfig,
  CreateTaskOptions,
  TeamManagerConfig,
} from './v2/index.js';

// Re-export config
export { OrchestratorConfigSchema } from './config/schema.js';
export type { OrchestratorConfig } from './config/schema.js';

// Re-export utilities
export { logger, configureLogDirectory } from './utils/logger.js';
export { extractRepoName } from './utils/repo.js';
export { GitManager } from './git/worktree.js';
