import { expect, mock, test } from 'claude-code/testing'

import { afterImage, blockCells, drawsPictures, fitCells, fitRow, fitTextTiles, imageNumbers, pngSize, removeImage } from '../hooks/layout'
import { editorRows, expandNotes, lineCount, matchPastes, noteTag, preview, replaceTag, textTags } from '../hooks/pastes'
import { decodeThumb } from '../hooks/png'

function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

// A session in Ghostty with no CLAUDE_CODE_TMPDIR, run as uid 501: Claude Code's temp folder
// is /tmp/claude-501.
const GHOSTTY: Record<string, string> = { TERM_PROGRAM: 'ghostty' }
const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('image numbers come from the draft, deduplicated, in order', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
  expect(imageNumbers('[Image 1] [image #3] #4')).toEqual([])
})

test('removing an image takes its tags and one neighbouring space out, and keeps the caret in place', () => {
  // The caret sits after the second tag: it moves back over what was removed before it.
  expect(removeImage('see [Image #1] and [Image #1] now', 29, 1)).toEqual({ text: 'see and now', cursor: 8 })
  // At the end of a word, the space before the tag goes instead.
  expect(removeImage('fix this [Image #2]', 5, 2)).toEqual({ text: 'fix this', cursor: 5 })
  // A caret inside the tag lands where the tag began.
  expect(removeImage('[Image #3] why', 4, 3)).toEqual({ text: 'why', cursor: 0 })
  // Another image's tag is untouched.
  expect(removeImage('[Image #1] [Image #12]', 22, 1)).toEqual({ text: '[Image #12]', cursor: 11 })
})

test('editing after an image puts the caret just past its first tag', () => {
  expect(afterImage('a [Image #4] b [Image #4]', 4)).toBe(12)
  expect(afterImage('a [Image #4] b', 5)).toBeNull()
})

test('PNG size is read from the IHDR header', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...'))).toBeNull()
})

test('thumbnails keep aspect ratio within the tile', () => {
  // Square: 6 rows tall, twice as many columns because cells are tall.
  expect(fitCells({ width: 500, height: 500 })).toEqual({ columns: 12, rows: 6 })
  // Very wide: capped at 32 columns, rows shrink to match.
  expect(fitCells({ width: 3000, height: 500 })).toEqual({ columns: 32, rows: 3 })
  // Very tall: never narrower than 11 columns, the controls row's width.
  expect(fitCells({ width: 100, height: 2000 })).toEqual({ columns: 11, rows: 6 })
})

