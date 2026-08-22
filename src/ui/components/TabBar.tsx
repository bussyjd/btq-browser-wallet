export type HomeTab = 'receive' | 'send' | 'activity';

const TABS: { id: HomeTab; label: string }[] = [
  { id: 'receive', label: 'Receive' },
  { id: 'send', label: 'Send' },
  { id: 'activity', label: 'Activity' },
];

export function TabBar({ tab, onTab }: { tab: HomeTab; onTab: (t: HomeTab) => void }) {
  return (
    <div className="tabbar" role="tablist" aria-label="Wallet sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          className="tab"
          data-testid={`tab-${t.id}`}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
