// Template + pure calculation for the monthly "Facturas" sheet (the per-client
// invoice worksheet the accountant gets). The structure, prices, fiscal texts
// and comments mirror the hand-built Google Sheet; the numbers (hours) come
// from time entries. The same `computeInvoice` output drives both the on-screen
// preview and the .xlsx export (with live formulas), so they can never diverge.

export type InvoiceUnit = 'hours' | 'days'

export type InvoiceItemDef =
  | { type: 'text'; text: string }
  | { type: 'blank' }
  | {
      type: 'line'
      id: string
      label: string
      rate: number | null
      // Shown as a live formula in the .xlsx while the rate is left untouched.
      rateFormula?: string
      // undefined = manual quantity (no person concept); string = default person
      // (Resource.name candidate); null = person concept but nobody by default.
      person?: string | null
      qtyDefault?: number
      comment?: string
    }
  | { type: 'sum'; id: string; label: string; over: string[]; qty?: boolean; avgRate?: boolean; comment?: string }
  | { type: 'vat'; id: string; label: string; of: string; factor: number; comment?: string }
  | { type: 'discount'; id: string; label: string; from: string; rate: number; comment?: string }

export interface InvoiceBlockDef {
  id: string
  client: string
  header: boolean
  okMark: boolean
  priceLabel: string
  qtyLabel: string
  unit: InvoiceUnit
  // Project.name candidates the hours come from; null = no project in the DB
  // for this client (quantities are typed by hand in the preview).
  projectLookup: string[] | null
  items: InvoiceItemDef[]
}

export const INVOICE_TITLE_ROWS = [
  'AGREGAR NUEVOS COMENTARIOS EN FACTURAS',
  'Servicios exonerados literal S Art 66 T4 T.O 2023',
]

const ART66 = 'Servicios exonerados literal S Art 66 T4 T.O 2023'
const ART52 = 'Servicios exonerados literal S artículo 52 Titulo 4'