test('a row of tiles shrinks to fit the band so it never scrolls', () => {
  const square = { width: 500, height: 500 }
  // Plenty of room: full 6-row tiles.
  expect(fitRow([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // A short band: border, number and controls take 4 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 11, rows: 3 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 42 forces 5 rows (11 wide, the minimum).
  expect(fitRow([square, square, square], 20, 42)).toEqual([
    { columns: 11, rows: 5 },
    { columns: 11, rows: 5 },
    { columns: 11, rows: 5 },
  ])
})

test('a row too wide even at one row keeps the tiles that fit beside a +N label', () => {
  const square = { width: 500, height: 500 }
  // One-row squares are 11 + 2 columns: three with gaps take 41; two take 27, and " +8" makes it 30.
  expect(fitRow(Array(10).fill(square), 20, 36)).toEqual(Array(2).fill({ columns: 11, rows: 1 }))
  // Under one tile's height (4 rows of chrome and 1 of picture), nothing is drawn.
  expect(fitRow([square], 4, 120)).toEqual([])
})

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1] [Image #2]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', () => ({
    value: [
      { name: '-other', kind: 'dir', ...entry },
      { name: 'notes.txt', kind: 'file', ...entry },
      { name: '-work', kind: 'dir', ...entry },
    ],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' }, columns: 24, rows: 6 })
  // #2 has no cached file, so it gets a placeholder tile instead of a broken Image.
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  await ui.unmount()

  // Sending the prompt empties the box.
  draft = ''
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a tile with no preview is neither re-read nor redrawn on every poll', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-2/images'
  const draft = 'see [Image #1] [Image #2]'
  let reads = 0
  let writes = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-2' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  // #1 is a JPEG under a .png name; #2 was never cached.
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => {
    reads++
    return { value: { base64: btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...') } }
  })
  on('state.set', ($, e, next) => {
    writes++
    return next(e)
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await clock.advance(200)
  await clock.advance(200)

  expect(reads).toBe(1)
  expect(writes).toBe(1)
})

test('tiles that don\'t fit become a +N label, and a band too short for one draws nothing', async ($, on) => {
  const clock = mock.clock(on)
  const draft = Array.from({ length: 10 }, (_, i) => `[Image #${i + 1}]`).join(' ')
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-3' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: { base64: pngHead(500, 500) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 36 } })
  // One-row tiles are 11 + 2 columns wide: two fit beside the "+8" label.
  expect(await narrow.find({ type: 'Text', text: '#2' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: '#3' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: '+8' })).toBeDefined()
  await narrow.unmount()

  const short = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 3 } })
  expect(await short.find({ type: 'Image' })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: /^\+/ })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a file still too short to hold a PNG header is read again on the next poll', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-4/images'
  const draft = 'see [Image #1]'
  let reads = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-4' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', () => ({ value: true }))
  // The first poll catches the file mid-write, after only 10 bytes.
  on('fs.read', () => ({ value: { base64: reads++ === 0 ? pngHead(500, 500).slice(0, 16) : pngHead(500, 500) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await clock.advance(200)

  expect(reads).toBe(2)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' } })
})

test('a webp paste is converted to PNG once and drawn from the converted file', async ($, on) => {
  const clock = mock.clock(on)
  const session = '/tmp/claude-501/-work/sess-1'
  const dir = `${session}/images`
  const out = `${session}/image-view-1.png`
  const draft = 'see [Image #1]'
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  const converted = new Set<string>()
  const runs: (readonly string[])[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', ($, e) => ({
    value:
      e.path === dir
        ? [
            { name: '12.webp', kind: 'file', ...entry },
            { name: '1.webp', kind: 'file', ...entry },
          ]
        : [{ name: '-work', kind: 'dir', ...entry }],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || converted.has(e.path) }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'id') return ran('501\n')
    runs.push(e.argv)
    converted.add(e.argv.at(-1) ?? '')
    return ran('')
  })
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  await clock.advance(200)

  // Converted once (12.webp is not #1's file), then reused on the next poll.
  expect(runs).toEqual([['sips', '-s', 'format', 'png', '-Z', '800', `${dir}/1.webp`, '--out', out]])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: out, format: 'png' }, columns: 24, rows: 6 })
})
// Real PNGs made with zlib, each row using a different PNG filter (none, sub, up, average, paeth).
// RGBA 64x40, dynamic Huffman blocks: x < 32 opaque, the rest half transparent.
const RGBA = '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'
// 4-bit palette 16x8, fixed Huffman blocks: palette entry 0 is fully transparent.
const PALETTE = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAIBAMAAAACWGKkAAAAMFBMVEUA/wAQ7yUg30owz29Av5RQr7lgn95wjwOAfyiQb02gX3KwT5fAP7zQL+HgHwbwDysGwvM4AAAAEHRSTlMA////////////////////wFCLQwAAADlJREFUeNpjYFR2Te9cffY9o5ASGAgxCUIBs7IUCHDNYoEKKDGEVczac++DkAljOlipkhJYMSMQAwAESQ0dnDbg1AAAAABJRU5ErkJggg=='
// 16-bit grayscale 8x4.
const GRAY16 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAEEAAAAADGNv1vAAAANElEQVR42mNgYJB3sGuIPVDLMMdhd8OtA4zMLxQc5MEQQjOxvECFzBwBglOEpgiJCIlAaADdQBS1IoDTFgAAAABJRU5ErkJggg=='

const bytesOf = (base64: string) => Uint8Array.fromBase64(base64)
const pixel = (thumb: { width: number; rgb: Uint8Array }, x: number, y: number) =>
  [...thumb.rgb.subarray((y * thumb.width + x) * 3, (y * thumb.width + x) * 3 + 3)]
