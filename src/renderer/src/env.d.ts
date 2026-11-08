import type { ZenbookApi } from '../../shared/api'

declare global {
  interface Window {
    zenbook: ZenbookApi
  }
}

export {}
