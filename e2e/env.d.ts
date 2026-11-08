import type { ZenbookApi } from '../src/shared/api'

declare global {
  interface Window {
    zenbook: ZenbookApi
  }
}

export {}
