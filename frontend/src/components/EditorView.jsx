import { useState, useEffect } from 'react';

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round"
      className="w-3 h-3" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-vscode-text-muted select-none">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25"
        strokeLinecap="round" strokeLinejoin="round" className="w-14 h-14 opacity-30">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </svg>
      <p className="text-sm opacity-50">Open a file from the Explorer</p>
    </div>
  );
}

export default function EditorView({ openFiles, activeFilePath, onSelectFile, onCloseFile }) {
  const [fileContents, setFileContents] = useState({}); // path → string content
  const [loadingPath, setLoadingPath] = useState(null);
  const [errorPath, setErrorPath] = useState(null);

  // Fetch file content whenever a new activeFilePath appears that we haven't loaded yet
  useEffect(() => {
    if (!activeFilePath) return;
    if (fileContents[activeFilePath] !== undefined) return; // already loaded

    setLoadingPath(activeFilePath);
    setErrorPath(null);

    fetch(`/api/file?path=${encodeURIComponent(activeFilePath)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      })
      .then((text) => {
        setFileContents((prev) => ({ ...prev, [activeFilePath]: text }));
      })
      .catch((e) => {
        setFileContents((prev) => ({ ...prev, [activeFilePath]: null }));
        setErrorPath(activeFilePath);
        console.error('EditorView fetch error:', e);
      })
      .finally(() => setLoadingPath(null));
  }, [activeFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeFile = openFiles.find((f) => f.path === activeFilePath);
  const content = activeFilePath ? fileContents[activeFilePath] : undefined;
  const isLoading = loadingPath === activeFilePath;
  const hasError = errorPath === activeFilePath;

  return (
    <div className="flex flex-col h-full">
      {/* ── Horizontal-scrolling open-file tab bar ── */}
      {openFiles.length > 0 && (
        <div
          className="no-scrollbar flex shrink-0 overflow-x-auto border-b border-vscode-border"
          style={{ backgroundColor: 'var(--color-vscode-bg)' }}
        >
          {openFiles.map((file) => {
            const isActive = file.path === activeFilePath;
            return (
              <div
                key={file.path}
                className={[
                  'flex items-center gap-2 px-3 shrink-0 cursor-pointer',
                  'min-h-[44px] border-r border-vscode-border transition-colors',
                  'text-sm select-none',
                  isActive
                    ? 'text-vscode-text border-t-2 border-t-vscode-accent'
                    : 'text-vscode-text-muted hover:text-vscode-text hover:bg-vscode-sidebar',
                ].join(' ')}
                style={{
                  backgroundColor: isActive
                    ? 'var(--color-vscode-tab-active)'
                    : 'transparent',
                }}
                onClick={() => onSelectFile(file.path)}
              >
                <span className="truncate max-w-[120px]">{file.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseFile(file.path);
                  }}
                  aria-label={`Close ${file.name}`}
                  style={{ background: 'none', border: 'none', outline: 'none' }}
                  className="flex items-center justify-center w-5 h-5 rounded
                             text-vscode-text-muted hover:text-vscode-text
                             hover:bg-vscode-sidebar cursor-pointer transition-colors shrink-0"
                >
                  <IconClose />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Editor body ── */}
      <div className="flex-1 overflow-auto">
        {openFiles.length === 0 && <EmptyState />}

        {openFiles.length > 0 && isLoading && (
          <div className="flex items-center gap-2 p-4 text-vscode-text-muted text-sm">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-6.22-8.56" strokeLinecap="round" />
            </svg>
            Loading {activeFile?.name}…
          </div>
        )}

        {openFiles.length > 0 && hasError && (
          <p className="p-4 text-sm text-red-400">
            Failed to load {activeFile?.name}.
          </p>
        )}

        {openFiles.length > 0 && !isLoading && !hasError && content !== undefined && (
          <pre
            className="p-4 text-sm font-mono leading-relaxed text-vscode-text whitespace-pre-wrap break-words"
            style={{ tabSize: 2 }}
          >
            {content ?? '(empty file)'}
          </pre>
        )}
      </div>
    </div>
  );
}
