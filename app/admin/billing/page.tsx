'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import {
  INVOICE_TEMPLATE,
  computeInvoice,
  hoursToQty,
  type LineState,
} from '@/lib/invoice-sheet'

function formatHours(h: number) {
  return h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)
}

const money = (n: number) =>
  n.toLocaleString('es-UY', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

interface InvoicingRow {
  label: string
  resolvedName: string | null
  exists: boolean
  hasData: boolean
  total: number
  hoursByProject: Record<string, number>
}

interface InvoicingCol {
  label: string
  resolvedName: string | null
  exists: boolean
  hasData: boolean
  total: number
}

interface InvoicingPreview {
  month: string
  resources: InvoicingRow[]
  projects: InvoicingCol[]
  warnings: string[]
}

interface InvoiceSheetData {
  month: string
  blockProjects: Record<string, string | null>
  lineDefaults: Record<string, string | null>
  hours: Record<string, Record<string, number>>
  resourceNames: string[]
  warnings: string[]
}

function buildInitialStates(data: InvoiceSheetData): Record<string, LineState> {
  const states: Record<string, LineState> = {}
  for (const block of INVOICE_TEMPLATE) {
    const project = data.blockProjects[block.id]
    for (const item of block.items) {
      if (item.type === 'line') {
        const person = item.person !== undefined ? data.lineDefaults[item.id] ?? null : null
        const fromHours = item.person !== undefined && !!project && !!person
        const qty = fromHours ? hoursToQty(block.unit, data.hours[person!]?.[project!] ?? 0) : item.qtyDefault ?? 0
        states[item.id] = { resourceName: person, rate: item.rate ?? 0, qty }
      } else if (item.type === 'discount') {
        states[item.id] = { resourceName: null, rate: item.rate, qty: 0 }
      }
    }
  }
  return states
}

function PivotSection({
  preview, excluded, onToggle,
}: {
  preview: InvoicingPreview
  excluded: Set<string>
  onToggle: (label: string) => void
}) {
  const warnedItems = [...preview.resources, ...preview.projects].filter((x) => !x.hasData)
  return (
    <div className="border border-blue-200 rounded-lg p-5 bg-white space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">Info para invoicing</span>
        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Hoja 1 · Recurso × Proyecto</span>
      </div>

      {warnedItems.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 space-y-2">
          <div className="flex items-center gap-1 text-yellow-700 font-medium text-sm">
            <AlertTriangle size={14} /> Avisos — desmarcá lo que no quieras incluir en el archivo
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {warnedItems.map((x) => (
              <label key={x.label} className="flex items-center gap-2 text-xs text-yellow-800">
                <input
                  type="checkbox"
                  checked={x.exists && !excluded.has(x.label)}
                  onChange={() => onToggle(x.label)}
                  disabled={!x.exists}
                />
                {x.exists
                  ? `"${x.resolvedName}" no tiene horas cargadas en ${preview.month}`
                  : `"${x.label}" no existe en la base — no se puede incluir`}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto max-h-72 border rounded">
        <table className="w-full text-xs">
          <thead className="bg-blue-600 text-white sticky top-0">
            <tr>
              <th className="px-2 py-2 text-left sticky left-0 bg-blue-600">Recurso</th>
              <th className="px-2 py-2 text-right">Total</th>
              {preview.projects.map((p) => (
                <th
                  key={p.label}
                  className={`px-2 py-2 text-right whitespace-nowrap ${excluded.has(p.label) ? 'opacity-40 line-through' : ''}`}
                >
                  {p.resolvedName ?? p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.resources.map((r) => (
              <tr key={r.label} className={`border-t hover:bg-gray-50 ${excluded.has(r.label) ? 'opacity-40' : ''}`}>
                <td className="px-2 py-1.5 sticky left-0 bg-white font-medium whitespace-nowrap">
                  {r.exists ? r.resolvedName : `${r.label} (sin match)`}
                </td>
                <td className="px-2 py-1.5 text-right font-semibold">{formatHours(r.total)}</td>
                {preview.projects.map((p) => (
                  <td key={p.label} className="px-2 py-1.5 text-right text-gray-600">
                    {r.hoursByProject[p.label] > 0 ? formatHours(r.hoursByProject[p.label]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InvoiceSection({
  data, states, setStates,
}: {
  data: InvoiceSheetData
  states: Record<string, LineState>
  setStates: (updater: (prev: Record<string, LineState>) => Record<string, LineState>) => void
}) {
  const rows = useMemo(() => computeInvoice(states), [states])
  const blockById = useMemo(() => new Map(INVOICE_TEMPLATE.map((b) => [b.id, b])), [])
  const personOptions = useMemo(
    () => [{ value: '', label: '— Sin persona —' }, ...data.resourceNames.map((n) => ({ value: n, label: n }))],
    [data.resourceNames]
  )

  const patch = (id: string, change: Partial<LineState>) =>
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }))

  const changePerson = (id: string, blockId: string, name: string) => {
    const block = blockById.get(blockId)!
    const project = data.blockProjects[blockId]
    const qty = name && project && block ? hoursToQty(block.unit, data.hours[name]?.[project] ?? 0) : 0
    patch(id, { resourceName: name || null, qty })
  }

  const visibleRows = rows.filter((r) => r.kind !== 'blank')

  return (
    <div className="border border-green-200 rounded-lg p-5 bg-white space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">Facturas por cliente</span>
        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Hoja 2 · Precio × Horas = Total</span>
      </div>
      <p className="text-xs text-gray-500">
        Las horas salen de las horas cargadas de la persona en el proyecto del cliente (enteros). Podés cambiar la persona,
        el precio o la cantidad de cada línea solo para este mes; el archivo lleva las fórmulas de la columna Total.
      </p>

      {data.warnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 space-y-1">
          <div className="flex items-center gap-1 text-yellow-700 font-medium text-sm">
            <AlertTriangle size={14} /> Avisos
          </div>
          {data.warnings.map((w, i) => (
            <p key={i} className="text-yellow-800 text-xs">{w}</p>
          ))}
        </div>
      )}

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-xs min-w-[900px]">
          <thead className="bg-green-600 text-white">
            <tr>
              <th className="px-2 py-2 text-left">Concepto</th>
              <th className="px-2 py-2 text-left w-48">Persona</th>
              <th className="px-2 py-2 text-right w-20">Precio</th>
              <th className="px-2 py-2 text-right w-20">Cant.</th>
              <th className="px-2 py-2 text-right w-24">Total</th>
              <th className="px-2 py-2 text-left w-44">Comentario</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              if (row.kind === 'title') {
                return (
                  <tr key={row.sheetRow} className="bg-gray-50 text-gray-500">
                    <td colSpan={6} className="px-2 py-1.5">{row.label}</td>
                  </tr>
                )
              }
              if (row.kind === 'header') {
                const project = row.blockId ? data.blockProjects[row.blockId] : null
                return (
                  <tr key={row.sheetRow} className="bg-green-50 font-semibold border-t">
                    <td className="px-2 py-1.5">{row.label}</td>
                    <td className="px-2 py-1.5 text-gray-500 font-normal">
                      {project ? `Proyecto: ${project}` : 'Sin proyecto en la base — cantidades a mano'}
                    </td>
                    <td className="px-2 py-1.5 text-right">{row.priceLabel}</td>
                    <td className="px-2 py-1.5 text-right">{row.qtyLabel}</td>
                    <td className="px-2 py-1.5 text-right">Total</td>
                    <td />
                  </tr>
                )
              }
              if (row.kind === 'text') {
                return (
                  <tr key={row.sheetRow} className="border-t text-gray-500">
                    <td colSpan={6} className="px-2 py-1.5">{row.label}</td>
                  </tr>
                )
              }
              const st = row.itemId ? states[row.itemId] : undefined
              const isSubtotal = row.kind === 'sum' || row.kind === 'vat'
              return (
                <tr key={row.sheetRow} className={`border-t ${isSubtotal ? 'bg-gray-50 font-semibold' : 'hover:bg-gray-50'}`}>
                  <td className="px-2 py-1.5">{row.label}</td>
                  <td className="px-2 py-1">
                    {row.kind === 'line' && row.hasPerson && row.itemId && row.blockId && (
                      <SearchableSelect
                        value={st?.resourceName ?? ''}
                        onChange={(v) => changePerson(row.itemId!, row.blockId!, v)}
                        options={personOptions}
                        placeholder="Elegí persona..."
                        className="border border-gray-300 rounded px-2 py-1 text-xs w-full"
                      />
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {row.kind === 'line' && row.itemId ? (
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={st?.rate ?? 0}
                        onChange={(e) => patch(row.itemId!, { rate: Number(e.target.value) || 0 })}
                        className="border border-gray-300 rounded px-1.5 py-1 text-xs w-20 text-right"
                      />
                    ) : row.kind === 'discount' && row.rate != null ? (
                      row.rate
                    ) : null}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {row.qtyEditable && row.itemId ? (
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={st?.qty ?? 0}
                        onChange={(e) => patch(row.itemId!, { qty: Math.round(Number(e.target.value)) || 0 })}
                        className="border border-gray-300 rounded px-1.5 py-1 text-xs w-20 text-right"
                      />
                    ) : row.qty != null ? (
                      row.qty
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{row.total != null ? money(row.total) : ''}</td>
                  <td className="px-2 py-1.5 text-gray-500">
                    {row.avgRate !== undefined ? `Tarifa prom.: ${money(row.avgRate)}` : row.comment}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BillingReport() {
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [pivot, setPivot] = useState<InvoicingPreview | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [invoice, setInvoice] = useState<InvoiceSheetData | null>(null)
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({})
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const handlePreview = async () => {
    setLoading(true); setError(''); setPivot(null); setInvoice(null); setExcluded(new Set())
    try {
      const [pivotRes, invoiceRes] = await Promise.all([
        fetch(`/api/reports/invoicing?month=${month}`),
        fetch(`/api/reports/invoice-sheet?month=${month}`),
      ])
      const pivotData = await pivotRes.json()
      if (!pivotRes.ok) throw new Error(pivotData.error ?? 'Error al generar la previsualización')
      const invoiceData = await invoiceRes.json()
      if (!invoiceRes.ok) throw new Error(invoiceData.error ?? 'Error al generar la hoja de facturas')
      setPivot(pivotData)
      setInvoice(invoiceData)
      setLineStates(buildInitialStates(invoiceData))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setLoading(false)
    }
  }

  const toggleExcluded = (label: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const handleExport = async () => {
    if (!pivot || !invoice) return
    setExporting(true); setError('')
    try {
      const includeResources = pivot.resources.filter((r) => r.exists && !excluded.has(r.label)).map((r) => r.label)
      const includeProjects = pivot.projects.filter((p) => p.exists && !excluded.has(p.label)).map((p) => p.label)
      const res = await fetch('/api/reports/invoicing/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: pivot.month, includeResources, includeProjects, invoiceLines: lineStates }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Error al generar el archivo')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoicing-${pivot.month}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="border border-gray-200 rounded-lg p-5 bg-white space-y-3">
        <p className="text-sm text-gray-500">
          Genera el archivo mensual para invoicing/contador con dos hojas: el pivot Recurso × Proyecto y las facturas por cliente.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="month"
            value={month}
            onChange={(e) => { setMonth(e.target.value); setPivot(null); setInvoice(null) }}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
          <button
            onClick={handlePreview}
            disabled={!month || loading}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Generando...' : 'Generar previsualización'}
          </button>
        </div>
        {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-red-700 text-sm">{error}</div>}
      </div>

      {pivot && invoice && (
        <>
          <PivotSection preview={pivot} excluded={excluded} onToggle={toggleExcluded} />
          <InvoiceSection data={invoice} states={lineStates} setStates={setLineStates} />
          <button
            onClick={handleExport}
            disabled={exporting}
            className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {exporting ? 'Generando archivo...' : 'Descargar .xlsx (2 hojas)'}
          </button>
        </>
      )}
    </div>
  )
}

export default function BillingPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Facturación</h1>
        <p className="text-sm text-gray-500">Reportes mensuales para facturación e invoicing.</p>
      </div>
      <BillingReport />
    </div>
  )
}
