// ==============================================
// Mini Flow - MD2EPUB：把当前打开的笔记转 epub3，输出到 ~/Downloads/。
//
// 行为：
// - 取当前活动文件，execFile qy 二进制转出 <home>/Downloads/<任务名>.epub。
//   folder 任务的活动文件是 README.md，basename 没有任务信息——README（大小写不敏感）
//   取父目录名，其余取 basename。Rust 子命令 `qy md2epub convert` 负责 wikilink 降级、
//   callout 转 fenced_divs、frontmatter 剥除等预处理（pandoc 3.11 不原生支持 callout，
//   Rust 端走 fenced_divs，详见任务 README）。
// - 失败时 stderr 截前 200 字走 Notice，成功走 5s Notice。
//
// 边界：
// - 仅桌面端（window.require 存在）。iOS 静默提示。
// - 路径可能含中文/空格，execFile 直接传 argv 不经 shell，无需转义。
// - qy 落点按平台探测（见 resolveQyBin）：macOS 是 ~/.local/bin/qy；Windows 本机在
//   %USERPROFILE%\.cargo\bin\qy.exe（cargo install 的落点，用户级 PATH 里也有这个
//   目录）。刻意用绝对路径探测、不交给 PATH 解析——Obsidian 继承的是它启动那一刻的
//   环境，PATH 后加进来的目录它看不到，踩过这个坑才改成探测候选表。探测不到就直接给
//   明确提示、不去起进程，免得 execFile 抛一句英文 ENOENT 让人摸不着头脑。
//   换落点/换装法时补进候选表即可。
// - 任务 README 这类含 wikilink/哨兵/内化段的文档，原型预处理已覆盖，
//   单文件直转。
// ==============================================

const nodeRequire =
  typeof window !== "undefined" && typeof window.require === "function"
    ? window.require
    : null;

module.exports = async ({ app }) => {
  if (!nodeRequire) {
    new Notice("MD2EPUB：仅桌面端可用", 4000);
    return;
  }

  const active = app.workspace.activeEditor || app.workspace.activeLeaf;
  const file = active && active.file;
  if (!file) {
    new Notice("MD2EPUB：没有活动文件，先打开一个笔记", 4000);
    return;
  }

  const adapter = app.vault.adapter;
  if (typeof adapter.getFullPath !== "function") {
    new Notice("MD2EPUB：当前 vault 不支持本地路径", 4000);
    return;
  }

  // qy 二进制按平台探测；探测不到就直接明确提示，不盲目 execFile——execFile 抛的是
  // 一句英文 ENOENT，看的人会以为是脚本坏了而不是 bin 没装。
  const qyBin = resolveQyBin(nodeRequire);
  if (!qyBin) {
    new Notice("MD2EPUB：未找到 qy 二进制（查过 ~/.local/bin、~/.cargo/bin、scoop shims）", 8000);
    return;
  }

  // getFullPath 签名是 (normalPath: string)，传 TFile 会在 Obsidian
  // 内部字符串方法上炸 "e.substr is not a function"，必须传 file.path。
  const fullPath = adapter.getFullPath(file.path);
  // folder 任务活动文件固定是 README.md，导出文件名取父目录名（任务名）；
  // 根目录 README 的 parent 是无名根目录，退回 basename。
  const isFolderReadme = file.basename.toLowerCase() === "readme";
  const exportName =
    isFolderReadme && file.parent && file.parent.name
      ? file.parent.name
      : file.basename;
  // path.join 而非拼 `${home}/Downloads`：Windows 上 homedir 带反斜杠，混拼虽能用，
  // 出错时路径形态会很怪。
  const outPath = nodeRequire("path").join(
    nodeRequire("os").homedir(),
    "Downloads",
    `${exportName}.epub`
  );

  const { execFile } = nodeRequire("child_process");
  execFile(
    qyBin,
    ["md2epub", "convert", fullPath, "-o", outPath],
    { timeout: 60000 },
    (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || String(err)).trim().slice(0, 200);
        new Notice(`MD2EPUB 失败：${detail}`, 6000);
        return;
      }
      // stdout 含「已导出: 路径」；有远程图下载失败时追加失败清单，照显。
      const detail = (stdout || "").trim() || `已导出：${outPath}`;
      new Notice(detail.slice(0, 500), detail.includes("失败") ? 10000 : 5000);
    }
  );
};

// 按平台探测 qy 二进制落点，探测不到返回 null（调用方给提示，不盲目 execFile）。
// macOS 是任务闭环内装出来的 ~/.local/bin/qy；Windows 本机在 .cargo\bin（cargo
// install 的落点，用户级 PATH 里也有该目录），另列手工 .local 与 scoop shims 两个
// 可能位置。走绝对路径而不查 PATH：Obsidian 的环境是启动时快照，新加进 PATH 的目录
// 它看不到；且 PATH 里同名程序形态不可控，误起比不起更糟。
function resolveQyBin(nodeRequire) {
  const fs = nodeRequire("fs");
  const os = nodeRequire("os");
  const path = nodeRequire("path");
  const home = os.homedir();
  const candidates =
    os.platform() === "win32"
      ? [
          path.join(home, ".local", "bin", "qy.exe"),
          path.join(home, ".cargo", "bin", "qy.exe"),
          path.join(home, "scoop", "shims", "qy.exe"),
        ]
      : [
          path.join(home, ".local", "bin", "qy"),
          "/usr/local/bin/qy",
          "/opt/homebrew/bin/qy",
        ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (e) {
      // 权限/路径异常当不存在处理，继续试下一个。
    }
  }
  return null;
}
