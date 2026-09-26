import { createFileRoute } from '@tanstack/react-router'
import { ReviewRoute } from '../review'

export const Route = createFileRoute('/review')({ component: ReviewRoute })
