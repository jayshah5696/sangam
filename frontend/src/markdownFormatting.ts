/**
 * Pure Markdown formatting edits for the editor's shortcuts and selection toolbar.
 * Each function returns one replacement plus the selection to restore, so the
 * editor applies it as a single undoable transaction.
 */

export type TextEdit = {
  from: number
  to: number
  insert: string
  selection: { anchor: number; head: number }
}

/** Wrap or unwrap the selection in an inline marker such as `**`, `_`, or a backtick. */
export function toggleInlineMarker(doc: string, from: number, to: number, marker: string): TextEdit {
  const size = marker.length
  if (from === to) {
    return { from, to, insert: marker + marker, selection: { anchor: from + size, head: from + size } }
  }
  if (doc.slice(from - size, from) === marker && doc.slice(to, to + size) === marker) {
    const text = doc.slice(from, to)
    return {
      from: from - size,
      to: to + size,
      insert: text,
      selection: { anchor: from - size, head: from - size + text.length },
    }
  }
  const selected = doc.slice(from, to)
  if (selected.length > size * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const text = selected.slice(size, -size)
    return { from, to, insert: text, selection: { anchor: from, head: from + text.length } }
  }
  // Markers must touch the words: `** word **` is not bold in CommonMark.
  const leading = selected.length - selected.trimStart().length
  const trailing = selected.length - selected.trimEnd().length
  const start = from + leading
  const end = to - trailing
  const text = doc.slice(start, end)
  return {
    from: start,
    to: end,
    insert: `${marker}${text}${marker}`,
    selection: { anchor: start + size, head: start + size + text.length },
  }
}

const URL_PATTERN = /^https?:\/\/\S+$/i

/** Turn the selection into a Markdown link, selecting whichever part still needs typing. */
export function linkSelection(doc: string, from: number, to: number): TextEdit {
  const selected = doc.slice(from, to).trim()
  if (URL_PATTERN.test(selected)) {
    const label = 'link text'
    return {
      from,
      to,
      insert: `[${label}](${selected})`,
      selection: { anchor: from + 1, head: from + 1 + label.length },
    }
  }
  const label = selected || 'link text'
  const destination = 'https://'
  const insert = `[${label}](${destination})`
  const urlStart = from + label.length + 3
  return { from, to, insert, selection: { anchor: urlStart, head: urlStart + destination.length } }
}
