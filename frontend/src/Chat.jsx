import { useState, useRef, useEffect } from 'react';

// ── Message types ──────────────────────────────────────────────────────────
// { role: 'user',   text: string }
// { role: 'agent',  text: string, streaming?: bool }
// { role: 'tool',   tool: string, done?: bool }
// { role: 'error',  text: string }

function UserBubble({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tr-sm text-sm
                      bg-vscode-accent text-white break-words leading-relaxed">
        {text}
      </div>
    </div>
  );
}

function AgentBubble({ text, streaming }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm
                      bg-vscode-sidebar text-vscode-text break-words leading-relaxed whitespace-pre-wrap">
        {text}
        {streaming && (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-vscode-accent align-middle
                           rounded-sm animate-pulse" />
        )}
      </div>
    </div>
  );
}

function ToolCallBubble({ tool, done }) {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs
                      text-vscode-text-muted border border-vscode-border
                      bg-vscode-bg max-w-[85%]">
        {!done ? (
          <svg className="w-3.5 h-3.5 shrink-0 animate-spin text-vscode-accent"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 11-6.22-8.56" strokeLinecap="round" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 shrink-0 text-green-500"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        <span>
          {done ? 'Done: ' : 'Agent is running: '}
          <span className="font-mono text-vscode-text">{tool}</span>
        </span>
      </div>
    </div>
  );
}

function ReasoningBubble({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-start">
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: 'none', border: 'none', outline: 'none' }}
        className="flex flex-col gap-1 max-w-[85%] cursor-pointer text-left"
      >
        <span className="text-[11px] text-vscode-text-muted flex items-center gap-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          Thinking {open ? '▲' : '▼'}
        </span>
        {open && (
          <div className="px-3 py-2 rounded-xl text-xs text-vscode-text-muted
                          bg-vscode-sidebar border border-vscode-border
                          whitespace-pre-wrap leading-relaxed">
            {text}
          </div>
        )}
      </button>
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState([
    { role: 'agent', text: 'Hello! I am your autonomous coding agent. How can I help?' },
  ]);
  const [reasoning, setReasoning] = useState('');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef(null);
  const abortRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(e) {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || streaming) return;

    setInput('');
    setReasoning('');
    setStreaming(true);

    // Append user message
    setMessages((prev) => [...prev, { role: 'user', text: prompt }]);

    // Reserve a slot for the streaming agent reply
    const agentIdx = messages.length + 1; // after user msg
    setMessages((prev) => [...prev, { role: 'agent', text: '', streaming: true }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let reasoningAcc = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          switch (event.type) {
            case 'reasoning':
              reasoningAcc += event.content;
              setReasoning(reasoningAcc);
              break;

            case 'delta':
              setMessages((prev) => {
                const next = [...prev];
                const target = next[agentIdx];
                if (target?.role === 'agent') {
                  next[agentIdx] = { ...target, text: target.text + event.content, streaming: true };
                }
                return next;
              });
              break;

            case 'tool_call':
              setMessages((prev) => [
                ...prev,
                { role: 'tool', tool: event.tool, done: false },
              ]);
              break;

            case 'tool_result':
              setMessages((prev) => {
                const next = [...prev];
                // Mark the last matching tool bubble as done
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === 'tool' && next[i].tool === event.tool && !next[i].done) {
                    next[i] = { ...next[i], done: true };
                    break;
                  }
                }
                return next;
              });
              break;

            case 'message':
              // Replace streaming placeholder with final complete text
              setMessages((prev) => {
                const next = [...prev];
                const target = next[agentIdx];
                if (target?.role === 'agent') {
                  next[agentIdx] = { role: 'agent', text: event.content, streaming: false };
                }
                return next;
              });
              break;

            case 'error':
              setMessages((prev) => [
                ...prev,
                { role: 'error', text: event.message },
              ]);
              break;

            case 'done':
              break;
          }
        }
      }

      // If reasoning was accumulated, inject it just before the agent bubble
      if (reasoningAcc) {
        setMessages((prev) => {
          const next = [...prev];
          next.splice(agentIdx, 0, { role: 'reasoning', text: reasoningAcc });
          return next;
        });
      }

      // Finalise: strip streaming flag
      setMessages((prev) => {
        const next = [...prev];
        const target = next[agentIdx + (reasoningAcc ? 1 : 0)];
        if (target?.role === 'agent') {
          next[agentIdx + (reasoningAcc ? 1 : 0)] = { ...target, streaming: false };
        }
        return next;
      });

    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'agent' && m.text === '' && m.streaming)),
          { role: 'error', text: err.message },
        ]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleAbort() {
    abortRef.current?.abort();
    setStreaming(false);
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'agent' && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {messages.map((msg, idx) => {
          if (msg.role === 'user')      return <UserBubble    key={idx} text={msg.text} />;
          if (msg.role === 'agent')     return <AgentBubble   key={idx} text={msg.text} streaming={msg.streaming} />;
          if (msg.role === 'tool')      return <ToolCallBubble key={idx} tool={msg.tool} done={msg.done} />;
          if (msg.role === 'reasoning') return <ReasoningBubble key={idx} text={msg.text} />;
          if (msg.role === 'error')     return (
            <div key={idx} className="flex justify-start">
              <div className="px-4 py-2.5 rounded-2xl text-sm bg-red-900/30 text-red-400
                              border border-red-900/50 max-w-[85%] break-words">
                {msg.text}
              </div>
            </div>
          );
          return null;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <form
        onSubmit={handleSend}
        className="flex items-end gap-2 border-t border-vscode-border p-3"
        style={{ backgroundColor: 'var(--color-vscode-nav)' }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
          placeholder="Message the agent… (Enter to send, Shift+Enter for newline)"
          disabled={streaming}
          rows={1}
          className="flex-1 resize-none bg-vscode-sidebar text-vscode-text
                     placeholder-vscode-text-muted px-3 py-2.5 rounded-2xl
                     border border-vscode-border outline-none text-sm
                     min-h-[44px] max-h-[120px] overflow-y-auto
                     disabled:opacity-50 leading-relaxed"
          style={{ fieldSizing: 'content' }}
        />
        {streaming ? (
          <button
            type="button"
            onClick={handleAbort}
            className="bg-red-600 text-white px-4 py-2.5 rounded-2xl text-sm font-medium
                       min-h-[44px] min-w-[44px] cursor-pointer border-none shrink-0"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-vscode-accent text-white px-4 py-2.5 rounded-2xl text-sm font-medium
                       min-h-[44px] min-w-[44px] cursor-pointer border-none shrink-0
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
