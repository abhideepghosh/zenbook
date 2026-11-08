import { Excalidraw, MainMenu, serializeLibraryAsJSON, WelcomeScreen } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
  UIOptions,
} from '@excalidraw/excalidraw/types'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { PAPERS, type Paper } from '../../../shared/api'
import { reveal } from '../commands'
import { useStore } from '../store'
import '../styles/excalidraw.css'
import styles from './Canvas.module.css'
import { canvas } from './controller'
import { paperGeometry } from './scene'

/** A module constant, so Excalidraw never re-renders because of a new options object. */
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: {
    loadScene: false, // would replace the page; pages come from the sidebar
    saveToActiveFile: false,
    toggleTheme: false, // follows the app theme
    changeViewBackgroundColor: false, // Zenbook pages use paper instead
    clearCanvas: true,
    saveAsImage: true,
    export: { saveFileToDisk: true },
  },
  // The shape library always opens as an overlay, so it never competes with the notes panel.
  dockedSidebarBreakpoint: 100_000,
}

const paperLabel: Record<Paper, string> = {
  plain: 'Plain',
  dots: 'Dotted',
  lines: 'Lined',
  grid: 'Squared',
}

async function loadInitialData(): Promise<ExcalidrawInitialDataState> {
  let libraryItems: LibraryItems = []
  try {
    const text = await window.zenbook.library.loadShapes()
    if (text) {
      const data = JSON.parse(text) as { libraryItems?: LibraryItems; library?: LibraryItems }
      libraryItems = data.libraryItems ?? data.library ?? []
    }
  } catch {
    // An unreadable shape library just starts empty; the file is left alone.
  }
  return { appState: { viewBackgroundColor: 'transparent' }, libraryItems }
}

let shapesTimer: ReturnType<typeof setTimeout> | undefined
let shapesReady = false
function saveShapes(items: LibraryItems): void {
  // Excalidraw reports the initial library too; only persist real changes.
  if (!shapesReady) {
    shapesReady = true
    return
  }
  clearTimeout(shapesTimer)
  shapesTimer = setTimeout(
    () => void window.zenbook.library.saveShapes(serializeLibraryAsJSON(items)),
    500,
  )
}

function onChange(elements: readonly ExcalidrawElement[], appState: AppState): void {
  canvas.onChange(elements, appState)
}

function PaperLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const [paper, setPaper] = useState<Paper>(canvas.currentPaper())
  useEffect(() => canvas.onPaperChange(setPaper), [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    // Scroll and zoom update the pattern with direct style writes: no React render.
    return canvas.onViewportChange((scrollX, scrollY, zoom) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const g = paperGeometry(scrollX, scrollY, zoom)
        el.style.setProperty('--paper-size', `${g.size}px`)
        el.style.setProperty('--paper-x', `${g.x}px`)
        el.style.setProperty('--paper-y', `${g.y}px`)
        el.style.setProperty('--paper-opacity', String(g.opacity))
      })
    })
  }, [])
  return <div ref={ref} className={styles.paper} data-paper={paper} aria-hidden="true" />
}

function PaperMenuItems() {
  const [paper, setPaper] = useState<Paper>(canvas.currentPaper())
  useEffect(() => canvas.onPaperChange(setPaper), [])
  return (
    <MainMenu.Group title="Paper">
      {PAPERS.map((p) => (
        <MainMenu.Item key={p} onSelect={() => canvas.setPaper(p)} selected={paper === p}>
          {paperLabel[p]}
        </MainMenu.Item>
      ))}
    </MainMenu.Group>
  )
}

const mod = window.zenbook.platform === 'darwin' ? '⌘' : 'Ctrl'

function Canvas() {
  const theme = useStore((s) => (s.dark ? 'dark' : 'light'))
  const focus = useStore((s) => s.focus)
  const [initialData] = useState(loadInitialData)

  const onApi = useCallback((api: ExcalidrawImperativeAPI) => canvas.attach(api), [])
  useEffect(() => () => canvas.detach(), [])

  // Load whichever page becomes current.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.pageId && s.pageId !== prev.pageId) void canvas.load(s.pageId)
      }),
    [],
  )

  return (
    <div className={styles.wrap}>
      <PaperLayer />
      <Excalidraw
        excalidrawAPI={onApi}
        initialData={initialData}
        onChange={onChange}
        onScrollChange={canvas.emitViewport}
        onLibraryChange={saveShapes}
        theme={theme}
        zenModeEnabled={focus}
        UIOptions={UI_OPTIONS}
        langCode="en"
        autoFocus
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.Separator />
          <PaperMenuItems />
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => void reveal()}>
            {window.zenbook.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder'}
          </MainMenu.Item>
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>
              A blank page. Draw anything, or press {mod} K to jump elsewhere.
            </WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  )
}

export default memo(Canvas)
