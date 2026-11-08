/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "true" by the release workflow when the macOS build is signed and notarised. */
  readonly MAIN_VITE_MAC_SIGNED?: string
}
