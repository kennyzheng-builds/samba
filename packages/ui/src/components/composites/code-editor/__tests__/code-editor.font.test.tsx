// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CodeEditor from '../code-editor'

// This file deliberately renders the real CodeMirror (no `@uiw/react-codemirror` mock):
// the behaviour under test is which of CodeMirror's own injected stylesheets wins.
const scrollerFontFamilyDeclarations = () =>
  Array.from(document.querySelectorAll('style'))
    .flatMap((style) => (style.textContent ?? '').split('}'))
    .filter((rule) => rule.includes('.cm-scroller') && rule.includes('font-family'))

describe('CodeEditor code font', () => {
  it('lets the app code font outrank CodeMirror’s monospace default', () => {
    render(<CodeEditor value="const answer = 42" language="javascript" />)

    const declarations = scrollerFontFamilyDeclarations()

    // CodeMirror's base theme pins `.cm-scroller` to `monospace` from an unlayered
    // stylesheet, so the app font cannot be delivered by an `@layer` rule — it has to
    // sit in a CodeMirror theme, which mounts after the base theme and therefore wins.
    expect(declarations.length).toBeGreaterThan(0)
    expect(declarations.at(-1)).toContain('var(--code-font-family')
  })
})
