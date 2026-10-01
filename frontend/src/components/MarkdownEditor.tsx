import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { SUPPORTED_IMAGE_TYPES, type DocumentSummary } from '../api'
import { internalDocumentMarkdown } from '../internalLinks'
import { linkSelection, toggleInlineMarker, type TextEdit } from '../markdownFormatting'

export type EditorSelection = {
  line: number
  column: number
  selectedCharacters: number
}

export type EditorViewState = {
  anchor: number
  head: number
  scrollTop: number
}

export type MarkdownFormat = 'bold' | 'italic' | 'code' | 'link'

/** A settled, non-empty editor selection and where it sits on screen. */
export type EditorSelectionAnchor = {
  text: string
  rect: { left: number; right: number; top: number; bottom: number; width: number }
}

export type MarkdownEditorHandle = {
  focus: () => void
  insertText: (text: string, expectedContent?: string) => boolean
  scrollToLine: (lineNumber: number) => void
  /** Select `exact` within the 1-based line (or the line start) and centre it. */
  revealPassage: (lineNumber: number, exact?: string) => void
  applyFormat: (format: MarkdownFormat) => void
}

type MarkdownEditorProps = {
  value: string
  onChange: (value: string) => void
  onSelectionChange?: (selection: EditorSelection) => void
  initialViewState?: EditorViewState
  onViewStateChange?: (viewState: EditorViewState) => void
  contentType?: 'text/markdown' | 'text/html'
  focusOnOpen?: boolean
  onFocused?: () => void
  onReady?: () => () => void
  availableDocuments?: DocumentSummary[]
  currentDocumentId?: string
  /** Called with pasted or dropped image files; the caller uploads and inserts them. */
  onImageFiles?: (files: File[]) => void
  onSelectionSettled?: (selection: EditorSelectionAnchor | null) => void
}

function formatEdit(view: EditorView, format: MarkdownFormat): TextEdit {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc.toString()
  if (format === 'link') return linkSelection(doc, from, to)
  return toggleInlineMarker(doc, from, to, format === 'bold' ? '**' : format === 'italic' ? '_' : '`')
}

function applyEdit(view: EditorView, edit: TextEdit) {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: edit.selection,
    scrollIntoView: true,
    userEvent: 'input.format',
  })
  view.focus()
}

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => SUPPORTED_IMAGE_TYPES.includes(file.type))
}

function settledSelection(view: EditorView): EditorSelectionAnchor | null {
  const { from, to } = view.state.selection.main
  const text = view.state.sliceDoc(from, to)
  if (!text.trim()) return null
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to, -1)
  if (!start || !end) return null
  const left = Math.min(start.left, end.left)
  const right = Math.max(start.right, end.right)
  return {
    text,
    rect: {
      left,
      right,
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
      width: right - left,
    },
  }
}