// A half-transparent pixel over the backdrop the decoder uses.
const over = (c: number) => Math.round((c * 128 + 0x1e * 127) / 255)

test('PNG decoding gives the picture back through every row filter', () => {
  const thumb = decodeThumb(bytesOf(RGBA))!
  expect([thumb.width, thumb.height]).toEqual([64, 40])
  for (const [x, y] of [[0, 0], [31, 7], [5, 39], [20, 22]] as const) {
    expect(pixel(thumb, x, y)).toEqual([x * 4, y * 6, (x * y) % 256])
  }
  for (const [x, y] of [[32, 0], [63, 39], [40, 13]] as const) {
    expect(pixel(thumb, x, y)).toEqual([over(x * 4), over(y * 6), over((x * y) % 256)])
  }
})

test('PNG decoding handles palettes with transparency and 16-bit gray', () => {
  const palette = decodeThumb(bytesOf(PALETTE))!
  expect(pixel(palette, 0, 0)).toEqual([0x1e, 0x1e, 0x1e]) // palette entry 0 is transparent
  expect(pixel(palette, 3, 2)).toEqual([5 * 16, 255 - 5 * 16, (5 * 37) % 256])
  const gray = decodeThumb(bytesOf(GRAY16))!
  expect(pixel(gray, 5, 2)).toEqual(Array(3).fill(((5 * 8000 + 2 * 1000) % 65536) >> 8))
})

test('a PNG that cannot be decoded gives no thumbnail', () => {
  const png = bytesOf(RGBA)
  expect(decodeThumb(png.subarray(0, 40))).toBeNull() // cut off before its data
  expect(decodeThumb(new Uint8Array(100))).toBeNull() // not a PNG
  const corrupt = png.slice()
  corrupt.fill(0xff, 60, 200)
  expect(decodeThumb(corrupt)).toBeNull()
})

test('a thumbnail is averaged down into half-block cells', () => {
  // 64x40 drawn in 8x2 cells is 8x4 pixels: each is the average of an 8x10 block of the picture.
  const thumb = decodeThumb(bytesOf(RGBA))!
  const words = new Uint32Array(bytesOf(blockCells(thumb, 8, 2)).buffer)
  expect(words.length).toBe(8 * 2 * 3)
  expect(words[0]).toBe(0x2580) // an upper half block
  const mean = (y0: number, f: (x: number, y: number) => number) => {
    let sum = 0
    for (let y = y0; y < y0 + 10; y++) for (let x = 0; x < 8; x++) sum += f(x, y)
    return Math.round(sum / 80)
  }
  const color = (y0: number) =>
    (mean(y0, x => x * 4) << 16) | (mean(y0, (_, y) => y * 6) << 8) | mean(y0, (x, y) => (x * y) % 256)
  expect(words[1]).toBe(color(0)) // the cell's foreground is the top pixel...
  expect(words[2]).toBe(color(10)) // ...and its background the one below
})

