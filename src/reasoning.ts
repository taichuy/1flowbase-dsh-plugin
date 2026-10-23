import type { LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { FlowbaseError } from './errors.js'
import type { ModelReasoning } from './shared/api.js'

/** Validate catalogue/state metadata at its JSON boundary, retaining provider-owned effort ids. */
export function parseReasoning(value: unknown): { reasoning?: ModelReasoning } {
  if (value === undefined || value === null) return {}
  const invalid = (): never => { throw new FlowbaseError('model/invalid-reasoning', 'Invalid model reasoning metadata') }
  if (typeof value !== 'object' || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.supported_efforts)
    || !raw.supported_efforts.every((effort: unknown) => typeof effort === 'string' && effort.trim().length > 0)) return invalid()
  const efforts: string[] = [...new Set<string>(raw.supported_efforts)]
  const defaultEffort = raw.default_effort
  if (defaultEffort !== undefined && defaultEffort !== null
    && (typeof defaultEffort !== 'string' || !efforts.includes(defaultEffort))) return invalid()
  if (efforts.length === 0) return {}
  return { reasoning: {
    supported_efforts: efforts,
    ...(typeof defaultEffort === 'string' ? { default_effort: defaultEffort } : {}),
  } }
}

/** Translate the application contract into DSH's native selector metadata. */
export function dshReasoning(reasoning: ModelReasoning | undefined): { reasoning?: LlmModelReasoningInfo } {
  if (reasoning === undefined) return {}
  return { reasoning: {
    efforts: reasoning.supported_efforts.map(id => ({ id: id as ReasoningEffortId, name: id })),
    ...(reasoning.default_effort === undefined ? {} : { defaultEffort: reasoning.default_effort as ReasoningEffortId }),
  } }
}
