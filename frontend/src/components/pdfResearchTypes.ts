import type { Annotation, PdfRect } from '../api'

export type AnnotationDraft = {
  annotationType: Annotation['annotation_type']
  selectedText: string | null
  geometry: PdfRect[]
}

export function annotationTypeLabel(type: Annotation['annotation_type']) {
  return type.replaceAll('_', ' ')
}
