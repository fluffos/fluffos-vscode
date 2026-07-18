// LSP client: starts server/main.js via the official vscode-languageclient
// (node IPC transport) and exposes it to the rest of the extension. When
// lpc.useLanguageServer is on (the default), the server owns diagnostics,
// symbols, formatting, hover, definition and completion; the legacy
// in-process wiring in extension.js stays as the fallback path.

'use strict';

const vscode = require('vscode');
const path = require('path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client = null;

function enabled() {
  return vscode.workspace.getConfiguration('lpc').get('useLanguageServer', true);
}

async function start(ctx) {
  const serverModule = path.join(ctx.extensionPath, 'server', 'main.js');
  client = new LanguageClient(
    'lpc', 'LPC Language Server',
    {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: {
        module: serverModule, transport: TransportKind.ipc,
        options: { execArgv: ['--nolazy', '--inspect=6009'] },
      },
    },
    {
      documentSelector: [{ language: 'lpc' }],
      synchronize: {
        configurationSection: 'lpc',
        // Off-editor changes (git pull, generators): keeps the workspace
        // cross-index fresh and re-triggers driver-config discovery.
        fileEvents: [
          vscode.workspace.createFileSystemWatcher('**/*.{lpc,c,h}'),
          vscode.workspace.createFileSystemWatcher('**/{config,config.*,*.cfg,*.conf}'),
        ],
      },
      initializationOptions: {
        settings: vscode.workspace.getConfiguration('lpc'),
      },
    });
  await client.start();
  ctx.subscriptions.push({ dispose: () => client && client.stop() });
  return client;
}

function get() { return client; }

// Explorer model over LSP; null when the client isn't running (caller
// falls back to the in-process build).
async function requestModel(docUri) {
  if (!client || !client.isRunning()) return null;
  try {
    return await client.sendRequest('lpc/model', { uri: docUri.toString() });
  } catch (_e) {
    return null;
  }
}

module.exports = { enabled, start, get, requestModel };
