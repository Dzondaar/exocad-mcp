Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = 'ExocadMcpSmokeTest'; $f.Width = 500; $f.Height = 300; $f.StartPosition = 'CenterScreen'
$b = New-Object Windows.Forms.Button; $b.Text = 'Aceptar'; $b.Name = 'okBtn'; $b.Dock = 'Bottom'
$b.Add_Click({ $f.Text = 'ExocadMcpSmokeTest clicked' })
$t = New-Object Windows.Forms.TextBox; $t.Multiline = $true; $t.Dock = 'Fill'
$f.Controls.Add($t); $f.Controls.Add($b)
$f.Add_Shown({ $f.Activate(); $t.Focus() })
[void]$f.ShowDialog()
