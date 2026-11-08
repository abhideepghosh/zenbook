import { SOURCE } from './model'

// The welcome page of a new library. Elements are written as minimal skeletons;
// Excalidraw's restoreElements() fills in every missing property when the page opens.

const INK = '#1e1e1e'
const SOFT = '#868e96'

let seq = 0
const id = () => `welcome-${(seq++).toString(36).padStart(4, '0')}`

function text(x: number, y: number, value: string, fontSize = 20, color = INK) {
  const lines = value.split('\n')
  return {
    id: id(),
    type: 'text',
    x,
    y,
    width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.55,
    height: lines.length * fontSize * 1.25,
    text: value,
    originalText: value,
    fontSize,
    fontFamily: 5, // Excalifont, the hand-drawn font
    textAlign: 'left',
    verticalAlign: 'top',
    lineHeight: 1.25,
    strokeColor: color,
    roughness: 1,
    seed: 1 + seq,
    version: 1,
    versionNonce: seq,
  }
}

function box(x: number, y: number, width: number, height: number, background: string) {
  return {
    id: id(),
    type: 'rectangle',
    x,
    y,
    width,
    height,
    strokeColor: INK,
    backgroundColor: background,
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 1,
    roundness: { type: 3 },
    seed: 7 + seq,
    version: 1,
    versionNonce: seq,
  }
}

function arrow(x: number, y: number, dx: number, dy: number) {
  return {
    id: id(),
    type: 'arrow',
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    strokeColor: SOFT,
    strokeWidth: 1,
    roughness: 1,
    endArrowhead: 'arrow',
    seed: 11 + seq,
    version: 1,
    versionNonce: seq,
  }
}

export function welcomeScene(pageId: string): string {
  seq = 0
  const elements = [
    text(80, 60, 'Welcome to Zenbook', 36),
    text(80, 115, 'A quiet place to think, sketch and write.', 20, SOFT),

    box(80, 190, 250, 120, '#ebfbee'),
    text(100, 210, 'Draw here\nshapes, arrows,\nhandwriting', 20),

    box(380, 190, 250, 120, '#e7f5ff'),
    text(400, 210, 'Write there\nthe notes panel\non the right →', 20),

    box(680, 190, 250, 120, '#fff9db'),
    text(700, 210, 'Find anything\nCtrl/⌘ K searches\npages and drawings', 20),

    arrow(330, 250, 50, 0),
    arrow(630, 250, 50, 0),

    text(80, 360, 'Everything saves by itself.', 20, SOFT),
    text(80, 392, 'Your pages are plain files in the folder you chose.', 20, SOFT),
  ]
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
    files: {},
    zenbook: { id: pageId, paper: 'dots' },
  })
}

export const welcomeNotes = `# Welcome

Every page is a canvas and a note. This is the note.

## A few keys

- **Ctrl/⌘ K**: jump to any page, or run any action
- **Ctrl/⌘ N**: new page
- **Ctrl/⌘ .**: focus mode (Esc to leave)
- **Ctrl/⌘ \\\\**: hide the sidebar, **Ctrl/⌘ J**: hide these notes
- **F2**: rename a page

## Try

- [ ] Draw something on the canvas
- [ ] Right-click a page in the sidebar
- [ ] Drag a page to reorder it

Your library is a normal folder. Put it in Dropbox, iCloud Drive, OneDrive or a git repo
to have it on every computer.
`