test('real pictures only where Claude Code draws them: kitty and Ghostty, or when forced', () => {
  expect(drawsPictures({ TERM: 'xterm-kitty' })).toBe(true)
  expect(drawsPictures({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  expect(drawsPictures({ KITTY_WINDOW_ID: '4' })).toBe(true)
  expect(drawsPictures({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  expect(drawsPictures({ TERM_PROGRAM: 'vscode' })).toBe(false)
  // WezTerm speaks the protocol, but Claude Code only trusts kitty and Ghostty by name.
  expect(drawsPictures({ TERM_PROGRAM: 'WezTerm' })).toBe(false)
  // Claude Code turns pictures off in tmux, screen and background sessions, even inside kitty...
  expect(drawsPictures({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-501/default,1,0' })).toBe(false)
  expect(drawsPictures({ TERM: 'xterm-kitty', STY: '1234.pts-0.host' })).toBe(false)
  expect(drawsPictures({ TERM: 'xterm-kitty', CLAUDE_CODE_SESSION_KIND: 'bg' })).toBe(false)
  // ...unless they're forced on, which it honors anywhere.
  expect(drawsPictures({ TMUX: '/tmp/tmux-501/default,1,0', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBe(true)
  // An override beats guessing from the environment.
  expect(drawsPictures({ TERM_PROGRAM: 'iTerm.app', CLAUDE_IMAGE_VIEW_RENDERER: 'image' })).toBe(true)
  expect(drawsPictures({ TERM: 'xterm-kitty', CLAUDE_IMAGE_VIEW_RENDERER: 'blocks' })).toBe(false)
})

for (const [name, env, drawn, notDrawn] of [
  ['a terminal without pictures gets the thumbnail in colored blocks', { TERM_PROGRAM: 'Apple_Terminal' }, 'Raster', 'Image'],
  ['a kitty terminal still gets the real picture', { TERM: 'xterm-kitty' }, 'Image', 'Raster'],
] as const) {
  test(name, async ($, on) => {
    const clock = mock.clock(on)
    // Its own session, so nothing is cached from the other tests.
    const session = `sess-${drawn}`
    const dir = `/tmp/claude-501/-work/${session}/images`
    const entry = { size: 0, mtimeMs: 0, isLink: false }
    on('session.start', () => ({ cwd: '/work' }))
    on('prompt.read', () => ({ value: { text: 'see [Image #1]', cursor: 14 } }))
    on('env.get', (_, e) => ({ value: (env as Record<string, string>)[e.name] }))
    on('process.run', () => ran('501\n'))
    on('session.id', () => ({ value: session }))
    on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', ...entry }] }))
    on('fs.exists', (_, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
    on('fs.read', () => ({ value: { base64: RGBA } }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: notDrawn })).toBeUndefined()
    // 64x40 is wider than tall: 6 rows of cells, twice as many columns as 6 * 64 / 40 pixels.
    expect((await ui.find({ type: drawn }))?.props).toMatchObject({ columns: 19, rows: 6 })
    await ui.unmount()
  })
}

for (const [platform, env, root] of [
  ['macOS and Linux', { CLAUDE_CODE_TMPDIR: '/scratch/' }, '/scratch/claude-501'],
  // The test engine resolves paths for the platform it runs on, so %TEMP% is spelled POSIX-style here.
  ['Windows', { OS: 'Windows_NT', TEMP: '/Users/me/AppData/Local/Temp\\' }, '/Users/me/AppData/Local/Temp/claude'],
] as const) {
  test(`on ${platform} the cache is found where Claude Code nests its temp folder`, async ($, on) => {
    const clock = mock.clock(on)
    const listed: string[] = []
    on('session.start', () => ({ cwd: '/work' }))
    on('prompt.read', () => ({ value: { text: 'see [Image #1]', cursor: 14 } }))
    on('env.get', (_, e) => ({ value: (env as Record<string, string>)[e.name] }))
    on('process.run', () => ran('501\n'))
    on('session.id', () => ({ value: 'sess-tmp' }))
    on('fs.list', (_, e) => {
      listed.push(e.path)
      return { value: [] }
    })
    on('fs.exists', () => ({ value: false }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await clock.advance(200)

    // CLAUDE_CODE_TMPDIR (or %TEMP%) is the base Claude Code makes its own folder in, not that folder.
    expect(listed[0]).toBe(root)
  })
}

test('the cross removes the tag from the draft and the pencil moves the caret after it', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-3/images'
  let draft = 'see [Image #1] and more'
  let cursor = draft.length
  const fills: { text: string; cursor?: number }[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, cursor: e.cursor })
    draft = e.text
    cursor = e.cursor ?? draft.length
    return { isFilled: true, text: draft, cursor }
  })
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-3' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'edit-1' })).toBeDefined()
  // The image's number is the cross's hotkey once the band has the focus (ctrl+x tab).
  expect((await ui.find({ type: 'Button', key: 'remove-1' }))?.props).toMatchObject({ hotkey: '1' })
  await ui.press({ key: 'edit-1' })
  expect(fills.at(-1)).toEqual({ text: 'see [Image #1] and more', cursor: 14 })

  // The caret stood right after the tag: it lands where the tag began.
  await ui.press({ key: 'remove-1' })
  expect(fills.at(-1)).toEqual({ text: 'see and more', cursor: 4 })
  await ui.unmount()

  // The draft no longer names the image: the next poll clears the tiles.
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Button', key: 'remove-1' })).toBeUndefined()
})

test('text tags are read off the draft in order, Claude Code\'s pastes and the mod\'s notes alike', () => {
  expect(textTags('a [Note #4 (2 lines)] b [Pasted text #3 +2 lines] c [Pasted text #3 +2 lines] [Pasted text #5]')).toEqual([
    { kind: 'note', n: 4, lines: 2, tag: '[Note #4 (2 lines)]' },
    { kind: 'paste', n: 3, lines: 2, tag: '[Pasted text #3 +2 lines]' },
    { kind: 'paste', n: 5, lines: 0, tag: '[Pasted text #5]' },
  ])
  expect(textTags('[Pasted text 3] [Note 4]')).toEqual([])
  expect(noteTag(7, 'one')).toBe('[Note #7 (1 line)]')
  expect(noteTag(7, 'one\ntwo\n')).toBe('[Note #7 (3 lines)]')
  expect(lineCount('')).toBe(1)
})

test('pastes seen going in are paired with the tags that appear, by line count first', () => {
  const tags = textTags('[Pasted text #1 +4 lines] [Pasted text #2 +1 lines] [Pasted text #3 +9 lines]')
  // #2 is already known; the two-line paste fits #1's "+1 lines" only, so #1 waits for the next one.
  const pending = ['x\ny', 'a\nb\nc\nd\ne', 'p\nq\nr']
  const matched = matchPastes(tags, new Set([2]), pending)
  expect([...matched]).toEqual([
    [1, 'a\nb\nc\nd\ne'],
    [3, 'x\ny'],
  ])
  expect(pending).toEqual(['p\nq\nr'])
  // Nothing pending: nothing paired.
  expect(matchPastes(tags, new Set(), []).size).toBe(0)
})

test('a preview is the first line with words, cut to the tile', () => {
  expect(preview('\n   \n  Hello world, this is a long first line indeed\nmore', 24)).toBe('Hello world, this is a …')
  expect(preview('short\nlonger', 24)).toBe('short')
  expect(preview('\n\n', 24)).toBe('')
})

test('replacing a tag keeps the caret in place, and notes expand when the prompt is sent', () => {
  expect(replaceTag('see [Note #4 (2 lines)] now [Note #4 (2 lines)]', 27, '[Note #4 (2 lines)]', 'a\nb')).toEqual({ text: 'see a\nb now a\nb', cursor: 11 })
  // A caret inside the tag lands after what replaced it.
  expect(replaceTag('[Note #4 (2 lines)] x', 5, '[Note #4 (2 lines)]', 'ab')).toEqual({ text: 'ab x', cursor: 2 })
  expect(expandNotes('x [Note #4 (2 lines)] y [Note #9 (1 line)]', { '4': 'a\nb' })).toBe('x a\nb y [Note #9 (1 line)]')
})

test('note tiles fit after the image tiles, with a +N label for the rest', () => {
  const image = { columns: 12, rows: 6 }
  // One image is 14 columns; each note tile 26 plus a gap: two fit in 72 columns beside " +1" (71), three need 94.
  expect(fitTextTiles(3, [image], 20, 72)).toBe(2)
  expect(fitTextTiles(3, [image], 20, 70)).toBe(1)
  expect(fitTextTiles(3, [image], 20, 120)).toBe(3)
  // A band shorter than a note tile draws none; no notes, none.
  expect(fitTextTiles(3, [image], 6, 120)).toBe(0)
  expect(fitTextTiles(0, [], 20, 120)).toBe(0)
})

test('pasted texts get a note tile; the cross removes the tag, the editor rewrites it, and notes expand on send', async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'see [Pasted text #3 +2 lines] and [Note #4 (2 lines)] end'
  let cursor = draft.length
  const fills: { text: string; cursor: number | undefined }[] = []
  const opened: string[] = []
  const closed: string[] = []
  let submitted: string | undefined
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, cursor: e.cursor })
    draft = e.text
    cursor = e.cursor ?? draft.length
    return { isFilled: true, text: draft, cursor }
  })
  on('prompt.submit', ($, e) => {
    submitted = e.text
    return { text: e.text }
  })
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', ($, e) => (e.argv[0] === 'pbpaste' ? ran('one line only') : ran('501\n')))
  on('session.id', () => ({ value: 'sess-6' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  // Note #4 was folded earlier in the session: its text is in the session's state.
  on('state.get', ($, e, next) => (e.key === 'notes' ? { value: { value: { '4': 'alpha beta\ngamma' }, version: 1 } } : next(e)))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The paste went in before the mod loaded and the clipboard holds something else: no text to show.
  expect((await ui.find({ type: 'Button', key: 'open-text-3' }))?.props).toMatchObject({ label: '(text not captured)' })
  expect((await ui.find({ type: 'Button', key: 'open-text-4' }))?.props).toMatchObject({ label: 'alpha beta' })
  expect(await ui.find({ type: 'Text', text: '2 lines' })).toBeDefined()

  // Sending expands the note; Claude Code expands its own paste itself.
  await $.prompt.submit({ text: draft, wait: false, origin: { kind: 'composer' } })
  expect(submitted).toBe('see [Pasted text #3 +2 lines] and alpha beta\ngamma end')

  await ui.press({ key: 'remove-text-3' })
  expect(fills.at(-1)).toEqual({ text: 'see and [Note #4 (2 lines)] end', cursor: 31 })

  // A tile whose text is unknown still opens the editor, empty.
  await ui.press({ key: 'edit-text-3' })
  expect(opened).toEqual(['image-view-text'])
  await ui.press({ key: 'edit-text-4' })
  expect(opened).toEqual(['image-view-text', 'image-view-text'])
  await ui.unmount()

  const pane = await $.ui.mount({
    plugin: 'image-view',
    component: 'Pane',
    requestId: 'image-view-text',
    surface: 'terminal',
    props: { title: 'Text #4', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} },
  })
  // Two short lines: the field is three rows, the smallest it gets.
  expect((await pane.find({ type: 'Input', key: 'text' }))?.props).toMatchObject({ value: 'alpha beta\ngamma', rows: 3 })
  // Enter saves: the text goes into the draft in place of the mark, and the pane closes.
  // The caret stood at the end: it moves back by what the shorter text saved.
  await pane.input({ key: 'text', text: 'one\ntwo\nthree' })
  expect(fills.at(-1)).toEqual({ text: 'see and one\ntwo\nthree end', cursor: 25 })
  expect(closed).toEqual(['image-view-text'])
  await pane.unmount()
})

test('folding from the editor leaves the mod\'s own mark and keeps the text for sending', async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'see [Note #4 (2 lines)] end'
  let cursor = 4
  const fills: { text: string; cursor: number | undefined }[] = []
  const stored: Record<string, string>[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, cursor: e.cursor })
    draft = e.text
    cursor = e.cursor ?? draft.length
    return { isFilled: true, text: draft, cursor }
  })
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-7' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('state.get', ($, e, next) => (e.key === 'notes' ? { value: { value: { '4': 'alpha\nbeta' }, version: 1 } } : next(e)))
  on('state.set', ($, e, next) => {
    if (e.key === 'notes') stored.push(e.value as Record<string, string>)
    return next(e)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'open-text-4' })
  await ui.unmount()

  const pane = await $.ui.mount({
    plugin: 'image-view',
    component: 'Pane',
    requestId: 'image-view-text',
    surface: 'terminal',
    props: { title: 'Text #4', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} },
  })
  await pane.input({ key: 'text', text: 'one\ntwo\nthree', kind: 'change' })
  await pane.press({ key: 'fold' })
  expect(fills.at(-1)).toEqual({ text: 'see [Note #4 (3 lines)] end', cursor: 4 })
  expect(stored.at(-1)).toEqual({ '4': 'one\ntwo\nthree' })
  await pane.unmount()
})

test('a raw paste left in the session\'s file goes into the draft as it is, once', async ($, on) => {
  const clock = mock.clock(on)
  const file = '/tmp/claude-501/image-view/raw-paste-sess-8.txt'
  let content = 'line one\nline two'
  let mtimeMs = 10
  const fills: { text: string; mode: string }[] = []
  const writes: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: 'hi ', cursor: 3 } }))
  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true, text: `hi ${e.text}`, cursor: 3 + e.text.length }
  })
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', () => ran('501\n'))
  on('session.id', () => ({ value: 'sess-8' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: e.path === file }))
  on('fs.stat', () => ({ value: { kind: 'file', size: content.length, mtimeMs, isLink: false } }))
  on('fs.read', () => ({ value: content }))
  on('fs.write', ($, e) => {
    writes.push(e.path)
    content = e.text
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  expect(fills).toEqual([{ text: 'line one\nline two', mode: 'insert' }])
  expect(writes).toEqual([file])

  // The emptied file is not inserted again; a new paste (a new modification time) is.
  await clock.advance(200)
  expect(fills.length).toBe(1)
  content = 'again'
  mtimeMs = 20
  await clock.advance(200)
  expect(fills.at(-1)).toEqual({ text: 'again', mode: 'insert' })
})

