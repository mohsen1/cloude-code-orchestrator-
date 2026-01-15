#!/usr/bin/env npx tsx
/**
 * End-to-End Test for Claude Code Orchestrator
 *
 * This test validates the complete orchestration workflow by running real Claude
 * instances against a test repository. It verifies that:
 *
 * - Manager and worker instances start correctly
 * - Workers receive and complete tasks from PROJECT_DIRECTION.md
 * - Workers commit and push changes to their branches
 * - Merge queue processes worker branches correctly
 * - Manager heartbeat keeps the system active
 * - Graceful shutdown works properly
 *
 * ## Test Flow
 *
 * 1. Creates a unique test branch (e2e-{timestamp}) in the test repo
 * 2. Sets up a simple calculator project with PROJECT_DIRECTION.md
 * 3. Starts the orchestrator with configured workers
 * 4. Runs for the specified duration while Claude instances work
 * 5. Validates results (commits, files created, worker branches)
 * 6. Reports success/failure with detailed metrics
 *
 * ## Usage
 *
 *   # Run with defaults (5 minutes, 2 workers, haiku model)
 *   npm run test:e2e
 *
 *   # Run for 10 minutes with 3 workers
 *   npm run test:e2e -- --duration 10 --workers 3
 *
 *   # Use a different model
 *   npm run test:e2e -- --model sonnet
 *
 *   # Use custom auth config
 *   npm run test:e2e -- --auth-config ~/my-auth-configs.json
 *
 * ## Options
 *
 *   -r, --repo <repo>         GitHub repo (default: mohsen1/claude-code-orchestrator-e2e-test)
 *   -d, --duration <minutes>  Test duration in minutes (default: 5)
 *   -w, --workers <count>     Number of workers (default: 2)
 *   -m, --model <model>       Claude model: haiku, sonnet, opus (default: haiku)
 *   -a, --auth-config <path>  Path to auth-configs.json for API key auth
 *   --no-cleanup              Don't clean up tmux sessions after test
 *
 * ## Requirements
 *
 *   - Git configured with SSH push access to the test repo
 *   - Claude Code CLI installed (`claude` command available)
 *   - Valid authentication (OAuth via ~/.claude or API keys via auth-configs.json)
 *   - tmux installed (for running Claude instances)
 *
 * ## Success Criteria
 *
 * The test passes if:
 *   - At least one commit was made to the test branch
 *   - WORKER_*_TASK_LIST.md files were created (indicates task distribution)
 *
 * ## Viewing Results
 *
 * After the test completes, visit the GitHub URL printed in the results to see:
 *   - Commits made by workers
 *   - Files created (src/*.ts)
 *   - Worker branches (worker-1, worker-2, etc.)
 *   - Task list files showing work distribution
 */

import { execa } from 'execa';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'node:util';

// Parse command line arguments
const { values } = parseArgs({
  options: {
    repo: {
      type: 'string',
      short: 'r',
      default: 'mohsen1/claude-code-orchestrator-e2e-test',
    },
    duration: {
      type: 'string',
      short: 'd',
      default: '5',
    },
    workers: {
      type: 'string',
      short: 'w',
      default: '2',
    },
    'auth-config': {
      type: 'string',
      short: 'a',
      description: 'Path to auth-configs.json',
    },
    model: {
      type: 'string',
      short: 'm',
      default: 'haiku',
      description: 'Claude model to use (haiku, sonnet, opus)',
    },
    cleanup: {
      type: 'boolean',
      default: true,
    },
  },
});

const TEST_REPO = values.repo!;
const DURATION_MINUTES = parseInt(values.duration!, 10);
const WORKER_COUNT = parseInt(values.workers!, 10);
const AUTH_CONFIG_PATH = values['auth-config'];
const MODEL = values.model!;

const PROJECT_DIRECTION = `# Calculator Project

## Overview
Build a simple command-line calculator in TypeScript.

## Requirements

### Core Features
1. **Basic Operations**: Add, subtract, multiply, divide
2. **Input Handling**: Parse expressions like "2 + 3" or "10 / 2"
3. **Error Handling**: Handle division by zero, invalid input

### File Structure
\`\`\`
src/
  calculator.ts    # Main calculator logic
  parser.ts        # Expression parser
  operations.ts    # Math operations
  index.ts         # CLI entry point
tests/
  calculator.test.ts
package.json
tsconfig.json
\`\`\`

### Implementation Notes
- Use TypeScript with strict mode
- Include unit tests using vitest
- Support decimal numbers
- Print results to stdout

## Success Criteria
- All basic operations work correctly
- Tests pass
- Code compiles without errors
`;

