import { loggerService } from '@logger'
import type { JobScheduleSnapshot, Trigger } from '@shared/data/api/schemas/jobs'

import type { JobHandler, JobMissEvent } from '../types'

const logger = loggerService.withContext('JobCatchUp')

/**
 * Projects the first occurrence of a cron trigger strictly after `fromMs`, or
 * `null` if it has none. Injected by the caller rather than computed here:
 * croner belongs to SchedulerService, and this module stays pure.
 */
export type CronProjector = (trigger: Extract<Trigger, { kind: 'cron' }>, fromMs: number) => number | null

/**
 * What the caller (JobManager) should do for this schedule.
 *
 * `shouldEnqueue=false + missEvent=null` means the schedule is fine — no
 * action needed. `shouldEnqueue=false + missEvent != null` means notify the
 * handler that a fire was missed but do not enqueue (skip-missed policy).
 */
export interface CatchUpAction {
  scheduleId: string
  type: string
  shouldEnqueue: boolean
  /** Delay before enqueuing the make-up job. Used by `after-startup`. */
  enqueueDelayMs: number
  missEvent: JobMissEvent | null
}

/**
 * Compute the catch-up action for one schedule given current time and the
 * handler registered for its type. Pure function — JobManager owns the
 * iteration and the actual side-effect dispatch.
 *
 * "Overdue" depends on trigger kind:
 *   - cron: `schedule.nextRun <= now` when that column is populated. Only a
 *     fire writes it, so a schedule that has never fired (just created, or its
 *     trigger just edited) falls back to the same anchor rule as interval —
 *     `projectNextRun(trigger, lastRun ?? createdAt) <= now`. Without the
 *     fallback, a cron task missed before its first fire is never caught up.
 *   - interval: `(lastRun ?? createdAt) + ms <= now` — Scheduler does not
 *     compute a nextRun for non-cron triggers, so the catch-up branch falls
 *     back to lastRun + interval. Without this, an interval schedule with
 *     `after-startup` would never enqueue a make-up job.
 *   - once: never overdue here. A `once` trigger that already fired
 *     consumed itself; if it never fired, the SchedulerService timer will.
 *
 * Catch-up policies:
 *   - skip-missed   : do NOT enqueue, but still emit missEvent (observability).
 *   - after-startup : enqueue once after `minutes * 60_000` ms; emit missEvent.
 *
 * `after-idle` is deferred (requires PowerMonitor.getSystemIdleTime API).
 */
export function computeCatchUpAction(
  schedule: JobScheduleSnapshot,
  handler: JobHandler,
  nowMs: number,
  projectNextRun?: CronProjector
): CatchUpAction {
  const lastRunMs = schedule.lastRun ? Date.parse(schedule.lastRun) : null
  const isOverdue = isScheduleOverdue(schedule, lastRunMs, nowMs, projectNextRun)

  if (!isOverdue) {
    return { scheduleId: schedule.id, type: schedule.type, shouldEnqueue: false, enqueueDelayMs: 0, missEvent: null }
  }

  // Always build miss event when overdue + handler defines onMissed.
  // skip-missed still wants the event for observability / breaker logic.
  const missEvent: JobMissEvent | null = handler.onMissed
    ? {
        scheduleId: schedule.id,
        type: schedule.type,
        missedCount: 1,
        lastFireAt: lastRunMs
      }
    : null

  if (schedule.catchUpPolicy.kind === 'skip-missed') {
    logger.debug('Catch-up: skip-missed', { scheduleId: schedule.id, type: schedule.type })
    return { scheduleId: schedule.id, type: schedule.type, shouldEnqueue: false, enqueueDelayMs: 0, missEvent }
  }

  // after-startup
  const delayMs = schedule.catchUpPolicy.minutes * 60_000
  logger.debug('Catch-up: after-startup', { scheduleId: schedule.id, type: schedule.type, delayMs })
  return { scheduleId: schedule.id, type: schedule.type, shouldEnqueue: true, enqueueDelayMs: delayMs, missEvent }
}

/**
 * Overdue = the schedule owed a fire that has not happened and has not been
 * made up. `lastRun` / `nextRun` advance only on a real fire or on a make-up
 * (JobManager writes `markFired` for the fire it makes up), so an expected
 * fire still sitting in the past is an unpaid debt.
 *
 * A fire stranded by a pause counts as owed: pause is one of the three ways
 * the reported regression loses a fire (app closed, machine asleep, task
 * paused), and JobManager settles that debt on resume.
 */
function isScheduleOverdue(
  schedule: JobScheduleSnapshot,
  lastRunMs: number | null,
  nowMs: number,
  projectNextRun?: CronProjector
): boolean {
  const dueMs = expectedFireMs(schedule, lastRunMs, projectNextRun)
  return dueMs !== null && dueMs <= nowMs
}

/**
 * The fire this schedule should already have made, per trigger kind.
 * Separated out so the trigger-kind switch is one place and the overdue rule
 * above stays focused on whether that fire is still owed.
 */
function expectedFireMs(
  schedule: JobScheduleSnapshot,
  lastRunMs: number | null,
  projectNextRun?: CronProjector
): number | null {
  const trigger = schedule.trigger
  if (trigger.kind === 'cron') {
    if (schedule.nextRun) return Date.parse(schedule.nextRun)
    // Never fired — no persisted nextRun to compare against. Same anchor as
    // the interval branch: if the app had been running, the occurrence
    // following the anchor would have fired.
    return projectNextRun?.(trigger, lastRunMs ?? Date.parse(schedule.createdAt)) ?? null
  }
  if (trigger.kind === 'interval') {
    // Anchor: lastRun (if ever fired) else createdAt. Scheduler does not write
    // nextRun for non-cron triggers, so the anchor + ms math is the authority.
    return (lastRunMs ?? Date.parse(schedule.createdAt)) + trigger.ms
  }
  // once: armed in SchedulerService via setTimeout. If it hasn't fired by now,
  // the timer is still pending — not overdue from catch-up's perspective.
  return null
}