export const INVOICE_TEMPLATE: InvoiceBlockDef[] = [
  {
    id: 'infogain', client: 'Infogain', header: true, okMark: true, priceLabel: 'Precio', qtyLabel: 'Horas',
    unit: 'hours', projectLookup: ['Infogain'],
    items: [
      { type: 'line', id: 'infogain-luciana', label: `${ART66} - Salesforce Analyst - Luciana Diniz Gonçalves dos Santos`, rate: 40, person: 'Luciana Diniz', comment: 'Sin iva, hay que sumar iva.' },
      { type: 'line', id: 'infogain-victor', label: `${ART66} - Power BI Analyst - Victor Córdoba`, rate: 33, person: 'Victor Cordoba', comment: 'Sin iva, hay que sumar iva.' },
      { type: 'blank' },
      { type: 'sum', id: 'infogain-sub', label: ART52, over: ['infogain-luciana', 'infogain-victor'], comment: 'Sin iva' },
      { type: 'vat', id: 'infogain-vat', label: `${ART52} - Software dev`, of: 'infogain-sub', factor: 1.22, comment: 'IVA incluído' },
    ],
  },
  {
    id: 'infinite', client: 'Infinite', header: true, okMark: false, priceLabel: 'Precio', qtyLabel: 'Horas',
    unit: 'hours', projectLookup: null,
    items: [
      { type: 'line', id: 'infinite-alejandro', label: 'Alejandro Barrios', rate: 55, person: 'Alejandro Barrios' },
      { type: 'line', id: 'infinite-gonzalo', label: 'Gonzalo Torterolo', rate: 55, person: 'Gonzalo Torterolo' },
      { type: 'line', id: 'infinite-federico', label: 'Federico Alvarez', rate: 55, person: 'Federico Alvarez' },
      { type: 'sum', id: 'infinite-dev', label: 'Total Development', over: ['infinite-alejandro', 'infinite-gonzalo', 'infinite-federico'], qty: true },
      { type: 'blank' },
      { type: 'line', id: 'infinite-luz', label: 'Luz Gutierrez', rate: 28, person: 'Luz Gutierrez' },
      { type: 'sum', id: 'infinite-testing', label: 'Total Testing', over: ['infinite-luz'] },
      { type: 'blank' },
      { type: 'sum', id: 'infinite-total', label: 'Total General', over: ['infinite-testing', 'infinite-dev'] },
      { type: 'blank' },
      { type: 'discount', id: 'infinite-discount', label: 'Descuento', from: 'infinite-total', rate: 20 },
    ],
  },
  {
    id: 'hover', client: 'Hover', header: false, okMark: false, priceLabel: 'Precio', qtyLabel: 'Horas',
    unit: 'hours', projectLookup: null,
    items: [
      { type: 'line', id: 'hover-title', label: 'Hover', rate: 45, comment: 'March ok' },
      { type: 'line', id: 'hover-ismael', label: 'Ismael Francisco', rate: 45, person: 'ifrancisco' },
      { type: 'line', id: 'hover-design', label: 'Diseño', rate: 45 },
      { type: 'sum', id: 'hover-total', label: '', over: ['hover-ismael', 'hover-design'], qty: true, avgRate: true },
    ],
  },
  {
    id: 'suku', client: 'Suku', header: true, okMark: true, priceLabel: 'Precio', qtyLabel: 'Horas',
    unit: 'hours', projectLookup: ['Suku 2024'],
    items: [
      { type: 'line', id: 'suku-abdulelah', label: `${ART66} - Software development hours - Abdulelah`, rate: 45, person: 'Abdulelah Ragih' },
      { type: 'line', id: 'suku-gonzalo', label: `${ART66} - Software development hours - Gonzalo T`, rate: 45, person: 'Gonzalo Torterolo' },
      { type: 'line', id: 'suku-luz', label: `${ART66} - Manual testing hours - Luz`, rate: 25, person: 'Luz Gutierrez' },
      { type: 'line', id: 'suku-rodrigo', label: `${ART66} - Automated testing hours - Rodrigo`, rate: 35, person: 'rgomez' },
      { type: 'line', id: 'suku-hiring', label: `${ART66} - Hiring fee`, rate: 3750, rateFormula: '5000*1.5/2', qtyDefault: 0, comment: 'Ajustarlo según salario real' },
      { type: 'sum', id: 'suku-total', label: '', over: ['suku-abdulelah', 'suku-gonzalo', 'suku-luz', 'suku-rodrigo', 'suku-hiring'], qty: true },
      { type: 'text', text: ART66 },
    ],
  },
  {
    id: 'imouy', client: 'IMOUY', header: true, okMark: true, priceLabel: 'Rate', qtyLabel: 'Days',
    unit: 'days', projectLookup: ['EG+', 'IMOUY'],
    items: [
      { type: 'line', id: 'imouy-facundo', label: 'Facundo', rate: 240, person: 'Facundo Wade' },
      { type: 'blank' },
      { type: 'sum', id: 'imouy-total', label: `${ART52} - Software dev`, over: ['imouy-facundo'] },
    ],
  },
  {
    id: 'ideal', client: 'Ideal Protein', header: true, okMark: true, priceLabel: 'Rate', qtyLabel: 'Hours',
    unit: 'hours', projectLookup: ['Ideal Protein'],
    items: [
      { type: 'line', id: 'ideal-dev', label: `${ART52} - Software dev`, rate: 55, person: null, comment: 'Costos' },
      { type: 'line', id: 'ideal-testing', label: `${ART52} - Software testing`, rate: 30, person: 'Luz Gutierrez' },
      { type: 'line', id: 'ideal-claude', label: 'Claude Code Licences', rate: 50, qtyDefault: 2 },
      { type: 'sum', id: 'ideal-total', label: '', over: ['ideal-dev', 'ideal-testing', 'ideal-claude'] },
    ],
  },
  {
    id: 'cash', client: 'Cash', header: true, okMark: false, priceLabel: 'Rate', qtyLabel: 'Hours',
    unit: 'hours', projectLookup: null,
    items: [{ type: 'line', id: 'cash-irae', label: 'ingresos gravados IRAE', rate: null, qtyDefault: 1 }],
  },
  {
    id: 'smartway', client: 'Smartway', header: true, okMark: false, priceLabel: 'Rate', qtyLabel: 'Hours',
    unit: 'hours', projectLookup: null,
    items: [{ type: 'line', id: 'smartway-irae', label: 'ingresos gravados IRAE', rate: null, qtyDefault: 1 }],
  },
  {
    id: 'mob', client: 'MOB', header: true, okMark: true, priceLabel: 'Rate', qtyLabel: 'Hours',
    unit: 'hours', projectLookup: ['MOB Mantenimiento'],
    items: [
      { type: 'line', id: 'mob-dev', label: `${ART52} - Software dev`, rate: 45, person: null },
      { type: 'sum', id: 'mob-total', label: '', over: ['mob-dev'] },
    ],
  },
  {
    id: 'claldy', client: 'Claldy', header: true, okMark: true, priceLabel: 'Rate', qtyLabel: 'Hours',
    unit: 'hours', projectLookup: ['Claldy'],
    items: [
      { type: 'line', id: 'claldy-dev', label: `${ART52} - `, rate: 1, person: null },
      { type: 'sum', id: 'claldy-total', label: '', over: ['claldy-dev'] },
    ],
  },
]

