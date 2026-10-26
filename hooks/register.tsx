import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage, PastedText } from '../types'
import { afterImage, blockCells, drawsPictures, fitRow, fitTextTiles, imageNumbers, pngSize, removeImage, TEXT_TILE_COLUMNS } from './layout'
import type { Size } from './layout'
import { editorRows, expandNotes, lineCount, matchPastes, noteTag, preview, removeTag, replaceTag, textTags } from './pastes'
import type { TextKind } from './pastes'
import { decodeThumb } from './png'
import type { Thumb } from './png'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200
// The pane the pasted-text editor draws in.
const EDITOR = 'paste-view-text'
// Pastes seen at prompt.edit and not yet paired with a `[Pasted text #n]` tag: a few at most,
// so a paste the editor never folded doesn't pile up.
const PENDING_MAX = 8

const images = atom({ plugin: 'paste-view', key: 'images' } as const, [] as PastedImage[])
const texts = atom({ plugin: 'paste-view', key: 'texts' } as const, [] as PastedText[])
// The texts behind the mod's own `[Note #n (N lines)]` marks: session state, so a reload of the
// mod doesn't lose what a sent prompt must carry.
const NOTES = { plugin: 'paste-view', key: 'notes' } as const
const notes = atom(NOTES, {} as Record<string, string>)
// Bumped when a save in VS Code changes the editor's text, so the pane draws the new text.
const editorTick = atom({ plugin: 'paste-view', key: 'editor' } as const, 0)

let tmpRoot: string | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
// The list last written, so a poll that finds the same tiles doesn't redraw the band.
let written: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()
// Files whose first bytes aren't a PNG's: they never will be, so they aren't read again.
const notPng = new Set<string>()
// Source files sips couldn't convert, so a broken paste isn't retried on every poll.
const unconvertible = new Set<string>()
// Small decoded copies for terminals that can't draw pictures, which get colored blocks instead.
const thumbs = new Map<string, Thumb | null>()
let pictures: boolean | undefined
// What Claude Code folded into each `[Pasted text #n]`, as prompt.edit showed it going in.
const pastes = new Map<number, string>()
const pending: string[] = []
// The text tags last drawn, so an unchanged draft doesn't rewrite state; the list last written,
// so a draft with no text tag doesn't write the empty list the state starts with.
let textsKey: string | undefined
let textsWritten: string | undefined = '[]'
// The text open in the editor pane, as edited so far.
let editing:
  | {
      kind: TextKind
      n: number
      tag: string
      text: string
      isUnknown: boolean
      // The file VS Code edits, once opened there, with the modification time last read and when.
      file?: string
      fileMtimeMs?: number
      savedAt?: string
    }
  | undefined
// The raw-paste file last consumed, by its modification time, so it isn't inserted twice.
let rawPasteFile: string | undefined

// Claude Code doesn't tell mods whether its Image draws a picture, so go by the environment
// it decides from.
async function canDrawPictures($: EngineInterface): Promise<boolean> {
  if (pictures === undefined) {
    pictures = drawsPictures({
      TERM: await $.env.get('TERM'),
      TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
      TMUX: await $.env.get('TMUX'),
      STY: await $.env.get('STY'),
      KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
      GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
      CLAUDE_PASTE_VIEW_RENDERER: await $.env.get('CLAUDE_PASTE_VIEW_RENDERER'),
    })
  }
  return pictures
}

