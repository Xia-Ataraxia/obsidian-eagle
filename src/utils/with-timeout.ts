/** Resolves to `fallback` if `promise` has not settled within `ms`; the underlying work is not cancelled. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = window.setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    window.clearTimeout(timer)
  }
}
