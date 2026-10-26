export default class EagleApiError extends Error {}

/** Eagle answered that the item doesn't exist. */
export class EagleNotFoundError extends EagleApiError {}

/** The request never reached Eagle; `detail` holds the engine error for logs only. */
export class EagleUnreachableError extends EagleApiError {
  constructor(readonly detail: string) {
    super("Couldn't reach Eagle. Make sure Eagle is open.")
  }
}
