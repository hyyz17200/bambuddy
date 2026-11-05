import { useCallback, useEffect, useRef, useState } from 'react';
import { discoveryApi } from '../../api/client';
import { Hyyz17200RequestError } from '../request';
import { getScan, startScan, stopScan } from './api';
import type { Discovered } from './rows';

// Shared with upstream's Add Printer dialog, so a custom subnet typed in either is remembered by both.
const CUSTOM_SUBNET_KEY = 'bambuddy.discovery.customSubnet';
const POLL_MS = 1000;

/** The fork's subnet scan (POST /hyyz17200/printers/scan), driven for the
 *  import page. Up to a /16, and every printer found comes with its serial;
 *  upstream's scan stops at 1024 addresses and misses A1/P1 serials. The
 *  subnets offered are the ones upstream detects. */
export function useNetworkScan() {
  const [subnets, setSubnets] = useState<string[]>([]);
  const [subnet, setSubnet] = useState('');
  const [customSubnet, setCustomSubnet] = useState(() => {
    try {
      return localStorage.getItem(CUSTOM_SUBNET_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [found, setFound] = useState<Discovered[]>([]);
  /** An error code from the scan route (`invalid_subnet`, `subnet_too_large`, `scan_running`) or a message. */
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    discoveryApi
      .getInfo()
      .then((info) => {
        setSubnets(info.subnets);
        if (info.subnets.length > 0) setSubnet((current) => current || info.subnets[0]);
        else setSubnet('__custom__');
      })
      .catch(() => setSubnet('__custom__'));
  }, []);

  const finish = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    runningRef.current = false;
    setRunning(false);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      if (runningRef.current) stopScan().catch(() => {});
    },
    [],
  );

  const cidr = subnet === '__custom__' ? customSubnet.trim() : subnet;

  const start = useCallback(async () => {
    if (!cidr || runningRef.current) return;
    if (subnet === '__custom__') {
      try {
        localStorage.setItem(CUSTOM_SUBNET_KEY, cidr);
      } catch {
        // Best effort: the user retypes it next time.
      }
    }
    setError('');
    setFound([]);
    setProgress({ scanned: 0, total: 0 });
    runningRef.current = true;
    setRunning(true);
    try {
      const first = await startScan(cidr);
      setProgress({ scanned: first.scanned, total: first.total });
    } catch (e) {
      setError(e instanceof Hyyz17200RequestError ? e.detail ?? e.message : e instanceof Error ? e.message : String(e));
      finish();
      return;
    }
    timer.current = setInterval(async () => {
      try {
        const state = await getScan();
        setProgress({ scanned: state.scanned, total: state.total });
        setFound(
          state.printers.map((p) => ({
            serial: p.serial_number,
            name: p.name ?? '',
            ip_address: p.ip_address,
            model: p.model,
          })),
        );
        if (!state.running) finish();
      } catch {
        // One missed poll is harmless; the next one catches up.
      }
    }, POLL_MS);
  }, [cidr, subnet, finish]);

  const stop = useCallback(() => {
    stopScan().catch(() => {});
  }, []);

  return {
    subnets, subnet, setSubnet, customSubnet, setCustomSubnet, cidr,
    running, progress, found, error, start, stop,
  };
}