export interface LineState {
  resourceName: string | null
  rate: number
  qty: number
}

export interface ComputedRow {
  blockId: string | null
  kind: 'blank' | 'title' | 'header' | 'text' | 'line' | 'sum' | 'vat' | 'discount'
  sheetRow: number
  itemId?: string
  okMark?: string
  label?: string
  priceLabel?: string
  qtyLabel?: string
  rate?: number | null
  rateFormula?: string
  qty?: number | null
  qtyFormula?: string
  total?: number | null
  totalFormula?: string
  comment?: string
  avgRate?: number
  avgRateFormula?: string
  hasPerson?: boolean
  resourceName?: string | null
  qtyEditable?: boolean
  rateEditable?: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Whole numbers only (agreed with the user): 167.7 h -> 168; days = h / 8.
export function hoursToQty(unit: InvoiceUnit, hours: number): number {
  return unit === 'days' ? Math.round(hours / 8) : Math.round(hours)
}

function sumFormula(col: 'D' | 'E', rowNumbers: number[]): string {
  const rows = Array.from(new Set(rowNumbers)).sort((a, b) => a - b)
  const contiguous = rows.every((r, i) => i === 0 || r === rows[i - 1] + 1)
  if (rows.length > 1 && contiguous) return `SUM(${col}${rows[0]}:${col}${rows[rows.length - 1]})`
  return `SUM(${rows.map((r) => `${col}${r}`).join(',')})`
}

export function computeInvoice(states: Record<string, LineState>): ComputedRow[] {
  const rows: ComputedRow[] = []
  let sheetRow = 0
  const push = (row: Omit<ComputedRow, 'sheetRow'>): ComputedRow => {
    sheetRow += 1
    const full = { ...row, sheetRow }
    rows.push(full)
    return full
  }

  push({ blockId: null, kind: 'blank' })
  INVOICE_TITLE_ROWS.forEach((text) => push({ blockId: null, kind: 'title', label: text }))
  push({ blockId: null, kind: 'blank' })
  push({ blockId: null, kind: 'blank' })

  for (const block of INVOICE_TEMPLATE) {
    const byId = new Map<string, { row: number; total: number; qty: number }>()

    if (block.header) {
      push({
        blockId: block.id, kind: 'header', okMark: block.okMark ? 'OK' : undefined,
        label: block.client, priceLabel: block.priceLabel, qtyLabel: block.qtyLabel,
      })
    }

    for (const item of block.items) {
      if (item.type === 'blank') {
        push({ blockId: block.id, kind: 'blank' })
      } else if (item.type === 'text') {
        push({ blockId: block.id, kind: 'text', label: item.text })
      } else if (item.type === 'line') {
        const st = states[item.id] ?? { resourceName: null, rate: item.rate ?? 0, qty: item.qtyDefault ?? 0 }
        const rate = item.rate === null && st.rate === 0 ? null : st.rate
        const total = round2(st.rate * st.qty)
        const row = push({
          blockId: block.id, kind: 'line', itemId: item.id, label: item.label,
          rate, rateFormula: item.rateFormula && st.rate === item.rate ? item.rateFormula : undefined,
          qty: st.qty, total, totalFormula: `C${sheetRow + 1}*D${sheetRow + 1}`,
          comment: item.comment, hasPerson: item.person !== undefined && block.projectLookup !== null,
          resourceName: st.resourceName, qtyEditable: true, rateEditable: true,
        })
        byId.set(item.id, { row: row.sheetRow, total, qty: st.qty })
      } else if (item.type === 'sum') {
        const parts = item.over.map((id) => byId.get(id)).filter((p): p is { row: number; total: number; qty: number } => !!p)
        const total = round2(parts.reduce((s, p) => s + p.total, 0))
        const qty = item.qty ? parts.reduce((s, p) => s + p.qty, 0) : null
        const r = sheetRow + 1
        const row = push({
          blockId: block.id, kind: 'sum', itemId: item.id, label: item.label, qty,
          qtyFormula: item.qty ? sumFormula('D', parts.map((p) => p.row)) : undefined,
          total, totalFormula: sumFormula('E', parts.map((p) => p.row)), comment: item.comment,
          avgRate: item.avgRate ? (qty ? round2(total / qty) : 0) : undefined,
          avgRateFormula: item.avgRate ? `E${r}/D${r}` : undefined,
        })
        byId.set(item.id, { row: row.sheetRow, total, qty: qty ?? 0 })
      } else if (item.type === 'vat') {
        const base = byId.get(item.of)
        const total = round2((base?.total ?? 0) * item.factor)
        const row = push({
          blockId: block.id, kind: 'vat', itemId: item.id, label: item.label, total,
          totalFormula: base ? `E${base.row}*${item.factor}` : undefined, comment: item.comment,
        })
        byId.set(item.id, { row: row.sheetRow, total, qty: 0 })
      } else if (item.type === 'discount') {
        const base = byId.get(item.from)
        const st = states[item.id] ?? { resourceName: null, rate: item.rate, qty: 0 }
        const total = round2((base?.total ?? 0) - st.qty)
        const r = sheetRow + 1
        const row = push({
          blockId: block.id, kind: 'discount', itemId: item.id, label: item.label,
          rate: item.rate, qty: st.qty, total, totalFormula: base ? `E${base.row}-D${r}` : undefined,
          comment: item.comment, qtyEditable: true,
        })
        byId.set(item.id, { row: row.sheetRow, total, qty: st.qty })
      }
    }
    push({ blockId: block.id, kind: 'blank' })
  }
  return rows
}

export interface XlsxCell {
  v?: string | number
  f?: string
}

// Columns A..F (OK | concept | price | qty | total | comment), one array per
// sheet row (index 0 = row 1). Numeric cells with a formula carry the cached value.
export function computedRowsToCells(rows: ComputedRow[]): XlsxCell[][] {
  return rows.map((row) => {
    const cells: XlsxCell[] = [{}, {}, {}, {}, {}, {}]
    if (row.kind === 'header') {
      if (row.okMark) cells[0] = { v: row.okMark }
      cells[1] = { v: row.label }
      cells[2] = { v: row.priceLabel }
      cells[3] = { v: row.qtyLabel }
      cells[4] = { v: 'Total' }
    } else if (row.kind === 'title' || row.kind === 'text') {
      cells[1] = { v: row.label }
    } else if (row.kind !== 'blank') {
      if (row.label) cells[1] = { v: row.label }
      if (row.rate !== undefined && row.rate !== null) cells[2] = row.rateFormula ? { v: row.rate, f: row.rateFormula } : { v: row.rate }
      if (row.qty !== undefined && row.qty !== null) cells[3] = row.qtyFormula ? { v: row.qty, f: row.qtyFormula } : { v: row.qty }
      if (row.total !== undefined && row.total !== null) cells[4] = row.totalFormula ? { v: row.total, f: row.totalFormula } : { v: row.total }
      if (row.avgRate !== undefined) cells[5] = { v: row.avgRate, f: row.avgRateFormula }
      else if (row.comment) cells[5] = { v: row.comment }
    }
    return cells
  })
}
