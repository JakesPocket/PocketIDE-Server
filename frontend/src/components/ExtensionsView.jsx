import { useState, useEffect } from 'react';

function IconFolder({ open }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round"
      className="w-4 h-4 shrink-0 text-yellow-400" aria-hidden="true">
      {open
        ? <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        : <>
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </>
      }
    </svg>
  );
}

function IconFileSmall() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round"
      className="w-4 h-4 shrink-0 text-vscode-text-muted" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconChevron({ open }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/** Recursive file tree node */
function FileNode({ node, depth = 0, onOpenFile }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const indent = depth * 12 + 12;

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{ paddingLeft: indent, background: 'none', border: 'none', outline: 'none' }}
          className="w-full flex items-center gap-1.5 h-[36px] min-h-[36px] text-vscode-text
                     hover:bg-vscode-sidebar-hover cursor-pointer transition-colors"
        >
          <IconChevron open={expanded} />
          <IconFolder open={expanded} />
          <span className="text-sm truncate">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <FileNode key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onOpenFile({ path: node.path, name: node.name })}
      style={{ paddingLeft: indent + 16, background: 'none', border: 'none', outline: 'none' }}
      className="w-full flex items-center gap-2 h-[44px] min-h-[44px] text-vscode-text
                 hover:bg-vscode-sidebar-hover cursor-pointer transition-colors"
    >
      <IconFileSmall />
      <span className="text-sm truncate">{node.name}</span>
    </button>
  );
}

const SUB_TABS = [
  { id: 'file-explorer', label: 'Explorer' },
  { id: 'source-control', label: 'Git' },
];

export default function ExtensionsView({ onOpenFile }) {
  const [activeSubTab, setActiveSubTab] = useState('file-explorer');
  const [fileTree, setFileTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (activeSubTab !== 'file-explorer') return;
    setLoading(true);
    setError(null);
    fetch('/api/files')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data) => setFileTree(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [activeSubTab]);

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div
        className="flex shrink-0 border-b border-vscode-border"
        style={{ backgroundColor: 'var(--color-vscode-sidebar)' }}
      >
        {SUB_TABS.map((tab) => {
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              style={{ background: 'transparent', border: 'none', outline: 'none' }}
              className={[
                'flex-1 py-3 text-sm font-medium transition-colors cursor-pointer',
                'min-h-[44px]',
                isActive
                  ? 'text-white border-b-2 border-vscode-accent'
                  : 'text-vscode-text-muted hover:text-vscode-text',
              ].join(' ')}
              aria-current={isActive ? 'true' : undefined}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'file-explorer' && (
          <>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-vscode-text-muted">
                Workspace
              </span>
              <button
                onClick={() => {
                  setFileTree(null);
                  setLoading(true);
                  fetch('/api/files')
                    .then((r) => r.json())
                    .then(setFileTree)
                    .catch((e) => setError(e.message))
                    .finally(() => setLoading(false));
                }}
                title="Refresh"
                style={{ background: 'none', border: 'none', outline: 'none' }}
                className="text-vscode-text-muted hover:text-vscode-text cursor-pointer p-1"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                </svg>
              </button>
            </div>

            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-vscode-text-muted text-sm">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 11-6.22-8.56" strokeLinecap="round" />
                </svg>
                Loading…
              </div>
            )}

            {error && (
              <p className="px-3 py-4 text-sm text-red-400">
                Error: {error}
              </p>
            )}

            {!loading && !error && fileTree && (
              <FileNode node={fileTree} depth={0} onOpenFile={onOpenFile} />
            )}
          </>
        )}

        {activeSubTab === 'source-control' && (
          <div className="px-3 py-4">
            <p className="text-sm text-vscode-text-muted">
              Git controls coming soon.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
