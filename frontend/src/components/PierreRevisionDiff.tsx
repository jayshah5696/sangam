import { useEffect, useState, type ComponentProps } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import { preloadMultiFileDiff } from '@pierre/diffs/ssr'
import type { FileContents } from '@pierre/diffs'

interface PierreRevisionDiffProps {
  oldFile: FileContents
  newFile: FileContents
  options: NonNullable<ComponentProps<typeof MultiFileDiff>['options']>
}

interface PreloadState extends PierreRevisionDiffProps {
  prerenderedHTML?: string
  error?: string
}

export function PierreRevisionDiff({ oldFile, newFile, options }: PierreRevisionDiffProps) {
  const [preloadState, setPreloadState] = useState<PreloadState>()

  useEffect(() => {
    let cancelled = false

    void preloadMultiFileDiff({ oldFile, newFile, options })
      .then((result) => {
        if (!cancelled) {
          setPreloadState({ oldFile, newFile, options, prerenderedHTML: result.prerenderedHTML })
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setPreloadState({
            oldFile,
            newFile,
            options,
            error: reason instanceof Error ? reason.message : 'Unable to render this comparison.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [newFile, oldFile, options])

  const isCurrent =
    preloadState?.oldFile === oldFile && preloadState.newFile === newFile && preloadState.options === options

  if (isCurrent && preloadState.error) {
    return <p className="revision-diff-error">Revision comparison failed: {preloadState.error}</p>
  }
  if (!isCurrent || !preloadState.prerenderedHTML) {
    return <p className="revision-diff-loading">Preparing revision comparison…</p>
  }

  return (
    <MultiFileDiff
      oldFile={oldFile}
      newFile={newFile}
      options={options}
      prerenderedHTML={preloadState.prerenderedHTML}
      disableWorkerPool
    />
  )
}
