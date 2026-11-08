import { useEffect, useRef } from 'react'
import { commitRename } from '../commands'
import { set } from '../store'

/** Inline rename: Enter or blur saves, Esc cancels. Used for pages, chapters and spaces. */
export function RenameInput({
  id,
  name,
  className,
  onDone,
}: {
  id: string
  name: string
  className?: string
  onDone?: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save && ref.current && ref.current.value.trim() !== name)
      void commitRename(id, ref.current.value)
    else set({ renamingId: null })
    onDone?.()
  }

  return (
    <input
      ref={ref}
      className={className}
      defaultValue={name}
      aria-label="Name"
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
