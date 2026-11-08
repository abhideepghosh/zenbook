import { describe, expect, it } from 'vitest'
import { paperGeometry, parseScene, SceneParseError, serializeScene } from './scene'

describe('scene files', () => {
  it('round-trips elements, kept appState and paper, without images', () => {
    const elements = [{ id: 'a', type: 'rectangle' }]
    const json = serializeScene('page-0001', elements, { viewBackgroundColor: '#fff9db' }, 'dots')
    const data = JSON.parse(json)
    expect(data).toMatchObject({
      type: 'excalidraw',
      version: 2,
      files: {},
      zenbook: { id: 'page-0001', paper: 'dots' },
    })
    const parsed = parseScene(json)
    expect(parsed.elements).toEqual(elements)
    expect(parsed.appState).toEqual({ viewBackgroundColor: '#fff9db' })
    expect(parsed.paper).toBe('dots')
  })

  it('reads files made by excalidraw.com (embedded images, no zenbook key)', () => {
    const json = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      appState: { viewBackgroundColor: '#ffffff', zoom: { value: 2 }, theme: 'dark' },
      files: { abc: { id: 'abc', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==' } },
    })
    const parsed = parseScene(json)
    expect(parsed.paper).toBe('plain')
    expect(parsed.appState).toEqual({ viewBackgroundColor: '#ffffff' })
    expect(Object.keys(parsed.files)).toEqual(['abc'])
  })

  it('treats a missing file body as an empty page but refuses garbage', () => {
    expect(parseScene(null).elements).toEqual([])
    expect(() => parseScene('{"half":')).toThrow(SceneParseError)
    expect(() => parseScene('{"type":"other"}')).toThrow(SceneParseError)
  })
})

describe('paperGeometry', () => {
  it('scales the cell with zoom and keeps offsets within one cell', () => {
    expect(paperGeometry(0, 0, 1)).toEqual({ size: 24, x: 0, y: 0, opacity: 1 })
    const g = paperGeometry(-30, 50, 2)
    expect(g.size).toBe(48)
    expect(g.x).toBe(36) // -60 mod 48
    expect(g.y).toBe(4) // 100 mod 48
  })

  it('fades the pattern out when zoomed far out', () => {
    expect(paperGeometry(0, 0, 0.2).opacity).toBe(0)
    expect(paperGeometry(0, 0, 0.425).opacity).toBeCloseTo(0.5)
  })
})
