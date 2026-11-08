import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// "Live Markdown": the note is plain Markdown text, styled in place. Headings get
// larger, emphasis renders, the syntax markers fade into the background, and task
// boxes become real checkboxes. What you see is exactly what's in the .md file.

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.4em', fontWeight: '650', lineHeight: '1.35' },
  { tag: t.heading2, fontSize: '1.2em', fontWeight: '650' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '650' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  {
    tag: t.link,
    color: 'var(--text)',
    textDecoration: 'underline',
    textDecorationColor: 'var(--text-faint)',
  },
  { tag: t.url, color: 'var(--text-muted)' },
  {
    tag: t.monospace,
    fontFamily: 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: '0.92em',
  },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  // #, **, _, >, -, ` and friends: present, but quiet.
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-faint)' },
])

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--text-notes)',
    color: 'var(--text)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-ui)',
    lineHeight: 'var(--leading-notes)',
    padding: '4px 0 48px',
  },
  '.cm-content': { padding: '0 24px', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--text)', borderLeftWidth: '1.5px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent) !important',
  },
  '.cm-placeholder': { color: 'var(--text-faint)', fontStyle: 'normal' },
  '.cm-task': {
    width: '14px',
    height: '14px',
    margin: '0 4px 0 0',
    verticalAlign: '-2px',
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
  '.cm-task-done': { color: 'var(--text-muted)', textDecoration: 'line-through' },
})

class TaskBox extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(other: TaskBox): boolean {
    return other.checked === this.checked
  }
  toDOM(): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Done' : 'To do')
    return box
  }
  override ignoreEvent(): boolean {
    return false
  }
}

function taskDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'TaskMarker') return
        const checked = /x/i.test(view.state.sliceDoc(node.from, node.to))
        ranges.push(Decoration.replace({ widget: new TaskBox(checked) }).range(node.from, node.to))
        if (checked) {
          const line = view.state.doc.lineAt(node.from)
          if (node.to + 1 < line.to)
            ranges.push(Decoration.mark({ class: 'cm-task-done' }).range(node.to + 1, line.to))
        }
      },
    })
  }
  return Decoration.set(ranges, true)
}

/** Renders `- [ ]` / `- [x]` as clickable checkboxes that edit the underlying text. */
const tasks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = taskDecorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = taskDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement
        if (!target.classList.contains('cm-task')) return false
        const pos = view.posAtDOM(target)
        const text = view.state.sliceDoc(pos, pos + 3)
        const next = /x/i.test(text) ? '[ ]' : '[x]'
        view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } })
        event.preventDefault()
        return true
      },
    },
  },
)

/** Everything a note's EditorState needs; `onChange` fires on every document change. */
export function notesExtensions(onChange: (doc: string) => void): Extension[] {
  return [
    history(),
    markdown({ base: markdownLanguage, addKeymap: true }),
    syntaxHighlighting(highlight),
    tasks,
    keymap.of([
      ...markdownKeymap,
      { key: 'Tab', run: indentMore, shift: indentLess },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocapitalize: 'sentences',
      'aria-label': 'Notes',
    }),
    placeholder('Notes for this page…'),
    theme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
    }),
  ]
}

export function createState(doc: string, onChange: (doc: string) => void): EditorState {
  return EditorState.create({ doc, extensions: notesExtensions(onChange) })
}

export { EditorView, EditorState }
