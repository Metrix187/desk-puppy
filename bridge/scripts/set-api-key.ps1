# Asks for the SmartSpectra API key in a small masked dialog and saves it to
# bridge\.env (which is gitignored). The key is never printed or logged.
#
#   npm run set-key

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$name = 'SMARTSPECTRA_API_KEY'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Desk Puppy - SmartSpectra API key'
$form.ClientSize = New-Object System.Drawing.Size(460, 150)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = "Paste your SmartSpectra API key. It is saved only to:`n$envFile"
$label.Location = New-Object System.Drawing.Point(14, 12)
$label.Size = New-Object System.Drawing.Size(432, 40)
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(14, 60)
$box.Size = New-Object System.Drawing.Size(432, 24)
$box.UseSystemPasswordChar = $true
$form.Controls.Add($box)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Save'
$ok.Location = New-Object System.Drawing.Point(280, 104)
$ok.Size = New-Object System.Drawing.Size(80, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)
$form.AcceptButton = $ok

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(366, 104)
$cancel.Size = New-Object System.Drawing.Size(80, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$form.Add_Shown({ $form.Activate(); $box.Focus() })
$result = $form.ShowDialog()
$key = $box.Text.Trim()
$box.Text = ''
$form.Dispose()

if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Output 'Cancelled. Nothing was saved.'
    exit 1
}
if ($key.Length -eq 0) {
    Write-Output 'Nothing was entered. Nothing was saved.'
    exit 1
}
if ($key -match "[\r\n'""]") {
    Write-Output 'That does not look like an API key (it contains quotes or line breaks). Nothing was saved.'
    exit 1
}

# Keep any other settings already in .env; replace only this one line.
$lines = @()
if (Test-Path $envFile) {
    $lines = @(Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch "^\s*$name\s*=" })
}
$lines += "$name='$key'"
$key = $null
[System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Saved to $envFile (the key itself is not shown)."
