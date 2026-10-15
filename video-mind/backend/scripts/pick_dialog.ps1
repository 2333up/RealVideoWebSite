<#
.SYNOPSIS
    弹出操作系统原生「选择文件 / 选择文件夹」对话框，把选中路径逐行写入 -OutFile。

.DESCRIPTION
    为什么需要它：
    浏览器出于安全策略，永远不会把文件的真实绝对路径交给网页
    （<input type=file> 只给 File 对象，File System Access API 也不暴露磁盘路径）。
    而 video-mind 的设计红线是「只登记路径、不复制文件」，所以这一步只能由
    **和用户在同一台机器上的后端进程**代劳：后端起一个原生对话框，用户选完
    再把真实路径回传给前端。

    为什么结果写进文件而不是打到 stdout：
    PowerShell 在 -File 模式下的控制台输出受 $OutputEncoding 与系统代码页影响，
    中文路径（以及部分特殊符号路径）极易被踩损成问号；直接写 UTF-8 无 BOM 文件最稳。

.PARAMETER Mode
    File = 多选文件；Folder = 选单个文件夹。

.PARAMETER OutFile
    结果文件（每行一个绝对路径）。用户取消时写入空文件——这就是「取消」的信号。

.PARAMETER StartDir
    对话框的初始目录，用于「记住上次打开的位置」。

.NOTES
    本文件必须以 **UTF-8 with BOM** 保存。

    Windows PowerShell 5.1 读取 .ps1 时默认按系统 ANSI 代码页解码，
    没有 BOM 的中文会被踩成乱码，报错还会指错方向（实测表现为
    「对象上找不到属性 TopMost」），排查起来极具误导性。
    core/files_dialog.py 在调用前会自查并自动补 BOM 兜底。

.PARAMETER Extensions
    半角分号分隔的扩展名通配串，例如 "*.mp4;*.mkv;*.mov"。
    由 Python 侧统一维护，避免后端两份列表不一致。
#>
param(
    [ValidateSet('File', 'Folder')]
    [string]$Mode = 'File',

    [Parameter(Mandatory = $true)]
    [string]$OutFile,

    [string]$StartDir = '',

    [string]$Title = '',

    [string]$Extensions = '*.*'
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
} catch {
    # 让 Python 侧能看出失败原因。写在 stdout 上即可——这里只有 ASCII，不会乱码。
    Write-Output "VM-PICKER-ERROR: 无法加载 System.Windows.Forms（请使用 Windows PowerShell 5.1）：$($_.Exception.Message)"
    exit 2
}

# ---------------------------------------------------------------- 置顶
# WinForms 的 ShowDialog(owner) 会让对话框继承 owner 的 TopMost 属性；
# 直接用 ShowDialog() 打开的对话框会落在浏览器窗口**后面**，
# 用户会以为点了按钮「没反应」——这是这类后端弹窗最常见的翻车点。
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
[void]$owner.Handle   # 必须先强制创建窗口句柄，否则 TopMost 属性不会真正生效

$paths = New-Object System.Collections.Generic.List[string]

try {
    if ($Mode -eq 'Folder') {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = if ($Title) { $Title } else { '选择包含视频的文件夹（其子文件夹中的视频也会一并导入）' }
        $dlg.ShowNewFolderButton = $true
        if ($StartDir -and (Test-Path -LiteralPath $StartDir -PathType Container)) {
            $dlg.SelectedPath = (Resolve-Path -LiteralPath $StartDir).Path
        }
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $paths.Add($dlg.SelectedPath)
        }
        $dlg.Dispose()
    }
    else {
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Multiselect = $true
        $dlg.CheckFileExists = $true
        $dlg.Title = if ($Title) { $Title } else { '选择要导入的视频文件（可多选）' }

        # Filter 的写法是 "显示名|通配串|显示名|通配串"，必须成对出现
        $extLabel = $Extensions.Replace('*', '')
        $dlg.Filter = "视频文件 ($extLabel)|$Extensions|所有文件 (*.*)|*.*"
        $dlg.FilterIndex = 1

        if ($StartDir -and (Test-Path -LiteralPath $StartDir -PathType Container)) {
            $dlg.InitialDirectory = (Resolve-Path -LiteralPath $StartDir).Path
        }
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            foreach ($p in $dlg.FileNames) { $paths.Add($p) }
        }
        $dlg.Dispose()
    }
}
finally {
    $owner.Dispose()
}

$enc = New-Object System.Text.UTF8Encoding($false)
if ($paths.Count -gt 0) {
    [System.IO.File]::WriteAllLines($OutFile, $paths, $enc)
}
else {
    # 空文件 = 用户点了「取消」，这是约定好的信号
    [System.IO.File]::WriteAllText($OutFile, '', $enc)
}
