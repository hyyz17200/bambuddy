import { useCallback, useEffect, useRef, useState } from 'react';
import { discoveryApi, type DiscoveredPrinter } from '../../api/client';

// Shared with upstream's Add Printer dialog, so a custom subnet typed in either is remembered by both.
const CUSTOM_SUBNET_KEY = 'bambuddy.discovery.customSubnet';
const POLL_MS = 1000;

/** Upstream's subnet scan (POST /discovery/scan), driven for the import page.
 *  The subnet scan probes every address, so unlike the 10-second SSDP listen it
 *  finds printers that happen not to announce themselves, and it works in Docker. */
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
  const [found, setFound] = useState<DiscoveredPrinter[]>([]);
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
      if (runningRef.current) discoveryApi.stopSubnetScan().catch(() => {});
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
      await discoveryApi.startSubnetScan(cidr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      finish();
      return;
    }
    timer.current = setInterval(async () => {
      try {
        const status = await discoveryApi.getScanStatus();
        setProgress({ scanned: status.scanned, total: status.total });
        // Also lists what an earlier SSDP listen found: real printers too.
        setFound(await discoveryApi.getDiscoveredPrinters());
        if (!status.running) finish();
      } catch {
        // One missed poll is harmless; the next one catches up.
      }
    }, POLL_MS);
  }, [cidr, subnet, finish]);

  const stop = useCallback(() => {
    discoveryApi.stopSubnetScan().catch(() => {});
  }, []);

  return {
    subnets, subnet, setSubnet, customSubnet, setCustomSubnet, cidr,
    running, progress, found, error, start, stop,
  };
}
