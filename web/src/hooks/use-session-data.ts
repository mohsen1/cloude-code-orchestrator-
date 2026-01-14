"use client";

import { useEffect, useState } from 'react';
import type { SessionSnapshot } from '@/lib/types';

const POLL_INTERVAL_MS = 5000;
const API_BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_API;

function buildUrl(path: string): string {
  if (!API_BASE) {
    return path;
  }

  const normalizedBase = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  return `${normalizedBase}${path}`;
}

export function useSessionData() {
  const [data, setData] = useState<SessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function fetchSnapshot(firstPass = false) {
      if (firstPass) {
        setLoading(true);
      }

      try {
        const response = await fetch(buildUrl('/api/session/current'), { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload: SessionSnapshot = await response.json();
        if (!active) return;
        setData(payload);
        setError(null);
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : 'Failed to load session data';
        setError(message);
      } finally {
        if (!active) return;
        setLoading(false);
        timer = setTimeout(() => fetchSnapshot(false), POLL_INTERVAL_MS);
      }
    }

    fetchSnapshot(true);

    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { data, loading, error } as const;
}
