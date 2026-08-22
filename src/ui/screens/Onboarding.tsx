import { useState } from 'react';
import type { Wallet } from '../hooks/useWallet.js';
import { ConfirmSeed } from './ConfirmSeed.js';
import { CreatePassword } from './CreatePassword.js';
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
  | 'import-raw';

/** The one-shot reveal: the password and the words, held only until the vault is sealed. */
interface Reveal {
  password: string;
  mnemonic: string;
  challenge: number[];
}

/**
 * Create and import, in one place. Every secret this flow touches — the chosen
 * password, the generated phrase, pasted import text — lives in state that dies
 * with this component, and the component unmounts the moment the vault exists.
 */
export function Onboarding({
  wallet,
  notice,
  onDone,
}: {
  wallet: Wallet;
  /** e.g. the previous reveal was discarded because the popup closed. */
  notice: string | null;
  onDone: () => Promise<void>;
}) {
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
          onBack={() => setStep('show-seed')}
          onSubmit={async (answers) => {
            await wallet.confirmSeed(answers, reveal.password);
            setReveal(null);
            await onDone();
          }}
        />
      ) : null;

    case 'import-choice':
      return (
        <ImportChoice
          onMnemonic={() => setStep('import-mnemonic')}
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
        <Welcome
          notice={notice}
          onCreate={() => restart('create-password')}
          onImport={() => restart('import-choice')}
        />
      );
  }
}
