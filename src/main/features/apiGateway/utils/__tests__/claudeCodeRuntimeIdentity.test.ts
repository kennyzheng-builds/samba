import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import { stripClaudeCodeRuntimeIdentity } from '../claudeCodeRuntimeIdentity'

/**
 * The identity sentences and the surrounding block layout are copied from a real
 * request captured off the bundled Claude Code CLI with `ANTHROPIC_MODEL` pointed at a
 * non-Anthropic gateway model.
 */
const APPENDED_PROMPT_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const CUSTOM_PROMPT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

const text = (value: string): TextBlockParam => ({ type: 'text', text: value })

const attributionBlock = text('x-anthropic-billing-header: cc_version=2.1.220.04c; cc_entrypoint=sdk-ts;')
const presetBlock = text(
  [
    'You are an interactive agent that helps users with software engineering tasks.',
    '',
    '# Environment',
    ' - You are powered by the model deepseek:deepseek-chat.',
    ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app, and IDE extensions.'
  ].join('\n')
)

describe('stripClaudeCodeRuntimeIdentity', () => {
  it('drops the identity claim the CLI injects when Cherry appends its own prompt', () => {
    const system = [attributionBlock, text(APPENDED_PROMPT_IDENTITY), presetBlock]

    expect(stripClaudeCodeRuntimeIdentity(system)).toEqual([attributionBlock, presetBlock])
  })

  it('drops the identity claim the CLI injects for a fully custom system prompt', () => {
    const system = [attributionBlock, text(CUSTOM_PROMPT_IDENTITY), text('AGENT_INSTRUCTIONS')]

    expect(stripClaudeCodeRuntimeIdentity(system)).toEqual([attributionBlock, text('AGENT_INSTRUCTIONS')])
  })

  it('keeps the preset body, so the target model still reads which model powers it', () => {
    const kept = stripClaudeCodeRuntimeIdentity([text(APPENDED_PROMPT_IDENTITY), presetBlock]) as TextBlockParam[]

    expect(kept).toHaveLength(1)
    expect(kept[0].text).toContain('You are powered by the model deepseek:deepseek-chat.')
  })

  it('keeps agent instructions that merely mention Claude Code alongside other text', () => {
    const agentBlock = text('You are Claude Code savvy.\n\nHelp the user script the Claude Code CLI.')
    const system = [agentBlock]

    expect(stripClaudeCodeRuntimeIdentity(system)).toBe(system)
  })

  it('leaves a system prompt that carries no identity claim untouched', () => {
    const system = [attributionBlock, presetBlock]

    expect(stripClaudeCodeRuntimeIdentity(system)).toBe(system)
  })

  it('leaves a string system prompt alone — it carries no separate identity block', () => {
    expect(stripClaudeCodeRuntimeIdentity(APPENDED_PROMPT_IDENTITY)).toBe(APPENDED_PROMPT_IDENTITY)
  })
})
