import type { KeyboardEvent, PointerEvent } from 'react'
import { setPrefs } from '../store'
import styles from './ui.module.css'

interface Props {
  side: 'sidebar' | 'notes'
  width: number
  min: number
  max: number
}

const KEY_STEP = 16 // px per arrow key press

/**
 * Drag to resize a panel. While dragging only a CSS variable changes (no React
 * renders); the final width is saved when the pointer is released. The arrow keys
 * resize too, while the handle has focus.
 */
export function ResizeHandle({ side, width, min, max }: Props) {
  const variable = side === 'sidebar' ? '--sidebar-width' : '--notes-width'
  const direction = side === 'sidebar' ? 1 : -1
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)))
  const save = (w: number) => setPrefs(side === 'sidebar' ? { sidebarWidth: w } : { notesWidth: w })
  // The app element sets these variables inline, so live changes must go there too.
  const host = (handle: HTMLElement) =>
    handle.closest<HTMLElement>('[data-sidebar]') ?? document.documentElement

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let next = width
    const target = host(handle)
    const html = document.documentElement
    html.dataset.resizing = 'true'
    const move = (ev: globalThis.PointerEvent) => {
      next = clamp(width + (ev.clientX - startX) * direction)
      target.style.setProperty(variable, `${next}px`)
    }
    const end = (commit: boolean) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel)
      handle.removeEventListener('lostpointercapture', up)
      delete html.dataset.resizing
      if (commit) save(next)
      else target.style.setProperty(variable, `${width}px`)
    }
    const up = () => end(true)
    const cancel = () => end(false)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel)
    // Fires after pointerup too; end() removed it by then, so it only catches lost captures.
    handle.addEventListener('lostpointercapture', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation() // Excalidraw (on document) would nudge selected shapes
    const delta = (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP) * direction
    const next = clamp(width + delta)
    if (next !== width) save(next)
  }

  return (
    <div
      className={styles.resize}
      data-side={side}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={side === 'sidebar' ? 'Resize sidebar' : 'Resize notes'}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        const initial = side === 'sidebar' ? 248 : 340
        host(e.currentTarget).style.setProperty(variable, `${initial}px`)
        save(initial)
      }}
    />
  )
}
