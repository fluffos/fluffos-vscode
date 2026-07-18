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
const { makeScaffoldFiles, findDriverConfigs } = require('./lpcc.js');

// Discovery cache: workspace root -> findDriverConfigs() result.
const discoveryCache = new Map();
function discover(rootDir) {
  if (!discoveryCache.has(rootDir)) {
    try { discoveryCache.set(rootDir, findDriverConfigs(rootDir)); }
    catch (_e) { discoveryCache.set(rootDir, []); }
  }
  return discoveryCache.get(rootDir);
}

// Resolve effective lpcc settings for a document, applying the zero-setup
// defaults. Returns {lpccPath, configFile, mudlibRoot, runCwd, relPath,
// available}.
function resolveLpccSettings(ctx, doc) {
  const cfg = vscode.workspace.getConfiguration('lpc', doc.uri);
  let lpccPath = cfg.get('lpcc.path', '');
  let configFile = cfg.get('lpcc.configFile', '');
  let mudlibRoot = cfg.get('mudlibRoot', '');
  let runCwd = null;
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
  if (!configFile) {
    // Zero-setup: a real driver config at a well-known spot (config.* at
    // the root, etc/config.*) -- see lpcc.findDriverConfigs().
    const found = discover(mudlibRoot);
    if (found.length > 0) {
      configFile = found[0].configFile;
      runCwd = found[0].runCwd;
      mudlibRoot = found[0].mudlibRoot;
    }
  }
  const relPath = path.relative(mudlibRoot, doc.uri.fsPath).split(path.sep).join('/');
  const available = !!(lpccPath && configFile) && !relPath.startsWith('..');
  return { lpccPath, configFile, mudlibRoot, runCwd, relPath, available };
}

// One-time (per workspace) suggestion: when no config is set and a real
// driver config exists at a well-known spot, offer to persist it into the
// workspace settings. Resolution already falls back to it silently -- the
// prompt makes the choice explicit/visible, and lets the user pick when a
// checkout carries several configs.
async function suggestAutoConfig(ctx) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  const root = folder.uri.fsPath;
  const cfg = vscode.workspace.getConfiguration('lpc');
  if (cfg.get('lpcc.configFile', '')) return;               // already configured
  if (fs.existsSync(path.join(root, '.lpc', 'config'))) return; // scaffold present
  const stateKey = 'lpc.autoConfigSuggested:' + root;
  if (ctx.workspaceState.get(stateKey)) return;             // asked before
  const found = discover(root);
  if (found.length === 0) return;

  const rel = (abs) => {
    const r = path.relative(root, abs).split(path.sep).join('/');
    return r.startsWith('..') ? abs : r;
  };
  let choice = found[0];
  const pickLabel = found.length === 1
    ? `Use ${rel(choice.configFile)}`
    : 'Choose config…';
  const answer = await vscode.window.showInformationMessage(
    `LPC: found FluffOS driver config ${rel(found[0].configFile)}` +
    (found.length > 1 ? ` (and ${found.length - 1} more)` : '') +
    ' — use it for compiler diagnostics and the Compiler Explorer?',
    pickLabel, 'Not now');
  if (answer === undefined) return;                          // dismissed: ask again later
  await ctx.workspaceState.update(stateKey, true);
  if (answer === 'Not now') return;
  if (found.length > 1) {
    const picked = await vscode.window.showQuickPick(
      found.map((f) => ({ label: rel(f.configFile), description: f.name, f })),
      { placeHolder: 'Driver config to use for this workspace' });
    if (!picked) return;
    choice = picked.f;
  }
  // Store workspace-relative when the mudlib root IS the workspace root
  // (portable if settings.json is checked in; a relative configFile
  // resolves against the lpcc cwd = mudlibRoot). If the config points the
  // mudlib elsewhere, store both absolute so they can't drift apart.
  const sameRoot = path.resolve(choice.mudlibRoot) === path.resolve(root);
  await cfg.update('lpcc.configFile', sameRoot ? rel(choice.configFile) : choice.configFile,
                   vscode.ConfigurationTarget.Workspace);
  if (!sameRoot) {
    await cfg.update('mudlibRoot', choice.mudlibRoot, vscode.ConfigurationTarget.Workspace);
  }
  vscode.window.showInformationMessage(
    `LPC: workspace configured with ${rel(choice.configFile)}.`);
}

async function initConfigCommand(ctx) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage('LPC: open a folder (your mudlib root) first.');
    return;
  }
  const root = folder.uri.fsPath;
  // A real driver config beats a scaffold: offer it first.
  discoveryCache.delete(root);
  const found = discover(root);
  if (found.length > 0 && !vscode.workspace.getConfiguration('lpc').get('lpcc.configFile', '')) {
    const relCfg = path.relative(root, found[0].configFile).split(path.sep).join('/');
    const use = await vscode.window.showQuickPick(
      [`Use discovered driver config (${relCfg})`, 'Scaffold a minimal .lpc/ config'],
      { placeHolder: 'This workspace already has a FluffOS driver config' });
    if (use === undefined) return;
    if (use.startsWith('Use discovered')) {
      await ctx.workspaceState.update('lpc.autoConfigSuggested:' + root, false);
      return suggestAutoConfig(ctx);
    }
  }
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

module.exports = { makeScaffoldFiles, resolveLpccSettings, suggestAutoConfig, register };
