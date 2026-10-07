import { useState } from 'react'
import {
  Calculator,
  Code2,
  ExternalLink,
  Eye,
  FileText,
  GitBranch,
  Layers,
  Plus,
  Sliders,
  Trash2,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import type { Document } from '../../api'
import {
  EXPLANATION_TEMPLATES,
  useInteractiveExplanations,
  type ExplanationKind,
  type InteractiveExplanation,
} from '../../interactiveExplanations'
import { HtmlPreview } from '../HtmlPreview'
import { ModalDialog } from '../ui/ModalDialog'
import { StateMessage } from '../ui/StateMessage'

const QUICK_TEMPLATE_KINDS: ExplanationKind[] = ['calculator', 'comparison', 'timeline', 'diagram']
const ALL_EXPLANATION_KINDS: ExplanationKind[] = ['calculator', 'comparison', 'timeline', 'diagram', 'custom']

export function InteractiveExplanationRail({
  document,
  onNavigateSource,
}: {
  document: Document
  onNavigateSource?: (documentId: string, revisionId?: string) => void
}) {
  const navigate = useNavigate()
  const { explanations, addExplanation, updateExplanation, removeExplanation } =
    useInteractiveExplanations(document.document_id)

  const [activeTabMap, setActiveTabMap] = useState<
    Record<string, 'preview' | 'assumptions' | 'code'>
  >({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<ExplanationKind>('calculator')
  const [formTitle, setFormTitle] = useState('')
  const [formHtml, setFormHtml] = useState('')
  const [formSourceTitle, setFormSourceTitle] = useState('')
  const [formPassage, setFormPassage] = useState('')

  const getActiveTab = (id: string) => activeTabMap[id] ?? 'preview'
  const setActiveTab = (id: string, tab: 'preview' | 'assumptions' | 'code') => {
    setActiveTabMap((prev) => ({ ...prev, [id]: tab }))
  }

  const handleOpenCreateModal = (kind: ExplanationKind = 'calculator') => {
    const template = EXPLANATION_TEMPLATES[kind]
    setSelectedKind(kind)
    setFormTitle(template.defaultTitle)
    setFormHtml(template.sampleHtml)
    setFormSourceTitle(document.title)
    setFormPassage('')
    setEditingId(null)
    setModalOpen(true)
  }

  const handleOpenEditModal = (item: InteractiveExplanation) => {
    setEditingId(item.id)
    setSelectedKind(item.kind)
    setFormTitle(item.title)
    setFormHtml(item.htmlContent)
    const firstAssumption = item.assumptions[0]
    setFormSourceTitle(firstAssumption?.sourceTitle ?? document.title)
    setFormPassage(firstAssumption?.passage ?? '')
    setModalOpen(true)
  }

  const handleSaveExplanation = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formTitle.trim()) return

    const assumptions = formSourceTitle.trim()
      ? [
          {
            sourceDocumentId: document.document_id,
            sourceTitle: formSourceTitle.trim(),
            revisionId: document.current_revision_id,
            passage: formPassage.trim() || undefined,
          },
        ]
      : []

    if (editingId) {
      await updateExplanation(editingId, {
        title: formTitle.trim(),
        htmlContent: formHtml,
        assumptions,
      })
    } else {
      await addExplanation({
        documentId: document.document_id,
        title: formTitle.trim(),
        kind: selectedKind,
        htmlContent: formHtml,
        assumptions,
      })
    }
    setModalOpen(false)
  }

  const getKindIcon = (kind: ExplanationKind) => {
    switch (kind) {
      case 'calculator':
        return <Calculator size="var(--icon-detail)" />
      case 'comparison':
        return <Sliders size="var(--icon-detail)" />
      case 'timeline':
        return <GitBranch size="var(--icon-detail)" />
      case 'diagram':
        return <Layers size="var(--icon-detail)" />
      default:
        return <FileText size="var(--icon-detail)" />
    }
  }

  return (
    <section className="interactive-explanation-rail" aria-label="Attached interactive explanations">
      <header className="explanation-rail-header">
        <div>
          <p className="eyebrow">Interactive Explanations</p>
          <strong>Explorable Attachments</strong>
        </div>
        <button
          type="button"
          className="secondary-action button-sm"
          onClick={() => handleOpenCreateModal('calculator')}
          aria-label="Attach interactive explanation"
        >
          <Plus size="var(--icon-detail)" />
          <span>Attach</span>
        </button>
      </header>

      {explanations.length === 0 ? (
        <div className="explanation-rail-empty">
          <StateMessage
            compact
            kind="empty"
            title="No interactive explanations attached"
            description="Turn document sections into interactive calculators, comparison tools, timelines, or diagrams."
            action={
              <div className="template-quick-buttons">
                {QUICK_TEMPLATE_KINDS.map(
                  (kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="secondary-action button-sm"
                      onClick={() => handleOpenCreateModal(kind)}
                    >
                      {getKindIcon(kind)}
                      <span className="capitalize">{kind}</span>
                    </button>
                  ),
                )}
              </div>
            }
          />
        </div>
      ) : (
        <div className="explanation-items-list" role="feed" aria-label="Interactive explanation list">
          {explanations.map((item) => {
            const currentTab = getActiveTab(item.id)
            return (
              <article key={item.id} className="explanation-card" aria-label={item.title}>
                <header className="explanation-card-header">
                  <div className="explanation-card-meta">
                    <span className="explanation-kind-badge">
                      {getKindIcon(item.kind)}
                      <span>{item.kind}</span>
                    </span>
                    <strong className="explanation-card-title">{item.title}</strong>
                  </div>

                  <div className="explanation-card-actions">
                    <button
                      type="button"
                      className="icon-button-sm"
                      onClick={() => handleOpenEditModal(item)}
                      title="Edit explanation and assumptions"
                      aria-label="Edit explanation"
                    >
                      <Code2 size="var(--icon-detail)" />
                    </button>
                    <button
                      type="button"
                      className="icon-button-sm"
                      onClick={() => void removeExplanation(item.id)}
                      title="Remove explanation"
                      aria-label="Remove explanation"
                    >
                      <Trash2 size="var(--icon-detail)" />
                    </button>
                  </div>
                </header>

                <div className="explanation-tab-bar" role="tablist" aria-label="Explanation view modes">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={currentTab === 'preview'}
                    className={`explanation-tab-btn ${currentTab === 'preview' ? 'active' : ''}`}
                    onClick={() => setActiveTab(item.id, 'preview')}
                  >
                    <Eye size="var(--icon-detail)" />
                    <span>Interactive View</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={currentTab === 'assumptions'}
                    className={`explanation-tab-btn ${currentTab === 'assumptions' ? 'active' : ''}`}
                    onClick={() => setActiveTab(item.id, 'assumptions')}
                  >
                    <FileText size="var(--icon-detail)" />
                    <span>Source Inputs ({item.assumptions.length})</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={currentTab === 'code'}
                    className={`explanation-tab-btn ${currentTab === 'code' ? 'active' : ''}`}
                    onClick={() => setActiveTab(item.id, 'code')}
                  >
                    <Code2 size="var(--icon-detail)" />
                    <span>HTML Spec</span>
                  </button>
                </div>

                <div className="explanation-body">
                  {currentTab === 'preview' && (
                    <div className="explanation-preview-pane">
                      <HtmlPreview content={item.htmlContent} />
                    </div>
                  )}

                  {currentTab === 'assumptions' && (
                    <div className="explanation-assumptions-pane">
                      <p className="assumptions-lead">
                        Underlying assumptions and source inputs tied to this interactive model:
                      </p>
                      {item.assumptions.length === 0 ? (
                        <p className="assumptions-empty">No explicit source documents linked yet.</p>
                      ) : (
                        <div className="assumptions-list">
                          {item.assumptions.map((assump, index) => (
                            <div key={index} className="assumption-item">
                              <div className="assumption-header">
                                <strong>{assump.sourceTitle}</strong>
                                {assump.revisionId && (
                                  <span className="scope-badge">rev {assump.revisionId.slice(0, 8)}</span>
                                )}
                              </div>
                              {assump.passage && (
                                <blockquote className="assumption-quote">{assump.passage}</blockquote>
                              )}
                              <button
                                type="button"
                                className="secondary-action button-sm"
                                onClick={() => {
                                  if (onNavigateSource) {
                                    onNavigateSource(assump.sourceDocumentId, assump.revisionId)
                                  } else {
                                    void navigate({
                                      to: '/documents/$documentId',
                                      params: { documentId: assump.sourceDocumentId },
                                    })
                                  }
                                }}
                              >
                                <ExternalLink size="var(--icon-detail)" />
                                <span>Inspect in source</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {currentTab === 'code' && (
                    <div className="explanation-code-pane">
                      <pre className="explanation-code-block">
                        <code>{item.htmlContent}</code>
                      </pre>
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {modalOpen && (
        <ModalDialog
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title={editingId ? 'Edit Interactive Explanation' : 'Attach Interactive Explanation'}
          className="explanation-edit-dialog"
        >
          <form className="explanation-modal-form" onSubmit={handleSaveExplanation}>
            <div className="form-group">
              <label htmlFor="exp-title">Explanation Title</label>
              <input
                id="exp-title"
                type="text"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g. Model VRAM Memory Estimator"
                required
              />
            </div>

            {!editingId && (
              <div className="form-group">
                <label>Template Type</label>
                <div className="kind-picker" role="radiogroup" aria-label="Template type">
                  {ALL_EXPLANATION_KINDS.map(
                    (kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={`kind-picker-btn ${selectedKind === kind ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedKind(kind)
                          setFormTitle(EXPLANATION_TEMPLATES[kind].defaultTitle)
                          setFormHtml(EXPLANATION_TEMPLATES[kind].sampleHtml)
                        }}
                      >
                        {getKindIcon(kind)}
                        <span className="capitalize">{kind}</span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}

            <div className="form-group">
              <label htmlFor="exp-html">HTML &amp; Script Content</label>
              <textarea
                id="exp-html"
                rows={10}
                className="code-textarea"
                value={formHtml}
                onChange={(e) => setFormHtml(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="exp-source">Source Document Title (Assumptions)</label>
              <input
                id="exp-source"
                type="text"
                value={formSourceTitle}
                onChange={(e) => setFormSourceTitle(e.target.value)}
                placeholder="Source document or experiment name"
              />
            </div>

            <div className="form-group">
              <label htmlFor="exp-passage">Input Assumption Passage</label>
              <textarea
                id="exp-passage"
                rows={3}
                value={formPassage}
                onChange={(e) => setFormPassage(e.target.value)}
                placeholder="Key assumptions, formula inputs, or baseline parameters..."
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-action"
                onClick={() => setModalOpen(false)}
              >
                Cancel
              </button>
              <button type="submit" className="panel-button">
                {editingId ? 'Save Changes' : 'Attach Explanation'}
              </button>
            </div>
          </form>
        </ModalDialog>
      )}
    </section>
  )
}
