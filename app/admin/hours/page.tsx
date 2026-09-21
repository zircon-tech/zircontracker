'use client'

import { useMemo, useState, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { parse as dateParse } from 'date-fns'
import { enUS } from 'date-fns/locale'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  Upload, AlertTriangle, CheckCircle2, FileText, Pencil, Trash2, Check, X,
  ChevronDown, Plus, ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { toast } from '@/lib/toast'
import { confirmDialog } from '@/lib/confirm-dialog'
import type {
  ParsedTimeEntry, ImportTimeEntriesResult,
  TimeEntryByResource, TimeEntryByProject, TimeEntryByMonth,
} from '@/types'

// ─── CSV Parsing (Legacy) ────────────────────────────────────────────────────

function parseCsvDate(raw: string): string | null {
  const d = dateParse(raw.trim(), 'dd/MMM/yy', new Date(), { locale: enUS })
  if (isNaN(d.getTime())) return null
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0)).toISOString()
}

function parseCsv(buffer: ArrayBuffer): ParsedTimeEntry[] {
  const bytes = new Uint8Array(buffer)
  // Strip UTF-8 BOM
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const text = new TextDecoder('utf-8').decode(bytes.slice(start))

  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []

  const header = lines[0].split(',')

  // Find date columns (format DD/MMM/YY)
  const dateCols: { index: number; iso: string }[] = []
  for (let i = 5; i < header.length; i++) {
    const iso = parseCsvDate(header[i])
    if (iso) dateCols.push({ index: i, iso })
  }

  const entries: ParsedTimeEntry[] = []

  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(',')
    const resourceName = cols[1]?.trim() ?? ''
    const projectName = cols[2]?.trim() ?? ''

    if (!resourceName || !projectName) continue

    for (const { index, iso } of dateCols) {
      const raw = cols[index]?.trim() ?? ''
      if (!raw || raw === '0') continue
      const hours = parseFloat(raw)
      if (isNaN(hours) || hours <= 0) continue
      entries.push({ resourceName, projectName, date: iso, hours })
    }
  }

  return entries
}

// ─── Clockify CSV Parsing ────────────────────────────────────────────────────

function parseQuotedRow(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const c of line) {
    if (c === '"') { inQuotes = !inQuotes }
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = '' }
    else { current += c }
  }
  result.push(current.trim())
  return result
}

function parseClockifyCsv(buffer: ArrayBuffer): ParsedTimeEntry[] {
  const bytes = new Uint8Array(buffer)
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const text = new TextDecoder('utf-8').decode(bytes.slice(start))

  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []

  const agg = new Map<string, ParsedTimeEntry>()

  for (let r = 1; r < lines.length; r++) {
    const cols = parseQuotedRow(lines[r])
    const projectName = cols[0]?.trim() ?? ''
    const taskName    = cols[3]?.trim() ?? ''
    const userName    = cols[5]?.trim() ?? ''
    const email       = cols[7]?.trim() ?? ''
    const dateRaw     = cols[10]?.trim() ?? ''
    const hoursRaw    = cols[15]?.trim() ?? ''

    if (!projectName || !dateRaw || (!userName && !email)) continue
    const hours = parseFloat(hoursRaw)
    if (isNaN(hours) || hours <= 0) continue

    const parts = dateRaw.split('/')
    if (parts.length !== 3) continue
    const [d, m, y] = parts.map(Number)
    if (!d || !m || !y) continue
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toISOString()

    // Task is part of the grouping key — rows for the same person/project/day
    // but different tasks must stay separate, not get summed into one entry.
    const key = `${email || userName}|${projectName}|${taskName}|${date}`
    const existing = agg.get(key)
    if (existing) {
      existing.hours = Math.round((existing.hours + hours) * 100) / 100
    } else {
      agg.set(key, { resourceName: userName, resourceEmail: email, projectName, taskName, date, hours })
    }
  }

  return Array.from(agg.values())
}

// ─── SCC Excel Parsing ───────────────────────────────────────────────────────
//
// Two SCC templates circulate: an older per-resource "grid" file (one person
// per file, hours laid out on a fixed day×month grid) and a newer
// "summary" file (one row per consultant, with a single monthly
// "Working days" total instead of a day-by-day breakdown). parseSccExcel
// detects which one it's looking at and dispatches accordingly — both
// return the same shape so the rest of the component doesn't need to care.

interface ParsedScc {
  entries: ParsedTimeEntry[]
  resourceNames: string[]
  warnings: string[]
}

// Grid format: resource name hardcoded at A7, hours on a fixed day×month
// grid (rows 10–40 "Working Days", rows 45–75 "Extra Hours", columns B–M =
// Jan–Dec). No header row to detect — this is the original/legacy template.
function parseSccExcelGrid(ws: XLSXWorkSheet, year: number, projectName: string): ParsedScc {
  const resourceName = ((ws['A7']?.v as string) ?? '').trim()
  const cols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
  const dayEntries = new Map<string, ParsedTimeEntry>()

  function addHours(day: number, monthIdx: number, hours: number, entryType: string) {
    const monthNum = monthIdx + 1
    const test = new Date(year, monthNum - 1, day)
    if (test.getMonth() !== monthNum - 1) return // invalid date (e.g. Feb 31)
    const date = new Date(Date.UTC(year, monthNum - 1, day, 12, 0, 0)).toISOString()
    const key = `${resourceName}|${projectName}|${date}|${entryType}`
    const existing = dayEntries.get(key)
    if (existing) existing.hours = Math.round((existing.hours + hours) * 100) / 100
    else dayEntries.set(key, { resourceName, projectName, date, hours, entryType })
  }

  // Working Days: rows 10–40, value × 8 hours
  for (let row = 10; row <= 40; row++) {
    const day = row - 9
    for (let m = 0; m < 12; m++) {
      const cell = ws[`${cols[m]}${row}`]
      if (!cell?.v || typeof cell.v === 'string') continue
      const hours = Number(cell.v) * 8
      if (hours > 0) addHours(day, m, hours, 'regular')
    }
  }

  // Extra Hours: rows 45–75, value = actual hours (not ×8)
  for (let row = 45; row <= 75; row++) {
    const day = row - 44
    for (let m = 0; m < 12; m++) {
      const cell = ws[`${cols[m]}${row}`]
      if (!cell?.v || typeof cell.v === 'string') continue
      const hours = Number(cell.v)
      if (hours > 0) addHours(day, m, hours, 'extra')
    }
  }

  if (!resourceName) {
    throw new Error('No se reconoce el formato de este archivo Excel.')
  }

  return { entries: Array.from(dayEntries.values()), resourceNames: [resourceName], warnings: [] }
}