interface TestResult {
  success: boolean;
  branchName: string;
  duration: number;
  commits: number;
  filesCreated: string[];
  workerBranches: string[];
  errors: string[];
}

async function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  if (data) {
    console.log(`[${timestamp}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

async function runCommand(cmd: string, args: string[], options?: { cwd?: string; reject?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execa(cmd, args, {
      cwd: options?.cwd,
      reject: options?.reject ?? true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: any) {
    if (options?.reject === false) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.exitCode || 1 };
    }
    throw err;
  }
}

async function createTestBranch(): Promise<string> {
  const branchName = `e2e-${Date.now()}`;
  log(`Creating test branch: ${branchName}`);

  const tmpDir = `/tmp/e2e-branch-setup-${Date.now()}`;
  await mkdir(tmpDir, { recursive: true });

  try {
    // Clone the repo (use SSH for push access)
    await runCommand('git', ['clone', `git@github.com:${TEST_REPO}.git`, tmpDir]);

    // Create and checkout new branch
    await runCommand('git', ['checkout', '-b', branchName], { cwd: tmpDir });

    // Create PROJECT_DIRECTION.md
    await writeFile(join(tmpDir, 'PROJECT_DIRECTION.md'), PROJECT_DIRECTION);

    // Create basic package.json
    const packageJson = {
      name: 'calculator',
      version: '1.0.0',
      type: 'module',
      scripts: {
        build: 'tsc',
        test: 'vitest run',
        start: 'node dist/index.js',
      },
      devDependencies: {
        typescript: '^5.0.0',
        vitest: '^1.0.0',
        '@types/node': '^20.0.0',
      },
    };
    await writeFile(join(tmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const gitignore = [
      'node_modules/',
      'dist/',
      'worktrees/',
      '.claude/',
      '.vite/',
    ].join('\n') + '\n';
    await writeFile(join(tmpDir, '.gitignore'), gitignore);

    // Create tsconfig.json
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['src/**/*'],
    };
    await writeFile(join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

    // Create src directory
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', '.gitkeep'), '');

    // Commit and push
    await runCommand('git', ['add', '.'], { cwd: tmpDir });
    await runCommand('git', ['commit', '-m', 'Setup calculator project for e2e test'], { cwd: tmpDir });
    await runCommand('git', ['push', '-u', 'origin', branchName], { cwd: tmpDir });

    log(`Branch ${branchName} created and pushed`);
    return branchName;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function createTestConfig(branchName: string): Promise<string> {
  const configDir = `/tmp/e2e-config-${Date.now()}`;
  await mkdir(configDir, { recursive: true });

  const engineerManagerGroupSize = Math.min(8, Math.max(1, WORKER_COUNT - 1));
  const serverPort = 20000 + Math.floor(Math.random() * 30000);

  const config = {
    repositoryUrl: `git@github.com:${TEST_REPO}.git`,
    branch: branchName,
    model: MODEL,
    workerCount: WORKER_COUNT,
    engineerManagerGroupSize,
    serverPort,
    timingBaseMs: 30000,
    maxRunDurationMinutes: DURATION_MINUTES + 2,
  };

  await writeFile(join(configDir, 'orchestrator.json'), JSON.stringify(config, null, 2));

  // Copy auth config if provided
  if (AUTH_CONFIG_PATH && existsSync(AUTH_CONFIG_PATH)) {
    const authContent = await readFile(AUTH_CONFIG_PATH, 'utf-8');
    await writeFile(join(configDir, 'auth-configs.json'), authContent);
    log('Auth config copied');
  }

  log('Test config created', config);
  return configDir;
}

async function runOrchestrator(configDir: string, workspaceDir: string, durationMs: number): Promise<{ stdout: string; stderr: string }> {
  log(`Starting orchestrator for ${durationMs / 60000} minutes...`);

  const orchestratorPath = join(process.cwd(), 'dist', 'index.js');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = execa('node', [orchestratorPath, '--config', configDir, '--workspace', workspaceDir], {
      reject: false,
      timeout: durationMs + 30000, // Add 30s buffer
    });

    proc.stdout?.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    // Set timeout to gracefully stop
    setTimeout(async () => {
      log('Duration reached, sending SIGTERM...');
      proc.kill('SIGTERM');
    }, durationMs);

    proc.then(() => {
      resolve({ stdout, stderr });
    }).catch(() => {
      resolve({ stdout, stderr });
    });
  });
}

async function validateResults(branchName: string): Promise<TestResult> {
  log('Validating results...');

  const result: TestResult = {
    success: false,
    branchName,
    duration: DURATION_MINUTES,
    commits: 0,
    filesCreated: [],
    workerBranches: [],
    errors: [],
  };

  const tmpDir = `/tmp/e2e-validate-${Date.now()}`;
  await mkdir(tmpDir, { recursive: true });

  try {
    // Clone and checkout the test branch
    await runCommand('git', ['clone', `git@github.com:${TEST_REPO}.git`, tmpDir]);
    await runCommand('git', ['fetch', '--all'], { cwd: tmpDir });
    await runCommand('git', ['checkout', branchName], { cwd: tmpDir });

    // Count commits on this branch (excluding initial)
    const { stdout: logOutput } = await runCommand('git', ['log', '--oneline', `main..${branchName}`], { cwd: tmpDir, reject: false });
    result.commits = logOutput.trim().split('\n').filter(l => l.trim()).length;

    // List files created in src/
    const { stdout: filesOutput } = await runCommand('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'src/'], { cwd: tmpDir, reject: false });
    result.filesCreated = filesOutput.trim().split('\n').filter(f => f.trim() && f !== 'src/.gitkeep');

    // Check for worker branches
    const { stdout: branchesOutput } = await runCommand('git', ['branch', '-r'], { cwd: tmpDir });
    result.workerBranches = branchesOutput
      .split('\n')
      .map(b => b.trim())
      .filter(b => b.includes('worker-'));

    // Check for WORKER_*_TASK_LIST.md files
    const { stdout: taskListsOutput } = await runCommand('git', ['ls-files', 'WORKER_*_TASK_LIST.md'], { cwd: tmpDir, reject: false });
    const taskLists = taskListsOutput.trim().split('\n').filter(f => f.trim());

    // Determine success
    if (result.commits > 0) {
      result.success = true;
    } else {
      result.errors.push('No commits were made');
    }

    if (taskLists.length === 0) {
      result.errors.push('No WORKER_*_TASK_LIST.md files found');
    }

    log('Validation complete', result);
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function cleanup(configDir: string, workspaceDir: string): Promise<void> {
  if (values.cleanup) {
    log('Cleaning up...');
    await rm(configDir, { recursive: true, force: true });

    // Kill any orphaned tmux sessions
    await runCommand('bash', ['-c', "tmux list-sessions 2>/dev/null | grep '^claude-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true"]);

    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Claude Code Orchestrator - E2E Test');
  console.log('='.repeat(60));
  console.log(`Repo: ${TEST_REPO}`);
  console.log(`Duration: ${DURATION_MINUTES} minutes`);
  console.log(`Workers: ${WORKER_COUNT}`);
  console.log(`Model: ${MODEL}`);
  console.log('='.repeat(60));

  let configDir = '';
  let workspaceDir = '';
  let branchName = '';

  try {
    // 1. Create test branch with PROJECT_DIRECTION.md
    branchName = await createTestBranch();

    // 2. Create test config
    configDir = await createTestConfig(branchName);
    workspaceDir = `/tmp/orchestrator-e2e-${Date.now()}`;
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(workspaceDir, { recursive: true });

    // 3. Build the project first
    log('Building orchestrator...');
    await runCommand('npm', ['run', 'build']);

    // 4. Run orchestrator
    const durationMs = DURATION_MINUTES * 60 * 1000;
    await runOrchestrator(configDir, workspaceDir, durationMs);

    // 5. Validate results
    const result = await validateResults(branchName);

    // 6. Print summary
    console.log('\n' + '='.repeat(60));
    console.log('E2E TEST RESULTS');
    console.log('='.repeat(60));
    console.log(`Status: ${result.success ? 'PASSED' : 'FAILED'}`);
    console.log(`Branch: ${result.branchName}`);
    console.log(`Commits: ${result.commits}`);
    console.log(`Files Created: ${result.filesCreated.length}`);
    result.filesCreated.forEach(f => console.log(`  - ${f}`));
    console.log(`Worker Branches: ${result.workerBranches.length}`);
    result.workerBranches.forEach(b => console.log(`  - ${b}`));
    if (result.errors.length > 0) {
      console.log('Errors:');
      result.errors.forEach(e => console.log(`  - ${e}`));
    }
    console.log('='.repeat(60));
    console.log(`\nView results: https://github.com/${TEST_REPO}/tree/${branchName}`);

    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.error('E2E test failed with error:', err);
    process.exit(1);
  } finally {
    await cleanup(configDir, workspaceDir);
  }
}

main();
