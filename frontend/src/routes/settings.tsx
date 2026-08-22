import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { WorkspaceSettings } from './settings.appearance'

export const settingsCategorySchema = z.enum([
  'appearance',
  'workbench',
  'organization',
  'models',
  'agents',
  'operations',
])

export const Route = createFileRoute('/settings')({
  validateSearch: z.object({
    category: settingsCategorySchema.catch('appearance').default('appearance'),
    destination: z.string().optional(),
  }),
  component: WorkspaceSettings,
})
