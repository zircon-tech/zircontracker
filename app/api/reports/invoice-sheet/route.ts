export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'
import { resolveInvoicingOrder } from '@/lib/invoicing-report'
import { INVOICE_TEMPLATE } from '@/lib/invoice-sheet'

// Data the "Facturas" preview needs (read-only): which Resource/Project each
// template line resolves to today, and the month's hours per (person, project)
// for the client projects — so the UI can recompute a line when the admin
// picks a different person, without extra requests. Same groupBy as the pivot.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const month = req.nextUrl.searchParams.get('month') // YYYY-MM
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
  const resourceNames = allResources.map((r) => r.name)

  const warnings: string[] = []
  const blockProjects: Record<string, string | null> = {}
  const lineDefaults: Record<string, string | null> = {}

  for (const block of INVOICE_TEMPLATE) {
    if (block.projectLookup) {
      const [resolved] = resolveInvoicingOrder(
        [{ label: block.client, lookupNames: block.projectLookup }],
        allProjects.map((p) => p.name)
      )
      blockProjects[block.id] = resolved.resolvedName
      if (!resolved.resolvedName) warnings.push(`Cliente "${block.client}": no existe el proyecto en la base, cargá las horas a mano.`)
    } else {
      blockProjects[block.id] = null
    }
    for (const item of block.items) {
      if (item.type !== 'line' || item.person === undefined) continue
      if (item.person === null) {
        lineDefaults[item.id] = null
        continue
      }
      const [resolved] = resolveInvoicingOrder([{ label: item.label, lookupNames: [item.person] }], resourceNames)
      lineDefaults[item.id] = resolved.resolvedName ? resolved.resolvedName.trim() : null
      if (block.projectLookup && !resolved.resolvedName) {
        warnings.push(`Cliente "${block.client}": la persona "${item.person}" no existe en la base — elegí otra en la línea.`)
      }
    }
  }

  const projectNames = Object.values(blockProjects).filter((n): n is string => !!n)
  const projectIdByName = new Map(allProjects.map((p) => [p.name, p.id]))
  const resourceById = new Map(allResources.map((r) => [r.id, r.name]))
  const projectNameById = new Map(allProjects.map((p) => [p.id, p.name]))

  const grouped = projectNames.length
    ? await prisma.timeEntry.groupBy({
        by: ['resourceId', 'projectId'],
        where: {
          date: { gte: from, lte: to },
          projectId: { in: projectNames.map((n) => projectIdByName.get(n)!) },
        },
        _sum: { hours: true },
      })
    : []

  const hours: Record<string, Record<string, number>> = {}
  for (const g of grouped) {
    const resName = resourceById.get(g.resourceId)?.trim()
    const projName = projectNameById.get(g.projectId)
    const value = g._sum.hours ?? 0
    if (!resName || !projName || value <= 0) continue
    if (!hours[resName]) hours[resName] = {}
    hours[resName][projName] = value
  }

  return NextResponse.json({
    month,
    blockProjects,
    lineDefaults,
    hours,
    resourceNames: resourceNames.map((n) => n.trim()).sort((a, b) => a.localeCompare(b)),
    warnings,
  })
}
