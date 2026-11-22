// ==============================================
// MVP - task-finish-cli：把 task 切到 #finish（补 [completion:: 今天]）。
//
// 用法：node task-finish-cli.js <vault_root> <task_path>
// 由 外部同步 CLI spawn 触发；standalone 不依赖 Obsidian runtime。
// 退出码透传给 qy（0=成功 / 2=usage / 3=parse / 4=IO），见 _set-status.js 头部。
// ==============================================

const { setStatus, SetStatusError } = require("./_set-status.js");

const [, , vaultRoot, taskPath] = process.argv;
if (!vaultRoot || !taskPath) {
  process.stderr.write("usage: task-finish-cli.js <vault_root> <task_path>\n");
  process.exit(2);
}

// setStatus 自 2026-11-19（段 2）起是 async——它要写 README milestones 与进展归档，
// 复用 Obsidian 侧 async helper。未预期异常仍走退出码 4。
setStatus({ vaultRoot, taskPath, targetStatus: "finish" }).catch((e) => {
  if (e instanceof SetStatusError) {
    process.stderr.write(`set-status: ${e.message}\n`);
    process.exit(e.code);
  }
  process.stderr.write(`task-finish-cli: 未预期异常：${e && e.stack || e}\n`);
  process.exit(4);
});
