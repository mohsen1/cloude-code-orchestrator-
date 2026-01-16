import chalk from 'chalk';
import { rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';

interface CleanupOptions {
  config?: string;
}

/**
 * Clean up orphaned worktrees and temporary files from previous orchestrator runs
 */
export async function cleanupCommand(options: CleanupOptions): Promise<void> {
  console.log(chalk.cyan('Cleaning up Claude Code Orchestrator resources...\n'));

  // Clean up default workspace locations
  const workspacePaths = [
    '/tmp/orchestrator-workspace',
    join(process.cwd(), 'worktrees'),
  ];

  // If config is provided, also look for workspaces in config directory
  if (options.config && existsSync(options.config)) {
    const configWorkspace = join(options.config, 'workspace');
    if (existsSync(configWorkspace)) {
      workspacePaths.push(configWorkspace);
    }
  }

  // Clean up workspaces
  console.log(chalk.yellow('Cleaning up worktrees...'));
  let cleaned = 0;

  for (const workspacePath of workspacePaths) {
    if (!existsSync(workspacePath)) continue;

    try {
      const worktreesDir = join(workspacePath, 'worktrees');
      if (existsSync(worktreesDir)) {
        const entries = await readdir(worktreesDir);
        for (const entry of entries) {
          const entryPath = join(worktreesDir, entry);
          console.log(chalk.gray(`  Removing: ${entryPath}`));
          await rm(entryPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      // Also try to remove the workspace itself if it's temp
      if (workspacePath.includes('/tmp/')) {
        await rm(workspacePath, { recursive: true, force: true });
        console.log(chalk.gray(`  Removed workspace: ${workspacePath}`));
      }
    } catch (error) {
      console.log(chalk.yellow(`  Warning: Could not fully clean ${workspacePath}`));
    }
  }

  if (cleaned === 0) {
    console.log(chalk.gray('  No worktrees found to clean'));
  }
  console.log(chalk.green('  Done\n'));

  // Clean up git worktrees in current directory (if it's a git repo)
  console.log(chalk.yellow('Pruning git worktrees...'));
  try {
    await execa('git', ['worktree', 'prune'], { reject: false });
    console.log(chalk.gray('  Pruned stale worktree entries'));
    console.log(chalk.green('  Done\n'));
  } catch {
    console.log(chalk.gray('  Not a git repository or no worktrees to prune\n'));
  }

  // Clean up temporary files
  console.log(chalk.yellow('Cleaning up temporary files...'));
  const tmpPatterns = [
    '/tmp/cco-*',
    '/tmp/cco-workspace-*',
    '/tmp/v2-orchestrator-*',
  ];

  let tmpCleaned = 0;
  for (const pattern of tmpPatterns) {
    const baseDir = '/tmp';
    const prefix = pattern.replace('/tmp/', '').replace('*', '');

    try {
      if (existsSync(baseDir)) {
        const entries = await readdir(baseDir);
        for (const entry of entries) {
          if (entry.startsWith(prefix)) {
            const entryPath = join(baseDir, entry);
            console.log(chalk.gray(`  Removing: ${entryPath}`));
            await rm(entryPath, { recursive: true, force: true });
            tmpCleaned++;
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  if (tmpCleaned === 0) {
    console.log(chalk.gray('  No temporary files found'));
  }
  console.log(chalk.green('  Done\n'));

  // Clean up git temporary pack files (these can accumulate to GB+ during runs)
  console.log(chalk.yellow('Cleaning up git temporary pack files...'));
  let packsCleaned = 0;
  const varFolders = '/var/folders';

  try {
    // Find all cco-workspace directories in /var/folders (macOS temp location)
    const result = await execa('find', [varFolders, '-maxdepth', '5', '-type', 'd', '-name', 'cco-workspace-*'], { reject: false });

    if (result.stdout) {
      const workspaceDirs = result.stdout.split('\n').filter(Boolean);
      for (const wsDir of workspaceDirs) {
        const packDir = join(wsDir, '.git', 'objects', 'pack');
        if (existsSync(packDir)) {
          try {
            const packFiles = await readdir(packDir);
            for (const file of packFiles) {
              if (file.startsWith('tmp_pack_')) {
                const filePath = join(packDir, file);
                await rm(filePath, { force: true });
                packsCleaned++;
              }
            }
            // Run git gc in the workspace if it exists
            if (existsSync(join(wsDir, '.git'))) {
              await execa('git', ['gc', '--prune=now'], { cwd: wsDir, reject: false, timeout: 60000 });
            }
          } catch {
            // Ignore individual file errors
          }
        }
      }
    }
  } catch {
    // Ignore find errors
  }

  // Also check /tmp for workspaces
  try {
    const tmpEntries = await readdir('/tmp');
    for (const entry of tmpEntries) {
      if (entry.startsWith('cco-workspace-')) {
        const packDir = join('/tmp', entry, '.git', 'objects', 'pack');
        if (existsSync(packDir)) {
          const packFiles = await readdir(packDir);
          for (const file of packFiles) {
            if (file.startsWith('tmp_pack_')) {
              await rm(join(packDir, file), { force: true });
              packsCleaned++;
            }
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  if (packsCleaned > 0) {
    console.log(chalk.gray(`  Removed ${packsCleaned} temporary pack files`));
  } else {
    console.log(chalk.gray('  No temporary pack files found'));
  }
  console.log(chalk.green('  Done\n'));

  console.log(chalk.green('✓ Cleanup complete!'));
}
