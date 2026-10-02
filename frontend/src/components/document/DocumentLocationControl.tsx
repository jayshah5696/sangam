import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FileText, Folder as FolderIcon, X } from 'lucide-react'

import { api, writeFailureMessage, type Document, type Folder } from '../../api'
import { defaultFilename, materializePath } from '../../documentWorkspaceState'
import { StateMessage } from '../ui/StateMessage'

interface DocumentLocationControlProps {
  document: Document
  saveState: string
  onUpdated?: (updated: Document) => void
}

interface LocationPopoverFormProps {
  document: Document
  saveState: string
  onClose: () => void
  onUpdated?: (updated: Document) => void
}

function LocationPopoverForm({ document, saveState, onClose, onUpdated }: LocationPopoverFormProps) {
  const parts = document.path ? document.path.split('/') : []
  const initialFilename = parts.pop() ?? defaultFilename(document.title, document.content_type)
  const initialFolder = parts.join('/')

  const [folder, setFolder] = useState(initialFolder)
  const [filename, setFilename] = useState(initialFilename)
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()

  const foldersQuery = useQuery<Folder[]>({
    queryKey: ['folders'],
    queryFn: () => api.listFolders(),
  })

  const materializeMutation = useMutation({
    mutationFn: (targetPath: string) => api.materializeDocument(document, targetPath),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      onUpdated?.(updated)
      onClose()
    },
    onError: (err) => setError(writeFailureMessage(err, 'The draft could not be saved to that path.')),
  })

  const moveMutation = useMutation({
    mutationFn: (targetPath: string) => api.moveDocument(document, targetPath),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      onUpdated?.(updated)
      onClose()
    },
    onError: (err) => setError(writeFailureMessage(err, 'The document could not be moved.')),
  })

  const isDraft = !document.path
  const targetPath = materializePath(folder, filename)
  const isPending = materializeMutation.isPending || moveMutation.isPending
  const isSaveReady = saveState === 'saved'

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!filename.trim()) {
      setError('Please provide a valid filename.')
      return
    }
    setError(null)
    if (isDraft) {
      materializeMutation.mutate(targetPath)
    } else {
      moveMutation.mutate(targetPath)
    }
  }

  return (
    <div className="location-control-popover-content">
      <div className="location-control-popover-header">
        <div>
          <h4 className="location-control-title">{isDraft ? 'Draft location' : 'Document location'}</h4>
          <p className="location-control-description">
            {isDraft
              ? 'This document is a saved draft. Choose a workspace path to materialize it into a file.'
              : 'Choose a folder or rename the file in your workspace.'}
          </p>
        </div>
        <button
          type="button"
          className="location-control-close"
          onClick={onClose}
          aria-label="Close location popover"
        >
          <X size="var(--icon-inline)" aria-hidden="true" />
        </button>
      </div>

      <form className="location-control-form" onSubmit={handleSubmit}>
        <div className="location-control-field">
          <label className="location-control-field-label" htmlFor="location-folder-select">
            Folder
          </label>
          <select
            id="location-folder-select"
            aria-label="Workspace folder"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">Workspace root</option>
            {(foldersQuery.data ?? []).map((f) => (
              <option key={f.folder_id} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        </div>

        <div className="location-control-field">
          <label className="location-control-field-label" htmlFor="location-filename-input">
            Filename
          </label>
          <input
            id="location-filename-input"
            aria-label="Workspace filename"
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            placeholder="document.md"
          />
        </div>

        {error && <StateMessage compact kind="error" title={error} />}

        <div className="location-control-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={isPending || !filename.trim() || !isSaveReady}
          >
            {isPending ? 'Moving…' : isDraft ? 'Move to folder' : 'Move file'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function DocumentLocationControl({ document, saveState, onUpdated }: DocumentLocationControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Dismiss on outside click and Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mousedown', handleClickOutside)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const isDraft = !document.path
  const label = document.path ?? 'Saved draft'

  return (
    <div className="location-control">
      <button
        ref={triggerRef}
        type="button"
        className={`location-control-pill ${isDraft ? 'draft' : 'workspace-file'}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`Document location: ${label}. Click to change location.`}
      >
        {isDraft ? (
          <FileText size="var(--icon-inline)" aria-hidden="true" />
        ) : (
          <FolderIcon size="var(--icon-inline)" aria-hidden="true" />
        )}
        <span className="location-control-label">{label}</span>
        <ChevronDown size="var(--icon-inline)" className="location-control-chevron" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={isDraft ? 'Draft location' : 'Workspace location'}
          className="location-control-popover"
        >
          <LocationPopoverForm
            document={document}
            saveState={saveState}
            onClose={() => {
              setIsOpen(false)
              triggerRef.current?.focus()
            }}
            onUpdated={onUpdated}
          />
        </div>
      )}
    </div>
  )
}
