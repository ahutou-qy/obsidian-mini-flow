// ==============================================
// Inbox Capture：随手闪念，追加到月度收件箱。
//
// 与 type:task 任务分工：这里收的是一两句、尚不成结论的
// 碎片（想法、待消化的链接、临时记录），按月聚合成单个文件，不进任务流水线、
// 不被 miniflow 索引。沉淀成行动项的再走任务 capture。
//
// 落点：flow/data/inbox/YYYY/MM/YYYY-MM.md（每月一文件，不存在则建）。
// 每条追加一行：`- HH:MM 内容`；正文内可写 #tag，Obsidian/Dataview 可查。
// Esc 或空输入取消，不落空行。
//
// 接线：QuickAdd 里加 Macro choice（如 "Inbox Capture"）→ 添加 UserScript
// 步骤指向本文件 → 勾选 "Add Command" → 在 Obsidian 快捷键里绑键。
// 不依赖 Daily Notes / periodic-notes 插件。
// ==============================================

module.exports = async ({ app, quickAddApi }) => {
  const text = await quickAddApi.inputPrompt("闪念（Esc 取消）");
  const body = (text ?? "").trim();
  if (!body) {
    new Notice("已取消：空内容不写入", 2000);
    return;
  }

  const m = window.moment();
  const month = m.format("YYYY-MM");
  const path = `flow/data/inbox/${m.format("YYYY/MM")}/${month}.md`;
  const line = `- ${m.format("HH:mm")} ${body}`;

  const vault = app.vault;
  const existing = vault.getAbstractFileByPath(path);
  if (existing) {
    const prev = await vault.read(existing);
    await vault.modify(existing, appendLine(prev, line));
  } else {
    const dir = `flow/data/inbox/${m.format("YYYY/MM")}`;
    if (!vault.getAbstractFileByPath(dir)) {
      // 中间层可能已存在（同年已有别的月份）；Obsidian 递归建，逐层已存在会抛错，忽略。
      try { await vault.createFolder(dir); } catch (_) { if (!vault.getAbstractFileByPath(dir)) throw _; }
    }
    await vault.create(path, `# ${month}\n\n${line}\n`);
  }

  new Notice(`已记入 ${month}`, 2000);
};

function appendLine(prev, line) {
  // 文件尾部留恰好一个换行，再追加新条；避免叠空行或把新行粘到上一行尾。
  const base = prev.replace(/\s*$/, "");
  return `${base}\n${line}\n`;
}
