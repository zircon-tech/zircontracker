'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

function formatHours(h: number) {
  return h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)
}

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

function InvoicingReportExport() {
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [preview, setPreview] = useState<InvoicingPreview | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  const handlePreview = async () => {
    setLoading(true); setError(''); setPreview(null); setExcluded(new Set())
    try {
      const res = await fetch(`/api/reports/invoicing?month=${month}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error al generar la previsualización')
      setPreview(data)
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
    if (!preview) return
    setExporting(true); setError('')
    try {
      const includeResources = preview.resources.filter((r) => r.exists && !excluded.has(r.label)).map((r) => r.label)
      const includeProjects = preview.projects.filter((p) => p.exists && !excluded.has(p.label)).map((p) => p.label)
      const res = await fetch('/api/reports/invoicing/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: preview.month, includeResources, includeProjects }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Error al generar el archivo')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoicing-${preview.month}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setExporting(false)
    }
  }

  const warnedItems = preview ? [...preview.resources, ...preview.projects].filter((x) => !x.hasData) : []

  return (
    <div className="border border-blue-200 rounded-lg p-5 bg-white space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">Info para invoicing</span>
        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Excel (.xlsx)</span>
      </div>
      <p className="text-sm text-gray-500">
        Genera el pivot mensual Recurso × Proyecto para el reporte de invoicing, respetando el orden fijo de personas y proyectos.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="month"
          value={month}
          onChange={(e) => { setMonth(e.target.value); setPreview(null) }}
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

      {preview && (
        <div className="space-y-3">
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
                      onChange={() => toggleExcluded(x.label)}
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

          <button
            onClick={handleExport}
            disabled={exporting}
            className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {exporting ? 'Generando archivo...' : 'Descargar .xlsx'}
          </button>
        </div>
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
      <InvoicingReportExport />
    </div>
  )
}
