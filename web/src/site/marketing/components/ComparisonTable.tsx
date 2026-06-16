import { Fragment, type ReactElement } from 'react'
import { Check, X, Minus } from 'lucide-react'
import './ComparisonTable.css'

/**
 * ComparisonTable — side-by-side feature comparison table.
 */
export interface ComparisonRow {
  /** Feature label shown in first column */
  feature: string
  /** Optional category grouping shown as a sub-header row */
  category?: string
  /**
   * Values keyed by competitor name.
   * Value: true (checkmark) | false (cross) | string (text) | null (N/A dash)
   */
  values: Record<string, boolean | string | null>
  /** Highlight this row (e.g. for a key differentiator) */
  highlight?: boolean
}

export interface ComparisonTableProps {
  competitors: string[]
  rows: ComparisonRow[]
  caption?: string
  /** Which competitor is "us" — gets accent column style */
  ourName?: string
}

function renderValue(v: boolean | string | null): ReactElement | string {
  if (v === true) return <Check size={17} strokeWidth={2.75} aria-label="Yes" />
  if (v === false) return <X size={16} strokeWidth={2.5} aria-label="No" />
  if (v === null) return <Minus size={15} strokeWidth={2.5} aria-label="Not applicable" />
  return String(v)
}

function valueClass(v: boolean | string | null, isOurs: boolean): string {
  const base = isOurs ? 'cell cell--ours' : 'cell'
  if (v === true) return `${base} cell--yes`
  if (v === false) return `${base} cell--no`
  if (v === null) return `${base} cell--na`
  return `${base} cell--text`
}

export default function ComparisonTable({ competitors, rows, caption, ourName = 'CartCrft' }: ComparisonTableProps) {
  let lastCategory = ''

  return (
    <div className="comparison-wrapper">
      {caption && <p className="comparison-caption">{caption}</p>}
      <div className="table-scroll">
        <table className="comparison-table" aria-label={caption ?? 'Feature comparison'}>
          <thead>
            <tr>
              <th className="feature-col" scope="col">Feature</th>
              {competitors.map((c) => (
                <th
                  key={c}
                  className={c === ourName ? 'competitor-col competitor-col--ours' : 'competitor-col'}
                  scope="col"
                >
                  {c === ourName ? (
                    <span className="our-label">{c}<span className="badge">us</span></span>
                  ) : c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const catRow = row.category && row.category !== lastCategory ? row.category : null
              if (catRow) lastCategory = row.category!
              return (
                <Fragment key={`${row.feature}-${i}`}>
                  {catRow && (
                    <tr className="category-row">
                      <td colSpan={competitors.length + 1}>{catRow}</td>
                    </tr>
                  )}
                  <tr className={row.highlight ? 'data-row data-row--highlight' : 'data-row'}>
                    <td className="feature-label">{row.feature}</td>
                    {competitors.map((c) => {
                      const v = row.values[c] ?? null
                      return (
                        <td key={c} className={valueClass(v, c === ourName)}>
                          {renderValue(v)}
                        </td>
                      )
                    })}
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
