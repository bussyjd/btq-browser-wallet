import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'BTQ Wallet',
  version: '0.1.0',
  description: 'Bitcoin Quantum testnet wallet — ML-DSA-44 / P2MR',
  action: {
    default_popup: 'src/ui/index.html',
    default_title: 'BTQ Wallet',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['storage', 'alarms'],
  host_permissions: [
    'https://explorer.bitcoinquantum.com/*',
    'http://127.0.0.1:*/*',
    'http://localhost:*/*',
  ],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_start',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['src/inpage/btq-provider.js'],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],
});
