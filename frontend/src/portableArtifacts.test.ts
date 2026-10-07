import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'
import { portableArtifactRestrictions } from '../tools/portable-artifacts'

const linter = new Linter()
function violations(code: string) {
  return linter.verify(code, {
    rules: { 'no-restricted-syntax': ['error', ...portableArtifactRestrictions] },
  })
}

describe('portable browser artifacts', () => {
  it.each([
    "const artifactDir = '/home/jshah/.t3/brain/session'",
    "const screenshotPath = '/Users/developer/capture.png'",
    "page.screenshot({ path: '/home/developer/capture.png' })",
    'page.screenshot({ path: `/Users/developer/${name}.png` })',
  ])('rejects machine-specific capture destinations: %s', (code) => {
    expect(violations(code).map((issue) => issue.ruleId)).toEqual(['no-restricted-syntax'])
  })

  it.each([
    "page.screenshot({ path: testInfo.outputPath('capture.png') })",
    'const evidenceDir = process.env.SANGAM_EVIDENCE_DIR',
    "page.screenshot({ path: path.join(evidenceDir, 'capture.png') })",
    "const fixtureContent = '/home/developer/research.md'",
    "const artifactDir = '/tmp/sangam-evidence'",
  ])('accepts portable destinations and unrelated fixture data: %s', (code) => {
    expect(violations(code)).toEqual([])
  })
})
