// Icons as tiny inline components so there are no extra dependencies
function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <line x1="3" y1="6"  x2="21" y2="6"  />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

const TAB_ITEMS = [
  { id: 'extensions', label: 'Explorer' },
  { id: 'editor',     label: 'Editor'   },
  { id: 'terminal',   label: 'Terminal' },
  { id: 'ai-chat',    label: 'AI Chat'  },
];

function TabIcon({ id, isActive }) {
  if (id === 'extensions') return isActive ? <IconMenu /> : <IconLayers />;
  if (id === 'editor')     return <IconFile />;
  if (id === 'terminal')   return <IconTerminal />;
  if (id === 'ai-chat')    return <IconChat />;
  return null;
}

export default function Layout({ activeTab, onTabChange, children }) {
  return (
    <div className="flex flex-col h-full">
      {/* Main content — leave room for the nav bar via padding so nothing hides under it */}
      <main className="flex-1 overflow-hidden">
        {children}
      </main>

      {/* ── Bottom Navigation Bar ── */}
      <nav
        aria-label="Main navigation"
        style={{
          // Glassmorphism: semi-transparent dark surface + blur
          backgroundColor: 'rgba(13, 13, 15, 0.75)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          // Safe-area inset for iPhone notch / Dynamic Island
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        className="flex shrink-0"
      >
        {TAB_ITEMS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              style={{ background: 'transparent', border: 'none', outline: 'none' }}
              className={[
                'flex-1 flex flex-col items-center justify-center gap-1 py-2',
                'min-h-[56px] transition-colors cursor-pointer',
                'relative',
                isActive ? 'text-vscode-accent' : 'text-vscode-text-muted',
              ].join(' ')}
            >
              {/* Active indicator pill */}
              {isActive && (
                <span
                  className="absolute top-0 left-1/2 -translate-x-1/2 rounded-full"
                  style={{
                    width: 28,
                    height: 3,
                    background: 'var(--color-vscode-accent)',
                    borderRadius: '0 0 4px 4px',
                    top: 0,
                  }}
                />
              )}
              <TabIcon id={tab.id} isActive={isActive} />
              <span className="text-[10px] leading-tight font-medium">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
