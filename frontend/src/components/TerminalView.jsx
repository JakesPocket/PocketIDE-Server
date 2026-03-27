export default function TerminalView() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-4">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"
        className="w-12 h-12 text-vscode-text-muted mb-4 opacity-40">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <p className="text-sm text-vscode-text-muted opacity-50">
        Terminal (node-pty) will appear here.
      </p>
    </div>
  );
}
