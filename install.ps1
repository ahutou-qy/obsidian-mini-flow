<#
.SYNOPSIS
  把 Mini Flow 共享仓挂载进 Obsidian vault（Windows 侧）。

.DESCRIPTION
  目录挂载用 junction、单文件挂载用 symlink，全部按共享仓根目录的 mounts.json 走——
  路径表只有一份，mac 侧的 install.sh 读同一份，两边不各写一套判据。

  三件套：
    install（默认）  逐条挂载，已挂则跳过（幂等）
    --dry-run        只打印将执行的动作，零副作用
    --uninstall      移除挂载点并还原挂载前的内容
    --verify         只读核对：每条挂载是否指向正确的共享仓路径、配置是否漂移

  退路（与 mounts.json 无关的权限问题）：单文件 symlink 拿不到权限（未开开发者模式、
  非管理员）时，那几条改为**拷贝落地**，脚本会明确告知「共享仓后续改动不会自动同步，
  需重跑本脚本刷新」——不静默失败。

.PARAMETER VaultRoot
  Obsidian vault 根目录（含 .obsidian/ 与 flow/ 的那一层）。不给则用当前目录。

.PARAMETER SharedRoot
  共享仓根目录，默认取本脚本所在目录。

.EXAMPLE
  .\install.ps1 -VaultRoot D:\vaults\my-vault
  .\install.ps1 -VaultRoot D:\vaults\my-vault --dry-run
  .\install.ps1 -VaultRoot D:\vaults\my-vault --verify

