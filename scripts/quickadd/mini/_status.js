// ==============================================
// Mini Flow - 状态字典（_status.js#STATUSES 单源）
//
// 仅保留 STATUSES 字典供 task-capture.js / task-edit.js / task-finish-gui.js 共享。
// 2026-09-14 删除 NOW_KEYWORDS / NEXT_KEYWORDS / TEST_KEYWORDS 词典与对应推断：
// capture 状态无自动推断（用户手动点 chip 选档）；task-edit 切档不依赖
// 关键词；test 机制整体下线。
//
// 两档状态机（与 flow/CLAUDE.md「Mini Flow 状态机」段一致）：active / finish
// 行内互斥。2026-11-12 把 now / next 合并为单活跃档 active——实测月度 Capture 行
// #next 38 条、#now 8 条（扣掉文件头说明行与两条已删任务的留底纯文本行后，真实
// #now 仅 4 条且全部带 #yunxiao；11 月 #now 为 0）：capture 默认写 #next、人从不
// 改档，两档信息量相同，故收敛为一档。
//
// 历史别名只保留 reader-side 宽读：#now / #next / #dev_done 归一为 active
//（dev_done 档 2026-10-22 删除），#archive 归一为 finish（archive 档 2026-08-19
// 删除、语义已并入 finish）。写盘路径（_capture-line-rewrite.js / _finish.js）
// 把这些历史 tag 一起清掉。
//
// 云效工作项的细粒度状态（待开发/开发中/开发完成/待测试…）不在 MF 复刻：
// README 输入段的「状态 X」行与 Home 云效卡原样展示云效 status，MF 只回答
// 「现在做不做、结不结案」。
//
// 渲染分层（capture / task-edit 侧不同）：
// - task-capture.js：capture 新建入口只产 active 档；finish 是已存在任务的推进态，
//   不在 capture 链路出现，由 task-finish 推进。
// - task-edit.js：管理已有任务的全生命周期。active 态渲染只读 chip「活跃」；
//   finish 态渲染「已完成 · 重开为：」+ 一个可点的 Active chip——finish → active
//   是唯一的状态跃迁，点它走 rewriteStatus 回 active 并补一条 reopen 里程碑。
// - _capture.js / _infer.js 继续走全字典（reader-side wide 也保留）。
const STATUSES = [
  { value: "active", label: "Active" },
  { value: "finish", label: "完成" },
];

// 重开判定：finish → active。
// task-edit 的「已完成 · 重开为：Active」chip 落盘时用它决定要不要补一条
// reopen 里程碑（2026-11-04 起 `reopen` 类型槽有了 writer）。只认 finish 起点——
// 两档状态下没有别的状态跃迁可留痕。
function isReopenTransition(from, to) {
  return from === "finish" && to === "active";
}

module.exports = { STATUSES, isReopenTransition };
