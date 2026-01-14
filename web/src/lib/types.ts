export type InstanceType = 'director' | 'em' | 'worker' | 'manager';
export type InstanceStatus = 'starting' | 'ready' | 'busy' | 'idle' | 'merging' | 'error' | 'stopped';

export interface SessionInstance {
  id: string;
  type: InstanceType;
  status: InstanceStatus;
  workerId: number;
  currentTask?: string;
  lastToolUse: string | null;
  toolUseCount: number;
  sessionName: string;
  workDir: string;
  logFile: string | null;
  authConfig: string | null;
  createdAt: string;
}

export interface TeamSnapshot {
  id: number;
  status: 'active' | 'decommissioned';
  workers: number[];
  queueSize: number;
  lastAssessment: number;
  branchName: string;
  worktreePath: string;
  priorityScore: number;
}

export interface SessionSnapshot {
  meta: {
    repositoryUrl: string;
    branch: string;
    workspaceDir: string;
    runLogDir: string | null;
    workerCount: number;
    hierarchyEnabled: boolean;
    startedAt: string | null;
    model?: string;
  };
  instances: {
    total: number;
    byStatus: Record<InstanceStatus, number>;
    totalToolUses: number;
    list: SessionInstance[];
  };
  queues: {
    directorQueueSize: number;
    managerQueueSize: number;
    teams: TeamSnapshot[];
  };
  costs: {
    totalToolUses: number;
    runDurationMinutes: number;
    startTime: string;
    toolUsesPerInstance: Array<{ id: string; count: number }>;
    limits: {
      maxToolUsesPerInstance: number;
      maxTotalToolUses: number;
      maxRunDurationMinutes: number;
    };
  };
  auth: {
    mode: string;
    configs: string[];
    rotationPoolSize: number;
  };
  logs: {
    runLogDir: string | null;
    sessions: Array<{ id: string; path: string | null }>;
  };
}
