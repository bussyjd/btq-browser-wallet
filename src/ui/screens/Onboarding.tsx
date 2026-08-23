import { useState } from 'react';
import type { Wallet } from '../hooks/useWallet.js';
import { ConfirmSeed } from './ConfirmSeed.js';
import { CreatePassword } from './CreatePassword.js';
import { ImportBackup } from './ImportBackup.js';
import { ImportChoice } from './ImportChoice.js';
import { ImportMnemonic } from './ImportMnemonic.js';
import { ImportRawSeed } from './ImportRawSeed.js';
import { ShowSeed } from './ShowSeed.js';
import { Welcome } from './Welcome.js';

type Step =
  | 'welcome'
  | 'create-password'
  | 'show-seed'
  | 'confirm-seed'
  | 'import-choice'
  | 'import-mnemonic'
  | 'import-backup'
  | 'import-raw';

/**
 * The onboarding reveal: the chosen password and the phrase of a wallet that
 * `wallet.create` has *already sealed*.
 *
 * This state is the half of the flow that survives the background worker, and
 * that asymmetry is the reason the flow is shaped this way. Chrome ends an idle
 * MV3 worker after about thirty seconds and the popup keeps rendering
 * regardless, so anything the worker held between the two screens was gone while
 * the words were still on screen. Now the worker holds nothing: the vault is
 * sealed, and what lives here is a convenience — the password, so the
 * confirmation step need not ask for it again, and the words, so "Back to the
 * words" works without a round trip.
 *
 * Both die with this component, and losing them costs the user nothing: the
 * wallet exists, and Settings → Security shows the phrase again behind the
 * password.
 */
interface Reveal {
  password: string;
  mnemonic: string;
  challenge: number[];
}

/**
 * Create and import, in one place. Every secret this flow touches — the chosen
 * password, the generated phrase, pasted import text — lives in state that dies
 * with this component, and the component unmounts the moment setup finishes.
 */
export function Onboarding({ wallet, onDone }: { wallet: Wallet; onDone: () => Promise<void> }) {
  const [step, setStep] = useState<Step>('welcome');
  const [reveal, setReveal] = useState<Reveal | null>(null);

  function restart(next: Step) {
    setReveal(null);
    setStep(next);
  }

  switch (step) {
    case 'create-password':
      return (
        <CreatePassword
          onBack={() => restart('welcome')}
          onSubmit={async (password) => {
            const r = await wallet.create(password);
            setReveal({ password, mnemonic: r.mnemonic, challenge: r.challenge });
            setStep('show-seed');
          }}
        />
      );

    case 'show-seed':
      return reveal ? (
        <ShowSeed words={reveal.mnemonic.split(' ')} onContinue={() => setStep('confirm-seed')} />
      ) : null;

    case 'confirm-seed':
      return reveal ? (
        <ConfirmSeed
          challenge={reveal.challenge}
          password={reveal.password}
          onBack={() => setStep('show-seed')}
          onSubmit={async (answers, password) => {
            await wallet.confirmSeed(answers, password);
            setReveal(null);
            await onDone();
          }}
        />
      ) : null;

    case 'import-choice':
      return (
        <ImportChoice
          onMnemonic={() => setStep('import-mnemonic')}
          onBackupFile={() => setStep('import-backup')}
          onRaw={() => setStep('import-raw')}
          onBack={() => setStep('welcome')}
        />
      );

    case 'import-mnemonic':
      return (
        <ImportMnemonic
          onBack={() => setStep('import-choice')}
          onSubmit={async (text, password) => {
            await wallet.importMnemonic(text, password);
            await onDone();
          }}
        />
      );

    case 'import-backup':
      return (
        <ImportBackup
          onBack={() => setStep('import-choice')}
          onSubmit={async (backupHex, password) => {
            await wallet.importBackup(backupHex, password);
            await onDone();
          }}
        />
      );

    case 'import-raw':
      return (
        <ImportRawSeed
          onBack={() => setStep('import-choice')}
          onSubmit={async (hex, password) => {
            await wallet.importSeed(hex, password);
            await onDone();
          }}
        />
      );

    default:
      return (
        <Welcome onCreate={() => restart('create-password')} onImport={() => restart('import-choice')} />
      );
  }
}
