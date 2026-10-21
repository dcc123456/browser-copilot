/**
 * The unmet goal rows of a verification report, as one list of readable lines.
 *
 * The compose path and the run-side bridge both report "the goal was not
 * achieved" and must name the SAME rows — two readings of one report would
 * drift, and a repair is aimed at the row the reader saw.
 *
 * The shape is structural on purpose: the report lives in the background
 * engine, but this module is chrome-free so the Runner can share it.
 */
export interface GoalRowCondition {
  description: string
  satisfied: boolean
  detail?: string
}

export interface GoalRowReport {
  l3: { conditions: GoalRowCondition[] }
  softUnconfirmed?: string[]
}

export function unmetGoalRows(report: GoalRowReport): string[] {
  return [
    ...report.l3.conditions
      .filter((condition) => !condition.satisfied)
      .map((condition) =>
        condition.detail ? `${condition.description} — ${condition.detail}` : condition.description,
      ),
    ...(report.softUnconfirmed ?? []),
  ]
}
