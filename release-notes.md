# MindFS v0.3.9

## 新功能
- release 包中增加 `scripts/deploy-release.sh`，Linux 服务器可直接一键部署
- `make deploy-release`，可用本地 Linux release 包快速部署并写入 systemd service
- 支持空白 Linux 服务器通过 `curl | bash` 直接部署最新 release

## 优化和修复
- `build-all` 产出的 release 包现在内置 `install.sh` 和 `deploy-release.sh`
- 修复更新器中 `downloadReleaseAsset` 缺少返回值导致的编译失败


# MindFS v0.3.8

## 新功能
- 多项目会话列表（需要主动勾选）
- 左右测变化位置交换（需要主动勾选）
- codex 增加 /login，方便远程登录

## 优化和修复
- 修复同名项目移除在添加后 git 历史缺失问题
- 优化 web push 内容
- 会话列表中正在回复会话添加呼吸灯效果
- 子会话过多时折叠展示
- 优化codex /status 展示
- 修复 codex /compact 立刻返回问题
- 增加 codex skill 候选扫描目录
- 修复执行命令创建脏文件问题
- 修复切换会话时的额外提示音


# MindFS v0.3.7

## 新功能
- codex 支持 ask user，todolist, plan 卡片/toolcall
- cc 支持 subagent
- web push 通知（需要菜单中手动打开）
- 从历史消息 fork 新会话

## 优化和修复
- 修复 markdown 中本地文件无法预览
- 修复 e2ee 模式下无法下载文件
- acp 协议新版本适配，修复无法设置模型
- 修复 ask user 刷新页面后回答丢失
- 修复 cc 模型名称显示问题
- 修复无法添加 nas/网络盘 项目


# MindFS v0.3.6

## 新功能
- 从公网访问本地服务，可以实现本地服务的一键公网访问
- codex/claude 支持/plan 命令

## 优化和修复
- 修复未安装 agent 出现在选择列表中
- 修复 e2ee 模式【从公网访问】按钮灰色
- 修复 Windows 上被识别为病毒
- 修复新开/刷新页面时未补拉已有回复
- 修复新开/刷新页面时 thought 重复
- 修复 acp agent 有时候一致处于正在回复
- 识别不可恢复错误，优化自动重试


# MindFS v0.3.5

## 新功能
- 通过前端安装和更新agent
- cli通过-agent-config 可自定义agent/shell
- cli增加-config 配置文件选项

## 优化和修复
- 取消回复时冻结队列，不在自动发送
- 优化更新包下载
- cli 增加 -update 更新选项
- markdown 渲染数学公式
- 文件权限错误返回到前端
- 修复移动端长时间切后台后一直正在回复的问题
- codex skill 扫描目录增加.agent/skills


# MindFS v0.3.4

## 新功能
- 当前链接状态圆点提示
- 错误信息框中可以刷新重启后台agent
- 普通 toolcall 结果从后台获取
- 回复中可以发送新消息、发送后排队、可打断发送
- 定时任务
- agent 增加 reasonix

## 优化和修复
- 修复 relay 下的 ws 链接错误
- 修复 切换 project 后的 ws 状态错误
- ask user中增加自定义回答
- 侧边栏可折叠收回
- 会话导入增加全选
- 修复 cc 导入会话项目匹配问题
- 修复项目发现时加入临时目录问题
- 修复有的 ui 组件颜色模式不一致问题
- 修复 cc 默认模型无法设置思考等级问题
- 修复导入阶段卡主问题
- e2ee 安全加固
- 自升级安装包签名验证


# MindFS v0.3.1

## 优化和修复
- 命令执行结果自适应屏幕宽度
- 命令执行结果UI优化
- 历史消息增加编辑快捷按钮
- 修复 git diff 中的中文乱码
- 优化git diff 中的关联文件展示


# MindFS v0.3.0

## 新功能
- 增加 shell【命令执行】交互模式
- 支持 codex subagent

## 优化和修复
- 修复 skill 目录不存在错误
- 修复 claude code ask user 回答无效
- 修复语言输入后，键盘输入错误
- 修复 /goal 权限审批卡主问题
- 修复Windows 上项目重命名错误


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
