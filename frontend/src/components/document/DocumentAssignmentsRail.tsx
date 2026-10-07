import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { AssignmentStatus } from '../projects/ProjectAssignments'
import { StateMessage } from '../ui/StateMessage'
import { Bot, Play } from 'lucide-react'

export function DocumentAssignmentsRail({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [instructions, setInstructions] = useState('Verify key claims and evidence consistency.')
  const [key, setKey] = useState(() => crypto.randomUUID())

  const assignmentsQuery = useQuery({
    queryKey: ['document-assignments', documentId],
    queryFn: () => api.listDocumentAssignments(documentId),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === 'running' || a.status === 'queued') ? 2000 : false,
  })

  const startMutation = useMutation({
    mutationFn: () =>
      api.createDocumentAssignment(
        documentId,
        {
          instructions,
          document_ids: [documentId],
          max_steps: 3,
          max_seconds: 180,
          resume_after_restart: true,
        },
        key,
      ),
    onSuccess: async () => {
      setStarting(false)
      setKey(crypto.randomUUID())
      await queryClient.invalidateQueries({ queryKey: ['document-assignments', documentId] })
    },
  })

  const assignments = assignmentsQuery.data ?? []

  return (
    <section className="document-assignments-rail" aria-label="Workspace agent reviews">
      <header className="document-assignments-header">
        <div className="document-assignments-title-group">
          <Bot className="document-assignments-icon" aria-hidden="true" />
          <h3 className="document-assignments-title">Workspace Agent</h3>
        </div>
        {!starting && (
          <button
            className="secondary-action document-assignments-start-btn"
            onClick={() => setStarting(true)}
          >
            <Play className="document-assignments-btn-icon" aria-hidden="true" />
            Check claims
          </button>
        )}
      </header>

      {starting && (
        <form
          className="document-assignments-form"
          onSubmit={(e) => {
            e.preventDefault()
            startMutation.mutate()
          }}
        >
          <input
            aria-label="Agent assignment instructions"
            className="project-modal-input"
            value={instructions}
            maxLength={4000}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="document-assignments-form-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={!instructions.trim() || startMutation.isPending}
            >
              Run review
            </button>
            <button className="secondary-action" type="button" onClick={() => setStarting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {assignmentsQuery.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load assignments"
          description={assignmentsQuery.error.message}
        />
      )}

      {assignments.length === 0 && !starting && (
        <p className="document-assignments-empty small-muted">
          No agent reviews run for this document yet. Start an assignment to check claims against sources.
        </p>
      )}

      {assignments.map((assignment) => (
        <AssignmentStatus key={assignment.assignment_id} assignment={assignment} />
      ))}
    </section>
  )
}
