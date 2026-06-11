// Registers the agent's read tools into the shared anthropic
// tool-registry exactly once (server boot calls this; tests reset the
// registry between cases). Write tools arrive in Wave B as adapters over
// ai-agent/tools.ts so one BullMQ executor runs everything.

import {
  getTool,
  registerTool,
} from "../../../integrations/anthropic/tool-registry.js";
import { buildAgentReadTools } from "./read-tools.js";

export function registerAgentReadTools(): void {
  for (const def of buildAgentReadTools()) {
    if (!getTool(def.name)) registerTool(def);
  }
}
