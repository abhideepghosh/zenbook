import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/base.css'

// Excalidraw's fonts ship with the app (copied to /fonts). This must be set before the
// Excalidraw chunk is imported, so it registers local font URLs instead of a CDN.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/'

// Lets CSS make room for the macOS traffic lights before React renders anything.
document.documentElement.dataset.platform = window.zenbook.platform

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
