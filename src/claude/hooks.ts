/**
 * Generate Claude Code hooks configuration that sends events to the orchestrator.
 * Compatible with Claude Code 2.1.5+ hooks format.
 */

interface HookMatcher {
  hooks: Hook[];
  matcher?: string; // Optional - only for PreToolUse, PermissionRequest, PostToolUse
}

interface Hook {
  type: 'command' | 'prompt';
  command?: string;
  prompt?: string;
  timeout?: number;
}

interface ClaudeHooksConfig {
  hooks: {
    Stop?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
}

/**
 * Escape a string for safe use in a shell command within JSON.
 */
function escapeShellString(str: string): string {
  // Replace " with \" and wrap in quotes
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Generate Claude Code hooks configuration that sends events to the orchestrator.
 */
export function generateHooksConfig(
  orchestratorUrl: string,
  instanceId: string,
  workerId: number,
  instanceType: 'manager' | 'worker'
): ClaudeHooksConfig {
  const basePayload = {
    instance_id: instanceId,
    worker_id: workerId,
    instance_type: instanceType,
  };

  const payloadJson = escapeShellString(JSON.stringify(basePayload));

  // Build curl command as a single string
  const stopHookCommand = `curl -s -X POST -H Content-Type:application/json -d ${payloadJson} ${orchestratorUrl}/hooks/stop`;

  return {
    hooks: {
      // Stop hook - instance finished its task
      // Note: Stop hooks don't use matchers, they just have the "hooks" array
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: stopHookCommand,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Generate the full Claude settings.json content with hooks.
 */
export function generateClaudeSettings(
  orchestratorUrl: string,
  instanceId: string,
  workerId: number,
  instanceType: 'manager' | 'worker',
  existingSettings: Record<string, unknown> = {}
): Record<string, unknown> {
  const hooksConfig = generateHooksConfig(orchestratorUrl, instanceId, workerId, instanceType);

  return {
    ...existingSettings,
    ...hooksConfig,
  };
}