.NOTES
  退出码：0 成功 / 1 有错误 / 2 用法错误。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$VaultRoot = (Get-Location).Path,
  [Parameter(Position = 1)]
  [string]$SharedRoot = $PSScriptRoot,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$Verify,
  [switch]$Refresh,
  # 兜底位：吸收多余的 token（如显式给了 -SharedRoot 之后再跟一个 --verify）。
  # 没有它，PowerShell 的绑定器会在进到脚本体之前就报「找不到接受该参数的位置」。
  [Parameter(Position = 2, ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# 容忍 POSIX 风格长选项（--dry-run / --uninstall / --verify）：
# PowerShell 里 `--` 开头的 token 不是合法参数名，会落到位置参数位，
# 这里摘出来当开关用，再把该位置复位。README 里两平台用同一套写法。
$posixFlags = @{ '--dry-run' = 'DryRun'; '--uninstall' = 'Uninstall'; '--verify' = 'Verify'; '--refresh' = 'Refresh' }

# 位置参数位上捡到的长选项 → 开关
foreach ($slot in @('VaultRoot', 'SharedRoot')) {
  $value = Get-Variable -Name $slot -ValueOnly
  if ($value -and $value.StartsWith('--')) {
    if (-not $posixFlags.ContainsKey($value)) {
      Write-Error "未知选项：$value（用法：install.ps1 [-VaultRoot <路径>] [--dry-run|--verify|--uninstall|--refresh]）"
      exit 2
    }
    Set-Variable -Name $posixFlags[$value] -Value $true
    if ($slot -eq 'SharedRoot') {
      Set-Variable -Name 'SharedRoot' -Value $PSScriptRoot
    } else {
      Set-Variable -Name 'VaultRoot' -Value (Get-Location).Path
    }
  }
}

# 兜底位里的长选项 → 开关；别的值一律当误用报错，不静默吞
foreach ($value in @($Rest)) {
  if (-not $value) { continue }
  if (-not $posixFlags.ContainsKey($value)) {
    Write-Error "未知参数：$value（用法：install.ps1 [-VaultRoot <路径>] [--dry-run|--verify|--uninstall|--refresh]）"
    exit 2
  }
  Set-Variable -Name $posixFlags[$value] -Value $true
}

# ---------- 路径与挂载表 ----------

function Resolve-FullPath([string]$Base, [string]$Relative) {
  # 相对路径按 Windows 惯例拼接；两段都用正斜杠，避免混合分隔符出岔
  return (Join-Path $Base ($Relative -replace '/', '\'))
}

function Get-MountTable([string]$Root) {
  $tablePath = Join-Path $Root 'mounts.json'
  if (-not (Test-Path -LiteralPath $tablePath)) {
    throw "找不到挂载表 $tablePath"
  }
  $raw = Get-Content -LiteralPath $tablePath -Raw -Encoding UTF8
  return ($raw | ConvertFrom-Json)
}

# ---------- 状态探测 ----------

function Get-LinkKind([string]$Path) {
  # 返回 @{ Kind = Missing|Junction|SymbolicLink|Dir|File; Target = <目标路径或 $null> }
  if (-not (Test-Path -LiteralPath $Path)) {
    return @{ Kind = 'Missing'; Target = $null }
  }
  $item = Get-Item -LiteralPath $Path -Force
  $target = $null
  if ($item.LinkType) {
    try { $target = @($item.Target)[0] } catch { $target = $null }
  }
  if ($item.LinkType -eq 'Junction') { return @{ Kind = 'Junction'; Target = $target } }
  if ($item.LinkType -eq 'SymbolicLink') { return @{ Kind = 'SymbolicLink'; Target = $target } }
  if ($item.PSIsContainer) { return @{ Kind = 'Dir'; Target = $null } }
  return @{ Kind = 'File'; Target = $null }
}

function Get-TreeSignature([string]$Path, [string]$Kind) {
  # 内容指纹：目录 = 每个文件的 sha256（相对路径 -> hash）；单文件 = 一条
  $sig = @{}
  if ($Kind -eq 'File') {
    $sig[''] = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return $sig
  }
  $root = (Get-Item -LiteralPath $Path).FullName
  foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File -Force) {
    $rel = $f.FullName.Substring($root.Length).TrimStart('\') -replace '\\', '/'
    $sig[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  }
  return $sig
}

function Compare-Signature($A, $B, [string]$LabelA = 'A', [string]$LabelB = 'B') {
  # 返回差异描述数组；空数组 = 完全一致。$A / $B 各自带标签，提示语才不会说反。
  $diff = @()
  foreach ($k in $A.Keys) {
    if (-not $B.ContainsKey($k)) { $diff += "$LabelA 有、$LabelB 缺：$k" }
    elseif ($A[$k] -ne $B[$k]) { $diff += "内容不同：$k" }
  }
  foreach ($k in $B.Keys) {
    if (-not $A.ContainsKey($k)) { $diff += "$LabelB 有、$LabelA 缺：$k" }
  }
  return $diff
}

function Test-SymlinkCapability([string]$Root) {
  # 单文件 symlink 要开发者模式或管理员权限；这里实测一次，别靠猜
  $probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("miniflow-symlink-probe-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $probeDir | Out-Null
  $target = Join-Path $probeDir 'target.txt'
  $link = Join-Path $probeDir 'link.txt'
  try {
    Set-Content -LiteralPath $target -Value 'probe' -Encoding UTF8
    New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    if (Test-Path -LiteralPath $probeDir) {
      Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

# ---------- 备份与还原 ----------

function Get-BackupRoot([string]$Vault) {
  return (Join-Path $Vault ('.miniflow-backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
}

function Backup-Existing([string]$VaultPath, [string]$BackupRoot, [string]$VaultRelative) {
  $dest = Join-Path $BackupRoot ($VaultRelative -replace '/', '\')
  $destParent = Split-Path -Parent $dest
  if (-not (Test-Path -LiteralPath $destParent)) {
    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
  }
  Copy-Item -LiteralPath $VaultPath -Destination $dest -Recurse -Force
  return $dest
}

function Restore-Backup([string]$BackupRoot, [string]$VaultPath, [string]$VaultRelative) {
  $src = Join-Path $BackupRoot ($VaultRelative -replace '/', '\')
  if (-not (Test-Path -LiteralPath $src)) { return $null }
  $parent = Split-Path -Parent $VaultPath
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Copy-Item -LiteralPath $src -Destination $VaultPath -Recurse -Force
  return $src
}

function Remove-Link([string]$Path) {
  # 删挂载点本身，不能连带删掉目标里的内容：
  # 目录 junction 用 Directory::Delete（只删链接），文件 symlink 用 Remove-Item -Force。
  $kind = Get-LinkKind $Path
  if ($kind.Kind -eq 'Junction') {
    [System.IO.Directory]::Delete($Path, $false)
    return
  }
  Remove-Item -LiteralPath $Path -Force
}

# ---------- 主流程 ----------

function Invoke-Install($Table, $Vault, $Shared, [bool]$CanSymlink) {
  $backupRoot = $null
  $created = @()
  $skipped = @()
  $copied = @()

  foreach ($m in $Table.mounts) {
    $vaultPath = Resolve-FullPath $Vault $m.vault
    $sharedPath = Resolve-FullPath $Shared $m.shared
    $label = "[$($m.id)] $($m.vault)"

    if (-not (Test-Path -LiteralPath $sharedPath)) {
      Write-Warning "$label 跳过：共享仓里没有 $($m.shared)"
      continue
    }

    $state = Get-LinkKind $vaultPath

    if ($state.Kind -eq 'Junction' -or $state.Kind -eq 'SymbolicLink') {
      $target = $state.Target
      if ($target) {
        $resolved = [System.IO.Path]::GetFullPath($target)
        $expected = [System.IO.Path]::GetFullPath($sharedPath)
        if ($resolved.TrimEnd('\') -eq $expected.TrimEnd('\')) {
          Write-Host "$label 已挂载，跳过（幂等）"
          $skipped += $label
          continue
        }
        Write-Host "$label 原挂载点指向别处（$target），改指共享仓"
        if (-not $DryRun) { Remove-Link $vaultPath }
      } else {
        Write-Host "$label 已是挂载点但读不到目标，改指共享仓"
        if (-not $DryRun) { Remove-Link $vaultPath }
      }
      $state = @{ Kind = 'Missing'; Target = $null }
    }

    if ($state.Kind -eq 'Dir' -or $state.Kind -eq 'File') {
      # vault 里还是真实内容：内容一致就直接替换，不一致的先备份
      $sharedKind = if ($m.type -eq 'dir') { 'Dir' } else { 'File' }
      $diff = Compare-Signature (Get-TreeSignature $vaultPath $state.Kind) (Get-TreeSignature $sharedPath $sharedKind) 'vault' '共享仓'
      if ($diff.Count -eq 0) {
        Write-Host "$label vault 内容与共享仓一致，直接替换为挂载点"
      } else {
        Write-Warning "$label vault 内容与共享仓有 $($diff.Count) 处差异，先备份再替换"
        foreach ($d in $diff) { Write-Warning "    $d" }
        if (-not $DryRun) {
          if (-not $backupRoot) { $backupRoot = Get-BackupRoot $Vault }
          $bk = Backup-Existing $vaultPath $backupRoot $m.vault
          Write-Host "    已备份到 $bk"
        }
      }
      if (-not $DryRun) { Remove-Item -LiteralPath $vaultPath -Recurse -Force }
    }

    if ($DryRun) {
      Write-Host "$label [dry-run] 将建立挂载点 -> $($m.shared)"
      continue
    }

    $parent = Split-Path -Parent $vaultPath
    if (-not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if ($m.type -eq 'dir') {
      New-Item -ItemType Junction -Path $vaultPath -Target $sharedPath | Out-Null
      Write-Host "$label 已建立目录 junction -> $($m.shared)"
      $created += $label
    } else {
      if ($CanSymlink) {
        New-Item -ItemType SymbolicLink -Path $vaultPath -Target $sharedPath | Out-Null
        Write-Host "$label 已建立文件 symlink -> $($m.shared)"
        $created += $label
      } else {
        Copy-Item -LiteralPath $sharedPath -Destination $vaultPath -Force
        Write-Warning "$label 拿不到 symlink 权限，已改**拷贝落地**（退路）：共享仓后续改动不会自动同步，需重跑本脚本刷新"
        $copied += $label
      }
    }
  }

  if ($backupRoot) {
    Write-Host ""
    Write-Host "备份目录：$backupRoot"
    Write-Host "（--uninstall 会从这里还原；该目录已列入 vault .gitignore，不会进仓）"
  }
  Write-Host ""
  Write-Host "汇总：新建 $($created.Count) 条 / 跳过 $($skipped.Count) 条 / 拷贝落地 $($copied.Count) 条"
  if ($copied.Count -gt 0) {
    Write-Warning "有 $($copied.Count) 条走的是拷贝落地，共享仓改动不会自动同步——这是权限受限时的既定退路，不是静默失败。"
  }
}

function Invoke-Uninstall($Table, $Vault, $Shared) {
  $restored = @()
  foreach ($m in $Table.mounts) {
    $vaultPath = Resolve-FullPath $Vault $m.vault
    $state = Get-LinkKind $vaultPath
    if ($state.Kind -eq 'Junction' -or $state.Kind -eq 'SymbolicLink') {
      Remove-Link $vaultPath
      Write-Host "[$($m.id)] $($m.vault) 挂载点已移除"
      $restored += $m.vault
    } elseif ($state.Kind -eq 'Dir' -or $state.Kind -eq 'File') {
      Write-Host "[$($m.id)] $($m.vault) 不是挂载点，未动"
    }
  }

  # 还原被替换掉的原内容
  # 备份里有就从备份还原；备份里没有（安装时内容本就一致、没触发备份）就从共享仓补回——
  # 那时 vault 的内容与共享仓逐字节一致，补回来就是原样。
  $backupParent = Join-Path $Vault '.miniflow-backup'
  $latest = $null
  if (Test-Path -LiteralPath $backupParent) {
    $stamps = Get-ChildItem -LiteralPath $backupParent -Directory | Sort-Object Name
    if ($stamps.Count -gt 0) { $latest = $stamps[$stamps.Count - 1] }
  }
  if ($latest) { Write-Host ""; Write-Host "从备份还原：$($latest.FullName)" }

  foreach ($m in $Table.mounts) {
    $vaultPath = Resolve-FullPath $Vault $m.vault
    $sharedPath = Resolve-FullPath $Shared $m.shared
    if ((Get-LinkKind $vaultPath).Kind -ne 'Missing') { continue }
    if ($latest) {
      $src = Restore-Backup $latest.FullName $vaultPath $m.vault
      if ($src) { Write-Host "  已从备份还原 $($m.vault)"; continue }
    }
    if (Test-Path -LiteralPath $sharedPath) {
      $parent = Split-Path -Parent $vaultPath
      if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      if ($m.type -eq 'dir') {
        New-Item -ItemType Directory -Path $vaultPath -Force | Out-Null
        Copy-Item -Path (Join-Path $sharedPath '*') -Destination $vaultPath -Recurse -Force
      } else {
        Copy-Item -LiteralPath $sharedPath -Destination $vaultPath -Force
      }
      Write-Host "  已从共享仓补回 $($m.vault)（安装时内容一致，未触发备份）"
    } else {
      Write-Warning "  $($m.vault) 无备份且共享仓也没有该路径，未能还原"
    }
  }
  if ($latest) {
    Write-Host "（备份目录本身保留，确认无误后可自行删除）"
  }
  Write-Host ""
  Write-Host "卸载完成：共享仓内容未受影响（挂载点只解除，共享仓目录原样保留）。"
}

function Invoke-Verify($Table, $Vault, $Shared) {
  $problems = 0
  foreach ($m in $Table.mounts) {
    $vaultPath = Resolve-FullPath $Vault $m.vault
    $sharedPath = Resolve-FullPath $Shared $m.shared
    $state = Get-LinkKind $vaultPath
    $sharedExists = Test-Path -LiteralPath $sharedPath
    switch ($state.Kind) {
      'Junction' { Write-Host "OK   [$($m.id)] $($m.vault) -> $($m.shared)（目录 junction）" }
      'SymbolicLink' { Write-Host "OK   [$($m.id)] $($m.vault) -> $($m.shared)（文件 symlink）" }
      'File' {
        Write-Warning "WARN [$($m.id)] $($m.vault) 是普通文件，不是挂载点"
        $problems++
      }
      'Dir' {
        Write-Warning "WARN [$($m.id)] $($m.vault) 是普通目录，不是挂载点"
        $problems++
      }
      default {
        Write-Warning "FAIL [$($m.id)] $($m.vault) 不存在"
        $problems++
      }
    }
    if (-not $sharedExists) {
      Write-Warning "     共享仓侧缺 $($m.shared)"
      $problems++
    }
  }

  # 配置不在挂载表里（方案 §五），单独做一致性核对。
  # **只比键集合、不比取值**（2026-11-21 改，与 _config.test.js 的漂移守卫同款判据）：
  # behavior.deliveryDomains / deliveryExcludeDomains 是各人自己的业务域名清单、paths 组
  # 是各机布局，真文件与 example 必然取值不同——比取值会把「按自己的 vault 填配置」报成漂移。
  # 守的是「加了键忘了同步另一边」，那才是会静默降级的错。
  # 组名单取**两边出现过的全部顶层键**，不写死（2026-11-23 改）：此前硬编码
  # modules/behavior/paths 三组，example 2026-11-22 新增 `i18n` 顶层组后，缺它的机器
  # 照样报「键集合一致」——mac 那次就是这么漏掉的（与 install.sh 同款判据）。
  if ($Table.config) {
    $cfgShared = Resolve-FullPath $Shared $Table.config.shared
    $cfgVault = Resolve-FullPath $Vault $Table.config.vault
    if ((Test-Path -LiteralPath $cfgShared) -and (Test-Path -LiteralPath $cfgVault)) {
      $keySets = @{}
      $topKeys = @{}
      $bad = $false
      foreach ($side in @(@('共享仓', $cfgShared), @('vault', $cfgVault))) {
        try {
          $json = Get-Content -LiteralPath $side[1] -Raw | ConvertFrom-Json
          $names = @($json.PSObject.Properties.Name)
          $topKeys[$side[0]] = $names
          foreach ($g in $names) {
            $sub = @()
            if ($json.$g -is [System.Management.Automation.PSCustomObject]) {
              $sub = @($json.$g.PSObject.Properties.Name | Sort-Object)
            }   # 标量 / 数组没有键，按空参与比较
            $keySets["$($side[0]):$g"] = ($sub -join ',')
          }
        } catch {
          Write-Warning "WARN 配置核对跳过：$($side[0]) 侧配置解析失败（$($_.Exception.Message)）"
          $bad = $true
        }
      }
      if (-not $bad) {
        $drift = @()
        foreach ($g in (@($topKeys['共享仓']) + @($topKeys['vault']) | Sort-Object -Unique)) {
          if ($keySets["共享仓:$g"] -ne $keySets["vault:$g"]) { $drift += $g }
        }
        if ($drift.Count -eq 0) {
          Write-Host "OK   配置键集合一致：$($Table.config.vault) == $($Table.config.shared)（取值各机自定，不比）"
        } else {
          Write-Warning "WARN 配置键集合漂移：$($drift -join '、') 组两边键不同（加了键忘了同步另一边）"
          $problems++
        }
      }
    } else {
      Write-Warning "WARN 配置核对跳过：共享仓或 vault 侧缺配置文件"
    }
  }

  Write-Host ""
  if ($problems -eq 0) {
    Write-Host "核对通过：全部挂载点指向正确，无漂移。"
    return 0
  }
  Write-Warning "核对发现 $problems 处问题。"
  return 1
}

function Write-LocalLocator([string]$Shared, [string]$Vault) {
  # 共享仓里的本机定位文件：代码被抽走后，「vault 在哪」不再能从代码位置推出来
  # （Node 会把 junction 解析成共享仓的真实路径），由本文件兜底。
  # 逐机器一份：共享仓 .gitignore 排除它，不跟着 git 走。
  $file = Join-Path $Shared '.miniflow-local.json'
  $payload = @{ vault_root = [System.IO.Path]::GetFullPath($Vault) } | ConvertTo-Json
  # 不写 BOM：Node 的 JSON.parse 吃不下 BOM 前缀
  [System.IO.File]::WriteAllText($file, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "本机定位文件：$file"
}

function Invoke-RefreshFromVault($Table, $Vault, $Shared) {
  # win 侧首挂前把 vault 的最新内容**回灌**共享仓。
  # 不做这一步的话：共享仓是早先从 vault 拷出来的快照，vault 里后来改过的内容
  # 会被 install 当成「差异」备份掉，而不是进共享仓——改动就丢了。
  # mac 侧不需要这一步：它从 git pull 拿最新。
  foreach ($m in $Table.mounts) {
    $vaultPath = Resolve-FullPath $Vault $m.vault
    $sharedPath = Resolve-FullPath $Shared $m.shared
    if (-not (Test-Path -LiteralPath $vaultPath)) { continue }
    $state = Get-LinkKind $vaultPath
    if ($state.Kind -eq 'Junction' -or $state.Kind -eq 'SymbolicLink') {
      Write-Host "[$($m.id)] $($m.vault) 已是挂载点，跳过回灌"
      continue
    }
    if ($m.type -eq 'dir') {
      if (-not (Test-Path -LiteralPath $sharedPath)) {
        New-Item -ItemType Directory -Path $sharedPath -Force | Out-Null
      }
      Copy-Item -Path (Join-Path $vaultPath '*') -Destination $sharedPath -Recurse -Force
    } else {
      $parent = Split-Path -Parent $sharedPath
      if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      Copy-Item -LiteralPath $vaultPath -Destination $sharedPath -Force
    }
    Write-Host "[$($m.id)] $($m.vault) 已回灌到共享仓 $($m.shared)"
  }
}

# ---------- 入口 ----------

if ($Uninstall -and $Verify) {
  Write-Error "--uninstall 与 --verify 不能同时用。"
  exit 2
}
if ($Uninstall -and $Refresh) {
  Write-Error "--uninstall 与 --refresh 不能同时用。"
  exit 2
}

$table = Get-MountTable $SharedRoot

if (-not (Test-Path -LiteralPath $VaultRoot)) {
  Write-Error "vault 根目录不存在：$VaultRoot"
  exit 2
}

Write-Host "共享仓：$SharedRoot"
Write-Host "vault ：$VaultRoot"
Write-Host ""

if ($Verify) {
  exit (Invoke-Verify $table $VaultRoot $SharedRoot)
}

if ($Uninstall) {
  Invoke-Uninstall $table $VaultRoot $SharedRoot
  exit 0
}

if ($Refresh) {
  Write-Host "== 回灌：vault -> 共享仓 =="
  if ($DryRun) {
    Write-Host "[dry-run] 将把 vault 内 7 条挂载路径的当前内容复制进共享仓"
  } else {
    Invoke-RefreshFromVault $table $VaultRoot $SharedRoot
  }
  Write-Host ""
}

$canSymlink = Test-SymlinkCapability $SharedRoot
if (-not $canSymlink) {
  Write-Warning "本机拿不到 symlink 权限（未开开发者模式 / 非管理员）：单文件挂载将走拷贝落地退路。"
  Write-Host ""
}

Invoke-Install $table $VaultRoot $SharedRoot $canSymlink

if (-not $DryRun) {
  Write-LocalLocator $SharedRoot $VaultRoot
}
exit 0
