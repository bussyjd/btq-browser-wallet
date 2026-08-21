import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'BTQ Wallet',
  version: '0.1.0',
  description: 'Bitcoin Quantum testnet wallet — ML-DSA-44 / P2MR',
  minimum_chrome_version: '116',
  icons: {
    16: 'src/assets/icons/icon-16.png',
    32: 'src/assets/icons/icon-32.png',
    48: 'src/assets/icons/icon-48.png',
    128: 'src/assets/icons/icon-128.png',
  },
  action: {
    default_popup: 'src/ui/index.html',
    default_title: 'BTQ Wallet',
    default_icon: {
      16: 'src/assets/icons/icon-16.png',
      32: 'src/assets/icons/icon-32.png',
      48: 'src/assets/icons/icon-48.png',
    },
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
      // Isolated world: relays allowlisted page requests to the service worker.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_start',
    },
    {
      // MAIN world: defines window.btq directly, so a page CSP cannot block it
      // (Chrome 111+). No key material, no chrome.* access in this world.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/inpage/btq-provider.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
});
