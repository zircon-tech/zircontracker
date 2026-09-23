export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'
import { INVOICING_PROJECT_ORDER, INVOICING_RESOURCE_ORDER, resolveInvoicingOrder } from '@/lib/invoicing-report'
import { computeInvoice, computedRowsToCells, type LineState } from '@/lib/invoice-sheet'

// Generates the final .xlsx for the monthly "Info para invoicing" report,
// scoped to exactly the resource/project labels the admin confirmed in the
// preview (app/api/reports/invoicing/route.ts) — anything they unchecked
// there (no match in the DB, or no hours that month) is left out here.
// When `invoiceLines` is sent (the edited state of the "Facturas" preview), a
// second sheet "Facturas" is added, with live formulas in the Total column.
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const month: string = body.month
  const includeResourceLabels: string[] = body.includeResources ?? []
  const includeProjectLabels: string[] = body.includeProjects ?? []

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'Parámetro month inválido (YYYY-MM)' }, { status: 400 })
  }
  const [y, m] = month.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0))
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59))

  const [allResources, allProjects] = await Promise.all([
    prisma.resource.findMany({ select: { id: true, name: true } }),
    prisma.project.findMany({ select: { id: true, name: true } }),
  ])

  const resolvedResources = resolveInvoicingOrder(INVOICING_RESOURCE_ORDER, allResources.map((r) => r.name))
    .filter((r) => includeResourceLabels.includes(r.label))
  const resolvedProjects = resolveInvoicingOrder(INVOICING_PROJECT_ORDER, allProjects.map((p) => p.name))
    .filter((p) => includeProjectLabels.includes(p.label))

  const resourceIdByName = new Map(allResources.map((r) => [r.name, r.id]))
  const projectIdByName = new Map(allProjects.map((p) => [p.name, p.id]))

  const resourceIds = resolvedResources
    .filter((r) => r.resolvedName)
    .map((r) => resourceIdByName.get(r.resolvedName!)!)

  const grouped = resourceIds.length
    ? await prisma.timeEntry.groupBy({
        by: ['resourceId', 'projectId'],
        where: { date: { gte: from, lte: to }, resourceId: { in: resourceIds } },
        _sum: { hours: true },
      })
    : []

  const hoursMap = new Map<string, number>()
  for (const g of grouped) hoursMap.set(`${g.resourceId}|${g.projectId}`, g._sum.hours ?? 0)

  const header = ['Recurso', 'Total Horas', ...resolvedProjects.map((p) => p.resolvedName ?? p.label)]
  const rows: (string | number)[][] = [header]

  for (const r of resolvedResources) {
    const resourceId = r.resolvedName ? resourceIdByName.get(r.resolvedName) : undefined
    const rowValues: number[] = []
    let total = 0
    for (const p of resolvedProjects) {
      const projectId = p.resolvedName ? projectIdByName.get(p.resolvedName) : undefined
      const hours = resourceId != null && projectId != null ? hoursMap.get(`${resourceId}|${projectId}`) ?? 0 : 0
      rowValues.push(Math.round(hours * 100) / 100)
      total += hours
    }
    rows.push([(r.resolvedName ?? r.label).trim(), Math.round(total * 100) / 100, ...rowValues])
  }

  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Info para invoicing')

  const invoiceLines: Record<string, LineState> | undefined = body.invoiceLines
  if (invoiceLines) {
    const cells = computedRowsToCells(computeInvoice(invoiceLines))
    const sheet: Record<string, unknown> = {}
    cells.forEach((rowCells, r) => {
      rowCells.forEach((cell, c) => {
        if (cell.v === undefined) return
        const ref = XLSX.utils.encode_cell({ r, c })
        if (typeof cell.v === 'number') sheet[ref] = cell.f ? { t: 'n', v: cell.v, f: cell.f } : { t: 'n', v: cell.v }
        else sheet[ref] = { t: 's', v: cell.v }
      })
    })
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(cells.length - 1, 0), c: 5 } })
    sheet['!cols'] = [{ wch: 5 }, { wch: 95 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 34 }]
    XLSX.utils.book_append_sheet(wb, sheet as import('xlsx').WorkSheet, 'Facturas')
  }

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="invoicing-${month}.xlsx"`,
    },
  })
}
