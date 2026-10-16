param(
 [Parameter(Mandatory = $true)]
 [ValidateCount(3, 3)]
 [string[]]$SourceImages
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$outDir = $PSScriptRoot
$sources = $SourceImages
function Fill($g,$x,$y,$w,$h,$color) {
 $b = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
 $g.FillRectangle($b,$x,$y,$w,$h); $b.Dispose()
}
function Text($g,$s,$x,$y,$size,$color,$width=950) {
 $f = [System.Drawing.Font]::new('Microsoft YaHei UI',$size,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
 $b = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($color))
 $g.DrawString($s,$f,$b,[System.Drawing.RectangleF]::new($x,$y,$width,300)); $f.Dispose(); $b.Dispose()
}
function Restore($g,$src,$x,$y,$w,$h) {
 $r = [System.Drawing.Rectangle]::new($x,$y,$w,$h)
 $g.DrawImage($src,$r,$r,[System.Drawing.GraphicsUnit]::Pixel)
}
for ($i=0;$i -lt 3;$i++) {
 $src = [System.Drawing.Bitmap]::FromFile($sources[$i])
 $bmp = [System.Drawing.Bitmap]::new($src.Width,$src.Height)
 $g = [System.Drawing.Graphics]::FromImage($bmp)
 $g.DrawImageUnscaled($src,0,0)
 $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
 Fill $g 2 2 1980 64 '#101214'
 # Opaque replacement removes personal sidebar entries and conversation content.
 Fill $g 2 66 ($src.Width-4) ($src.Height-68) '#181818'
 Fill $g 2 66 483 ($src.Height-68) '#1c1c1c'
 Text $g '项目列表已隐藏' 82 105 26 '#929292' 370
 if ($i -eq 0) {
  Restore $g $src 0 0 1079 943
  Restore $g $src 770 1844 1110 214
  $x=1150; $y=240; $width=900
  Text $g 'boostCodex' $x $y 38 '#6aa6ff' $width
  Text $g '模型快捷选项' $x ($y+88) 58 '#f5f5f5' $width
  Text $g '自定义常用模型与推理强度，`n在输入框底部快速切换。'.Replace('`n',"`n") $x ($y+190) 32 '#c9c9c9' $width
  Text $g '01  点击输入框底部的设置按钮' $x ($y+380) 32 '#f5f5f5' $width
  Text $g '02  设置名称、模型和推理强度' $x ($y+470) 32 '#f5f5f5' $width
  Text $g '03  拖动排序，保存后点击快捷项' $x ($y+560) 32 '#f5f5f5' $width
  Text $g '切换快捷项保留当前加速状态。`n闪电按钮可单独切换加速。'.Replace('`n',"`n") $x ($y+740) 29 '#aaaaaa' $width
  Text $g '项目列表已隐藏' 82 1030 26 '#929292' 370
  $name='01-original-model-presets.png'
 } elseif ($i -eq 1) {
  Restore $g $src 0 0 930 1171
  Restore $g $src 770 1844 1110 214
  $x=1010; $y=215; $width=1020
  Text $g 'boostCodex' $x $y 38 '#6aa6ff' $width
  Text $g 'DeepSeek 提示词优化' $x ($y+88) 52 '#f5f5f5' $width
  Text $g '将原始需求整理为清晰、准确、`n可执行的提示词。'.Replace('`n',"`n") $x ($y+190) 32 '#c9c9c9' $width
  Text $g '01  打开顶部「提示词优化设置」' $x ($y+365) 32 '#f5f5f5' $width
  Text $g '02  配置密钥、模型与关联上下文' $x ($y+455) 32 '#f5f5f5' $width
  Text $g '03  输入需求，点击「优化提示词」' $x ($y+545) 32 '#f5f5f5' $width
  Text $g '默认快捷键：Ctrl + Alt + P' $x ($y+720) 32 '#6aa6ff' $width
  Text $g '成功后直接替换输入框，不自动发送。`n按 Ctrl + Z 可还原原文。'.Replace('`n',"`n") $x ($y+800) 30 '#c9c9c9' $width
  Text $g '选择最近对话时，最近 6 轮文字会随输入`n发送给 DeepSeek；也可选择仅当前输入。'.Replace('`n',"`n") $x ($y+990) 28 '#aaaaaa' $width
  Text $g '项目列表已隐藏' 82 1250 26 '#929292' 370
  $name='02-original-prompt-optimizer.png'
 } else {
  Fill $g 0 0 1600 65 '#1c2125'
  Text $g 'boostCodex' 40 14 28 '#dddddd' 500
  Restore $g $src 486 224 275 379
  Restore $g $src 765 272 572 690
  # The original detail card contains a personal path and private task text.
  Fill $g 780 365 547 580 '#252525'
  Text $g '任务说明' 790 374 22 '#aaaaaa' 500
  Text $g '原始任务正文已隐藏' 790 425 24 '#dddddd' 500
  Text $g '最新进展' 790 545 22 '#aaaaaa' 500
  Text $g '进展内容已隐藏' 790 596 24 '#dddddd' 500
  Text $g '执行结果' 790 716 22 '#aaaaaa' 500
  Text $g '结果内容已隐藏' 790 767 24 '#dddddd' 500
  Restore $g $src 765 1845 1115 220
  Fill $g 780 1863 1080 64 '#303030'
  Text $g '与 Codex 协作' 790 1872 24 '#8b8b8b' 1000
  $x=1410; $y=255; $width=650
  Text $g 'boostCodex' $x $y 38 '#6aa6ff' $width
  Text $g '子代理状态' $x ($y+88) 54 '#f5f5f5' $width
  Text $g '查看任务名称、模型、推理强度、`n状态和累计执行时长。'.Replace('`n',"`n") $x ($y+190) 30 '#c9c9c9' $width
  Text $g '01  调用子代理后显示浮窗' $x ($y+380) 30 '#f5f5f5' $width
  Text $g '02  悬停任务，展开详情' $x ($y+475) 30 '#f5f5f5' $width
  Text $g '03  查看任务、进展与结果' $x ($y+570) 30 '#f5f5f5' $width
  Text $g '移入详情可滚动和复制。`n移出、关闭或按 Esc 收起。'.Replace('`n',"`n") $x ($y+760) 29 '#aaaaaa' $width
  Text $g '重新打开聊天，可恢复已完成记录。' 790 1190 30 '#c9c9c9' 1200
  $name='03-original-subagent-monitor.png'
 }
 Text $g '原始截图 · 隐私处理与用法标注' 790 1725 25 '#777777' 1200
 $g.Dispose()
 $bmp.Save((Join-Path $outDir $name),[System.Drawing.Imaging.ImageFormat]::Png)
 $bmp.Dispose(); $src.Dispose()
}
