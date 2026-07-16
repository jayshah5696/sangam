import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceSettings } from './settings.appearance'

export const Route = createFileRoute('/settings')({ component: WorkspaceSettings })
