// ==============================================
// Mini Flow - Capture 行级 rewrite 纯函数（公共）
//
// 从 task-edit.js#rewriteStatus 抽出三个纯函数,便于单测裸跑(node 无 obsidian):
//   normalizeCheckbox(line, targetStatus)
//   normalizeStatusTags(line, newStatus)
//   ensureCompletion(line, targetStatus, today)
//
// 与 task-finish-gui.js 同款语义:closed 态只余 finish,写 [completion:: 日期] 由
// finish 承担;active 态剥 completion。
// 历史别名(now/next/dev_done/archive)writer 仍识别并清理——2026-11-12 起
// now/next 并入 active、archive 并入 finish。
// 集中到一处避免漂移。
//
// **月度 Capture 行改写的唯一实现**（2026-11-19 写面收敛）：GUI（task-edit）、
// CLI（mvp/_set-status.js）、Task Finish（_finish.js#rewriteStatusLine 转调本文件）
// 三条路径都走这里，不许再出现第二份。口径：
//   - 历史档位 #urgent/#blocked/#later 一律剥；
//   - checkbox 两态都归一（finish → [x]、active → [ ]，含历史符号 x/X/o/O//>/-）。
//
// 三函数均接受 line 字符串返回新 line,无副作用,可测。
// ==============================================

function normalizeCheckbox(line, targetStatus) {
  let out = line;
  // 整行只允许的 checkbox 符号:`[ ]` 与 `[x]`(对齐 flow/CLAUDE.md「月度 Capture 行」段)。
  // - active/无:`[ ]`
  // - close(finish):`[x]`
  const wantCheck = targetStatus === "finish" ? "x" : " ";
  out = out.replace(/^(\s*)-\s*\[[ xXoO\/>-]\]\s*/, `$1- [${wantCheck}] `);
  return out;
}

function normalizeStatusTags(line, newStatus) {
  // 先剥历史档位标签 #urgent/#blocked/#later（已被 active 取代）：留着就是残留，
  // 且推进到 finish 后会出现 `#urgent #finish` 双标签。原先只有 _finish.js 那条剥、
  // 本文件不剥——2026-11-19 写面收敛统一为「剥」（口径拍板见任务
  // flow/data/2026/Q4/11/MiniFlowMCP对接面：CLI为主、命令面为辅/process/02-实施计划.md 段 1）。
  let out = line.replace(/(?:^|\s)#(?:urgent|blocked|later)(?=\s|$)/g, "");
  // 把所有现存 #active/#finish 及历史残留 #now/#next/#archive/#dev_done 替换为占位符
  // __STATUS_SLOT__,然后替换第一个占位符为 #<newStatus>,剩余占位符去掉 —— 保证行内只
  // 一个 status tag。注意:字典(STATUSES)已不写入历史档,但 writer 仍要识别历史行做
  // 清理,否则老行被 rewrite 后会出现双标签(#dev_done #finish)而非单状态。
  out = out.replace(/(?:^|\s)#(active|now|next|dev_done|archive|finish)(?=\s|$)/g, " __STATUS_SLOT__");
  if (/__STATUS_SLOT__/.test(out)) {
    out = out.replace("__STATUS_SLOT__", `#${newStatus}`);
    // 去掉剩余占位符(若有)
    out = out.replace(/\s*__STATUS_SLOT__/g, "");
  } else {
    // 无 status 标签时,锚点存在 → 在锚点前插;无锚点 → 行尾追加。
    const anchor = /(?:^|\s)(\^cap-[A-Za-z0-9-]+)\s*$/.exec(out);
    if (anchor) out = out.slice(0, anchor.index) + ` #${newStatus} ` + anchor[1];
    else out = out.replace(/\s*$/, "") + ` #${newStatus}`;
  }
  return out;
}

function ensureCompletion(line, targetStatus, today) {
  let out = line;
  // active 路径:剥旧 completion,无论原态如何。
  if (targetStatus === "active") {
    out = out.replace(/\s*\[completion::\s*\d{4}-\d{2}-\d{2}\s*\]/i, "");
    return out;
  }
  // finish 路径:补 completion(与 task-finish-gui.js 同款语义,2026-08-19 后统一)。
  if (targetStatus === "finish" && !/\[completion::\s*\d{4}-\d{2}-\d{2}\s*\]/i.test(out)) {
    const comp = `[completion:: ${today}]`;
    const anchor = /(?:^|\s)(\^cap-[A-Za-z0-9-]+)\s*$/.exec(out);
    if (anchor) out = out.slice(0, anchor.index) + ` ${comp} ` + anchor[1];
    else out = out.replace(/\s*$/, "") + ` ${comp}`;
  }
  return out;
}

function rewriteStatus(line, targetStatus, today) {
  let out = normalizeCheckbox(line, targetStatus);
  out = normalizeStatusTags(out, targetStatus);
  out = ensureCompletion(out, targetStatus, today);
  return out.replace(/\s+/g, " ").replace(/\s+(\^cap-)/, " $1").trimEnd();
}

module.exports = {
  normalizeCheckbox,
  normalizeStatusTags,
  ensureCompletion,
  rewriteStatus,
};
