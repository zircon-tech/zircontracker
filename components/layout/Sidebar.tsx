'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  BarChart3,
  FolderKanban,
  Users,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Shield,
  UserCog,
  KeyRound,
  LogOut,
  ChevronDown,
  ChevronUp,
  Clock,
  TrendingUp,
  CalendarClock,
  LayoutDashboard,
  X,
  Receipt,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSession, signOut } from 'next-auth/react'
import { useIsMobile } from '@/lib/use-is-mobile'

// Visible to every authenticated role regardless of the PagePermission
// matrix — same treatment as /perfil in middleware.ts's ALWAYS_ALLOWED_AUTHENTICATED.
const UNIVERSAL_NAV_ITEM = { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' }

const NAV_ITEMS = [
  { href: '/gantt', icon: BarChart3, label: 'Gantt' },
  { href: '/projects', icon: FolderKanban, label: 'Proyectos' },
  { href: '/resources', icon: Users, label: 'Recursos' },
  { href: '/holidays', icon: CalendarDays, label: 'Feriados & Vacaciones' },
  { href: '/mis-horas', icon: Clock, label: 'Mis Horas' },
  { href: '/mi-reporte', icon: CalendarClock, label: 'Mi Reporte' },
]

const ADMIN_ITEMS = [
  { href: '/admin/users', icon: UserCog, label: 'Usuarios' },
  { href: '/admin/roles', icon: Shield, label: 'Roles' },
  { href: '/admin/permissions', icon: KeyRound, label: 'Permisos' },
  { href: '/admin/hours', icon: Clock, label: 'Reporte de Horas' },
  { href: '/admin/daily-report', icon: CalendarClock, label: 'Reporte Diario' },
  { href: '/admin/control-horas', icon: TrendingUp, label: 'Control de Horas' },
  { href: '/admin/billing', icon: Receipt, label: 'Facturación' },
]

interface Props {
  mobileOpen: boolean
  onClose: () => void
}

export default function Sidebar({ mobileOpen, onClose }: Props) {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(false)
  const [adminOpen, setAdminOpen] = useState(pathname.startsWith('/admin'))
  const { data: session } = useSession()

  const roles = (session?.user as { roles?: string[] })?.roles ?? []
  const isAdmin = roles.includes('admin')
  const allowedPages = (session?.user as { allowedPages?: string[] })?.allowedPages ?? []
  const userName = session?.user?.name ?? session?.user?.email ?? ''

  // On mobile the drawer is always shown expanded (labels visible) regardless
  // of the desktop icon-only "collapsed" preference.
  const showLabels = !collapsed || isMobile

  const visibleNavItems = [
    UNIVERSAL_NAV_ITEM,
    ...(isAdmin ? NAV_ITEMS : NAV_ITEMS.filter((item) => allowedPages.includes(item.href))),
  ]

  return (
    <>
      {/* Backdrop — mobile drawer only */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} />
      )}

      <aside
        className={cn(
          'text-white flex flex-col shrink-0 z-50',
          // Desktop: in-flow column, collapsible width
          'md:static md:h-screen md:transition-all md:duration-300',
          collapsed ? 'md:w-16' : 'md:w-52',
          // Mobile: fixed off-canvas drawer, always full width when open
          'fixed inset-y-0 left-0 h-full w-64 transition-transform duration-200 md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{ backgroundColor: '#0170B9' }}
      >
        {/* Logo — icon above the name so the name gets the sidebar's full
            width instead of squeezing next to the collapse/close button,
            which is what caused "ZirconTracker" to truncate. */}
        <div className="relative px-4 py-4 border-b border-white/20">
          {showLabels && (
            <div className="flex flex-col items-center gap-2">
              <div className="w-9 h-9 rounded-md bg-white shrink-0 overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icon.jpg" alt="ZirconTech" className="w-full h-full object-contain" />
              </div>
              <span className="font-bold text-sm leading-tight text-white tracking-wide text-center">
                ZirconTracker
              </span>
            </div>
          )}
          {isMobile ? (
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors p-1 rounded hover:bg-white/10 shrink-0"
              aria-label="Cerrar menú"
            >
              <X size={20} />
            </button>
          ) : (
            <button
              onClick={() => setCollapsed((c) => !c)}
              style={{ position: 'absolute', top: 16, right: showLabels ? 16 : '50%', transform: showLabels ? undefined : 'translateX(50%)' }}
              className="text-white/70 hover:text-white transition-colors p-1 rounded hover:bg-white/10 shrink-0"
            >
              {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-0.5 p-2 flex-1 overflow-y-auto">
          {visibleNavItems.map(({ href, icon: Icon, label }) => {
            const isActive = pathname === href || (href !== '/' && pathname.startsWith(href))
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded text-sm transition-all duration-150',
                  isActive
                    ? 'bg-white/25 text-white font-semibold shadow-sm'
                    : 'text-white/75 hover:bg-white/15 hover:text-white'
                )}
              >
                <Icon size={17} className="shrink-0" />
                {showLabels && <span className="truncate">{label}</span>}
              </Link>
            )
          })}

          {/* Admin section */}
          {isAdmin && (
            <>
              {showLabels && (
                <button
                  onClick={() => setAdminOpen((o) => !o)}
                  className="flex items-center justify-between px-3 py-2 mt-2 rounded text-xs text-white/60 hover:text-white/90 hover:bg-white/10 transition-all"
                >
                  <span className="font-semibold tracking-wider uppercase">Administración</span>
                  {adminOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              )}
              {!showLabels && <div className="border-t border-white/20 mt-2 mb-1" />}

              {(adminOpen || !showLabels) &&
                ADMIN_ITEMS.map(({ href, icon: Icon, label }) => {
                  const isActive = pathname.startsWith(href)
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onClose}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded text-sm transition-all duration-150',
                        showLabels ? 'pl-5' : '',
                        isActive
                          ? 'bg-white/25 text-white font-semibold shadow-sm'
                          : 'text-white/70 hover:bg-white/15 hover:text-white'
                      )}
                    >
                      <Icon size={15} className="shrink-0" />
                      {showLabels && <span className="truncate">{label}</span>}
                    </Link>
                  )
                })}
            </>
          )}
        </nav>

        {/* User & logout */}
        <div className="p-3 border-t border-white/20">
          {showLabels ? (
            <div className="flex items-center gap-2">
              <Link
                href="/perfil"
                onClick={onClose}
                className="flex items-center gap-2 flex-1 min-w-0 rounded px-1 py-1 -mx-1 hover:bg-white/10 transition-colors"
                title="Mi Perfil"
              >
                <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center shrink-0 text-xs font-bold uppercase">
                  {userName.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{userName}</p>
                  <p className="text-xs text-white/50 truncate">
                    {roles.join(', ')}
                  </p>
                </div>
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                title="Cerrar sesión"
                className="p-1.5 rounded hover:bg-white/15 text-white/70 hover:text-white transition-colors"
              >
                <LogOut size={15} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              title="Cerrar sesión"
              className="w-full flex justify-center p-1.5 rounded hover:bg-white/15 text-white/70 hover:text-white transition-colors"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
