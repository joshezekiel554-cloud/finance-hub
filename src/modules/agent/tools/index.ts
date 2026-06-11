// Registers the agent's tools into the shared anthropic tool-registry
// exactly once (server boot calls this; tests reset the registry between
// cases). Read tools execute inline in the loop; write tools are
// DECLARATIONS ONLY — the loop proposalizes them and the ai-agent BullMQ
// executor runs the real implementations after operator approve.

import {
  getTool,
  registerTool,
} from "../../../integrations/anthropic/tool-registry.js";
import { buildAgentReadTools } from "./read-tools.js";
import { buildAgentWriteToolDeclarations } from "./write-tools.js";
import { buildAgentArtifactTools } from "./artifact-tools.js";

export function registerAgentReadTools(): void {
  for (const def of buildAgentReadTools()) {
    if (!getTool(def.name)) registerTool(def);
  }
}

export function registerAgentWriteToolDeclarations(): void {
  for (const def of buildAgentWriteToolDeclarations()) {
    if (!getTool(def.name)) registerTool(def);
  }
}

export function registerAgentArtifactTools(): void {
  for (const def of buildAgentArtifactTools()) {
    if (!getTool(def.name)) registerTool(def);
  }
}

export function registerAllAgentTools(): void {
  registerAgentReadTools();
  registerAgentWriteToolDeclarations();
  registerAgentArtifactTools();
}
