// Compiler configuration: resolve lpcc settings with zero-setup defaults,
// and scaffold a minimal driver config into a workspace.
//
// Zero-setup chain (each falls back to the next):
//   lpc.lpcc.path        -> bundled bin/lpcc.js (wasm build, run via node)
//   lpc.lpcc.configFile  -> <workspace>/.lpc/config (the scaffold below)
//
// The scaffold is the empirically-minimal config a modern driver boots
// with: name, mudlib/log dirs, master file, include dirs, and a REAL
// global include file -- an empty value gets quoted into "" by the
// driver's config parser and then fails as an #include, so the scaffold
// always ships .lpc/include/globals.h.

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { makeScaffoldFiles } = require('./lpcc.js');

// Resolve effective lpcc settings for a document, applying the zero-setup
// defaults. Returns {lpccPath, configFile, mudlibRoot, relPath, available}.
function resolveLpccSettings(ctx, doc) {
  const cfg = vscode.workspace.getConfiguration('lpc', doc.uri);
  let lpccPath = cfg.get('lpcc.path', '');
  let configFile = cfg.get('lpcc.configFile', '');
  let mudlibRoot = cfg.get('mudlibRoot', '');
  if (!mudlibRoot) {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    mudlibRoot = folder ? folder.uri.fsPath : path.dirname(doc.uri.fsPath);
  }
  if (!lpccPath) {
    const bundled = path.join(ctx.extensionPath, 'bin', 'lpcc.js');
    if (fs.existsSync(bundled)) lpccPath = bundled;
  }
  if (!configFile) {
    const scaffold = path.join(mudlibRoot, '.lpc', 'config');
    if (fs.existsSync(scaffold)) configFile = scaffold;
  }
  const relPath = path.relative(mudlibRoot, doc.uri.fsPath).split(path.sep).join('/');
  const available = !!(lpccPath && configFile) && !relPath.startsWith('..');
  return { lpccPath, configFile, mudlibRoot, relPath, available };
}

async function initConfigCommand(ctx) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage('LPC: open a folder (your mudlib root) first.');
    return;
  }
  const root = folder.uri.fsPath;
  const files = makeScaffoldFiles(root);
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) continue; // never overwrite
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  const bundled = fs.existsSync(path.join(ctx.extensionPath, 'bin', 'lpcc.js'));
  const cfg = vscode.workspace.getConfiguration('lpc');
  const hasPath = !!cfg.get('lpcc.path', '');
  vscode.window.showInformationMessage(
    (written.length
      ? `LPC: scaffolded ${written.length} file(s) under .lpc/. `
      : 'LPC: .lpc/ scaffold already present. ') +
    (bundled || hasPath
      ? 'Compiler diagnostics and the Compiler Explorer are ready.'
      : 'Set lpc.lpcc.path to an lpcc binary (or lpcc.js from a fluffos wasm build) to finish.'));
}

function register(ctx) {
  return vscode.commands.registerCommand('lpc.initConfig', () => initConfigCommand(ctx));
}

module.exports = { makeScaffoldFiles, resolveLpccSettings, register };
