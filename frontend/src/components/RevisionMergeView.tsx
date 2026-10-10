import { lazy, Suspense, useMemo } from 'react'
import type { FileContents } from '@pierre/diffs'
import { themeMode, useTheme } from '../theme'

const PierreRevisionDiff = lazy(async () => {
  const module = await import('./PierreRevisionDiff')
  return { default: module.PierreRevisionDiff }
})

export function RevisionMergeView({ original, modified }: { original: string; modified: string }) {
  const { preferences } = useTheme()
  const mode = themeMode(preferences)
  const oldFile = useMemo<FileContents>(
    () => ({ name: 'previous-revision.md', contents: original }),
    [original],
  )
  const newFile = useMemo<FileContents>(
    () => ({ name: 'current-revision.md', contents: modified }),
    [modified],
  )
  const options = useMemo(
    () => ({
      theme: { light: 'github-light', dark: 'github-dark' },
      themeType: mode,
      diffStyle: 'unified' as const,
      diffIndicators: 'bars' as const,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
    }),
    [mode],
  )

  return (
    <div className="revision-merge-view" aria-label="Revision comparison">
      <Suspense fallback={<p className="revision-diff-loading">Preparing revision comparison…</p>}>
        <PierreRevisionDiff oldFile={oldFile} newFile={newFile} options={options} />
      </Suspense>
    </div>
  )
}
