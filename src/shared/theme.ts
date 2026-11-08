// Colours the main process needs before any CSS exists: the window background
// (to avoid a white flash) and the Windows title-bar controls.
// Keep in sync with src/renderer/src/styles/tokens.css.
export const windowColors = {
  light: { bg: '#fbfaf8', text: '#24231f' },
  dark: { bg: '#1a1a19', text: '#e9e7e2' },
} as const
