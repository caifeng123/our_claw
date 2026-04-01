import type { Module, QueryContext } from '../module-system/types.js'
import type { EventHandlers } from '../agent/types/agent.js'
import { getVisionGuardConfig } from '../agent/engine/vision-guard.js'

export function createVisionGuardModule(): Module {
  const guard = getVisionGuardConfig()

  return {
    name: 'vision-guard',
    priority: 10,

    // SDK Slots
    hooks: guard.hooks,
    agents: guard.agents,
    canUseTool: guard.canUseTool,
    allowedTools: guard.additionalAllowedTools,
  }
}
