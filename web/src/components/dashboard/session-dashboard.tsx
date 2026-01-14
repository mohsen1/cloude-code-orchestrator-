"use client";

import { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  GitBranch,
  HeartPulse,
  Loader2,
  Server,
  Users,
} from 'lucide-react';
import { useSessionData } from '@/hooks/use-session-data';
import type { SessionInstance, SessionSnapshot, InstanceStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_VARIANTS: Record<InstanceStatus, { label: string; className: string }> = {
  starting: { label: 'Booting', className: 'bg-slate-600/60 text-white/80' },
  ready: { label: 'Ready', className: 'bg-sky-500/20 text-sky-200 border border-sky-500/40' },
  busy: { label: 'Executing', className: 'bg-amber-400/20 text-amber-100 border border-amber-300/40' },
  idle: { label: 'Idle', className: 'bg-emerald-400/20 text-emerald-100 border border-emerald-300/40' },
  merging: { label: 'Merging', className: 'bg-purple-500/25 text-purple-100 border border-purple-400/40' },
  error: { label: 'Attention', className: 'bg-rose-500/25 text-rose-100 border border-rose-400/40' },
  stopped: { label: 'Stopped', className: 'bg-slate-700/60 text-slate-200 border border-white/10' },
};

const STATUS_ORDER: InstanceStatus[] = ['error', 'starting', 'busy', 'merging', 'ready', 'idle', 'stopped'];

export default function SessionDashboard() {
  const { data, loading, error } = useSessionData();

  if (loading && !data) {
    return <LoadingState />;
  }

  if (error && !data) {
    return <ErrorState message={error} />;
  }

  if (!data) {
    return <ErrorState message="Session data unavailable" />;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-10 md:px-6 lg:px-10">
      <SessionHero snapshot={data} loading={loading} error={error} />
      <MetricsRow snapshot={data} />
      <div className="grid gap-6 lg:grid-cols-3">
        <TeamGrid snapshot={data} className="lg:col-span-2" />
        <CostAndAuth snapshot={data} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <InstancesPanel snapshot={data} />
        <LogsPanel snapshot={data} />
      </div>
    </main>
  );
}

function SessionHero({ snapshot, loading, error }: { snapshot: SessionSnapshot; loading: boolean; error: string | null }) {
  const uptime = formatRelativeMinutes(snapshot.meta.startedAt);

  return (
    <Card className="gradient-border relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-40 mix-blend-screen">
        <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-sky-500/10 via-transparent to-transparent" />
      </div>
      <CardHeader className="relative z-10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <CardDescription className="text-xs uppercase tracking-[0.4rem] text-white/60">Current Session</CardDescription>
          <CardTitle className="text-2xl md:text-3xl">
            {snapshot.meta.repositoryUrl.replace(/https?:\/\//, '')}
          </CardTitle>
          <p className="text-sm text-white/60">Workspace: {snapshot.meta.workspaceDir}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Badge variant="outline" className="gap-1 bg-white/5 text-white">
            <GitBranch className="h-3 w-3" /> {snapshot.meta.branch}
          </Badge>
          <Badge variant="outline" className="gap-1 bg-white/5 text-white">
            <Users className="h-3 w-3" /> {snapshot.meta.workerCount} workers
          </Badge>
          <Badge variant="outline" className={cn('gap-1 text-emerald-200', error && 'text-amber-200')}>
            <Activity className="h-3 w-3" /> {loading ? 'Syncing' : 'Live'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="relative z-10 grid gap-4 sm:grid-cols-3">
        <HeroTile icon={<Clock3 className="h-4 w-4" />} label="Uptime" value={uptime} />
        <HeroTile icon={<Server className="h-4 w-4" />} label="Hierarchy" value={snapshot.meta.hierarchyEnabled ? 'Director + EMs' : 'Manager only'} />
        <HeroTile icon={<HeartPulse className="h-4 w-4" />} label="Last Poll" value={new Date().toLocaleTimeString()} subtle />
      </CardContent>
    </Card>
  );
}

function MetricsRow({ snapshot }: { snapshot: SessionSnapshot }) {
  const busyWorkers = snapshot.instances.list.filter((i) => i.type === 'worker' && i.status === 'busy').length;
  const idleWorkers = snapshot.instances.list.filter((i) => i.type === 'worker' && i.status === 'idle').length;
  const queuePressure = snapshot.queues.teams.reduce((acc, team) => acc + team.queueSize, 0) + snapshot.queues.directorQueueSize + snapshot.queues.managerQueueSize;

  const metrics = [
    {
      title: 'Active Instances',
      value: snapshot.instances.total,
      change: `${snapshot.instances.byStatus.busy} busy · ${snapshot.instances.byStatus.idle} idle`,
      icon: <Activity className="h-4 w-4 text-violet-300" />,
    },
    {
      title: 'Worker Focus',
      value: `${busyWorkers}/${snapshot.meta.workerCount}`,
      change: `${idleWorkers} awaiting prompts`,
      icon: <Users className="h-4 w-4 text-sky-300" />,
    },
    {
      title: 'Queue Depth',
      value: queuePressure,
      change: snapshot.meta.hierarchyEnabled ? 'Workers → EMs → Director' : 'Workers → Manager',
      icon: <BarChart3 className="h-4 w-4 text-emerald-300" />,
    },
    {
      title: 'Tool Usage',
      value: snapshot.costs.totalToolUses,
      change: `${snapshot.costs.toolUsesPerInstance.length} tracked instances`,
      icon: <Server className="h-4 w-4 text-amber-300" />,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {metrics.map((metric) => (
        <Card key={metric.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/60">
              {metric.icon}
              {metric.title}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold text-white">{metric.value}</div>
            <p className="text-sm text-white/60">{metric.change}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TeamGrid({ snapshot, className }: { snapshot: SessionSnapshot; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Engineering Teams</CardTitle>
            <CardDescription>Queue pressure per EM worktree</CardDescription>
          </div>
          <Badge variant="outline" className="bg-white/5 text-white/70">
            {snapshot.queues.teams.length || 1} teams
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {snapshot.queues.teams.length === 0 && (
          <p className="text-sm text-white/60">Hierarchy disabled — manager handles worker merges directly.</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {snapshot.queues.teams.map((team) => (
            <div key={team.id} className="rounded-2xl border border-white/5 bg-white/5 p-4">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-white/60">EM-{team.id}</p>
                  <p className="text-lg font-semibold">{team.branchName}</p>
                </div>
                <Badge variant={team.queueSize > 0 ? 'warning' : 'success'}>
                  {team.queueSize > 0 ? `${team.queueSize} merge(s)` : 'Clear'}
                </Badge>
              </div>
              <Separator className="my-3" />
              <div className="space-y-2 text-sm text-white/70">
                <div className="flex items-center justify-between">
                  <span>Workers</span>
                  <span className="font-mono text-white">{team.workers.join(', ')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Last assessment</span>
                  <span className="text-white">{formatRelativeMs(team.lastAssessment)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CostAndAuth({ snapshot }: { snapshot: SessionSnapshot }) {
  const totalRatio = (snapshot.costs.totalToolUses / snapshot.costs.limits.maxTotalToolUses) * 100;
  const durationRatio = (snapshot.costs.runDurationMinutes / snapshot.costs.limits.maxRunDurationMinutes) * 100;

  return (
    <div className="flex h-full flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Cost Tracker</CardTitle>
          <CardDescription>Safety rails on runtime and tool usage</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <StatBar label="Total tool uses" value={snapshot.costs.totalToolUses} limit={snapshot.costs.limits.maxTotalToolUses} ratio={totalRatio} />
          <StatBar label="Run duration (min)" value={snapshot.costs.runDurationMinutes.toFixed(1)} limit={snapshot.costs.limits.maxRunDurationMinutes} ratio={durationRatio} />
          <div>
            <p className="text-xs uppercase tracking-wide text-white/60">Per-instance leaders</p>
            <div className="mt-2 space-y-1 text-sm text-white/70">
              {snapshot.costs.toolUsesPerInstance
                .sort((a, b) => b.count - a.count)
                .slice(0, 4)
                .map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between font-mono">
                    <span>{entry.id}</span>
                    <span>{entry.count}</span>
                  </div>
                ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Auth Rotation</CardTitle>
          <CardDescription>{snapshot.auth.mode}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-white/70">
          <div className="flex items-center justify-between">
            <span>Configs loaded</span>
            <span className="font-semibold text-white">{snapshot.auth.configs.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Rotation pool</span>
            <span className="font-semibold text-white">{snapshot.auth.rotationPoolSize}</span>
          </div>
          {snapshot.auth.configs.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-white/60">Available tokens</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {snapshot.auth.configs.map((config) => (
                  <Badge key={config} variant="outline" className="bg-white/5 text-white/80">
                    {config}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InstancesPanel({ snapshot }: { snapshot: SessionSnapshot }) {
  const instances = useMemo(() => {
    return [...snapshot.instances.list].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  }, [snapshot.instances.list]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instance Timeline</CardTitle>
        <CardDescription>Claude panes and their latest heartbeat</CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[420px] pr-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Instance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last tool use</TableHead>
                <TableHead className="text-right">Tool uses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((instance) => (
                <TableRow key={instance.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-white">{instance.id}</span>
                      <span className="text-xs uppercase tracking-wide text-white/50">{instance.type}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={instance.status} />
                  </TableCell>
                  <TableCell className="text-white/80">{formatRelativeIso(instance.lastToolUse)}</TableCell>
                  <TableCell className="text-right font-mono text-white">{instance.toolUseCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function LogsPanel({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs & Diagnostics</CardTitle>
        <CardDescription>Tail tmux output without leaving the browser</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-white/70">
        <div>
          <p className="text-xs uppercase tracking-wide text-white/60">Run log directory</p>
          <code className="mt-1 block rounded-xl bg-black/40 p-3 font-mono text-xs text-emerald-200">
            {snapshot.logs.runLogDir ?? 'Not configured'}
          </code>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-white/60">Session streams</p>
          <div className="mt-2 space-y-2">
            {snapshot.logs.sessions.slice(0, 6).map((session) => (
              <div key={session.id} className="rounded-xl border border-white/5 bg-white/5 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">{session.id}</span>
                  <Badge variant="outline" className="bg-black/30 text-white/70">
                    {session.path ? 'Streaming' : 'Pending'}
                  </Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-white/60">{session.path ?? 'Log path not available yet'}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-amber-100">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4" /> Rate limit detector on
          </p>
          <p className="mt-1 text-xs text-amber-100/80">
            If Anthropic throttles, orchestrator rotates auth and instructs instances to resume automatically.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function HeroTile({ icon, label, value, subtle }: { icon: React.ReactNode; label: string; value: string; subtle?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-black/30 p-4">
      <p className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/60">
        {icon}
        {label}
      </p>
      <p className={cn('text-2xl font-semibold text-white', subtle && 'text-white/80')}>{value}</p>
    </div>
  );
}

function StatBar({ label, value, limit, ratio }: { label: string; value: string | number; limit: number; ratio: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-white/60">
        <span>{label}</span>
        <span>
          {value} / {limit}
        </span>
      </div>
      <Progress value={Math.min(100, Math.max(0, ratio))} className="mt-2" />
    </div>
  );
}

function StatusPill({ status }: { status: InstanceStatus }) {
  const variant = STATUS_VARIANTS[status];
  return <span className={cn('rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide', variant.className)}>{variant.label}</span>;
}

function LoadingState() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 px-6 py-16">
      <Skeleton className="h-32 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-6 text-center text-white">
      <Card>
        <CardHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/20 text-rose-200">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <CardTitle>Unable to load session</CardTitle>
          <CardDescription className="text-white/70">{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Retry
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

function formatRelativeMinutes(startIso: string | null): string {
  if (!startIso) return 'Booting';
  const diffMs = Date.now() - new Date(startIso).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m`;
}

function formatRelativeMs(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) return 'seconds ago';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatRelativeIso(input: string | null): string {
  if (!input) return '—';
  const diff = Date.now() - new Date(input).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'seconds ago';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