// Summary format: one row per consultant, "Working days" is a single
// monthly total (not per-day) — there's no cell telling us WHICH days were
// worked, so we fill the first N business days of the selected month.
// Extra Hours / On-call columns are intentionally not imported yet.
function parseSccExcelSummary(
  rows: string[][],
  headerRowIdx: number,
  nameColIdx: number,
  workingDaysColIdx: number,
  year: number,
  month: number, // 1-12
  projectName: string
): ParsedScc {
  const businessDays: string[] = []
  const daysInMonth = new Date(year, month, 0).getDate()
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(year, month - 1, day).getDay()
    if (dow === 0 || dow === 6) continue
    businessDays.push(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString())
  }

  const entries: ParsedTimeEntry[] = []
  const resourceNames: string[] = []
  const warnings: string[] = []

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.every((c) => String(c).trim() === '')) break // first fully-blank row ends the data block

    const rawName = String(row[nameColIdx] ?? '').trim()
    const resourceName = rawName.replace(/^TBC:?\s*/i, '').trim()
    const workingDaysRaw = row[workingDaysColIdx]
    const workingDays = Number(workingDaysRaw)

    if (!resourceName) {
      warnings.push(`Fila ${i + 1}: sin nombre, se saltea`)
      continue
    }
    if (!workingDaysRaw || isNaN(workingDays) || workingDays <= 0) {
      warnings.push(`Fila ${i + 1} (${resourceName}): "Working days" inválido o vacío, se saltea`)
      continue
    }

    resourceNames.push(resourceName)
    const daysToFill = Math.min(Math.round(workingDays), businessDays.length)
    if (daysToFill < workingDays) {
      warnings.push(`${resourceName}: ${workingDays} días superan los ${businessDays.length} días hábiles del mes — se cargaron ${daysToFill}`)
    }
    for (let d = 0; d < daysToFill; d++) {
      entries.push({ resourceName, projectName, date: businessDays[d], hours: 8, entryType: 'regular' })
    }
  }

  return { entries, resourceNames: Array.from(new Set(resourceNames)), warnings }
}

type XLSXWorkSheet = ReturnType<typeof import('xlsx').read>['Sheets'][string]

async function parseSccExcel(
  buffer: ArrayBuffer,
  year: number,
  month: number,
  projectName: string
): Promise<ParsedScc> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]

  // Look for a "summary" header row (has both a "Name" and a "Working day(s)"
  // column) in the first ~25 rows — real files can have instructional/title
  // rows above the actual header. If none is found, this is the older grid
  // format instead.
  const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  let headerRowIdx = -1
  let nameColIdx = -1
  let workingDaysColIdx = -1
  for (let r = 0; r < Math.min(25, rows.length); r++) {
    const cells = rows[r].map((c) => String(c).trim().toLowerCase())
    const nIdx = cells.findIndex((c) => c === 'name')
    const wIdx = cells.findIndex((c) => c.includes('working day'))
    if (nIdx !== -1 && wIdx !== -1) {
      headerRowIdx = r
      nameColIdx = nIdx
      workingDaysColIdx = wIdx
      break
    }
  }

  if (headerRowIdx !== -1) {
    return parseSccExcelSummary(rows, headerRowIdx, nameColIdx, workingDaysColIdx, year, month, projectName)
  }
  return parseSccExcelGrid(ws, year, projectName)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatHours(h: number) {
  return h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)
}

function formatDateDisplay(iso: string) {
  const d = iso.substring(0, 10).split('-')
  return `${d[2]}/${d[1]}/${d[0]}`
}

function formatMonth(ym: string) {
  const [y, m] = ym.split('-')
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
  return `${months[parseInt(m) - 1]} ${y.slice(2)}`
}

// ─── Shared ImportResultBlock ─────────────────────────────────────────────────

function ImportResultBlock({ result, label }: { result: ImportTimeEntriesResult; label: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-2">
      <div className="flex items-center gap-2 text-green-700 font-semibold text-sm">
        <CheckCircle2 size={16} /> {label} completada
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {[
          { label: 'Insertados', value: result.inserted, color: 'text-green-600' },
          { label: 'Actualizados', value: result.updated, color: 'text-blue-600' },
          { label: 'Saltados', value: result.skipped, color: 'text-gray-500' },
        ].map((s) => (
          <div key={s.label} className="border rounded p-2 text-center">
            <div className={`text-lg font-bold ${s.color}`}>{s.value.toLocaleString()}</div>
            <div className="text-xs text-gray-500">{s.label}</div>
          </div>
        ))}
      </div>
      {result.unmatchedResources.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">
          <div className="flex items-center gap-1 text-yellow-700 font-medium mb-1">
            <AlertTriangle size={14} /> Personas sin match
          </div>
          <div className="text-yellow-800 text-xs">{result.unmatchedResources.join(', ')}</div>
        </div>
      )}
      {result.unmatchedProjects.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">
          <div className="flex items-center gap-1 text-yellow-700 font-medium mb-1">
            <AlertTriangle size={14} /> Proyectos sin match
          </div>
          <div className="text-yellow-800 text-xs">{result.unmatchedProjects.join(', ')}</div>
        </div>
      )}
    </div>
  )
}

