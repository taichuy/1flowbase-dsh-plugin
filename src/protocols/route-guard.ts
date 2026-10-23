import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertCompactRoute } from './compact-block.js'

/** Owned adapters validate captured settings, foreign adapters cannot replay our checkpoints. */
export function guardForeignCompactRoute(options: GenerateOptions, ownsRoute: boolean): void {
  if (!ownsRoute) assertCompactRoute(options, undefined)
}