test('a paste the mod never saw going in is read off the clipboard when the line count agrees', async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'see [Pasted text #5 +2 lines]'
  let clip = 'first\nsecond\nthird'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', ($, e) => (e.argv[0] === 'pbpaste' ? ran(clip) : ran('501\n')))
  on('session.id', () => ({ value: 'sess-9' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'open-text-5' }))?.props).toMatchObject({ label: 'first' })
  await ui.unmount()

  // A later tag with a clipboard of another shape stays unknown; the first keeps its text.
  draft = 'see [Pasted text #5 +2 lines] [Pasted text #6 +9 lines]'
  clip = 'something else'
  await clock.advance(200)
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await later.find({ type: 'Button', key: 'open-text-5' }))?.props).toMatchObject({ label: 'first' })
  expect((await later.find({ type: 'Button', key: 'open-text-6' }))?.props).toMatchObject({ label: '(text not captured)' })
  await later.unmount()
})

test('the editor\'s field grows to show the whole text when the pane has the room', () => {
  // Four lines, one of which wraps to three rows over 60 columns: six rows plus one spare.
  const text = 'one\ntwo\n' + 'x'.repeat(130) + '\nfour'
  expect(editorRows(text, 60, 40)).toBe(7)
  // A short pane caps it; a tiny text still gets three rows.
  expect(editorRows(text, 60, 10)).toBe(5)
  expect(editorRows('hi', 60, 40)).toBe(3)
})

