import { useEffect, useRef } from 'react'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'

export function RevisionMergeView({ original, modified }: { original: string; modified: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hostRef.current) return
    const extensions = [
      lineNumbers(),
      markdown(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ]
    const view = new MergeView({
      parent: hostRef.current,
      a: { doc: original, extensions },
      b: { doc: modified, extensions },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 2, minSize: 5 },
    })
    return () => view.destroy()
  }, [original, modified])
  return <div className="revision-merge-view" ref={hostRef} />
}
