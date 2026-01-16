/**
 * V2 Architecture - Non-Interactive Claude Code Orchestration
 *
 * This module provides a simplified orchestration system using Claude's --print mode.
 *
 * Key components:
 * - V2Orchestrator: Main orchestration engine
 * - WorkerExecutor: Process-based worker execution
 * - TaskQueue: Thread-safe task management
 * - TeamManager: Team/hierarchy structure management
 * - Task files: Markdown-based task communication
 */

// Core orchestrator
export { V2Orchestrator } from './orchestrator.js';

// Worker execution
export {
  WorkerExecutor,
  buildWorkerPrompt,
  buildMergePrompt,
  buildConflictResolutionPrompt,
  type WorkerConfig,
} from './worker.js';

// Task management
export {
  TaskQueue,
  type CreateTaskOptions,
} from './task-queue.js';

// Team management
export {
  TeamManager,
  type TeamManagerConfig,
} from './team-manager.js';

// Task file generation
export {
  getTaskFileName,
  getEmTaskFileName,
  DIRECTOR_TASK_FILE,
  MANAGER_TASK_FILE,
  generateWorkerTaskContent,
  generateEmTaskContent,
  generateDirectorTaskContent,
  generateManagerTaskContent,
  writeTaskFile,
  readTaskFile,
  deleteTaskFile,
} from './task-file.js';

// Types
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
} from './types.js';
