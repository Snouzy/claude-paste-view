// Pasted texts: Claude Code folds a multi-line paste into `[Pasted text #n +N lines]` and keeps
// the text to itself, so the mod remembers what went in at `prompt.edit` and draws a note tile.
// A text the person folds from the editor becomes the mod's own `[Note #n (N lines)]`, whose
// text the mod keeps and puts back when the prompt is sent.

export type TextKind = 'paste' | 'note'

export type TextTag = { kind: TextKind; n: number; lines: number; tag: string }

const PASTE_TAG = /\[Pasted text #(\d+)(?: \+(\d+) lines?)?\]/g
const NOTE_TAG = /\[Note #(\d+) \((\d+) lines?\)\]/g

/** How many lines a text spans: one more than its newlines. */
export function lineCount(text: string): number {
  return text.split('\n').length
}

/** The mod's own fold mark for a text numbered `n`. */
export function noteTag(n: number, text: string): string {
  const lines = lineCount(text)
  return `[Note #${n} (${lines} line${lines === 1 ? '' : 's'})]`
}

/** The distinct pasted-text and note tags a draft holds, in the order they first appear. */
export function textTags(draft: string): TextTag[] {
  const found: TextTag[] = []
  const seen = new Set<string>()
  const add = (tag: TextTag) => {
    const key = `${tag.kind}:${tag.n}`
    if (!seen.has(key)) {
      seen.add(key)
      found.push(tag)
    }
  }
  const all = [
    ...[...draft.matchAll(PASTE_TAG)].map(m => ({ kind: 'paste' as const, n: Number(m[1]), lines: Number(m[2] ?? 0), tag: m[0], at: m.index ?? 0 })),
    ...[...draft.matchAll(NOTE_TAG)].map(m => ({ kind: 'note' as const, n: Number(m[1]), lines: Number(m[2]), tag: m[0], at: m.index ?? 0 })),
  ].sort((a, b) => a.at - b.at)
  for (const { at: _at, ...tag } of all) add(tag)
  return found
}

/**
 * Pairs the pasted-text tags whose text isn't known yet with the pastes seen at `prompt.edit`, in
 * order; a paste whose line count agrees with the tag's `+N lines` is preferred over the oldest.
 * Each paste is used once; the ones taken are removed from `pending`.
 */
export function matchPastes(tags: readonly TextTag[], known: ReadonlySet<number>, pending: string[]): Map<number, string> {
  const matched = new Map<number, string>()
  for (const tag of tags) {
    if (tag.kind !== 'paste' || known.has(tag.n) || matched.has(tag.n) || pending.length === 0) continue
    let index = pending.findIndex(text => {
      const lines = lineCount(text)
      return lines === tag.lines || lines - 1 === tag.lines
    })
    if (index < 0) index = 0
    matched.set(tag.n, pending[index]!)
    pending.splice(index, 1)
  }
  return matched
}

/** The first line of a text with something on it, trimmed and cut to `columns` cells. */
export function preview(text: string, columns: number): string {
  const line = text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  return line.length > columns ? `${line.slice(0, Math.max(0, columns - 1))}…` : line
}

/**
 * The draft with every occurrence of `tag` replaced by `replacement`, and where the caret lands:
 * where it was, moved over what changed before it, or at the end of the replacement if it stood
 * inside the tag.
 */
export function replaceTag(draft: string, cursor: number, tag: string, replacement: string): { text: string; cursor: number } {
  let text = draft
  let at = cursor
  for (let start = text.lastIndexOf(tag); start >= 0; start = start === 0 ? -1 : text.lastIndexOf(tag, start - 1)) {
    const end = start + tag.length
    text = text.slice(0, start) + replacement + text.slice(end)
    if (at >= end) at += replacement.length - tag.length
    else if (at > start) at = start + replacement.length
  }
  return { text, cursor: Math.max(0, Math.min(at, text.length)) }
}

/**
 * The draft with every occurrence of `tag` taken out, each with the space after it (or, at the end
 * of a word, the one before it) so the words around it don't run together; and where the caret
 * lands: where it was, moved back over what went before it, or to the tag's start if it stood inside.
 */
export function removeTag(draft: string, cursor: number, tag: string): { text: string; cursor: number } {
  let text = draft
  let at = cursor
  for (let start = text.lastIndexOf(tag); start >= 0; start = text.lastIndexOf(tag, start - 1)) {
    let end = start + tag.length
    if (text[end] === ' ') end++
    else if (text[start - 1] === ' ') start--
    text = text.slice(0, start) + text.slice(end)
    if (at >= end) at -= end - start
    else if (at > start) at = start
    if (start === 0) break
  }
  return { text, cursor: Math.max(0, Math.min(at, text.length)) }
}

/** The prompt with every `[Note #n (N lines)]` whose text is known put back in its place. */
export function expandNotes(text: string, notes: Readonly<Record<string, string>>): string {
  return text.replace(NOTE_TAG, (tag, n: string) => notes[n] ?? tag)
}

/**
 * How tall the editor's field is: enough rows to show the whole text as it wraps at `columns`,
 * one spare, within what the pane has (`bodyRows` less the rows the buttons and hint take) and
 * never under three.
 */
export function editorRows(text: string, columns: number, bodyRows: number): number {
  const width = Math.max(1, columns)
  const wrapped = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)
  const room = bodyRows - EDITOR_CHROME_ROWS
  return Math.max(3, Math.min(wrapped + 1, room))
}

// The rows under the field: a gap, the buttons, a gap and the hint (two rows when it wraps).
const EDITOR_CHROME_ROWS = 5
