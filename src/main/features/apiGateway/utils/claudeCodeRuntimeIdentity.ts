/**
 * The Claude Code CLI prepends one hardcoded runtime-identity sentence to the system
 * prompt of every request it issues — `You are Claude Code, Anthropic's official CLI
 * for Claude, running within the Claude Agent SDK.` when an appended prompt is present,
 * `You are a Claude agent, built on Anthropic's Claude Agent SDK.` for a fully custom
 * one — and the SDK exposes no option to suppress or replace it. Cherry runs arbitrary
 * models on that runtime, so every non-Anthropic Agent model is told in the second
 * person that it is Claude and answers accordingly when asked who it is. The gateway is
 * the last hop Cherry owns, so authenticated internal Agent requests drop the sentence
 * here, before the request is serialized for the target provider.
 */
import type { MessageCreateParams, TextBlockParam } from '@anthropic-ai/sdk/resources/messages'

/**
 * A standalone single-line system block claiming the assistant *is* Claude Code or a
 * Claude agent. Deliberately narrow — it must be the entire block — so the preset's
 * third-person environment notes and agent instructions that merely mention Claude
 * Code are left alone.
 */
const RUNTIME_IDENTITY_BLOCK = /^You are (?:Claude Code|a Claude agent)\b[^\n]*$/

function isRuntimeIdentityBlock(block: TextBlockParam): boolean {
  return block.type === 'text' && RUNTIME_IDENTITY_BLOCK.test(block.text.trim())
}

/**
 * Remove the CLI's runtime-identity block from an Anthropic `system` field. Returns the
 * input unchanged when there is nothing to remove; a `string` system holds no separate
 * identity block, so it is never rewritten.
 */
export function stripClaudeCodeRuntimeIdentity(system: MessageCreateParams['system']): MessageCreateParams['system'] {
  if (!Array.isArray(system)) return system

  const kept = system.filter((block) => !isRuntimeIdentityBlock(block))
  return kept.length === system.length ? system : kept
}
