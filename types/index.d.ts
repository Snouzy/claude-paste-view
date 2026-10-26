export type PastedImage = {
  n: number
  /** Absolute path of the PNG to draw (the cached paste or its converted copy); null when it can't be found. */
  path: string | null
  /** Pixel size; null when unknown, and the tile falls back to a default shape. */
  size: { width: number; height: number } | null
}

export type PastedText = {
  n: number
  /** `paste`: Claude Code's own `[Pasted text #n +N lines]`; `note`: the mod's `[Note #n (N lines)]`. */
  kind: 'paste' | 'note'
  lines: number
  /** The tag as the draft spells it, `[Pasted text #3 +2 lines]` or `[Note #3 (3 lines)]`. */
  tag: string
  /** The first line with something on it; null when the text wasn't seen (pasted before the mod loaded). */
  preview: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'paste-view': {
      images: PastedImage[]
      texts: PastedText[]
      /** The text behind each `[Note #n (N lines)]` of the draft, by `n`; put back when the prompt is sent. */
      notes: Record<string, string>
      /** Bumped when the editor's text changes from outside (a save in VS Code), so the pane redraws. */
      editor: number
    }
  }
}
