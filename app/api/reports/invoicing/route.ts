export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth'
import { INVOICING_PROJECT_ORDER, INVOICING_RESOURCE_ORDER, resolveInvoicingOrder } from '@/lib/invoicing-report'

// Preview for the monthly "Info para invoicing" report: resolves the fixed
// resource/project order against the real DB, sums hours per (resource,
// project) for the given month, and flags anything that doesn't resolve to
// a real Resource/Project or has zero hours that month — the UI lets the
// admin decide whether to still include those in the final export.
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

  const resolvedResources = resolveInvoicingOrder(INVOICING_RESOURCE_ORDER, allResources.map((r) => r.name))
  const resolvedProjects = resolveInvoicingOrder(INVOICING_PROJECT_ORDER, allProjects.map((p) => p.name))

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

  const resources = resolvedResources.map((r) => {
    const resourceId = r.resolvedName ? resourceIdByName.get(r.resolvedName) ?? null : null
    const hoursByProject: Record<string, number> = {}
    let total = 0
    for (const p of resolvedProjects) {
      const projectId = p.resolvedName ? projectIdByName.get(p.resolvedName) ?? null : null
      const hours = resourceId != null && projectId != null ? hoursMap.get(`${resourceId}|${projectId}`) ?? 0 : 0
      hoursByProject[p.label] = Math.round(hours * 100) / 100
      total += hours
    }
    return {
      label: r.label,
      resolvedName: r.resolvedName,
      exists: resourceId != null,
      hasData: resourceId != null && total > 0,
      total: Math.round(total * 100) / 100,
      hoursByProject,
    }
  })

  const projects = resolvedProjects.map((p) => {
    const projectId = p.resolvedName ? projectIdByName.get(p.resolvedName) ?? null : null
    const total = resources.reduce((sum, r) => sum + (r.hoursByProject[p.label] ?? 0), 0)
    return {
      label: p.label,
      resolvedName: p.resolvedName,
      exists: projectId != null,
      hasData: projectId != null && total > 0,
      total: Math.round(total * 100) / 100,
    }
  })

  const warnings: string[] = []
  for (const r of resources) {
    if (!r.exists) warnings.push(`Recurso "${r.label}" no existe en la base.`)
    else if (!r.hasData) warnings.push(`"${r.resolvedName}" no tiene horas cargadas en ${month}.`)
  }
  for (const p of projects) {
    if (!p.exists) warnings.push(`Proyecto "${p.label}" no existe en la base.`)
    else if (!p.hasData) warnings.push(`Proyecto "${p.resolvedName}" no tiene horas cargadas en ${month}.`)
  }

  return NextResponse.json({ month, resources, projects, warnings })
}
