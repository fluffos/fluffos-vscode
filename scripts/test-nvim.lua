-- Drive the LPC language server from Neovim's REAL built-in LSP client,
-- against REAL testsuite code with the real driver config + native lpcc.
-- Run: nvim --headless -u NONE -l nvim-lsp-test.lua
local results = {}
local failures = 0
local function check(name, ok)
  results[#results + 1] = string.format('  %s nvim-lsp: %s', ok and 'OK ' or 'FAIL', name)
  if not ok then failures = failures + 1 end
end

-- Env: TESTSUITE (a fluffos testsuite checkout), LPCC_BIN (native lpcc),
-- run from the repo root:  nvim --headless -u NONE -l scripts/test-nvim.lua
local TESTSUITE = os.getenv('TESTSUITE')
local SERVER = vim.fn.getcwd() .. '/extension/server/main.js'
local LPCC = os.getenv('LPCC_BIN')
if not TESTSUITE or not LPCC then
  print('  (skip) nvim-lsp: set TESTSUITE and LPCC_BIN to run')
  os.exit(0)
end

local client_id = vim.lsp.start_client({
  name = 'lpc',
  cmd = { 'node', SERVER, '--stdio' },
  root_dir = TESTSUITE,
  init_options = {
    settings = { lpcc = { path = LPCC, configFile = 'etc/config.test' }, mudlibRoot = TESTSUITE },
  },
})
check('client started', client_id ~= nil)

-- 1) real file with known compile warnings: /std/base64.lpc
vim.cmd.edit(TESTSUITE .. '/std/base64.lpc')
local buf = vim.api.nvim_get_current_buf()
vim.lsp.buf_attach_client(buf, client_id)
vim.wait(3000, function() return #vim.lsp.get_active_clients({ bufnr = buf }) > 0 end)
check('client attached to real buffer', #vim.lsp.get_active_clients({ bufnr = buf }) > 0)

-- save (unchanged content) -> didSave -> lpcc compile -> published warnings
vim.cmd.write()
local got = vim.wait(30000, function()
  return #vim.diagnostic.get(buf) > 0
end, 100)
local diags = vim.diagnostic.get(buf)
local unused = false
for _, d in ipairs(diags) do
  if d.message:match('Unused local variable') and d.source == 'lpcc' then unused = true end
end
check('lpcc diagnostics on save (real warnings in base64.lpc)', got and unused)

-- 2) big real file: symbols / hover / definition / completion / formatting
vim.cmd.edit(TESTSUITE .. '/single/tests/operators/switch.lpc')
buf = vim.api.nvim_get_current_buf()
vim.lsp.buf_attach_client(buf, client_id)
vim.wait(2000, function() return #vim.lsp.get_active_clients({ bufnr = buf }) > 0 end)

local uri = vim.uri_from_bufnr(buf)
local function req(method, params)
  local r = vim.lsp.buf_request_sync(buf, method, params, 15000)
  for _, res in pairs(r or {}) do return res.result end
  return nil
end

local syms = req('textDocument/documentSymbol', { textDocument = { uri = uri } })
local hasDo = false
for _, s in ipairs(syms or {}) do if s.name == 'do_tests' then hasDo = true end end
check('documentSymbol on switch.lpc (do_tests present)', hasDo)

-- definition: find a call site of switch1 inside do_tests
local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
local callLine, callCol
for i, l in ipairs(lines) do
  local c = l:find('switch1%(')
  if c and not l:find('^int switch1') then callLine, callCol = i - 1, c - 1 end
end
local def = req('textDocument/definition', {
  textDocument = { uri = uri }, position = { line = callLine, character = callCol + 1 },
})
local defLine
for i, l in ipairs(lines) do if l:find('^int switch1') then defLine = i - 1 end end
check('definition: switch1 call -> declaration',
      def ~= nil and def.uri == uri and def.range.start.line == defLine)

local hov = req('textDocument/hover', {
  textDocument = { uri = uri }, position = { line = callLine, character = callCol + 1 },
})
check('hover: switch1 signature',
      hov ~= nil and hov.contents.value:find('switch1') ~= nil)

local comp = req('textDocument/completion', {
  textDocument = { uri = uri }, position = { line = callLine, character = callCol },
})
local hasFn, hasKw = false, false
for _, c in ipairs(comp or {}) do
  if c.label == 'do_tests' then hasFn = true end
  if c.label == 'foreach' then hasKw = true end
end
check('completion: functions + keywords on real file', hasFn and hasKw)

local fmt = req('textDocument/formatting', {
  textDocument = { uri = uri }, options = { tabSize = 2, insertSpaces = true },
})
check('formatting: real file returns edit list (corpus is preformatted: empty ok)',
      type(fmt) == 'table')

-- references: switch1 = 1 declaration + every call site in do_tests
local refs = req('textDocument/references', {
  textDocument = { uri = uri }, position = { line = callLine, character = callCol + 1 },
  context = { includeDeclaration = true },
})
local refCount = 0
for _, l in ipairs(lines) do
  for _ in l:gmatch('switch1') do refCount = refCount + 1 end
end
local hasDecl = false
for _, r in ipairs(refs or {}) do
  if r.range.start.line == defLine then hasDecl = true end
end
check('references: switch1 declaration + all call sites',
      refs ~= nil and #refs == refCount and hasDecl)

local hi = req('textDocument/documentHighlight', {
  textDocument = { uri = uri }, position = { line = callLine, character = callCol + 1 },
})
check('documentHighlight: switch1 occurrences', hi ~= nil and #hi == refCount)

-- include jump on real code: reference_loop.lpc '#include <lpctypes.h>'
-- resolves through the driver config's include dirs
vim.cmd.edit(TESTSUITE .. '/single/tests/operators/reference_loop.lpc')
local ibuf = vim.api.nvim_get_current_buf()
vim.lsp.buf_attach_client(ibuf, client_id)
vim.wait(2000, function() return #vim.lsp.get_active_clients({ bufnr = ibuf }) > 0 end)
local iuri = vim.uri_from_bufnr(ibuf)
local ilines = vim.api.nvim_buf_get_lines(ibuf, 0, -1, false)
local incLine
for i, l in ipairs(ilines) do if l:find('#include <lpctypes.h>', 1, true) then incLine = i - 1 end end
local idef
if incLine then
  idef = vim.lsp.buf_request_sync(ibuf, 'textDocument/definition', {
    textDocument = { uri = iuri }, position = { line = incLine, character = 12 },
  }, 15000)
  for _, res in pairs(idef or {}) do idef = res.result break end
end
check('definition: #include <lpctypes.h> -> testsuite/include/lpctypes.h',
      idef ~= nil and idef.uri ~= nil and idef.uri:find('include/lpctypes%.h$') ~= nil)

-- 3) M3 over a real client: full Explorer model for switch.lpc
local client = vim.lsp.get_client_by_id(client_id)
local mres = client.request_sync('lpc/model', { uri = uri }, 60000, buf)
local model = mres and mres.result
check('lpc/model over real client: bytecode + ast for switch.lpc',
      model ~= nil and model.lpcc.available == true and
      #model.lpcc.bytecode.functions == 6 and
      model.lpcc.ast[1].title:find('TREE_MAIN') ~= nil)

print(table.concat(results, '\n'))
print(failures == 0 and 'NVIM-LSP ALL OK' or (failures .. ' NVIM-LSP FAILURES'))
os.exit(failures == 0 and 0 or 1)