// Claude Code keeps its temp files in <base>/claude-<uid>, or <base>\claude on Windows. The base
// is CLAUDE_CODE_TMPDIR when set, else /tmp (%TEMP% on Windows): the variable names the folder
// Claude Code nests its own in, not that folder itself.
async function tempRoot($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const base = fromEnv ?? (await $.env.get('TEMP'))
    return base === undefined ? undefined : `${base.replace(/[\\/]+$/, '')}/claude`
  }
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  return `${(fromEnv ?? '/tmp').replace(/\/+$/, '')}/claude-${uid}`
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  tmpRoot ??= await tempRoot($)
  if (tmpRoot === undefined) return undefined
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = `${tmpRoot}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

// Pastes are cached as <n>.png or <n>.webp (or another format), but the terminal only
// decodes PNG, so anything else is converted once to <session>/paste-view-<n>.png.
// sips ships with macOS only, so on Linux a non-PNG paste still shows "no preview".
async function pngFor($: EngineInterface, dir: string, n: number): Promise<string | undefined> {
  const png = `${dir}/${n}.png`
  if (await $.fs.exists(png)) return png
  const out = `${dir.replace(/\/images$/, '')}/paste-view-${n}.png`
  if (await $.fs.exists(out)) return out
  const entries = await $.fs.list(dir).catch(() => [])
  const source = entries.find(entry => entry.kind === 'file' && entry.name.startsWith(`${n}.`))
  if (source === undefined) return undefined
  const sourcePath = `${dir}/${source.name}`
  if (unconvertible.has(sourcePath)) return undefined
  const { exitCode } = await $.process
    .run(['sips', '-s', 'format', 'png', '-Z', '800', sourcePath, '--out', out])
    .catch(() => ({ exitCode: 1 }))
  if (exitCode === 0) return out
  unconvertible.add(sourcePath)
  return undefined
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = dir === undefined ? undefined : await pngFor($, dir, n)
  if (path === undefined || notPng.has(path)) return { n, path: null, size: null }
  if (!sizes.has(path)) {
    const base64 = await $.fs.read(path, { as: 'bytes' }).then(
      bytes => bytes.base64,
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    const head = base64 === undefined ? undefined : pngSize(base64)
    if (head === null) {
      // A file no longer than the 24-byte header may still be being written; a longer one is settled.
      if (base64!.length > 32) notPng.add(path)
      return { n, path: null, size: null }
    }
    sizes.set(path, head ?? null)
    if (base64 !== undefined && !(await canDrawPictures($))) thumbs.set(path, decodeThumb(Uint8Array.fromBase64(base64)))
  }
  return { n, path, size: sizes.get(path) ?? null }
}

async function showImages($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  const json = JSON.stringify(list)
  if (json === written) return
  await update($, images, () => list)
  written = json
}

// The text behind a tile: Claude Code's paste as prompt.edit showed it, or the mod's own note.
async function textOf($: EngineInterface, kind: TextKind, n: number): Promise<string | undefined> {
  return kind === 'paste' ? pastes.get(n) : (await read($, notes))[n]
}

// The clipboard, for a paste prompt.edit didn't show going in (Claude Code folds a long paste on
// its own path): on macOS `pbpaste` still holds what was just pasted.
async function clipboard($: EngineInterface): Promise<string | undefined> {
  const result = await $.process.run(['pbpaste']).catch(() => undefined)
  return result?.exitCode === 0 && result.stdout !== '' ? result.stdout : undefined
}

async function showTexts($: EngineInterface, draft: string) {
  const tags = textTags(draft)
  const key = tags.map(tag => tag.tag).join('|')
  if (key === textsKey) return
  const before = new Set((textsKey ?? '').split('|'))
  textsKey = key
  for (const [n, text] of matchPastes(tags, new Set(pastes.keys()), pending)) pastes.set(n, text)
  // A tag that just appeared with no paste seen going in: the clipboard is what was pasted when
  // its line count agrees with the tag's.
  for (const tag of tags) {
    if (tag.kind !== 'paste' || pastes.has(tag.n) || before.has(tag.tag)) continue
    const text = await clipboard($)
    if (text !== undefined && (lineCount(text) === tag.lines || lineCount(text) - 1 === tag.lines)) pastes.set(tag.n, text)
  }
  const list: PastedText[] = []
  for (const tag of tags) {
    const text = await textOf($, tag.kind, tag.n)
    list.push({ n: tag.n, kind: tag.kind, lines: tag.lines, tag: tag.tag, preview: text === undefined ? null : preview(text, TEXT_TILE_COLUMNS) })
  }
  const json = JSON.stringify(list)
  if (json === textsWritten) return
  await update($, texts, () => list)
  textsWritten = json
}

// A paste the person made with the terminal's raw-paste shortcut lands in a file named after the
// session (see the README): it goes into the draft as it is, so Claude Code never folds it.
async function rawPastePath($: EngineInterface): Promise<string | undefined> {
  tmpRoot ??= await tempRoot($)
  return tmpRoot === undefined ? undefined : `${tmpRoot}/paste-view/raw-paste-${await $.session.id()}.txt`
}

async function insertRawPaste($: EngineInterface) {
  const path = await rawPastePath($)
  if (path === undefined || !(await $.fs.exists(path))) return
  const stamp = `${path}@${(await $.fs.stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs}`
  if (stamp === rawPasteFile) return
  rawPasteFile = stamp
  const text = await $.fs.read(path).catch(() => '')
  if (typeof text !== 'string' || text === '') return
  await $.fs.write(path, '')
  await $.prompt.fill({ text, mode: 'insert' })
}

// The editor's text is in a file VS Code has open: a save there (a new modification time) becomes
// the field's text, and the pane redraws to show it.
async function pullEditorFile($: EngineInterface) {
  const item = editing
  if (item?.file === undefined) return
  const stat = await $.fs.stat(item.file).catch(() => undefined)
  if (stat === undefined || stat.mtimeMs === item.fileMtimeMs) return
  item.fileMtimeMs = stat.mtimeMs
  const text = await $.fs.read(item.file).catch(() => undefined)
  if (typeof text !== 'string' || text === item.text) return
  item.text = text
  item.savedAt = new Date(stat.mtimeMs).toTimeString().slice(0, 8)
  await update($, editorTick, tick => tick + 1)
}

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    // A raw paste that can't be read or written is left where it is: the tiles still draw.
    await insertRawPaste($).catch(() => undefined)
    await pullEditorFile($).catch(() => undefined)
    const draft = (await $.prompt.read()).text
    await showImages($, draft)
    await showTexts($, draft)
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    pictures = undefined
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  // A paste is an edit with no key: what goes in is what Claude Code is about to fold, so keep it
  // for the tile and the editor. The draft is left to the editor as it stands.
  on('prompt.edit', async ($, e, next) => {
    if (e.key === undefined && e.inputText.length > 0) {
      pending.push(e.inputText)
      if (pending.length > PENDING_MAX) pending.shift()
    }
    return next(e)
  })

  // The mod's own folds go back into the prompt before it is sent; a slash command is left alone.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const known = await read($, notes)
    const text = expandNotes(e.text, known)
    return text === e.text ? next(e) : next({ ...e, text })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    const textList = await read($, texts)
    if (list.length === 0 && textList.length === 0) return next(e)

    const { Box, Button, Image, Raster, Text } = $.ui.resolve(e)

    // The cross takes every `[Image #n]` tag out of the draft; the pencil puts the caret just past
    // the first one. Both rewrite the draft as it stands, so what the person typed around stays.
    const remove = async (n: number) => {
      const box = await $.prompt.read()
      const draft = removeImage(box.text, box.cursor, n)
      await $.prompt.fill({ text: draft.text, cursor: draft.cursor })
    }
    const edit = async (n: number) => {
      const box = await $.prompt.read()
      const at = afterImage(box.text, n)
      if (at !== null) await $.prompt.fill({ text: box.text, cursor: at })
    }
    const removeText = async (tag: string) => {
      const box = await $.prompt.read()
      const draft = removeTag(box.text, box.cursor, tag)
      await $.prompt.fill({ text: draft.text, cursor: draft.cursor })
    }
    // The editor opens on the text as it is; one the mod never saw opens empty, and what is saved
    // replaces the tag all the same.
    const openEditor = async (item: PastedText, tag: string) => {
      const text = await textOf($, item.kind, item.n)
      editing = { kind: item.kind, n: item.n, tag, text: text ?? '', isUnknown: text === undefined }
      await $.ui.open({ id: EDITOR, title: `Text #${item.n}`, focus: true, closeOnEscape: true, rows: 30 })
    }
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const shownTexts = fitTextTiles(textList.length, cells, e.props.maxRows, e.props.bodyColumns)
    if (cells.length === 0 && shownTexts === 0) return next(e)
    const hidden = list.length - cells.length + (textList.length - shownTexts)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.slice(0, cells.length).map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box key={`tile-${image.n}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                <Text dimColor>#{image.n}</Text>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : thumbs.get(image.path) ? (
                  <Raster
                    key={`blocks-${image.n}`}
                    columns={columns}
                    rows={rows}
                    cells={blockCells(thumbs.get(image.path)!, columns, rows)}
                  />
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ file: image.path, format: 'png' }}
                    columns={columns}
                    rows={rows}
                    alt={`[Image #${image.n}]`}
                  />
                )}
                <Box flexDirection="row" columnGap={1}>
                  <Button key={`edit-${image.n}`} dimColor label="✎" onPress={() => void edit(image.n)} />
                  {/* On the main screen the terminal keeps the mouse, so the band is reached with
                      ctrl+x tab; the image's own number then removes it (the pencil is a Tab away). */}
                  <Button
                    key={`remove-${image.n}`}
                    dimColor
                    label="✕"
                    hotkey={image.n <= 9 ? String(image.n) : undefined}
                    onPress={() => void remove(image.n)}
                  />
                </Box>
              </Box>
            )
          })}
          {textList.slice(0, shownTexts).map(item => {
            const tag = item.tag
            return (
              <Box key={`text-${item.kind}-${item.n}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor width={TEXT_TILE_COLUMNS + 2}>
                <Text dimColor>{item.kind === 'note' ? '📝 note' : '📝 text'} #{item.n}</Text>
                <Button
                  key={`open-text-${item.n}`}
                  plain
                  label={item.preview === null ? '(text not captured)' : item.preview === '' ? '(blank)' : item.preview}
                  onPress={() => void openEditor(item, tag)}
                />
                <Text dimColor>{item.lines} line{item.lines === 1 ? '' : 's'}</Text>
                <Box flexDirection="row" columnGap={1}>
                  <Button key={`edit-text-${item.n}`} dimColor label="✎" onPress={() => void openEditor(item, tag)} />
                  <Button key={`remove-text-${item.n}`} dimColor label="✕" onPress={() => void removeText(tag)} />
                </Box>
              </Box>
            )
          })}
          {hidden > 0 && <Text dimColor>+{hidden}</Text>}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: EDITOR }, async ($, e, next) => {
    const item = editing
    // The mobile app draws no text field yet.
    if (item === undefined || e.surface === 'mobile') return next(e)
    await read($, editorTick) // a save in VS Code redraws this pane
    const { Box, Button, Input, Text } = $.ui.resolve(e)

    // The text goes to a file VS Code opens; each save there lands in the field (pullEditorFile).
    const openInCode = async () => {
      tmpRoot ??= await tempRoot($)
      if (tmpRoot === undefined) return
      const file = `${tmpRoot}/paste-view/edit-${await $.session.id()}-${item.n}.txt`
      await $.fs.write(file, item.text)
      const stat = await $.fs.stat(file).catch(() => undefined)
      item.file = file
      item.fileMtimeMs = stat?.mtimeMs
      const ran = await $.process.run(['code', '--reuse-window', file]).catch(() => undefined)
      if (ran === undefined || ran.exitCode !== 0) {
        item.file = undefined
        $.ui.toast('Could not run `code`: install the VS Code command line tool (Shell Command: Install \'code\' command in PATH).')
      }
    }

    const close = async () => {
      editing = undefined
      await $.ui.close({ id: EDITOR })
    }
    // Saving puts the text in the draft in place of the tag, in the open; folding leaves the mod's
    // own mark there instead and keeps the text to put back when the prompt is sent.
    const write = async (replacement: string, keep: string | undefined) => {
      const box = await $.prompt.read()
      const draft = replaceTag(box.text, box.cursor, item.tag, replacement)
      const known = { ...(await read($, notes)) }
      if (keep === undefined) delete known[item.n]
      else known[item.n] = keep
      await $.state.set(NOTES, known)
      await $.prompt.fill({ text: draft.text, cursor: draft.cursor })
      await close()
    }
    const save = (text: string) => write(text, undefined)
    const fold = () => write(noteTag(item.n, item.text), item.text)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Input
          key="text"
          rows={editorRows(item.text, e.props.bodyColumns, e.props.scroll.bodyRows)}
          value={item.text}
          autoFocus
          submitLabel="save"
          onInput={value => {
            item.text = value
          }}
          onSubmit={value => {
            item.text = value
            void save(value)
          }}
        />
        <Box flexDirection="row" columnGap={2}>
          <Button key="save" label="Save" hotkey="s" onPress={() => void save(item.text)} />
          <Button key="fold" label="Fold" hotkey="f" onPress={() => void fold()} />
          <Button key="cancel" label="Cancel" hotkey="c" onPress={() => void close()} />
          <Button key="code" label="VS Code" hotkey="v" onPress={() => void openInCode()} />
        </Box>
        {item.isUnknown && <Text color="warning">The pasted text wasn't captured, so the field starts empty: what you save replaces the tag.</Text>}
        {item.file !== undefined && (
          <Text dimColor>
            Open in VS Code: each save there lands here{item.savedAt === undefined ? '' : ` (last ${item.savedAt})`}; then Save or Fold.
          </Text>
        )}
        <Text dimColor>Save puts the text in the prompt as is; Fold keeps it behind a [Note] mark until you send.</Text>
      </Box>
    )
  })

  on('ui.close', { id: EDITOR }, async ($, e, next) => {
    editing = undefined
    return next(e)
  })
}
