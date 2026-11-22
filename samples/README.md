# Mini Flow samples —— 示例 domain 与 topic

这套是**开箱演示用**的最小集（2026-11-21 拍定：**1 个 work 域 + 1 个 personal 域**），
用来替代开源包里不能带的私有数据（真实 vault 里 `flow/data/domains/` 下的业务关键词表、
几百条真实任务）。

## 目录

```
samples/
├─ domains/
│  ├─ sample-work/        work: true  —— 演示领域推断 + 工作域排序
│  │  ├─ flow.json        label / work / keywords
│  │  └─ README.md        脚手架用法 + keywords 怎么写
│  └─ sample-personal/    work: false —— 演示零命中兜底 + 默认域
│     ├─ flow.json
│     └─ README.md
└─ topics/
   ├─ sample-topic.md         根主题（无 parent_topic）
   └─ sample-child-topic.md   子主题（parent_topic: sample-topic）
```

## 装法（`docs/INSTALL.md` 的一部分）

```bash
# 1) 复制域到 vault
cp -r samples/domains/sample-work        flow/data/domains/
cp -r samples/domains/sample-personal    flow/data/domains/

# 2) 复制主题（按需；只想要根主题就跳过子主题）
cp samples/topics/sample-topic.md        flow/data/topics/
cp samples/topics/sample-child-topic.md  flow/data/topics/
```

然后在 Obsidian 里：Task Capture 的领域推断应命中这些关键词；Topic 下拉应看到父子结构。

## 为什么只有这么点

**能演示的比堆得多更重要**：真实业务域的关键词全是项目专名，
复制进开源包等于把业务信息泄出去。本样例用通用词（示例 / 演示 / 笔记 / 阅读），
既跑通「work 组压过 personal 组」「零命中兜底」「父子主题聚合」三条关键路径，
又不含任何真实业务。

**没有带 `review.checklist`**：它是代码评审清单文件名，属项目内部约定，示例里给一份假的
反而误导。要用就在自己域里建 `flow.json` 的 `"review": { "checklist": "<文件名>" }`。
