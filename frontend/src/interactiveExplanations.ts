import { useSyncExternalStore } from 'react'
import { z } from 'zod'

export const INTERACTIVE_EXPLANATIONS_STORAGE_KEY = 'sangam-interactive-explanations'

export const assumptionReferenceSchema = z.object({
  sourceDocumentId: z.string().min(1),
  sourceTitle: z.string(),
  revisionId: z.string().optional(),
  passage: z.string().optional(),
})

export type AssumptionReference = z.infer<typeof assumptionReferenceSchema>

export const explanationKindSchema = z.enum(['calculator', 'comparison', 'timeline', 'diagram', 'custom'])

export type ExplanationKind = z.infer<typeof explanationKindSchema>

export const interactiveExplanationSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  title: z.string().min(1),
  kind: explanationKindSchema,
  htmlContent: z.string(),
  assumptions: z.array(assumptionReferenceSchema),
  createdAt: z.string(),
})

export type InteractiveExplanation = z.infer<typeof interactiveExplanationSchema>

export const EXPLANATION_TEMPLATES = {
  calculator: {
    defaultTitle: 'Parameter Estimation Calculator',
    description: 'Interactive calculator exploring parameter trade-offs and cost estimates.',
    sampleHtml: `<!doctype html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; background: #fafafa; color: #111; }
  .calc-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; max-width: 480px; }
  h3 { margin-top: 0; font-size: 16px; }
  .row { margin-bottom: 12px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
  input[type=range] { width: 100%; }
  .val { float: right; font-weight: 600; color: #0284c7; }
  .result { margin-top: 16px; padding: 12px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; font-size: 14px; font-weight: 600; color: #0369a1; }
</style>
</head>
<body>
<div class="calc-card">
  <h3>Interactive Model Memory Estimator</h3>
  <div class="row">
    <label>Model Parameters (Billions): <span id="pVal" class="val">7B</span></label>
    <input type="range" id="params" min="1" max="70" value="7" oninput="recalc()">
  </div>
  <div class="row">
    <label>Quantization Bits: <span id="qVal" class="val">4-bit</span></label>
    <input type="range" id="bits" min="2" max="16" step="2" value="4" oninput="recalc()">
  </div>
  <div class="result" id="res">Estimated Memory: ~3.5 GB VRAM</div>
</div>
<script>
  function recalc() {
    const p = parseFloat(document.getElementById('params').value);
    const b = parseFloat(document.getElementById('bits').value);
    document.getElementById('pVal').innerText = p + 'B';
    document.getElementById('qVal').innerText = b + '-bit';
    const mem = ((p * b) / 8 * 1.15).toFixed(1);
    document.getElementById('res').innerText = 'Estimated Memory: ~' + mem + ' GB VRAM';
  }
</script>
</body>
</html>`,
  },
  comparison: {
    defaultTitle: 'A/B Variant Metric Comparison',
    description: 'Compare test variants or model benchmarks interactively.',
    sampleHtml: `<!doctype html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; background: #fafafa; color: #111; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden; }
  th, td { padding: 10px 12px; border-bottom: 1px solid #e5e5e5; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  .badge-win { color: #15803d; font-weight: 600; background: #dcfce7; padding: 2px 6px; border-radius: 4px; }
  .badge-alt { color: #4b5563; }
</style>
</head>
<body>
<table>
  <thead>
    <tr><th>Metric</th><th>Baseline (FP16)</th><th>Optimized (4-Bit)</th></tr>
  </thead>
  <tbody>
    <tr><td>Latency (p95)</td><td class="badge-alt">142 ms</td><td class="badge-win">48 ms (-66%)</td></tr>
    <tr><td>Memory Footprint</td><td class="badge-alt">15.8 GB</td><td class="badge-win">4.2 GB (-73%)</td></tr>
    <tr><td>Task Accuracy</td><td class="badge-win">94.2%</td><td class="badge-alt">93.1% (-1.1%)</td></tr>
  </tbody>
</table>
</body>
</html>`,
  },
  timeline: {
    defaultTitle: 'Chronological Experiment Timeline',
    description: 'Step-by-step milestone and evaluation timeline.',
    sampleHtml: `<!doctype html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; background: #fafafa; color: #111; }
  .timeline { border-left: 2px solid #0284c7; padding-left: 16px; margin-left: 8px; }
  .item { margin-bottom: 16px; position: relative; }
  .dot { position: absolute; left: -22px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: #0284c7; }
  .date { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; }
  .title { font-size: 14px; font-weight: 600; margin: 2px 0; }
  .desc { font-size: 12px; color: #475569; }
</style>
</head>
<body>
<div class="timeline">
  <div class="item">
    <div class="dot"></div>
    <div class="date">Phase 1</div>
    <div class="title">Baseline Benchmark Reproduction</div>
    <div class="desc">Reproduced upstream numbers on 7B architecture.</div>
  </div>
  <div class="item">
    <div class="dot"></div>
    <div class="date">Phase 2</div>
    <div class="title">Quantization Calibration</div>
    <div class="desc">Applied AWQ profile on 10,000 domain tokens.</div>
  </div>
</div>
</body>
</html>`,
  },
  diagram: {
    defaultTitle: 'Explorable Architecture Flow',
    description: 'Interactive SVG diagram showing modular pipeline connections.',
    sampleHtml: `<!doctype html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; background: #fafafa; text-align: center; }
  svg { max-width: 100%; height: auto; }
  rect { fill: #ffffff; stroke: #0284c7; stroke-width: 2; rx: 6; }
  text { font-family: inherit; font-size: 12px; fill: #0f172a; font-weight: 500; }
  line { stroke: #64748b; stroke-width: 2; stroke-dasharray: 4; }
</style>
</head>
<body>
<svg viewBox="0 0 420 100" width="420" height="100">
  <rect x="10" y="25" width="100" height="50"/>
  <text x="60" y="55" text-anchor="middle">Input PDF</text>
  <line x1="110" y1="50" x2="160" y2="50"/>
  <rect x="160" y="25" width="100" height="50"/>
  <text x="210" y="55" text-anchor="middle">Extractor</text>
  <line x1="260" y1="50" x2="310" y2="50"/>
  <rect x="310" y="25" width="100" height="50"/>
  <text x="360" y="55" text-anchor="middle">Evidence Rail</text>
</svg>
</body>
</html>`,
  },
  custom: {
    defaultTitle: 'Custom Explorable Artifact',
    description: 'Freeform HTML, CSS, and SVG explorable view.',
    sampleHtml: `<!doctype html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; margin: 0; }
  .box { padding: 16px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; }
</style>
</head>
<body>
<div class="box">
  <h3>Interactive Concept Explanation</h3>
  <p>Modify this HTML block to demonstrate dynamic behaviors tied to source inputs.</p>
</div>
</body>
</html>`,
  },
} satisfies Record<ExplanationKind, { defaultTitle: string; sampleHtml: string; description: string }>

