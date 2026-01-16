/**
 * V2 Architecture Types - Non-Interactive (--print mode) Based
 */

/** Worker execution result */
export interface TaskResult {
  success: boolean;
  output: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  rateLimited?: boolean;
  timedOut?: boolean;
}

/** Task states */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Task priority */
export type TaskPriority = 'high' | 'normal' | 'low';

/** Task definition */
export interface Task {
  id: string;
  title: string;
  description: string;
  requirements?: string[];
  filesToModify?: string[];
  acceptanceCriteria?: string[];
  priority: TaskPriority;
  status: TaskStatus;
  assignedWorker?: number;
  teamId?: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: TaskResult;
  retryCount: number;
  maxRetries: number;
}

/** Worker states */
export type WorkerStatus = 'idle' | 'running' | 'error' | 'rate_limited';

/** Worker definition */
export interface Worker {
  id: number;
  status: WorkerStatus;
  worktreePath: string;
  branchName: string;
  currentTask?: Task;
  totalTasksCompleted: number;
  toolUseCount: number;
  lastActivityAt?: Date;
  authConfigIndex?: number;
}

/** Instance types for hierarchy mode */
export type InstanceType = 'director' | 'em' | 'manager' | 'worker';

/** Team structure for hierarchy mode */
export interface Team {
  id: number;
  emId: number;
  workerIds: number[];
  branchName: string;
  worktreePath: string;
}

/** Orchestrator modes */
export type OrchestratorMode = 'flat' | 'hierarchy';

/** Orchestrator status */
export interface OrchestratorStatus {
  mode: OrchestratorMode;
  isRunning: boolean;
  isPaused: boolean;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  workers: WorkerStatusInfo[];
  teams?: TeamStatusInfo[];
  startedAt: Date;
  runDurationMinutes: number;
}

/** Worker status summary */
export interface WorkerStatusInfo {
  id: number;
  status: WorkerStatus;
  currentTaskTitle?: string;
  tasksCompleted: number;
}

/** Team status summary */
export interface TeamStatusInfo {
  id: number;
  workerIds: number[];
  completedTasks: number;
  pendingMerges: number;
}

/** Auth configuration */
export interface AuthConfig {
  name?: string;
  apiKey?: string;
}

/** V2 Orchestrator config (extends base config) */
export interface V2OrchestratorConfig {
  repositoryUrl: string;
  branch: string;
  workerCount: number;
  workspaceDir: string;
  logDirectory?: string;
  model?: string;
  authMode: 'oauth' | 'api-keys-first' | 'api-keys-only';
  engineerManagerGroupSize: number;
  taskTimeoutMs: number;
  pollIntervalMs: number;
  maxToolUsesPerInstance: number;
  maxTotalToolUses: number;
  maxRunDurationMinutes: number;
  envFiles?: string[];
  cloneDepth?: number;
  useRunBranch?: boolean;
}

/** Merge result */
export interface MergeResult {
  success: boolean;
  hasConflicts?: boolean;
  conflictedFiles?: string[];
  message?: string;
}

/** Git commit info */
export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: Date;
}
