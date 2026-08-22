import { chunkAddress } from '../../core/wallet/format.js';

/**
 * A bech32m address in 4-character clusters with the human-readable prefix in
 * the accent colour. The groups are separate elements with no whitespace text
 * nodes, so textContent is still the exact address.
 */
export function AddressBlock({
  address,
  small,
  testId,
}: {
  address: string;
  small?: boolean;
  testId?: string;
}) {
  const groups = chunkAddress(address);
  return (
    <p
      className={small ? 'addr addr-sm' : 'addr'}
      data-testid={testId}
      data-address={address}
      title={address}
    >
      {groups.map((g, i) => (
        <span key={i} className={i === 0 ? 'grp hrp' : 'grp'}>
          {g}
        </span>
      ))}
    </p>
  );
}