const explanationsListSchema = z.array(interactiveExplanationSchema)
let cachedRaw: string | null | undefined
let cachedItems: InteractiveExplanation[] = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function readItems(): InteractiveExplanation[] {
  const raw = localStorage.getItem(INTERACTIVE_EXPLANATIONS_STORAGE_KEY)
  if (raw === cachedRaw) return cachedItems
  const items = raw === null ? [] : explanationsListSchema.parse(JSON.parse(raw))
  cachedRaw = raw
  cachedItems = items
  return items
}

function snapshot() {
  try {
    return readItems()
  } catch {
    return cachedItems
  }
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  const storage = (event: StorageEvent) => {
    if (event.key === INTERACTIVE_EXPLANATIONS_STORAGE_KEY) callback()
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', storage)
  }
}

async function mutate<T>(
  operation: (items: InteractiveExplanation[]) => { items: InteractiveExplanation[]; result: T },
): Promise<T> {
  if ('locks' in navigator && navigator.locks) {
    return await navigator.locks.request(INTERACTIVE_EXPLANATIONS_STORAGE_KEY, () => {
      const next = operation(readItems())
      const validated = explanationsListSchema.parse(next.items)
      const raw = JSON.stringify(validated)
      localStorage.setItem(INTERACTIVE_EXPLANATIONS_STORAGE_KEY, raw)
      cachedRaw = raw
      cachedItems = validated
      notify()
      return next.result
    })
  }
  const next = operation(readItems())
  const validated = explanationsListSchema.parse(next.items)
  const raw = JSON.stringify(validated)
  localStorage.setItem(INTERACTIVE_EXPLANATIONS_STORAGE_KEY, raw)
  cachedRaw = raw
  cachedItems = validated
  notify()
  return next.result
}

export const interactiveExplanationsStore = {
  getAll: readItems,
  getByDocument: (documentId: string): InteractiveExplanation[] =>
    readItems().filter((item) => item.documentId === documentId),
  addExplanation: async (
    item: Omit<InteractiveExplanation, 'id' | 'createdAt'>,
  ): Promise<InteractiveExplanation> => {
    const created: InteractiveExplanation = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    return mutate((items) => ({
      items: [created, ...items],
      result: created,
    }))
  },
  updateExplanation: async (
    id: string,
    patch: Partial<Pick<InteractiveExplanation, 'title' | 'htmlContent' | 'assumptions'>>,
  ): Promise<void> =>
    mutate((items) => ({
      items: items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      result: undefined,
    })),
  removeExplanation: async (id: string): Promise<void> =>
    mutate((items) => ({
      items: items.filter((item) => item.id !== id),
      result: undefined,
    })),
  clear: async (): Promise<void> =>
    mutate(() => ({
      items: [],
      result: undefined,
    })),
}

export function useInteractiveExplanations(documentId: string) {
  const all = useSyncExternalStore(subscribe, snapshot)
  const docExplanations = all.filter((item) => item.documentId === documentId)
  return {
    explanations: docExplanations,
    addExplanation: interactiveExplanationsStore.addExplanation,
    updateExplanation: interactiveExplanationsStore.updateExplanation,
    removeExplanation: interactiveExplanationsStore.removeExplanation,
  }
}
