/** Typed errors crossing the plugin HTTP boundary and the 1flowbase client. */

/** One failure with a stable code the settings page can branch on. */
export class FlowbaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'FlowbaseError'
  }
}

/** Normalize an unknown thrown value into a FlowbaseError. */
export function asFlowbaseError(error: unknown): FlowbaseError {
  if (error instanceof FlowbaseError) return error
  if (error instanceof Error) return new FlowbaseError('internal', error.message, undefined, { cause: error })
  return new FlowbaseError('internal', String(error), undefined, { cause: error })
}
