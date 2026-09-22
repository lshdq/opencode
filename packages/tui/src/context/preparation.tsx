import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"

// Rendering is independent of preparation. Every task is observed immediately,
// while each submit owns its cancellation (never cancelling shared installation).
export function createPreparation() {
  const pending = new Set<Promise<unknown>>()
  const failures = new Map<Promise<unknown>, { error: unknown }>()
  const [count, setCount] = createSignal(0)
  const [failure, setFailure] = createSignal<{ error: unknown }>()
  const lifetime = new AbortController()
  return {
    get ready() {
      return count() === 0 && !failure()
    },
    get error() {
      return failure()?.error
    },
    track<T>(task: Promise<T>, options: { fatal?: boolean; signal?: AbortSignal } = {}) {
      // A route may stop needing work which is still in flight. Resolve its
      // barrier too: deleting from pending alone strands existing waiters.
      const barrier = Promise.withResolvers<T | undefined>()
      const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])
      const cancel = () => {
        pending.delete(barrier.promise)
        failures.delete(barrier.promise)
        barrier.resolve(undefined)
        if (lifetime.signal.aborted) return
        setFailure(failures.values().next().value)
        setCount(pending.size)
      }
      pending.add(barrier.promise)
      setCount(pending.size)
      if (signal.aborted) cancel()
      if (!signal.aborted) signal.addEventListener("abort", cancel, { once: true })
      // Tasks can fail before any submit starts waiting.
      void barrier.promise.catch(() => {})
      void task.then(
        (value) => {
          if (signal.aborted) return
          signal.removeEventListener("abort", cancel)
          pending.delete(barrier.promise)
          setCount(pending.size)
          barrier.resolve(value)
        },
        (error) => {
          if (signal.aborted) return
          pending.delete(barrier.promise)
          if (options.fatal !== false) {
            failures.set(barrier.promise, { error: error ?? new Error("Startup preparation failed") })
            setFailure(failures.values().next().value)
          }
          // Retain a scoped failure only as long as its owner is still active.
          if (options.fatal === false || !options.signal) signal.removeEventListener("abort", cancel)
          setCount(pending.size)
          barrier.reject(error)
        },
      )
      return task
    },
    async wait(signal: AbortSignal) {
      const combined = AbortSignal.any([signal, lifetime.signal])
      combined.throwIfAborted()
      let cancel: () => void = () => {}
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(combined.reason)
        combined.addEventListener("abort", cancel, { once: true })
      })
      try {
        while (pending.size) {
          const failed = failure()
          if (failed) throw failed.error
          await Promise.race([Promise.all([...pending]), aborted])
        }
        combined.throwIfAborted()
        const failed = failure()
        if (failed) throw failed.error
      } finally {
        combined.removeEventListener("abort", cancel)
      }
    },
    dispose() {
      lifetime.abort()
      pending.clear()
      failures.clear()
    },
  }
}

// Isolated component hosts have no startup work; the application always supplies
// a scoped provider, so concurrent renderers never share pending work.
const Context = createContext<ReturnType<typeof createPreparation>>()
export function PreparationProvider(props: ParentProps) {
  const value = createPreparation()
  onCleanup(() => value.dispose())
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
export function usePreparation() {
  const context = useContext(Context)
  if (context) return context
  const value = createPreparation()
  onCleanup(() => value.dispose())
  return value
}