test('the editor hands the text to VS Code and takes each save there back into the field', async ($, on) => {
  const clock = mock.clock(on)
  const draft = 'see [Note #4 (2 lines)] end'
  const file = '/tmp/claude-501/image-view/edit-sess-10-4.txt'
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const argvs: string[][] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', ($, e) => ({ value: GHOSTTY[e.name] }))
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    return ran(e.argv[0] === 'id' ? '501\n' : '')
  })
  on('session.id', () => ({ value: 'sess-10' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    files.set(e.path, { text: e.text, mtimeMs: 100 })
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const held = files.get(e.path)
    if (held === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: held.text.length, mtimeMs: held.mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => ({ value: files.get(e.path)?.text ?? '' }))
  on('state.get', ($, e, next) => (e.key === 'notes' ? { value: { value: { '4': 'alpha\nbeta' }, version: 1 } } : next(e)))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'open-text-4' })
  await ui.unmount()

  const PANE = {
    plugin: 'image-view',
    component: 'Pane',
    requestId: 'image-view-text',
    surface: 'terminal',
    props: { title: 'Text #4', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'code' })
  expect(files.get(file)?.text).toBe('alpha\nbeta')
  expect(argvs.at(-1)).toEqual(['code', '--reuse-window', file])
  await pane.unmount()

  // A save in VS Code: the file's time moves, and the field shows the new text on the next poll.
  files.set(file, { text: 'alpha\nbeta\ngamma', mtimeMs: 200 })
  await clock.advance(200)
  const again = await $.ui.mount(PANE)
  expect((await again.find({ type: 'Input', key: 'text' }))?.props).toMatchObject({ value: 'alpha\nbeta\ngamma' })
  expect(await again.find({ type: 'Text', text: /each save there lands here/ })).toBeDefined()
  await again.unmount()
})
