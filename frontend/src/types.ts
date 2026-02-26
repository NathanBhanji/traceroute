export interface HopData {
  ttl: number;
  ip: string;
  hostname: string;
  rtt: number;      // milliseconds
  success: boolean;
  isFinal: boolean;
  isTimeout: boolean;
  isPending?: boolean; // true = result not yet arrived, show skeleton
}

export interface TraceRecord {
  id: number;
  destination: string;
  createdAt: string;  // RFC3339
  hopCount: number;
  timeoutCount: number;
  totalRtt: number;   // ms
}

export interface HopRecord {
  ttl: number;
  ip: string;
  hostname: string;
  rtt: number;
  success: boolean;
  isFinal: boolean;
}
