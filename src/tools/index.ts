import { ToolRegistry } from './types.js';
import { readFileTool, writeFileTool, appendFileTool, listDirTool } from './fs.js';
import { applyPatchTool } from './patch.js';
import {
  runProgramTool,
  runTestsTool,
  installDepsTool,
} from './sandbox.js';
import { replaceInFileTool, codeSearchTool, analyzeErrorTool } from './edit.js';
import { addDependencyTool } from './deps.js';
import { httpFetchTool } from './net.js';
import { skillResourceTool } from './skill_resource.js';

export { ToolRegistry, isAllowedWrite } from './types.js';
export type {
  Tool,
  ToolContext,
  ToolExecutionEvent,
  ToolExecutionReporter,
  ToolPermissionDecision,
  ToolPermissionOperation,
  ToolPermissionRequest,
  ToolPermissionRequester,
  ToolResult,
} from './types.js';
export { EditGuard } from './guard.js';
export type { EditRecord } from './guard.js';
export { resolveWriteChunkBytes } from './fs.js';
export type { WriteChunkBudgetContext } from './fs.js';

export function buildDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // 读
  reg.register(readFileTool);
  reg.register(listDirTool);
  reg.register(codeSearchTool);
  // 写
  reg.register(writeFileTool);
  reg.register(appendFileTool);
  reg.register(applyPatchTool);
  reg.register(replaceInFileTool);
  reg.register(addDependencyTool);
  // Runtime tools use language-neutral names.
  reg.register(runProgramTool);
  reg.register(runTestsTool);
  reg.register(installDepsTool);
  // 网络
  reg.register(httpFetchTool);
  // 分析
  reg.register(analyzeErrorTool);
  // Agent Skills progressive-disclosure resources (read-only; activation-scoped).
  reg.register(skillResourceTool);
  return reg;
}
