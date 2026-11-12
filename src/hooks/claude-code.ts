import { captureMedia, type CaptureOptions } from '../capture.js';

/** PostToolUse stdin payload fields this hook reads. */
export interface ClaudeCodePostToolUse {
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_response?: unknown;
}

/**
 * Claude Code PostToolUse handler. Returns the JSON to print on stdout, or undefined to leave the
 * result untouched. Uses `hookSpecificOutput.updatedToolOutput`, which Claude Code applies to built-in
 * and MCP tools; captureMedia only swaps strings and content blocks, so built-in output keeps its shape.
 */
export async function handleClaudeCodePostToolUse(
  payload: ClaudeCodePostToolUse,
  options: CaptureOptions,
): Promise<unknown | undefined> {
  if (payload.hook_event_name && payload.hook_event_name !== 'PostToolUse') return undefined;
  if (payload.tool_response === undefined) return undefined;
  const result = await captureMedia(payload.tool_response, { ...options, source: payload.tool_name ?? options.source });
  if (!result.captured.length && !result.dropped) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: result.value } };
}
