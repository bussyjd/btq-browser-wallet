/** Where each device records its video when RECORD_VIDEO=1 (see scripts/stitch-demo.sh). */
import { join } from 'node:path';
import { DEMO_RAW } from './extension.js';

/** `order` fixes the sequence the demo is stitched in. */
export function videoDir(order: number, name: string): string | undefined {
  if (!process.env.RECORD_VIDEO) return undefined;
  return join(DEMO_RAW, `${String(order).padStart(2, '0')}-${name}`);
}
