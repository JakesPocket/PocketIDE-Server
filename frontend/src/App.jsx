import { useState } from 'react';
import Layout from './components/Layout';
import ExtensionsView from './components/ExtensionsView';
import EditorView from './components/EditorView';
import TerminalView from './components/TerminalView';
import Chat from './Chat';

function App() {
  const [activeTab, setActiveTab] = useState('editor');

  // Open files: [{ path, name, content }]
  const [openFiles, setOpenFiles] = useState([]);
  // The path of the currently focused file
  const [activeFilePath, setActiveFilePath] = useState(null);

  /** Open a file from the explorer, switching to the editor tab */
  function handleOpenFile(file) {
    setOpenFiles((prev) => {
      if (prev.find((f) => f.path === file.path)) return prev;
      return [...prev, file];
    });
    setActiveFilePath(file.path);
    setActiveTab('editor');
  }

  /** Close a file tab */
  function handleCloseFile(path) {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      if (activeFilePath === path) {
        setActiveFilePath(next.length ? next[next.length - 1].path : null);
      }
      return next;
    });
  }

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'extensions' && (
        <ExtensionsView onOpenFile={handleOpenFile} />
      )}
      {activeTab === 'editor' && (
        <EditorView
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onSelectFile={setActiveFilePath}
          onCloseFile={handleCloseFile}
        />
      )}
      {activeTab === 'terminal' && <TerminalView />}
      {activeTab === 'ai-chat' && <Chat />}
    </Layout>
  );
}

export default App;
