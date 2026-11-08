// Set ZENBOOK_PERF=1 to log start-up timings (milliseconds since process start).
const enabled = Boolean(process.env.ZENBOOK_PERF)

export function perf(label: string): void {
  if (enabled) console.log(`[perf] ${label}: ${Math.round(performance.now())} ms`)
}
