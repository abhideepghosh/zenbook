import type { PointerEvent } from 'react'
import { setPrefs } from '../store'
import styles from './ui.module.css'

interface Props {
  side: 'sidebar' | 'notes'
  width: number
  min: number
  max: number
}

/**
 * Drag to resize a panel. While dragging only a CSS variable changes (no React
 * renders); the final width is saved when the pointer is released.
 */
export function ResizeHandle({ side, width, min, max }: Props) {
  const variable = side === 'sidebar' ? '--sidebar-width' : '--notes-width'
  const direction = side === 'sidebar' ? 1 : -1

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    let next = width
    const root = document.documentElement
    root.dataset.resizing = 'true'
    const move = (ev: globalThis.PointerEvent) => {
      next = Math.round(Math.max(min, Math.min(max, width + (ev.clientX - startX) * direction)))
      root.style.setProperty(variable, `${next}px`)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      delete root.dataset.resizing
      setPrefs(side === 'sidebar' ? { sidebarWidth: next } : { notesWidth: next })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  return (
    <div
      className={styles.resize}
      data-side={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'sidebar' ? 'Resize sidebar' : 'Resize notes'}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const initial = side === 'sidebar' ? 248 : 340
        document.documentElement.style.setProperty(variable, `${initial}px`)
        setPrefs(side === 'sidebar' ? { sidebarWidth: initial } : { notesWidth: initial })
      }}
    />
  )
}
