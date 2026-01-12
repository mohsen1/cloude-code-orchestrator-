import { stringify } from 'yaml';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger.js';

interface ComposeService {
  image: string;
  container_name: string;
  environment: Record<string, string>;
  volumes: string[];
  networks: string[];
  labels: Record<string, string>;
  restart: string;
  tty: boolean;
  stdin_open: boolean;
  extra_hosts?: string[];
}

interface ComposeConfig {
  version: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { driver: string }>;
  volumes: Record<string, Record<string, never>>;
}

export class ComposeGenerator {
  generateCompose(opts: {
    workerCount: number;
    orchestratorUrl: string;
    repoUrl: string;
    branch: string;
    configDir: string;
    useApiKey?: boolean;
  }): ComposeConfig {
    const services: Record<string, ComposeService> = {};

    // Manager service
    services['manager'] = this.createService({
      name: 'manager',
      workerId: 0,
      instanceType: 'manager',
      totalWorkers: opts.workerCount,
      orchestratorUrl: opts.orchestratorUrl,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      configDir: opts.configDir,
      useApiKey: opts.useApiKey,
    });

    // Worker services
    for (let i = 1; i <= opts.workerCount; i++) {
      services[`worker-${i}`] = this.createService({
        name: `worker-${i}`,
        workerId: i,
        instanceType: 'worker',
        totalWorkers: opts.workerCount,
        orchestratorUrl: opts.orchestratorUrl,
        repoUrl: opts.repoUrl,
        branch: opts.branch,
        configDir: opts.configDir,
        useApiKey: opts.useApiKey,
      });
    }

    return {
      version: '3.8',
      services,
      networks: {
        orchestrator: {
          driver: 'bridge',
        },
      },
      volumes: {
        'repo-data': {},
      },
    };
  }

  private createService(opts: {
    name: string;
    workerId: number;
    instanceType: 'manager' | 'worker';
    totalWorkers: number;
    orchestratorUrl: string;
    repoUrl: string;
    branch: string;
    configDir: string;
    useApiKey?: boolean;
  }): ComposeService {
    const environment: Record<string, string> = {
      WORKER_ID: opts.workerId.toString(),
      INSTANCE_TYPE: opts.instanceType,
      TOTAL_WORKERS: opts.totalWorkers.toString(),
      ORCHESTRATOR_URL: opts.orchestratorUrl,
      REPO_URL: opts.repoUrl,
      BRANCH: opts.branch,
    };

    // Pass API key from host environment to container
    if (process.env.ANTHROPIC_API_KEY) {
      environment.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    const volumes: string[] = [
      'repo-data:/repo', // Shared repo with .git for worktrees
    ];

    if (!opts.useApiKey) {
      // Mount config directory read-only
      volumes.push(`${opts.configDir}/${opts.workerId}:/claude-config:ro`);
    }

    return {
      image: 'claude-code-orchestrator:latest',
      container_name: `claude-${opts.name}`,
      environment,
      volumes,
      networks: ['orchestrator'],
      labels: {
        'orchestrator.instance': opts.name,
        'orchestrator.type': opts.instanceType,
        'orchestrator.worker_id': opts.workerId.toString(),
      },
      restart: 'unless-stopped',
      tty: true,
      stdin_open: true,
      // Allow container to reach host for hook callbacks
      extra_hosts: ['host.docker.internal:host-gateway'],
    };
  }

  async writeComposeFile(path: string, config: ComposeConfig): Promise<void> {
    const yamlContent = stringify(config, {
      lineWidth: 0, // Don't wrap long lines
    });
    await writeFile(path, yamlContent);
    logger.info(`Generated docker-compose file: ${path}`);
  }
}
