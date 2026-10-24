import { isDeepStrictEqual } from 'node:util'
import type WebSocket from 'ws'
import { object, type JsonObject } from './responses-request.js'

export interface ResponseSession {
  busy: boolean
  socket?: WebSocket | undefined
  idle?: ReturnType<typeof setTimeout> | undefined
  previous?: { body: JsonObject; id: string; output: unknown[] } | undefined
  continuationDisabled: boolean
}

/** Only an exact, successful native history prefix can be omitted from a request. */
export function continuation(body: JsonObject, session: ResponseSession): JsonObject {
  const previous = session.previous
  if (!previous || session.continuationDisabled || !Array.isArray(body.input) || !Array.isArray(previous.body.input)) return body
  const { input: _input, ...properties } = body
  const { input: _previousInput, ...previousProperties } = previous.body
  const prefix = [...previous.body.input, ...previous.output]
  if (!isDeepStrictEqual(properties, previousProperties) || body.input.length < prefix.length
    || !prefix.every((item, index) => isDeepStrictEqual(item, (body.input as unknown[])[index]))) return body
  return { ...body, previous_response_id: previous.id, input: body.input.slice(prefix.length) }
}

/** Do not infer retryability from a generic 400, auth failure, or free-form message. */
export function continuationRejection(event: JsonObject): 'missing' | 'unsupported' | undefined {
  const response = object(event.response) ? event.response : undefined
  const error = object(event.error) ? event.error : response && object(response.error) ? response.error : event
  if (!['error', 'response.failed'].includes(String(event.type))) return undefined
  if ([event.status, event.status_code, error.status, error.status_code].some(status => status === 401 || status === 403)) return undefined
  if (error.code === 'previous_response_not_found') return 'missing'
  if (error.param === 'previous_response_id' && ['unsupported_parameter', 'unknown_parameter', 'unsupported_value'].includes(String(error.code))) return 'unsupported'
  return undefined
}

export function saveResponse(session: ResponseSession, body: JsonObject, event: JsonObject): void {
  const response = event.response
  session.previous = event.type === 'response.completed' && object(response)
    && typeof response.id === 'string' && response.id.length > 0 && Array.isArray(response.output) && response.output.every(object)
    ? { body, id: response.id, output: structuredClone(response.output) } : undefined
}
