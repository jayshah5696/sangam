import { useState, type ClipboardEvent, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileUp, Inbox, X } from 'lucide-react'
import { api, type Document, type ProjectSummary } from '../../api'
import {
  captureKindForFile,
  captureSuffix,
  fileTitle,
  inboxPath,
  linkNoteContent,
  linkTitle,
  parseCaptureText,
  textNoteTitle,
  type CaptureKind,
} from '../../capture'
import { ProjectDialog } from '../projects/ProjectDialog'
import { StateMessage } from '../ui/StateMessage'

type CaptureItem =
  | { id: string; source: 'text'; label: string; text: string }
  | { id: string; source: 'link'; label: string; url: string; fetchContent?: boolean }
  | { id: string; source: 'file'; label: string; file: File; kind: CaptureKind }

type CaptureOutcome = {
  item: CaptureItem
  state: 'working' | 'saved' | 'attention' | 'failed'
  document?: Document
  message?: string
}

const FILE_ACCEPT = '.pdf,.md,.markdown,.txt,.html,.htm,image/png,image/jpeg,image/gif,image/webp'

/**
 * One way to bring material in. Everything becomes a file in the Inbox folder;
 * a chosen project also gets it as a source. Organizing happens later.
 */
export function CaptureDialog({
  projects,
  defaultProjectId,
  onClose,
}: {
  projects: ProjectSummary[]
  defaultProjectId?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [fetchContent, setFetchContent] = useState(false)
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const [outcomes, setOutcomes] = useState<CaptureOutcome[]>([])
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health() })
  const parsedText = parseCaptureText(text)
  const project = projects.find((candidate) => candidate.project_id === projectId)
  const unsupported = files.filter((file) => !captureKindForFile(file))

  // Copy first: a FileList is live and empties when its input is reset.
  const addFiles = (incoming: Iterable<File>) => {
    const added = [...incoming]
    setFiles((current) => [...current, ...added])
  }

  const run = useMutation({
    mutationFn: async (items: CaptureItem[]) => {
      for (const item of items) {
        setOutcomes((current) => upsert(current, { item, state: 'working' }))
        const outcome = await captureOne(item, project)
        setOutcomes((current) => upsert(current, outcome))
      }
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['folders'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['project'] }),
      ]),
  })

  const capture = () => {
    const items: CaptureItem[] = []
    if (parsedText?.kind === 'link')
      items.push({
        id: crypto.randomUUID(),
        source: 'link',
        label: linkTitle(parsedText.url),
        url: parsedText.url,
        fetchContent,
      })
    if (parsedText?.kind === 'text')
      items.push({
        id: crypto.randomUUID(),
        source: 'text',
        label: textNoteTitle(parsedText.text),
        text: parsedText.text,
      })
    for (const file of files) {
      const kind = captureKindForFile(file)
      if (kind) items.push({ id: crypto.randomUUID(), source: 'file', label: file.name, file, kind })
    }
    if (!items.length) return
    setText('')
    setFiles([])
    setFetchContent(false)
    run.mutate(items)
  }

  const onPaste = (event: ClipboardEvent) => {
    if (!event.clipboardData.files.length) return
    event.preventDefault()
    addFiles(event.clipboardData.files)
  }
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    addFiles(event.dataTransfer.files)
  }

  return (
    <ProjectDialog title="Capture to Inbox" onClose={onClose}>
      <form
        className="project-modal-form capture-form"
        onSubmit={(event) => {
          event.preventDefault()
          capture()
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <p className="small-muted">
          Paste text, Markdown, or a link, or add files. Everything is saved to the <strong>Inbox</strong>{' '}
          folder so you can organize it later from each document’s location.
        </p>
        <label className="project-modal-field">
          <span>Text, Markdown, or link</span>
          <textarea
            className="project-modal-textarea capture-text"
            rows={5}
            value={text}
            placeholder="Paste anything here…"
            onChange={(event) => setText(event.target.value)}
            onPaste={onPaste}
          />
        </label>
        {parsedText?.kind === 'link' && (
          <div className="capture-link-options">
            <p className="small-muted">
              Sangam saves the link and when you captured it; it does not download the page.
            </p>
            <label className="capture-download-toggle">
              <input
                type="checkbox"
                checked={fetchContent}
                onChange={(event) => setFetchContent(event.target.checked)}
              />
              <span>Download page content securely (admin only)</span>
            </label>
          </div>
        )}
        <label className="capture-drop">
          <FileUp size="var(--icon-control)" aria-hidden="true" />
          <span>Add PDFs, images, Markdown, or HTML files — or drop them here</span>
          <input
            type="file"
            multiple
            accept={FILE_ACCEPT}
            aria-label="Add files to capture"
            onChange={(event) => {
              addFiles(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
            }}
          />
        </label>
        {files.length > 0 && (
          <ul className="capture-files" aria-label="Files to capture">
            {files.map((file, index) => (
              <li key={`${file.name}:${index}`}>
                <span>{file.name}</span>
                <small>{captureKindForFile(file) ?? 'Not supported'}</small>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}
                >
                  <X size="var(--icon-inline)" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {unsupported.length > 0 && (
          <StateMessage
            compact
            kind="error"
            title="Some files cannot be captured"
            description={`${unsupported.map((file) => file.name).join(', ')} will be skipped. Sangam keeps PDFs, PNG, JPEG, GIF, and WebP images, Markdown, text, and HTML.`}
          />
        )}
        {health.data?.karakeep_configured && (
          <p className="small-muted">
            Bookmarks already in Karakeep?{' '}
            <Link to="/karakeep" onClick={onClose}>
              Import from Karakeep
            </Link>
          </p>
        )}
        <label className="project-modal-field">
          <span>Also add to project</span>
          <select
            className="project-modal-select"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">No project — Inbox only</option>
            {projects.map((candidate) => (
              <option key={candidate.project_id} value={candidate.project_id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        {outcomes.length > 0 && (
          <ul className="capture-results" aria-label="Capture results">
            {outcomes.map((outcome) => (
              <CaptureResultRow
                key={outcome.item.id}
                outcome={outcome}
                onRetry={() => run.mutate([outcome.item])}
                onClose={onClose}
              />
            ))}
          </ul>
        )}
        <footer className="project-detail-actions capture-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            Close
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={run.isPending || (!parsedText && files.every((file) => !captureKindForFile(file)))}
          >
            <Inbox size="var(--icon-control)" /> {run.isPending ? 'Capturing…' : 'Capture'}
          </button>
        </footer>
      </form>
    </ProjectDialog>
  )
}

function CaptureResultRow({
  outcome,
  onRetry,
  onClose,
}: {
  outcome: CaptureOutcome
  onRetry: () => void
  onClose: () => void
}) {
  const documentId = outcome.document?.document_id
  const isPdf = outcome.document?.content_type === 'application/pdf'
  // A PDF is saved immediately and made searchable in the background.
  const live = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId ?? ''),
    enabled: Boolean(documentId && isPdf),
    initialData: outcome.document,
    refetchInterval: (query) =>
      ['pending', 'processing'].includes(query.state.data?.pdf_extraction_status ?? '') ? 1500 : false,
  })
  const extraction = isPdf ? live.data?.pdf_extraction_status : null
  const label =
    outcome.state === 'working'
      ? 'Saving…'
      : outcome.state === 'failed'
        ? 'Not saved'
        : outcome.state === 'attention'
          ? 'Needs attention'
          : extraction === 'pending' || extraction === 'processing'
            ? 'Saved · extracting text'
            : extraction === 'failed'
              ? 'Saved · text extraction failed'
              : 'Saved'
  return (
    <li className={`capture-result ${outcome.state}`}>
      <div>
        <strong>{outcome.document?.title ?? outcome.item.label}</strong>
        <span className="scope-badge">{label}</span>
      </div>
      {outcome.message && <small>{outcome.message}</small>}
      <div className="capture-result-actions">
        {documentId && (
          <Link to="/documents/$documentId" params={{ documentId }} onClick={onClose}>
            Open
          </Link>
        )}
        {(outcome.state === 'failed' || outcome.state === 'attention') && (
          <button type="button" className="secondary-action" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </li>
  )
}

function upsert(current: CaptureOutcome[], next: CaptureOutcome) {
  const index = current.findIndex((outcome) => outcome.item.id === next.item.id)
  if (index < 0) return [...current, next]
  return current.map((outcome, position) => (position === index ? next : outcome))
}

async function captureOne(item: CaptureItem, project: ProjectSummary | undefined): Promise<CaptureOutcome> {
  let document: Document
  try {
    document = await saveToInbox(item)
  } catch (error) {
    return { item, state: 'failed', message: error instanceof Error ? error.message : 'The capture failed.' }
  }
  if (!project) return { item, state: 'saved', document }
  try {
    await api.addProjectDocument(project.project_id, { document_id: document.document_id, role: 'source' })
    return { item, state: 'saved', document, message: `Added to ${project.name}.` }
  } catch (error) {
    // Keep the saved file; retrying captures again only if the user asks.
    return {
      item,
      state: 'attention',
      document,
      message: `Saved to Inbox, but not added to ${project.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}

async function saveToInbox(item: CaptureItem): Promise<Document> {
  const now = new Date()
  const suffix = captureSuffix()
  if (item.source === 'link') {
    const title = linkTitle(item.url)
    if (item.fetchContent) {
      return api.captureUrl(item.url, {
        title,
        path: inboxPath(title, 'md', now, suffix),
      })
    }
    return api.createDocument(
      title,
      inboxPath(title, 'md', now, suffix),
      'text/markdown',
      linkNoteContent(item.url, now),
    )
  }
  if (item.source === 'text') {
    const title = textNoteTitle(item.text)
    const content = item.text.endsWith('\n') ? item.text : `${item.text}\n`
    return api.createDocument(title, inboxPath(title, 'md', now, suffix), 'text/markdown', content)
  }
  const title = fileTitle(item.file.name)
  switch (item.kind) {
    case 'pdf':
      return api.importPdf(item.file, title, inboxPath(title, 'pdf', now, suffix))
    case 'markdown':
      return api.createDocument(
        title,
        inboxPath(title, 'md', now, suffix),
        'text/markdown',
        await item.file.text(),
      )
    case 'html':
      return api.createDocument(
        title,
        inboxPath(title, 'html', now, suffix),
        'text/html',
        await item.file.text(),
      )
    case 'image': {
      // An image is captured as a note that shows it, with the file in the shared attachments folder.
      const note = await api.createDocument(
        title,
        inboxPath(title, 'md', now, suffix),
        'text/markdown',
        `# ${title}\n\n`,
      )
      const asset = await api.attachDocumentAsset(note.document_id, item.file, item.file.name)
      return api.updateDocument(note, `${note.content}${asset.markdown}\n`)
    }
  }
}
