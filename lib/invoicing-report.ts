// Fixed row/column order for the monthly "Info para invoicing" report, given
// directly by the user (matches their existing hand-built Google Sheet).
// This order is NOT derived from the DB — it's a curated list that has to
// stay stable month to month, so it's hardcoded here rather than computed.
//
// Each entry's `label` is the text from the user's original list (used for
// display when nothing in the DB matches, and as the stable key the UI uses
// to track include/exclude choices). `lookupNames` are the candidate
// Resource.name/Project.name values to try, case-insensitively, in order —
// most are exact matches; a few needed an alias because the sheet's label is
// an abbreviation or an old name (e.g. "Bsilva" -> "Betzabe Silva",
// "IMOUY (EG+)" -> the project is now just named "EG+").

export interface InvoicingOrderEntry {
  label: string
  lookupNames: string[]
}

export const INVOICING_PROJECT_ORDER: InvoicingOrderEntry[] = [
  { label: 'SCC-Congroup', lookupNames: ['SCC-Congroup'] },
  { label: 'Breinchild', lookupNames: ['Breinchild'] },
  { label: 'IMOUY  (EG+)', lookupNames: ['EG+', 'IMOUY'] },
  { label: 'Ideal Protein', lookupNames: ['Ideal Protein'] },
  { label: 'Bench  (Internal Issues)', lookupNames: ['Internal Issues', 'Bench'] },
  { label: 'MOB Mantenimiento', lookupNames: ['MOB Mantenimiento'] },
  { label: 'SCC-Holcim', lookupNames: ['SCC-Holcim'] },
  { label: 'SmartWay', lookupNames: ['SmartWay'] },
  { label: 'StarCenter', lookupNames: ['StarCenter'] },
  { label: 'Suku 2024', lookupNames: ['Suku 2024'] },
  { label: 'Infogain', lookupNames: ['Infogain'] },
  { label: 'AI Assessments', lookupNames: ['AI Assessments'] },
  { label: 'Claldy', lookupNames: ['Claldy'] },
  { label: 'HubID-Guardian', lookupNames: ['HubID-Guardian'] },
]

export const INVOICING_RESOURCE_ORDER: InvoicingOrderEntry[] = [
  { label: 'Raul Velazquez', lookupNames: ['Raul Velazquez'] },
  { label: 'Abdulelah Ragih', lookupNames: ['Abdulelah Ragih'] },
  { label: 'AVNER NAHUM', lookupNames: ['AVNER Santos', 'AVNER NAHUM'] },
  { label: 'Bruno Rodrigues Lopes', lookupNames: ['Bruno Rodrigues Lopes'] },
  { label: 'Bsilva', lookupNames: ['Betzabe Silva'] },
  { label: 'Claudio Uslenghi', lookupNames: ['Claudio Uslenghi'] },
  { label: 'EDUARDO NOGUEIRA', lookupNames: ['Eduardo Nogueira Vicentini', 'EDUARDO NOGUEIRA'] },
  { label: 'Facundo Wade Jacobs (fwade)', lookupNames: ['Facundo Wade'] },
  { label: 'Gonzalo Torterolo', lookupNames: ['Gonzalo Torterolo'] },
  { label: 'Kevin Yan', lookupNames: ['Kevin Yan'] },
  { label: 'lgutierrez', lookupNames: ['Luz Gutierrez'] },
  { label: 'PABLO RAPPALINI', lookupNames: ['PABLO RAPPALINI'] },
  { label: 'Rafael Basile', lookupNames: ['Rafael Basile'] },
  { label: 'rgomez', lookupNames: ['rgomez'] },
  { label: 'RICARDO AMARANTE', lookupNames: ['RICARDO AMARANTE'] },
  { label: 'Will Olivera', lookupNames: ['Will Olivera'] },
  { label: 'Yan - Kreitech', lookupNames: ['Yan'] },
  { label: 'Luciana Diniz Gonçalves dos Santos', lookupNames: ['Luciana Diniz'] },
  { label: 'Victor Córdoba', lookupNames: ['Victor Cordoba', 'Victor Córdoba'] },
  { label: 'Nicolas Daneri', lookupNames: ['Nicolas Daneri'] },
  { label: 'Nelson Toledo', lookupNames: ['Nelson Toledo'] },
]

export interface ResolvedEntry {
  label: string
  resolvedName: string | null
}

// Case-insensitive, trimmed match against real DB names. Returns null for
// entries with no match in dbNames — callers decide how to surface that
// (warning + manual include/exclude, never a silent drop or a guess).
export function resolveInvoicingOrder(order: InvoicingOrderEntry[], dbNames: string[]): ResolvedEntry[] {
  const byLower = new Map(dbNames.map((n) => [n.trim().toLowerCase(), n]))
  return order.map((entry) => {
    for (const candidate of entry.lookupNames) {
      const match = byLower.get(candidate.trim().toLowerCase())
      if (match) return { label: entry.label, resolvedName: match }
    }
    return { label: entry.label, resolvedName: null }
  })
}
