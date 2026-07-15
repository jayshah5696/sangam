import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

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

export type MarkdownEditorHandle = {
  focus: () => void
  insertText: (text: string) => void
}

type MarkdownEditorProps = {
  value: string
  onChange: (value: string) => void
  onSelectionChange?: (selection: EditorSelection) => void
  initialViewState?: EditorViewState
  onViewStateChange?: (viewState: EditorViewState) => void
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ value, onChange, onSelectionChange, initialViewState, onViewStateChange }, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onSelectionChangeRef = useRef(onSelectionChange)
    const onViewStateChangeRef = useRef(onViewStateChange)
    const initialValueRef = useRef(value)
    const initialViewStateRef = useRef(initialViewState)

    useEffect(() => {
      onChangeRef.current = onChange
      onSelectionChangeRef.current = onSelectionChange
      onViewStateChangeRef.current = onViewStateChange
    }, [onChange, onSelectionChange, onViewStateChange])

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text: string) => {
        const view = viewRef.current
        if (!view) return
        const selection = view.state.selection.main
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: text },
          selection: { anchor: selection.from + text.length },
          scrollIntoView: true,
        })
        view.focus()
      },
    }), [])

    useEffect(() => {
      if (!hostRef.current) return
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: initialValueRef.current,
          selection: initialViewStateRef.current ? {
            anchor: Math.min(initialViewStateRef.current.anchor, initialValueRef.current.length),
            head: Math.min(initialViewStateRef.current.head, initialValueRef.current.length),
          } : undefined,
          extensions: [
            lineNumbers(),
            history(),
            markdown(),
            highlightSelectionMatches(),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) onChangeRef.current(update.state.doc.toString())
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
      const reportScroll = () => {
        const selection = view.state.selection.main
        onViewStateChangeRef.current?.({ anchor: selection.anchor, head: selection.head, scrollTop: view.scrollDOM.scrollTop })
      }
      view.scrollDOM.addEventListener('scroll', reportScroll, { passive: true })
      if (initialViewStateRef.current?.scrollTop) {
        requestAnimationFrame(() => { view.scrollDOM.scrollTop = initialViewStateRef.current?.scrollTop ?? 0 })
      }
      return () => {
        reportScroll()
        view.scrollDOM.removeEventListener('scroll', reportScroll)
        view.destroy()
        viewRef.current = null
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current
      if (!view || view.state.doc.toString() === value) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }, [value])

    return <div className="editor" ref={hostRef} />
  },
)
