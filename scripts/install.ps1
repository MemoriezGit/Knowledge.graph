# Puts the second brain on this computer and gets it running.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Dest C:\Users\you\Projects\brain
#
# Safe to re-run: if it's already there, this updates it instead of complaining.

param(
  [string]$Dest = (Join-Path $HOME 'Knowledge.graph'),
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/MemoriezGit/Knowledge.graph.git'

function Write-Ok($msg) { Write-Host "  " -NoNewline; Write-Host "OK" -ForegroundColor Green -NoNewline; Write-Host " $msg" }
function Write-Dim($msg) { Write-Host $msg -ForegroundColor DarkGray }
function Stop-With($msg) {
  Write-Host ""
  Write-Host "  X $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "Installing your second brain" -ForegroundColor White
Write-Host ""

# --- what we need ------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-With "git isn't installed. Get it from https://git-scm.com/downloads"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-With "Node.js isn't installed. Get version 20.11 or newer from https://nodejs.org"
}

$nodeRaw = (node -v).Trim()                     # e.g. v22.22.2
$nodeVer = [version]($nodeRaw.TrimStart('v'))
if ($nodeVer -lt [version]'20.11.0') {
  Stop-With "Node $nodeRaw is too old - this needs 20.11 or newer. Update at https://nodejs.org"
}
Write-Ok "Node $nodeRaw"

# --- get the code ------------------------------------------------------------

if (Test-Path (Join-Path $Dest '.git')) {
  # Already installed. Update rather than fail, so this doubles as an updater.
  $origin = (git -C $Dest remote get-url origin)
  if ($origin -notmatch 'Knowledge\.graph') {
    Stop-With "$Dest is a different git repository. Pass another path with -Dest"
  }
  git -C $Dest pull --ff-only 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Dim "  (couldn't fast-forward - you have local changes, keeping them)" }
  Write-Ok "Updated $Dest"
}
elseif (Test-Path $Dest) {
  Stop-With "$Dest already exists and isn't this project. Pass another path with -Dest"
}
else {
  git clone --quiet $Repo $Dest
  if ($LASTEXITCODE -ne 0) { Stop-With "Download failed. Check your internet connection and try again." }
  Write-Ok "Downloaded to $Dest"
}

Set-Location $Dest

# --- dependencies ------------------------------------------------------------

Write-Host "  . installing dependencies (a minute or so)..."
npm install --silent --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Stop-With "npm install failed. Scroll up for what went wrong." }
Write-Ok "Dependencies installed"

# --- the brain ---------------------------------------------------------------

Write-Host ""
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "One thing left: pick a brain" -ForegroundColor White
  Write-Host ""
  Write-Host "  You already pay for Claude? Use that - no API bill:"
  Write-Dim "      npm install -g @anthropic-ai/claude-code"
  Write-Dim "      claude                 # sign in with your Pro/Max plan, once"
  Write-Host ""
  Write-Host "  Prefer an API key? Put ANTHROPIC_API_KEY or OPENAI_API_KEY in:"
  Write-Dim "      $Dest\.env"
  Write-Host ""
  Write-Host "  Then run:"
  Write-Dim "      cd `"$Dest`"; npm run setup; npm start"
  Write-Host ""
  exit 0
}

npm run setup

# --- go ----------------------------------------------------------------------

Write-Host ""
Write-Host "Starting it up..." -ForegroundColor White
Write-Dim "  Press Ctrl-C to stop. Next time, just: cd `"$Dest`"; npm start"
Write-Host ""

# Give the server a moment to build and bind, then open a browser at it.
Start-Job -ScriptBlock {
  Start-Sleep -Seconds 12
  Start-Process "http://localhost:$using:Port"
} | Out-Null

npm start
