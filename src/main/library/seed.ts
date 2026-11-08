import type { Library } from './library'
import { welcomeNotes, welcomeScene } from './sample'

/** Gives a brand-new library one Space with a welcome page, so it never opens empty. */
export async function seedLibrary(lib: Library): Promise<void> {
  if (lib.model.spaces.length > 0) return
  const space = await lib.create('space', null, 'Personal')
  const chapter = await lib.create('chapter', space, 'Start here')
  const page = await lib.create('page', chapter, 'Welcome')
  await lib.saveScene(page, welcomeScene(page))
  await lib.saveNotes(page, welcomeNotes)
  await lib.create('page', chapter, 'Blank page')
}
