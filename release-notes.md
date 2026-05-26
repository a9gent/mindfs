# MindFS v0.2.9

## 优化和修复
- 修复重启后重复输入 e2ee配对码问题
- markdown 代码块增加拷贝按钮
- 修复移动端某些浏览器拷贝报错
- 修复点击搜索结果的定位和回底错误
- 增加深色/浅色/跟随系统模式切换
- 修复 cc-switch 切换配置后 skill 无法识别问题
- 目录树中点击项目不再展开，便于快速切换项目


# MindFS v0.2.8

## 新功能
- 项目菜单增加重命名
- codex/claude 追踪项目自动加入
- 单个导入改为批量导入
- 项目重命名

## 优化和修复
- 修复直接下载安装包解压运行时静态文件缺失错误
- 优化mindfs 命令行为：没有目录参数时不添加当前目录
- 服务器上可以直接通过 mindfs -bind-relay 获取绑定 url
- 修复无项目时无法添加项目的问题
- 修复 Windows 下路径解决错误
- 修复 Windows 添加本地项目的目录导航错误
- Windows 添加项目的目录导航中增加盘符切换
- 修复 Windows 下 -stop/-restart 错误
- claude 增加 xhigh/max 思考等级


# MindFS v0.2.7

## 新功能
- codex 增加 /goal, /shell 命令
- 项目菜单增加worktree 切换
- 增加内置 agent：omp，hermes
- 增加桌面快捷键：esc取消会话
- 增加手机全局设置：回车键发送

## 优化和修复
- agent 错误不影响继续交互
- 添加项目时如果已有同名项目，错误提醒
- 支持目录软连接
- 修复重启后重复输入 e2ee配对码问题
- 修复开启e2ee时 Android 通知卡主问题
- 修复开启-tls 时，mindfs -stop无效问题
- 已有同名备份时可覆盖备份


# MindFS v0.2.6

## 新功能
- 查看 git commit 历史，git 分支切换
- agent 配置备份和切换

## 优化和修复
- 修复输入框粘贴多行内容异常
- 文件变更监控性能优化
- 回复下面显示当前使用模型


# MindFS v0.2.5

## 新功能
- 添加/删除 git worktree

## 优化和修复
- 增加codex fast模式开关
- 完善e2ee 接口保护，未配对访问直接 401
- 修复老版本Android 中进入节点白屏
- 视图插件中交互时添加当前视图上下文
- 静态文件缺失警告（Windows有时候会缺失）


# MindFS v0.2.4

## 新功能
- Android 通知栏和锁屏通知
- Android 版本更新检查
- e2ee 覆盖全部接口

## 优化和修复
- 从 release-notes.md 拉取更新版本，避免 github api 限频问题
- 修复safari 总输入框被键盘顶飞
- 移除agent主动探测，出错时依然可以选择和发送
- 修复 codex 交互时的错误识别不准确
- 修复 codex 切换 provider 后老 session 交互报错


# MindFS v0.2.3

## 优化和修复
- 修复safari中输入框被遮挡
- Android 中外部链接跳转系统浏览器
- 重装 Android 后保留已有节点
- 只保留重要 toolcall 的内容详情，避免 session 数据太大导致 relay加载太慢
- 预防codex 可能的重复


# MindFS v0.2.2

## 新功能
- 增加 Android 版本
- 错误恢复：自动重试
- mindfs 中已有的codex/claude 会话自动/手动同步

## 优化和修复
- 项目根目录高亮
- 移动端发送后收起键盘
- 探测复用 session，避免出现很多 session
- 避免代码文件被识别为二进制
- 刷新后保持 effort
- 修复新session的消息跑到正在回复 session 中


# MindFS v0.2.1

## 优化和修复
- 记住 model/effort 偏好选择
- claude ask user 交互回答
- 修复claude 上下文窗口显示
- 修复可能的导入错误，增加错误信息


# MindFS v0.2.0

## 新增功能
- 端到端加密（需主动开启）
- thought/toolcall持久化，刷新后保持会话完整
- 最新回复下面增加实时上下文窗口余额
- markdown 支持图片展示

## 修复和优化
- claude toolcall 卡片展示优化
- 修复mermaid 渲染错误
- 修复切视图后回复展示不稳定


# MindFS v0.1.8

## 新增功能
- 会话搜索
- 正在回复状态，添加呼吸灯效果
- session 重命名
- 回复结果可以复制为 markdown 文本
- 输入框可以直接粘贴图片
- 增加 qoder 和 pi

## 修复和优化
- relay 模式资源加载优化
- 关联文件移动端默认折叠
- windows 系统目录下打开 mindfs 空白页
- Windows 下退出终端 mindfs 退出
- 切换项目后显示最后选中会话
- agent 标记为不可用时仍然可以发送
