export function pollWhileVisible(refresh, intervalMs) {
  let lastStarted = -Infinity
  let pending = false
  let stopped = false
  let timer

  async function poll() {
    clearTimeout(timer)
    if (stopped || document.visibilityState !== 'visible' || pending) return
    const remaining = lastStarted + intervalMs - Date.now()
    if (remaining > 0) {
      timer = setTimeout(poll, remaining)
      return
    }
    lastStarted = Date.now()
    pending = true
    try {
      await refresh()
    } finally {
      pending = false
      void poll()
    }
  }

  document.addEventListener('visibilitychange', poll)
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', poll)
  }
}
