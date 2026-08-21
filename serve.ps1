# EUTXO.DEX — zero-dependency static file server (PowerShell, ships with Windows)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8080
$uri = "http://localhost:$port/"

$mime = @{
  '.html'  = 'text/html; charset=utf-8'
  '.js'    = 'text/javascript; charset=utf-8'
  '.mjs'   = 'text/javascript; charset=utf-8'
  '.css'   = 'text/css; charset=utf-8'
  '.json'  = 'application/json; charset=utf-8'
  '.svg'   = 'image/svg+xml'
  '.png'   = 'image/png'
  '.ico'   = 'image/x-icon'
  '.wasm'  = 'application/wasm'
  '.md'    = 'text/plain; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "EUTXO.DEX running at $uri  (serving: $root)" -ForegroundColor DarkRed
Write-Host "Press Ctrl+C to stop."

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = $ctx.Request.Url.AbsolutePath.TrimStart('/').Replace('/', '\')
    if (-not $rel) { $rel = 'index.html' }
    $file = Join-Path $root $rel
    if ($ctx.Request.HttpMethod -eq 'GET' -and (Test-Path $file -PathType Leaf)) {
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('404 not found')
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  } finally {
    try { $ctx.Response.Close() } catch {}
  }
}