// ─── Clockify Import Block ───────────────────────────────────────────────────

function ClockifyImport() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedTimeEntry[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportTimeEntriesResult | null>(null)
  const [error, setError] = useState('')

  const handleFile = useCallback((file: File) => {
    setFileName(file.name); setResult(null); setError('')
    const reader = new FileReader()
    reader.onload = (e) => setParsed(parseClockifyCsv(e.target?.result as ArrayBuffer))
    reader.readAsArrayBuffer(file)
  }, [])

  const handleImport = async () => {
    if (!parsed) return
    setImporting(true); setError('')
    try {
      const res = await fetch('/api/time-entries/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: parsed }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error al importar')
      setResult(data); setParsed(null); setFileName('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setImporting(false)
    }
  }

  const uniqueResources = parsed ? new Set(parsed.map((e) => e.resourceEmail ?? e.resourceName)).size : 0
  const uniqueProjects  = parsed ? new Set(parsed.map((e) => e.projectName)).size : 0

  return (
    <div className="border border-purple-200 rounded-lg p-5 space-y-4 bg-white">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">Clockify</span>
        <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">CSV detallado</span>
      </div>

      <div
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-purple-200 rounded-lg p-6 text-center cursor-pointer hover:border-purple-400 hover:bg-purple-50 transition-colors"
      >
        <Upload className="mx-auto mb-2 text-purple-400" size={28} />
        <p className="text-sm text-gray-600 font-medium">Arrastrá el CSV de Clockify o hacé clic</p>
        <p className="text-xs text-gray-400 mt-1">Formato: Proyecto, Tarea, Usuario, Correo electrónico, Fecha de inicio, Duración (decimal)...</p>
        <input ref={fileRef} type="file" accept=".csv" className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      </div>

      {parsed && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <FileText size={16} className="text-purple-500" />
            <span className="font-medium">{fileName}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Entradas agrupadas', value: parsed.length.toLocaleString() },
              { label: 'Personas únicas', value: uniqueResources },
              { label: 'Proyectos únicos', value: uniqueProjects },
            ].map((s) => (
              <div key={s.label} className="bg-purple-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-purple-600">{s.value}</div>
                <div className="text-xs text-gray-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400">Las horas del mismo recurso/proyecto/día se sumaron automáticamente.</p>
          <button onClick={handleImport} disabled={importing}
            className="w-full bg-purple-600 text-white py-2 rounded-lg font-medium hover:bg-purple-700 disabled:opacity-50 text-sm">
            {importing ? 'Importando...' : `Importar ${parsed.length.toLocaleString()} entradas`}
          </button>
        </div>
      )}

      {result && <ImportResultBlock result={result} label="Importación Clockify" />}
      {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-red-700 text-sm">{error}</div>}
    </div>
  )
}

// ─── SCC Excel Import Block ──────────────────────────────────────────────────

function SccExcelImport() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [projectName, setProjectName] = useState('')
  const [parsed, setParsed] = useState<ParsedScc | null>(null)
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportTimeEntriesResult | null>(null)
  const [error, setError] = useState('')

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetch('/api/projects').then((r) => r.json()),
  })
  const projectNameOptions = useMemo(
    () => (projects ?? []).map((p: { id: number; name: string }) => ({ value: p.name, label: p.name }))
      .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)),
    [projects]
  )

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name); setResult(null); setError(''); setParsed(null)
    if (!projectName) {
      setError('Seleccioná un proyecto antes de cargar el archivo')
      return
    }
    setParsing(true)
    try {
      const buf = await file.arrayBuffer()
      const data = await parseSccExcel(buf, year, month, projectName)
      setParsed(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al parsear el archivo')
    } finally {
      setParsing(false)
    }
  }, [year, month, projectName])

  const handleImport = async () => {
    if (!parsed) return
    setImporting(true); setError('')
    try {
      const res = await fetch('/api/time-entries/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: parsed.entries }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error al importar')
      setResult(data); setParsed(null); setFileName('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al importar')
    } finally {
      setImporting(false)
    }
  }

  const regularCount = parsed ? parsed.entries.filter((e) => e.entryType !== 'extra').length : 0
  const extraCount   = parsed ? parsed.entries.filter((e) => e.entryType === 'extra').length : 0

  return (
    <div className="border border-green-200 rounded-lg p-5 space-y-4 bg-white">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">SCC Time Report</span>
        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Excel (.xlsx)</span>
      </div>

      {/* Year + Month + Project selectors */}
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium">Año</label>
          <input
            type="number"
            value={year}
            min={2020}
            max={2035}
            onChange={(e) => { setYear(Number(e.target.value)); setParsed(null) }}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-24"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 font-medium" title="Solo se usa para el formato resumen (un total mensual de días trabajados)">Mes</label>
          <select
            value={month}
            onChange={(e) => { setMonth(Number(e.target.value)); setParsed(null) }}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-32"
          >
            {['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'].map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-48">
          <label className="text-xs text-gray-500 font-medium">Proyecto</label>
          <SearchableSelect
            value={projectName}
            onChange={(v) => { setProjectName(v); setParsed(null) }}
            options={projectNameOptions}
            placeholder="Seleccioná un proyecto..."
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-green-200 rounded-lg p-6 text-center cursor-pointer hover:border-green-400 hover:bg-green-50 transition-colors"
      >
        <Upload className="mx-auto mb-2 text-green-400" size={28} />
        {parsing ? (
          <p className="text-sm text-gray-500">Procesando archivo...</p>
        ) : (
          <>
            <p className="text-sm text-gray-600 font-medium">Arrastrá el Excel SCC o hacé clic</p>
            <p className="text-xs text-gray-400 mt-1">Formato: SCC Time Report (.xlsx)</p>
          </>
        )}
        <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      </div>

      {/* Preview */}
      {parsed && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-600 flex-wrap">
            <FileText size={16} className="text-green-500" />
            <span className="font-medium">{fileName}</span>
            <span className="text-gray-400">
              • {parsed.resourceNames.length === 1
                ? <>Recurso: <strong>{parsed.resourceNames[0]}</strong></>
                : <>Personas: <strong>{parsed.resourceNames.length}</strong></>}
            </span>
          </div>
          {parsed.warnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3 space-y-1">
              <div className="flex items-center gap-1 text-yellow-700 font-medium text-sm">
                <AlertTriangle size={14} /> Avisos
              </div>
              {parsed.warnings.map((w, i) => (
                <p key={i} className="text-yellow-800 text-xs">{w}</p>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Total entradas', value: parsed.entries.length.toLocaleString() },
              { label: 'Regulares', value: regularCount.toLocaleString() },
              { label: 'Horas extra', value: extraCount.toLocaleString() },
            ].map((s) => (
              <div key={s.label} className="bg-green-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-green-600">{s.value}</div>
                <div className="text-xs text-gray-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Preview table */}
          <div className="overflow-x-auto max-h-48 border rounded">
            <table className="w-full text-sm">
              <thead className="bg-green-600 text-white sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Persona</th>
                  <th className="px-3 py-2 text-left">Proyecto</th>
                  <th className="px-3 py-2 text-center">Tipo</th>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Horas</th>
                </tr>
              </thead>
              <tbody>
                {parsed.entries.slice(0, 15).map((e, i) => (
                  <tr key={i} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-1.5">{e.resourceName}</td>
                    <td className="px-3 py-1.5">{e.projectName}</td>
                    <td className="px-3 py-1.5 text-center">
                      {e.entryType === 'extra'
                        ? <span className="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded font-semibold">EX</span>
                        : <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-semibold">REG</span>
                      }
                    </td>
                    <td className="px-3 py-1.5">{formatDateDisplay(e.date)}</td>
                    <td className="px-3 py-1.5 text-right">{formatHours(e.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.entries.length > 15 && (
              <p className="text-xs text-center text-gray-400 py-2">
                ... y {parsed.entries.length - 15} entradas más
              </p>
            )}
          </div>

          <button onClick={handleImport} disabled={importing}
            className="w-full bg-green-600 text-white py-2 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 text-sm">
            {importing ? 'Importando...' : `Importar ${parsed.entries.length.toLocaleString()} entradas`}
          </button>
        </div>
      )}

      {result && <ImportResultBlock result={result} label="Importación SCC" />}
      {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-red-700 text-sm">{error}</div>}
    </div>
  )
}

// ─── Legacy CSV Import Block ─────────────────────────────────────────────────

function LegacyCsvImport() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedTimeEntry[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportTimeEntriesResult | null>(null)
  const [error, setError] = useState('')

  const handleFile = useCallback((file: File) => {
    setFileName(file.name)
    setResult(null)
    setError('')
    const reader = new FileReader()
    reader.onload = (e) => {
      const buf = e.target?.result as ArrayBuffer
      const entries = parseCsv(buf)
      setParsed(entries)
    }
    reader.readAsArrayBuffer(file)
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleImport = async () => {
    if (!parsed) return
    setImporting(true)
    setError('')
    try {
      const res = await fetch('/api/time-entries/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: parsed }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error al importar')
      setResult(data)
      setParsed(null)
      setFileName('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al importar')
    } finally {
      setImporting(false)
    }
  }

  const uniqueResources = parsed ? new Set(parsed.map((e) => e.resourceName)).size : 0
  const uniqueProjects = parsed ? new Set(parsed.map((e) => e.projectName)).size : 0

  return (
    <div className="space-y-4">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center cursor-pointer hover:border-[#0170B9] hover:bg-blue-50 transition-colors"
      >
        <Upload className="mx-auto mb-3 text-gray-400" size={36} />
        <p className="text-gray-600 font-medium">Arrastrá el archivo CSV aquí o hacé clic para seleccionarlo</p>
        <p className="text-sm text-gray-400 mt-1">Formato: User, Project, Key, Utilization, Logged, DD/MMM/YY...</p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      {parsed && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <div className="flex items-center gap-2 text-gray-700 font-medium">
            <FileText size={18} className="text-[#0170B9]" />
            <span>{fileName}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {[
              { label: 'Entradas detectadas', value: parsed.length.toLocaleString() },
              { label: 'Personas únicas', value: uniqueResources },
              { label: 'Proyectos únicos', value: uniqueProjects },
            ].map((s) => (
              <div key={s.label} className="bg-blue-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-[#0170B9]">{s.value}</div>
                <div className="text-xs text-gray-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto max-h-48 border rounded">
            <table className="w-full text-sm">
              <thead className="bg-[#0170B9] text-white sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Persona</th>
                  <th className="px-3 py-2 text-left">Proyecto</th>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Horas</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 15).map((e, i) => (
                  <tr key={i} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-1.5">{e.resourceName}</td>
                    <td className="px-3 py-1.5">{e.projectName}</td>
                    <td className="px-3 py-1.5">{formatDateDisplay(e.date)}</td>
                    <td className="px-3 py-1.5 text-right">{formatHours(e.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.length > 15 && (
              <p className="text-xs text-center text-gray-400 py-2">
                ... y {parsed.length - 15} entradas más
              </p>
            )}
          </div>
          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full bg-[#0170B9] text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? 'Importando...' : `Importar ${parsed.length.toLocaleString()} entradas`}
          </button>
        </div>
      )}

      {result && <ImportResultBlock result={result} label="Importación CSV" />}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}

// ─── Delete by Month Block ────────────────────────────────────────────────────

function DeleteByMonth() {
  const [month, setMonth] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [result, setResult] = useState<{ deleted: number; month: string } | null>(null)
  const [error, setError] = useState('')

  const handleDelete = async () => {
    if (!month) return
    const label = month
    const ok = await confirmDialog({
      title: `¿Eliminar todas las horas del mes ${label}?`,
      description: 'Esta acción no se puede deshacer.',
    })
    if (!ok) return
    setDeleting(true); setError(''); setResult(null)
    try {
      const res = await fetch(`/api/time-entries?month=${label}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error al eliminar')
      setResult(data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="border border-red-200 rounded-lg p-5 bg-white space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-gray-700">Eliminar horas por mes</span>
        <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">Irreversible</span>
      </div>
      <p className="text-sm text-gray-500">Eliminá todas las horas registradas de un mes específico para poder volver a importarlas.</p>
      <div className="flex items-center gap-3">
        <input
          type="month"
          value={month}
          onChange={(e) => { setMonth(e.target.value); setResult(null) }}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
        <button
          onClick={handleDelete}
          disabled={!month || deleting}
          className="px-4 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-colors"
        >
          {deleting ? 'Eliminando...' : 'Eliminar mes'}
        </button>
      </div>
      {result && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle2 size={16} />
          Se eliminaron <strong>{result.deleted.toLocaleString()}</strong> registros del mes {result.month}.
        </div>
      )}
      {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-red-700 text-sm">{error}</div>}
    </div>
  )
}

// ─── Tab: Importar ───────────────────────────────────────────────────────────

function TabImport() {
  const [showLegacyCsv, setShowLegacyCsv] = useState(false)

  return (
    <div className="space-y-6">
      {/* 1. Clockify — first, expanded */}
      <ClockifyImport />

      {/* 2. SCC Excel — second, expanded */}
      <SccExcelImport />

      {/* 3. Legacy CSV — collapsed */}
      <div className="border-t border-gray-200 pt-4">
        <button
          onClick={() => setShowLegacyCsv((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-gray-400 hover:text-gray-600"
        >
          <ChevronDown
            size={15}
            className={`transition-transform ${showLegacyCsv ? '' : '-rotate-90'}`}
          />
          Importación CSV legacy (formato anterior)
        </button>
        {showLegacyCsv && <div className="mt-4"><LegacyCsvImport /></div>}
      </div>

      {/* 4. Delete by month */}
      <div className="border-t border-gray-200 pt-4">
        <DeleteByMonth />
      </div>
    </div>
  )
}

// ─── Tab: Tabla ──────────────────────────────────────────────────────────────

type RawEntry = {
  id: number
  resourceId: number
  projectId: number
  date: string
  hours: number
  entryType: string
  resource: { id: number; name: string; color: string }
  project:  { id: number; name: string; color: string }
}

type EditForm = { resourceId: string; projectId: string; date: string; hours: string }

function TabTabla() {
  const qc = useQueryClient()
  const [resourceId, setResourceId] = useState('')
  const [projectId,  setProjectId]  = useState('')
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [month,      setMonth]      = useState('')
  const [page,       setPage]       = useState(1)

  // sorting
  const [sortBy,  setSortBy]  = useState<'date' | 'resource' | 'project'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // edit state
  const [editingId,  setEditingId]  = useState<number | null>(null)
  const [editForm,   setEditForm]   = useState<EditForm>({ resourceId: '', projectId: '', date: '', hours: '' })
  const [saving,     setSaving]     = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  // new entry state
  const [isAdding,     setIsAdding]     = useState(false)
  const [newForm,      setNewForm]      = useState({ resourceId: '', projectId: '', date: '', hours: '' })
  const [addingSaving, setAddingSaving] = useState(false)

  const { data: resources } = useQuery({ queryKey: ['resources'], queryFn: () => fetch('/api/resources').then((r) => r.json()) })
  const { data: projects }  = useQuery({ queryKey: ['projects'],  queryFn: () => fetch('/api/projects').then((r) => r.json()) })

  const projectOptions = useMemo(
    () => (projects ?? []).map((p: { id: number; name: string }) => ({ value: String(p.id), label: p.name }))
      .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)),
    [projects]
  )

  const rawKey = ['time-entries', 'raw', resourceId, projectId, dateFrom, dateTo, month, page, sortBy, sortDir]
  const params = new URLSearchParams({
    view: 'raw', page: String(page), pageSize: '100',
    sortBy, sortDir,
    ...(resourceId && { resourceId }),
    ...(projectId  && { projectId }),
    ...(month ? { month } : {}),
    ...(!month && dateFrom ? { dateFrom } : {}),
    ...(!month && dateTo   ? { dateTo }   : {}),
  })

  const { data, isFetching } = useQuery({
    queryKey: rawKey,
    queryFn: () => fetch(`/api/time-entries?${params}`).then((r) => r.json()),
  })

  const entries: RawEntry[] = data?.entries ?? []
  const total      = data?.total ?? 0
  const totalPages = Math.ceil(total / 100)
  const totalHours = entries.reduce((s, e) => s + e.hours, 0)

  const clearFilters = () => {
    setResourceId(''); setProjectId(''); setDateFrom(''); setDateTo(''); setMonth(''); setPage(1)
  }

  const handleSort = (col: 'date' | 'resource' | 'project') => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir('asc')
    }
    setPage(1)
  }

  function SortIcon({ col }: { col: 'date' | 'resource' | 'project' }) {
    if (sortBy !== col) return <ArrowUpDown size={12} className="opacity-40" />
    return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
  }

  const startEdit = (e: RawEntry) => {
    setIsAdding(false)
    setEditingId(e.id)
    setEditForm({
      resourceId: String(e.resourceId),
      projectId:  String(e.projectId),
      date:       e.date.substring(0, 10),
      hours:      String(e.hours),
    })
  }

  const cancelEdit = () => { setEditingId(null); setSaving(false) }

  const saveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const res = await fetch(`/api/time-entries/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceId: Number(editForm.resourceId),
          projectId:  Number(editForm.projectId),
          date:       new Date(editForm.date + 'T12:00:00Z').toISOString(),
          hours:      Number(editForm.hours),
        }),
      })
      if (!res.ok) throw new Error('Error al guardar')
      qc.invalidateQueries({ queryKey: ['time-entries'] })
      setEditingId(null)
    } catch {
      toast({ title: 'Error al guardar el registro', variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const deleteEntry = async (id: number) => {
    const ok = await confirmDialog({ title: '¿Eliminar este registro de horas?', description: 'Esta acción no se puede deshacer.' })
    if (!ok) return
    setDeletingId(id)
    try {
      await fetch(`/api/time-entries/${id}`, { method: 'DELETE' })
      qc.invalidateQueries({ queryKey: ['time-entries'] })
    } finally {
      setDeletingId(null)
    }
  }

  const saveNew = async () => {
    if (!newForm.resourceId || !newForm.projectId || !newForm.date || !newForm.hours) {
      toast({ title: 'Completar todos los campos', variant: 'warning' })
      return
    }
    setAddingSaving(true)
    try {
      const res = await fetch('/api/time-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceId: Number(newForm.resourceId),
          projectId:  Number(newForm.projectId),
          date:       new Date(newForm.date + 'T12:00:00Z').toISOString(),
          hours:      Number(newForm.hours),
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Error al guardar')
      }
      qc.invalidateQueries({ queryKey: ['time-entries'] })
      setIsAdding(false)
      setNewForm({ resourceId: '', projectId: '', date: '', hours: '' })
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'error' })
    } finally {
      setAddingSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <select value={resourceId} onChange={(e) => { setResourceId(e.target.value); setPage(1) }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm">
          <option value="">Todas las personas</option>
          {(resources ?? []).map((r: { id: number; name: string }) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <SearchableSelect
          value={projectId}
          onChange={(v) => { setProjectId(v); setPage(1) }}
          options={projectOptions}
          placeholder="Todos los proyectos"
          className="border border-gray-300 rounded px-2 py-1.5 text-sm"
        />
        <input type="month" value={month}
          onChange={(e) => { setMonth(e.target.value); setDateFrom(''); setDateTo(''); setPage(1) }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm" />
        <input type="date" value={dateFrom} disabled={!!month}
          onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm disabled:opacity-40" />
        <input type="date" value={dateTo} disabled={!!month}
          onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm disabled:opacity-40" />
        <button onClick={clearFilters}
          className="text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-3 py-1.5">
          Limpiar filtros
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
          <span className="text-sm text-gray-600">
            {isFetching ? 'Cargando...' : `${total.toLocaleString()} registros`}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-[#0170B9]">Total: {formatHours(totalHours)} hs</span>
            <button
              onClick={() => { setIsAdding(true); setEditingId(null) }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#0170B9] text-white rounded hover:bg-[#0160a0]"
            >
              <Plus size={14} /> Nueva entrada
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[500px]">
          <table className="w-full text-sm">
            <thead className="bg-[#0170B9] text-white sticky top-0">
              <tr>
                <th className="px-4 py-2 text-left cursor-pointer hover:bg-[#0161a5] select-none"
                    onClick={() => handleSort('resource')}>
                  <span className="inline-flex items-center gap-1">Persona <SortIcon col="resource" /></span>
                </th>
                <th className="px-4 py-2 text-left cursor-pointer hover:bg-[#0161a5] select-none"
                    onClick={() => handleSort('project')}>
                  <span className="inline-flex items-center gap-1">Proyecto <SortIcon col="project" /></span>
                </th>
                <th className="px-4 py-2 text-left cursor-pointer hover:bg-[#0161a5] select-none"
                    onClick={() => handleSort('date')}>
                  <span className="inline-flex items-center gap-1">Fecha <SortIcon col="date" /></span>
                </th>
                <th className="px-4 py-2 text-right">Horas</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {/* New entry row */}
              {isAdding && (
                <tr className="border-t bg-green-50">
                  <td className="px-2 py-1.5">
                    <select value={newForm.resourceId}
                      onChange={(e) => setNewForm((f) => ({ ...f, resourceId: e.target.value }))}
                      className="border rounded px-2 py-1 text-xs w-full">
                      <option value="">Persona...</option>
                      {(resources ?? []).map((r: { id: number; name: string }) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <SearchableSelect
                      value={newForm.projectId}
                      onChange={(v) => setNewForm((f) => ({ ...f, projectId: v }))}
                      options={projectOptions}
                      placeholder="Proyecto..."
                      className="border rounded px-2 py-1 text-xs w-full"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="date" value={newForm.date}
                      onChange={(e) => setNewForm((f) => ({ ...f, date: e.target.value }))}
                      className="border rounded px-2 py-1 text-xs w-full" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" step="0.5" min="0.5" value={newForm.hours}
                      onChange={(e) => setNewForm((f) => ({ ...f, hours: e.target.value }))}
                      className="border rounded px-2 py-1 text-xs w-20 text-right" />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <button onClick={saveNew} disabled={addingSaving}
                        className="p-1.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50" title="Guardar">
                        <Check size={13} />
                      </button>
                      <button onClick={() => { setIsAdding(false); setNewForm({ resourceId: '', projectId: '', date: '', hours: '' }) }}
                        className="p-1.5 rounded bg-gray-200 text-gray-600 hover:bg-gray-300" title="Cancelar">
                        <X size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )}

              {entries.map((e) => (
                editingId === e.id ? (
                  /* ── Edit row ── */
                  <tr key={e.id} className="border-t bg-blue-50">
                    <td className="px-2 py-1.5">
                      <select value={editForm.resourceId}
                        onChange={(ev) => setEditForm((f) => ({ ...f, resourceId: ev.target.value }))}
                        className="border rounded px-2 py-1 text-xs w-full">
                        {(resources ?? []).map((r: { id: number; name: string }) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <SearchableSelect
                        value={editForm.projectId}
                        onChange={(v) => setEditForm((f) => ({ ...f, projectId: v }))}
                        options={projectOptions}
                        className="border rounded px-2 py-1 text-xs w-full"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="date" value={editForm.date}
                        onChange={(ev) => setEditForm((f) => ({ ...f, date: ev.target.value }))}
                        className="border rounded px-2 py-1 text-xs w-full" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="number" step="0.5" min="0" value={editForm.hours}
                        onChange={(ev) => setEditForm((f) => ({ ...f, hours: ev.target.value }))}
                        className="border rounded px-2 py-1 text-xs w-20 text-right" />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <button onClick={saveEdit} disabled={saving}
                          className="p-1.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50" title="Guardar">
                          <Check size={13} />
                        </button>
                        <button onClick={cancelEdit}
                          className="p-1.5 rounded bg-gray-200 text-gray-600 hover:bg-gray-300" title="Cancelar">
                          <X size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  /* ── View row ── */
                  <tr key={e.id} className="border-t hover:bg-gray-50 group">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.resource.color }} />
                        {e.resource.name}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.project.color }} />
                        {e.project.name}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-600">{formatDateDisplay(e.date)}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {formatHours(e.hours)}
                      {e.entryType === 'extra' && (
                        <span className="ml-1.5 text-[10px] bg-orange-100 text-orange-600 px-1 py-0.5 rounded font-semibold">EX</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => startEdit(e)}
                          className="p-1.5 rounded text-blue-500 hover:bg-blue-100" title="Editar">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteEntry(e.id)} disabled={deletingId === e.id}
                          className="p-1.5 rounded text-red-500 hover:bg-red-100 disabled:opacity-40" title="Eliminar">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
              {entries.length === 0 && !isFetching && !isAdding && (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-gray-400">
                    No hay datos con los filtros seleccionados
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="text-sm px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">
              ← Anterior
            </button>
            <span className="text-sm text-gray-600">Página {page} de {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              className="text-sm px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">
              Siguiente →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab: Resumen ────────────────────────────────────────────────────────────

function TabResumen() {
  const [subView, setSubView] = useState<'resource' | 'project' | 'month'>('resource')
  const [month, setMonth] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const filterParams = new URLSearchParams({
    ...(month ? { month } : {}),
    ...((!month && dateFrom) ? { dateFrom } : {}),
    ...((!month && dateTo) ? { dateTo } : {}),
  })

  const { data: byResource } = useQuery<TimeEntryByResource[]>({
    queryKey: ['time-entries', 'by-resource', month, dateFrom, dateTo],
    queryFn: () => fetch(`/api/time-entries?view=by-resource&${filterParams}`).then((r) => r.json()),
  })
  const { data: byProject } = useQuery<TimeEntryByProject[]>({
    queryKey: ['time-entries', 'by-project', month, dateFrom, dateTo],
    queryFn: () => fetch(`/api/time-entries?view=by-project&${filterParams}`).then((r) => r.json()),
  })
  const { data: byMonth } = useQuery<TimeEntryByMonth[]>({
    queryKey: ['time-entries', 'by-month'],
    queryFn: () => fetch('/api/time-entries?view=by-month').then((r) => r.json()),
  })

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap gap-3 items-center">
        <span className="text-sm text-gray-600 font-medium">Filtrar por:</span>
        <input
          type="month"
          value={month}
          onChange={(e) => { setMonth(e.target.value); setDateFrom(''); setDateTo('') }}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm"
        />
        <input
          type="date"
          value={dateFrom}
          disabled={!!month}
          onChange={(e) => setDateFrom(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm disabled:opacity-40"
        />
        <input
          type="date"
          value={dateTo}
          disabled={!!month}
          onChange={(e) => setDateTo(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm disabled:opacity-40"
        />
        {(month || dateFrom || dateTo) && (
          <button
            onClick={() => { setMonth(''); setDateFrom(''); setDateTo('') }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            × Limpiar
          </button>
        )}
      </div>

      {/* Sub-view tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'resource', label: 'Por Persona' },
          { key: 'project', label: 'Por Proyecto' },
          { key: 'month', label: 'Por Mes' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setSubView(t.key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              subView === t.key ? 'bg-white text-[#0170B9] shadow-sm' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subView === 'resource' && (
        <SummaryTable
          data={(byResource ?? []).map((r) => ({
            label: r.resourceName,
            color: r.resourceColor,
            hours: r.totalHours,
          }))}
          label="Persona"
        />
      )}
      {subView === 'project' && (
        <SummaryTable
          data={(byProject ?? []).map((p) => ({
            label: p.projectName,
            color: p.projectColor,
            hours: p.totalHours,
          }))}
          label="Proyecto"
        />
      )}
      {subView === 'month' && (
        <SummaryTable
          data={(byMonth ?? []).map((m) => ({
            label: formatMonth(m.month),
            color: '#0170B9',
            hours: m.totalHours,
          }))}
          label="Mes"
        />
      )}
    </div>
  )
}

function SummaryTable({ data, label }: { data: { label: string; color: string; hours: number }[]; label: string }) {
  const total = data.reduce((sum, d) => sum + d.hours, 0)
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[#0170B9] text-white">
          <tr>
            <th className="px-4 py-2 text-left">{label}</th>
            <th className="px-4 py-2 text-right">Horas</th>
            <th className="px-4 py-2 text-right">% del total</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-t hover:bg-gray-50">
              <td className="px-4 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                  {row.label}
                </span>
              </td>
              <td className="px-4 py-2 text-right font-medium">{formatHours(row.hours)}</td>
              <td className="px-4 py-2 text-right text-gray-500">
                {total > 0 ? ((row.hours / total) * 100).toFixed(1) : 0}%
              </td>
            </tr>
          ))}
          <tr className="border-t bg-gray-50 font-semibold">
            <td className="px-4 py-2">Total</td>
            <td className="px-4 py-2 text-right text-[#0170B9]">{formatHours(total)}</td>
            <td className="px-4 py-2 text-right">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─── Tab: Gráficos ───────────────────────────────────────────────────────────

function TabGraficos() {
  const { data: byResource } = useQuery<TimeEntryByResource[]>({
    queryKey: ['time-entries', 'by-resource-chart'],
    queryFn: () => fetch('/api/time-entries?view=by-resource').then((r) => r.json()),
  })
  const { data: byProject } = useQuery<TimeEntryByProject[]>({
    queryKey: ['time-entries', 'by-project-chart'],
    queryFn: () => fetch('/api/time-entries?view=by-project').then((r) => r.json()),
  })
  const { data: byMonth } = useQuery<TimeEntryByMonth[]>({
    queryKey: ['time-entries', 'by-month-chart'],
    queryFn: () => fetch('/api/time-entries?view=by-month').then((r) => r.json()),
  })

  const topProjects = (byProject ?? []).slice(0, 12)
  const topResources = (byResource ?? []).slice(0, 12)
  const monthData = (byMonth ?? []).map((m) => ({ ...m, name: formatMonth(m.month) }))

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Bar: Horas por Proyecto */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">Horas por Proyecto</h3>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={topProjects} layout="vertical" margin={{ left: 120, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="projectName" tick={{ fontSize: 11 }} width={115} />
            <Tooltip formatter={(v) => [`${formatHours(Number(v))} hs`, 'Horas']} />
            <Bar dataKey="totalHours" radius={[0, 4, 4, 0]}>
              {topProjects.map((p, i) => (
                <Cell key={i} fill={p.projectColor} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Bar: Horas por Persona */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">Horas por Persona</h3>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={topResources} margin={{ bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="resourceName" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => [`${formatHours(Number(v))} hs`, 'Horas']} />
            <Bar dataKey="totalHours" radius={[4, 4, 0, 0]}>
              {topResources.map((r, i) => (
                <Cell key={i} fill={r.resourceColor} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Line: Evolución mensual */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">Evolución Mensual</h3>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={monthData} margin={{ bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => [`${formatHours(Number(v))} hs`, 'Horas']} />
            <Line
              type="monotone"
              dataKey="totalHours"
              stroke="#0170B9"
              strokeWidth={2}
              dot={{ r: 3, fill: '#0170B9' }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Pie: Distribución por Proyecto */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">Distribución por Proyecto</h3>
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie
              data={topProjects}
              dataKey="totalHours"
              nameKey="projectName"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={2}
            >
              {topProjects.map((p, i) => (
                <Cell key={i} fill={p.projectColor} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => [`${formatHours(Number(v))} hs`, 'Horas']} />
            <Legend
              formatter={(value: string) => <span style={{ fontSize: 11 }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}


// ─── Main Page ───────────────────────────────────────────────────────────────

type Tab = 'import' | 'table' | 'summary' | 'charts'

const TABS: { key: Tab; label: string }[] = [
  { key: 'import',  label: 'Importar' },
  { key: 'table',   label: 'Tabla' },
  { key: 'summary', label: 'Resumen' },
  { key: 'charts',  label: 'Gráficos' },
]

export default function HoursPage() {
  const [activeTab, setActiveTab] = useState<Tab>('import')

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-[#3a3a3a]">Reporte de Horas</h1>
        <p className="text-sm text-gray-500 mt-1">
          Importación y consulta de horas trabajadas por persona y proyecto
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 sm:px-5 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === t.key
                ? 'border-[#0170B9] text-[#0170B9]'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'import'  && <TabImport />}
      {activeTab === 'table'   && <TabTabla />}
      {activeTab === 'summary' && <TabResumen />}
      {activeTab === 'charts'  && <TabGraficos />}
    </div>
  )
}
