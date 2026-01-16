/**
 * TeamManager - Handles team structure for both flat and hierarchy modes
 *
 * Flat Mode: Manager -> Workers
 * Hierarchy Mode: Director -> Engineering Managers -> Workers
 */

import { logger } from '../utils/logger.js';
import type { Team, Worker, OrchestratorMode, WorkerStatus } from './types.js';

/** Team manager configuration */
export interface TeamManagerConfig {
  workerCount: number;
  engineerManagerGroupSize: number;
  baseBranch: string;
}

/**
 * TeamManager handles team organization and worker assignment
 */
export class TeamManager {
  private config: TeamManagerConfig;
  private mode: OrchestratorMode;
  private teams: Map<number, Team> = new Map();
  private workers: Map<number, Worker> = new Map();

  constructor(config: TeamManagerConfig) {
    this.config = config;
    this.mode = this.determineMode();

    logger.info('TeamManager initialized', {
      mode: this.mode,
      workerCount: config.workerCount,
      groupSize: config.engineerManagerGroupSize,
    });
  }

  /**
   * Determine operating mode based on worker count
   */
  private determineMode(): OrchestratorMode {
    return this.config.workerCount > this.config.engineerManagerGroupSize
      ? 'hierarchy'
      : 'flat';
  }

  /**
   * Get current operating mode
   */
  getMode(): OrchestratorMode {
    return this.mode;
  }

  /**
   * Initialize team structure based on mode
   */
  initialize(): void {
    if (this.mode === 'hierarchy') {
      this.initializeHierarchy();
    } else {
      this.initializeFlat();
    }
  }

  /**
   * Initialize hierarchy mode with teams
   */
  private initializeHierarchy(): void {
    const { workerCount, engineerManagerGroupSize } = this.config;
    const teamCount = Math.ceil(workerCount / engineerManagerGroupSize);

    let workerIndex = 1;

    for (let teamId = 1; teamId <= teamCount; teamId++) {
      const workerIds: number[] = [];

      // Assign workers to this team
      for (let i = 0; i < engineerManagerGroupSize && workerIndex <= workerCount; i++) {
        workerIds.push(workerIndex);
        this.createWorker(workerIndex, teamId);
        workerIndex++;
      }

      // Create team
      const team: Team = {
        id: teamId,
        emId: teamId, // EM ID matches team ID
        workerIds,
        branchName: `em-team-${teamId}`,
        worktreePath: '', // Set during worktree setup
      };

      this.teams.set(teamId, team);

      logger.debug('Team created', {
        teamId,
        emId: team.emId,
        workerIds,
        branchName: team.branchName,
      });
    }

    logger.info('Hierarchy mode initialized', {
      teamCount,
      totalWorkers: workerCount,
    });
  }

  /**
   * Initialize flat mode (no teams, just workers)
   */
  private initializeFlat(): void {
    for (let workerId = 1; workerId <= this.config.workerCount; workerId++) {
      this.createWorker(workerId);
    }

    logger.info('Flat mode initialized', {
      workerCount: this.config.workerCount,
    });
  }

  /**
   * Create a worker
   */
  private createWorker(workerId: number, teamId?: number): Worker {
    const worker: Worker = {
      id: workerId,
      status: 'idle',
      worktreePath: '', // Set during worktree setup
      branchName: `worker-${workerId}`,
      totalTasksCompleted: 0,
      toolUseCount: 0,
    };

    this.workers.set(workerId, worker);
    return worker;
  }

  /**
   * Get all workers
   */
  getAllWorkers(): Worker[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get a worker by ID
   */
  getWorker(workerId: number): Worker | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Get workers by status
   */
  getWorkersByStatus(status: WorkerStatus): Worker[] {
    return this.getAllWorkers().filter((w) => w.status === status);
  }

  /**
   * Get idle workers
   */
  getIdleWorkers(): Worker[] {
    return this.getWorkersByStatus('idle');
  }

  /**
   * Update worker status
   */
  updateWorkerStatus(workerId: number, status: WorkerStatus): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = status;
      worker.lastActivityAt = new Date();
      logger.debug('Worker status updated', { workerId, status });
    }
  }

  /**
   * Set worker worktree path
   */
  setWorkerWorktreePath(workerId: number, path: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.worktreePath = path;
    }
  }

  /**
   * Get all teams (hierarchy mode only)
   */
  getAllTeams(): Team[] {
    return Array.from(this.teams.values());
  }

  /**
   * Get a team by ID
   */
  getTeam(teamId: number): Team | undefined {
    return this.teams.get(teamId);
  }

  /**
   * Get team for a worker
   */
  getTeamForWorker(workerId: number): Team | undefined {
    if (this.mode === 'flat') return undefined;

    for (const team of this.teams.values()) {
      if (team.workerIds.includes(workerId)) {
        return team;
      }
    }
    return undefined;
  }

  /**
   * Set team worktree path
   */
  setTeamWorktreePath(teamId: number, path: string): void {
    const team = this.teams.get(teamId);
    if (team) {
      team.worktreePath = path;
    }
  }

  /**
   * Get worker branch names
   */
  getWorkerBranchNames(): string[] {
    return this.getAllWorkers().map((w) => w.branchName);
  }

  /**
   * Get team branch names (hierarchy mode only)
   */
  getTeamBranchNames(): string[] {
    return this.getAllTeams().map((t) => t.branchName);
  }

  /**
   * Get workers for a team
   */
  getWorkersForTeam(teamId: number): Worker[] {
    const team = this.teams.get(teamId);
    if (!team) return [];

    return team.workerIds
      .map((id) => this.workers.get(id))
      .filter((w): w is Worker => w !== undefined);
  }

  /**
   * Increment task completion count
   */
  incrementTaskCount(workerId: number): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.totalTasksCompleted++;
    }
  }

  /**
   * Increment tool use count
   */
  incrementToolUseCount(workerId: number, count: number = 1): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.toolUseCount += count;
    }
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    mode: OrchestratorMode;
    totalWorkers: number;
    idleWorkers: number;
    runningWorkers: number;
    errorWorkers: number;
    totalTeams: number;
    totalTasksCompleted: number;
    totalToolUses: number;
  } {
    const workers = this.getAllWorkers();
    return {
      mode: this.mode,
      totalWorkers: workers.length,
      idleWorkers: workers.filter((w) => w.status === 'idle').length,
      runningWorkers: workers.filter((w) => w.status === 'running').length,
      errorWorkers: workers.filter((w) => w.status === 'error').length,
      totalTeams: this.teams.size,
      totalTasksCompleted: workers.reduce((sum, w) => sum + w.totalTasksCompleted, 0),
      totalToolUses: workers.reduce((sum, w) => sum + w.toolUseCount, 0),
    };
  }

  /**
   * Reset a worker (for error recovery)
   */
  resetWorker(workerId: number): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTask = undefined;
      logger.debug('Worker reset', { workerId });
    }
  }

  /**
   * Get base branch
   */
  getBaseBranch(): string {
    return this.config.baseBranch;
  }
}
