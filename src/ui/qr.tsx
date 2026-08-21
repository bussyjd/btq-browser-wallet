import { useMemo } from 'react';
import { encode } from 'uqr';

export function AddressQr({ address }: { address: string }) {
  const qr = useMemo(() => encode(address, { border: 2, ecc: 'M' }), [address]);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < qr.size; y++) {
    const row = qr.data[y];
    if (!row) continue;
    for (let x = 0; x < qr.size; x++) {
      if (row[x]) cells.push({ x, y });
    }
  }
  return (
    <svg
      className="qr-svg"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="Receive address QR code"
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
      ))}
    </svg>
  );
}