function createDocumentLinkCompletionSource(
  availableDocumentsRef: React.MutableRefObject<DocumentSummary[] | undefined>,
  currentDocumentIdRef: React.MutableRefObject<string | undefined>,
) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\[\[([^\]]*)$/)
    if (!word) return null
    if (word.from === word.to && !context.explicit) return null

    const query = word.text.slice(2).trim().toLowerCase()
    const docs = availableDocumentsRef.current ?? []
    const currentId = currentDocumentIdRef.current
    const candidates = currentId ? docs.filter((doc) => doc.document_id !== currentId) : docs

    const matches = query
      ? candidates.filter(
          (doc) =>
            doc.title.toLowerCase().includes(query) || (doc.path && doc.path.toLowerCase().includes(query)),
        )
      : candidates

    return {
      from: word.from,
      options: matches.slice(0, 25).map((doc) => ({
        label: doc.title || (doc.path ?? 'Untitled'),
        detail: doc.path ?? 'Saved draft',
        type: 'text',
        apply: (view, _completion, from) => {
          const markdown = internalDocumentMarkdown(doc)
          view.dispatch({
            changes: { from, to: context.pos, insert: markdown },
            selection: { anchor: from + markdown.length },
          })
        },
      })),
    }
  }
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  {
    value,
    onChange,
    onSelectionChange,
    initialViewState,
    onViewStateChange,
    contentType = 'text/markdown',
    focusOnOpen,
    onFocused,
    onReady,
    availableDocuments,
    currentDocumentId,
    onImageFiles,
    onSelectionSettled,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  const initialValueRef = useRef(value)
  const initialViewStateRef = useRef(initialViewState)
  const availableDocumentsRef = useRef(availableDocuments)
  const currentDocumentIdRef = useRef(currentDocumentId)
  const onImageFilesRef = useRef(onImageFiles)
  const onSelectionSettledRef = useRef(onSelectionSettled)

  useEffect(() => {
    onImageFilesRef.current = onImageFiles
    onSelectionSettledRef.current = onSelectionSettled
  }, [onImageFiles, onSelectionSettled])

  useEffect(() => {
    availableDocumentsRef.current = availableDocuments
    currentDocumentIdRef.current = currentDocumentId
  }, [availableDocuments, currentDocumentId])

  useEffect(() => {
    onChangeRef.current = onChange
    onSelectionChangeRef.current = onSelectionChange
    onViewStateChangeRef.current = onViewStateChange
  }, [onChange, onSelectionChange, onViewStateChange])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text: string, expectedContent?: string) => {
        const view = viewRef.current
        if (!view) return false
        if (expectedContent !== undefined && view.state.doc.toString() !== expectedContent) return false
        const selection = view.state.selection.main
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: text },
          selection: { anchor: selection.from + text.length },
          scrollIntoView: true,
        })
        view.focus()
        return true
      },
      scrollToLine: (lineNumber: number) => {
        const view = viewRef.current
        if (!view) return
        const safeLineNumber = Math.max(1, Math.min(lineNumber, view.state.doc.lines))
        const line = view.state.doc.line(safeLineNumber)
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
        })
        view.focus()
      },
      revealPassage: (lineNumber: number, exact?: string) => {
        const view = viewRef.current
        if (!view) return
        const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, view.state.doc.lines)))
        const column = exact ? line.text.toLowerCase().indexOf(exact.toLowerCase()) : -1
        const anchor = column >= 0 ? line.from + column : line.from
        const head = column >= 0 && exact ? anchor + exact.length : anchor
        view.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
        })
        view.focus()
      },
      applyFormat: (format: MarkdownFormat) => {
        const view = viewRef.current
        if (view) applyEdit(view, formatEdit(view, format))
      },
    }),
    [],
  )

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValueRef.current,
        selection: initialViewStateRef.current
          ? {
              anchor: Math.min(initialViewStateRef.current.anchor, initialValueRef.current.length),
              head: Math.min(initialViewStateRef.current.head, initialValueRef.current.length),
            }
          : undefined,
        extensions: [
          lineNumbers(),
          history(),
          contentType === 'text/html' ? html() : markdown(),
          contentType === 'text/markdown'
            ? autocompletion({
                override: [createDocumentLinkCompletionSource(availableDocumentsRef, currentDocumentIdRef)],
              })
            : [],
          highlightSelectionMatches(),
          contentType === 'text/markdown'
            ? [
                keymap.of(
                  (
                    [
                      ['Mod-b', 'bold'],
                      ['Mod-i', 'italic'],
                      ['Mod-e', 'code'],
                      // Mod-k stays the global command palette; links come from the selection toolbar.
                    ] as const
                  ).map(([key, format]) => ({
                    key,
                    preventDefault: true,
                    run: (view: EditorView) => {
                      applyEdit(view, formatEdit(view, format))
                      return true
                    },
                  })),
                ),
                EditorView.domEventHandlers({
                  paste: (event) => {
                    const files = imageFiles(event.clipboardData)
                    if (!files.length || !onImageFilesRef.current) return false
                    event.preventDefault()
                    onImageFilesRef.current(files)
                    return true
                  },
                  drop: (event, view) => {
                    const files = imageFiles(event.dataTransfer)
                    if (!files.length || !onImageFilesRef.current) return false
                    event.preventDefault()
                    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
                    if (position !== null) view.dispatch({ selection: { anchor: position } })
                    onImageFilesRef.current(files)
                    return true
                  },
                }),
              ]
            : [],
          EditorView.domEventHandlers({
            mouseup: (_event, view) => {
              requestAnimationFrame(() => onSelectionSettledRef.current?.(settledSelection(view)))
            },
            keyup: (event, view) => {
              if (
                event.shiftKey ||
                event.key === 'Shift' ||
                (event.key === 'a' && (event.metaKey || event.ctrlKey))
              )
                onSelectionSettledRef.current?.(settledSelection(view))
            },
          }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
            if (update.selectionSet && update.state.selection.main.empty)
              onSelectionSettledRef.current?.(null)
            if (update.docChanged || update.selectionSet) {
              const selection = update.state.selection.main
              const line = update.state.doc.lineAt(selection.head)
              onSelectionChangeRef.current?.({
                line: line.number,
                column: selection.head - line.from + 1,
                selectedCharacters: selection.to - selection.from,
              })
              onViewStateChangeRef.current?.({
                anchor: selection.anchor,
                head: selection.head,
                scrollTop: update.view.scrollDOM.scrollTop,
              })
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    const initialSelection = view.state.selection.main
    const initialLine = view.state.doc.lineAt(initialSelection.head)
    onSelectionChangeRef.current?.({
      line: initialLine.number,
      column: initialSelection.head - initialLine.from + 1,
      selectedCharacters: initialSelection.to - initialSelection.from,
    })
    const reportScroll = () => {
      const selection = view.state.selection.main
      onViewStateChangeRef.current?.({
        anchor: selection.anchor,
        head: selection.head,
        scrollTop: view.scrollDOM.scrollTop,
      })
    }
    view.scrollDOM.addEventListener('scroll', reportScroll, { passive: true })
    if (initialViewStateRef.current?.scrollTop) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = initialViewStateRef.current?.scrollTop ?? 0
      })
    }
    return () => {
      reportScroll()
      view.scrollDOM.removeEventListener('scroll', reportScroll)
      view.destroy()
      viewRef.current = null
    }
  }, [contentType])

  useEffect(() => {
    if (!focusOnOpen || !viewRef.current) return
    viewRef.current.focus()
    onFocused?.()
  }, [focusOnOpen, onFocused])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  // Queued cursor transactions run after the mount's controlled value effect.
  useEffect(() => onReady?.(), [onReady, value])

  return <div className="editor" ref={hostRef} />
})
