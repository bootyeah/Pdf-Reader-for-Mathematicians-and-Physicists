# PDF 阅读性能回归测试

## 文本块 TikZ 与公式缩放

- `node tests/reader-text-zoom.cjs`：真实 Edge 验证单图、多图与公式在缩放期间及结束后复用节点、无加载提示闪烁、位置及尺寸稳定；覆盖多图缓存直接恢复、慢速编译期间缩放、缓存淘汰后不重复编译，以及缩放后的拖动预览、位置与尺寸落库。只使用生成的 PDF 和模拟图形接口。

## LaTeX 实时预览与宏包管理

- `python tests/test_latex_manager.py`：临时配置副本验证解析、保存、备份恢复、保留快捷键、配置冲突、输入校验与本机接口访问控制。
- `node tests/reader-latex-preview.cjs`：真实 Edge 验证高亮附注、文本块、导图的旁侧预览、红色光标与公式红框、选区移动和滚动跟随、速录、焦点、保存取消、撤销重做、TikZ 缓存及迟到结果、窄视口定位。
- `node tests/reader-latex-manager.cjs`：真实管理页面验证仅保留 TikZ 宏包、库与绘图环境，增删配置、保存刷新、恢复、冲突提示及退出；使用实际保存的配置副本验证阅读器图形导言区。`READER_TEST_ARTIFACTS=1` 可保存截图。以上测试不修改正式配置、不读取用户 PDF、不调用模型。

## 思维导图 TikZ 绘图

- `node tests/reader-mindmap-tikz.cjs`：真实 Edge 与本地 LaTeX 引擎验证节点内文字、公式、多图混排，中文 TikZ / tikzcd、与文本块共享编译缓存、异步图形完成后的连线更新、源码编辑、撤销重做、刷新恢复、编辑及文档切换时的迟到结果隔离和编译失败提示。只使用临时后端与生成的 PDF；`READER_TEST_ARTIFACTS=1` 保存截图。

## 手机互联网隧道

- `python tests/test_phone_tunnel.py`：真实模拟子进程的就绪、退出、超时、关闭与配置清理；下载 SHA-256 校验与取消；禁止转发主服务 8080。不调用外网。
- `python tests/test_formula_backend.py`：同时覆盖互联网方式创建、二维码状态与增量版本、模式切换与重试保留笔迹、关闭清理、迟到操作拒绝，隧道使用模拟对象。
- `node tests/phone-session.cjs`：覆盖网络切换保留会话和结果、过期二维码响应丢弃、连接方式偏好恢复。
- `node tests/reader-formula.cjs`：真实 Edge 检查两个面板的互联网入口、建立中隐藏二维码、失败重试、HTTPS 配对和切回 Wi-Fi；`READER_TEST_ARTIFACTS=1` 保存界面截图。
- `python tests/phone-tunnel-live.py --live`：显式真实外网烟测，只公开模拟手写板，不使用用户教材与密钥，不调用真实模型；加 `--browser` 验证真实公网手机网页、WSS 推送及鼠标绘制笔迹上传。结束时关闭测试隧道。

## 数据完整性与异步竞争

- `node tests/reader-data-integrity.cjs`：无操作不产生脏状态；刷新恢复本地草稿；外部 PDF 更新与本地修改三方恢复；保存中的新编辑和文档切换隔离；IndexedDB 快照串行写入与合并待写任务；目录父子解析顺序及整数目标；缓存的 TikZ 失败及时结束；缩放期间换文档；恢复期间超过 50 次编辑；空 MIME 类型与打开失败后的资源释放。
- `node tests/reader-cloud-races.cjs`：补传期间新入队的数据不被旧确认删除；上传捕获自己的文档快照；旧文档迟到响应不修改新文档状态。所有云端响应均为本地模拟。
- `python tests/test_reader_integrity.py`：真实 HTTP 走流式保存、上传中断、文件替换失败、PDF 类型限制、跨站及错误 Host 拒绝；相同 TikZ 并发请求共用一次模拟编译。只写临时文件。按使用范围，不再覆盖多个窗口同时写入同一 PDF。

原 API 管理器浏览器回归也验证窄窗口下六项配置入口完整可见、实际可点击，以及无横向溢出。新增脚本不调用真实模型、不读写用户教材。

数据完整性脚本还覆盖导入时提交编辑器及包内 ID 去重、迟到本地导入隔离，以及无原始 ID 的 PDF 保存后指纹和草稿保持关联。

## 视频框选放大

B 站直连回归：`python tests/test_bilibili_playback.py` 在系统和环境代理均指向失效端口时，使用真实 urllib 分发链验证二维码生成、登录轮询、账号状态、视频 Range 和短链接跳转仍直连，并以默认 urllib 走代理失败作为对照。`node tests/reader-bilibili-live.cjs --live --dead-proxy` 仅为临时后端进程注入失效代理，实测真实二维码、轮询和 1080P 播放；不关闭 Clash，不修改系统代理，也不改变其他进程的环境变量。

在线视频回归：`python tests/test_online_video.py` 检查 B 站分 P / 合集顺序、指定集起播、短链、视频直链、无效输入、外部跳转限制和本机 API 权限；`python tests/test_bilibili_playback.py` 检查扫码登录状态、加密保存 / 恢复 / 退出、账号清晰度、媒体代理 Range / HEAD、CDN 过期刷新，以及凭据不传给前端或 CDN。`node tests/reader-video-online.cjs` 使用真实 Edge、合成 WebM 和模拟 B 站响应，检查原生播放点击不跳转、框选放大、扫码登录提高清晰度、登录 / 清晰度切换保留进度 / 暂停 / 倍速 / 选区、上下集边界、全屏、网络失败与迟到结果、在线与本地互切，以及 280px 最小布局。设置 `READER_TEST_ARTIFACTS=1` 可保存截图。默认测试不连接 B 站。

高清回归额外覆盖 DASH 视频 / 音频选择、从实际视频流确认清晰度、本机 MPD 清单与 GET / HEAD、音频 Range 转发、音画地址一起刷新以及不可信 CDN / 字节范围拒绝。`node tests/reader-bilibili-live.cjs --live` 为显式联网测试，需要先在本项目扫码登录；以真实课程检查实际解码为 1920×1080 且有音频轨、拖动至两分钟、框选画面像素、1080P → 720P → 1080P 保留进度 / 暂停 / 倍速 / 字幕 / 选区，以及高清全屏切集和关闭停止声音。测试只使用临时浏览器和服务，不读取教材、不打印或修改保存的登录，截图为 `tests/results/bilibili-1080-live.png`。

`node tests/reader-video-crop.cjs` 使用真实 Edge 和运行时生成的横屏/竖屏 WebM 视频，检查固定比例框选、实际裁剪画面像素、原画预览悬停显现/离开透明、反向拖动、选区移动与边界、顶部按钮取消与手势中断、Esc 不取消选区也不拦截全屏快捷键、窗口缩放/折叠/重开、原生播放控件、暂停和跳转后的预览、倍速、外挂字幕，以及阅读器全屏中的播放器全屏。更换视频时旧选区清空。无需课程文件、网络或正式后端；设置 `READER_TEST_ARTIFACTS=1` 可输出界面截图。

全屏快捷键回归额外检查：Esc 在非全屏时没有进入动作；反引号／波浪号物理键在非全屏时进入并持续保持，已全屏或输入时不触发；退出全屏后 Esc 不会重新进入。视频选区保持不变。

视频文件夹播放列表回归：`python tests/test_video_library.py` 检查当前目录过滤、选择/取消、并发选择锁和视频 Range/HEAD 读取；`node tests/reader-video-crop.cjs` 同时检查标题自然排序、上一个/下一个、全屏切换保留倍速和紧凑按钮布局。`node tests/reader-formula.cjs` 检查白板纯白板模式与按钮/V 折叠独立，展开保留模式、尺寸、草稿和手机连接。测试使用临时文件、模拟选择器或模拟接口，不弹出真实选择窗口，不读取用户视频。

## 独立 API 管理工具

- `python tests/test_api_manager.py`：临时配置 + 模拟模型接口 + 真实管理服务/阅读器 HTTP，覆盖六组功能、热更新、手机端发起识别、管理页 Key 明文回显/共用/清空、连接测试、读取模型、备用模型、损坏文件恢复、原子保存与版本冲突、跨站请求拦截和私密文件保护。
- `node tests/reader-api-manager.cjs`：真实 Edge 验证功能导航、跨功能草稿、Key 明文显示与复制、连续共用来源更新、清空状态、保存与刷新、连接测试、模型列表、回退、已打开的阅读器使用新模型与思考设置，以及 320–1440px 布局、损坏配置提示和退出失败重试。截图在 `tests/results/api-manager-*.png`。Python 不在 PATH 时，用 `READER_TEST_PYTHON` 指向解释器。

这两项只使用临时配置和模拟接口，不消耗真实模型额度。原公式后端测试已隔离 API 配置路径，继续验证旧配置兼容行为。

这些测试使用本机 Edge 的无界面模式和临时回环 HTTP 服务，生成自己的 PDF，不启动正式服务、不读写用户教材。测试服务会在结束时关闭。

运行所需：Node.js、Playwright、Sharp。脚本默认使用当前 Codex 自带依赖；其他环境可通过 `READER_TEST_NODE_MODULES` 和 `READER_TEST_BROWSER` 指定依赖目录与浏览器路径。中文测试样本由 `make-cjk-fixture.py` 使用 ReportLab 生成，已保存在 `fixtures/cjk.pdf`。

```powershell
node tests/reader-regression.cjs
node tests/reader-startup.cjs
node tests/reader-startup-cache.cjs
python tests/test_static_assets.py
node tests/reader-resource-updates.cjs
node tests/reader-compatibility.cjs
node tests/reader-restore.cjs
node tests/reader-textbox.cjs
node tests/reader-note-outside.cjs
node tests/reader-note-cursor.cjs
node tests/reader-cursor-follow.cjs
node tests/reader-cursor-math.cjs
node tests/reader-draw-axis.cjs
node tests/reader-cross-page-arrows.cjs
node tests/reader-formula.cjs
python tests/test_formula_backend.py
node tests/phone-session.cjs
node tests/reader-chat-tikz.cjs
node tests/reader-chat-copy.cjs
node tests/reader-cloud-sync.cjs
python tests/test_cloud_backend.py
$env:READER_TEST_REAL_CHAT = '1'; node tests/reader-chat-real.cjs
$env:READER_TEST_REPEAT = '3'
node tests/reader-performance.cjs compare
```

性能脚本可额外传入文件名片段，只测指定类别，例如 `node tests/reader-performance.cjs compare long`。每一轮交替新旧版本的先后顺序，每次使用独立浏览器上下文。

`results/` 是**运行产物目录，不再随项目保留**：所有截图与 JSON 报告都由脚本在运行时按需重建（每个写入它的脚本都会先 `mkdirSync`，目录不存在也不会报错）。想留下某一轮的证据就重跑对应脚本；只看结论时不必保留任何历史报告。

覆盖内容：

- 普通文本、千页、横竖混排、复杂矢量、扫描图像、2401 条批注的文档。
- 连续缩放、50%/500% 缩放、保持阅读位置、缩放后立即跳页与反向滚动。
- 跨页箭头：三种箭头工具在非 100% 下绘制后，50%～500% 缩放过程及结束时尖端保持目标页内位置；覆盖远端 SVG、反向跨页、横竖混排、页顶边界、固定页间距落点、笔记气泡、旧格式恢复、不同缩放下重新打开及撤销/重做。
- 慢速绘制时保留旧图、故障后的重试、临时画布释放。
- 同页数文档切换、旧页面/文本搜索结果迟到、目录延迟、批注 Worker 不可用。
- 启动兼容：缓存旧 HTML 缺少新增目录按钮时，自动按路径打开、主文件加载及新页接收均正常；同时验证延迟加载脚本、搜索及文档切换，避免 `searchSidebarView` 初始化中断。
- 新标签页缓存：先缓存带 `?open=文件路径` 的旧界面，再强制刷新主窗口；断言主窗口已更新而新标签页仍用旧 HTML，修复版仍可正常打开。两个启动脚本均可传入旧脚本路径作为只读对照；缓存脚本会记录第一条 `addEventListener` 异常及后续初始化报错。
- 完整资源更新：真实 Python 阅读器服务与真实 Edge，先填充旧 HTML/JS/CSS/Worker 缓存，再启用新版规则；验证启动器新入口、旧 PDF 地址缓存仅清理一次、两种真实新窗口入口复用 JS/CSS 时零传输、普通刷新只改变已修改资源的地址、两个 Worker 内容更新，以及 localStorage/IndexedDB 批注保留。HTTP 回归另覆盖 GET/HEAD、URL 查询串、保留修改时间的替换、SHA-256 ETag 的正确 304、过期指纹不被长期缓存、原 PDF 缓存和私密文件保护，以及启动器生成不同 GUID。全部临时文件位于 harness 的 `tests/results`。
- 恢复期间编辑、撤销/重做，以及将批注重新写入测试 PDF。
- 打开后恢复到上次阅读页；恢复期间手动滚动、切换文档时不被旧计时器拉回。
- 中文、公式、文字层与原生链接；对比四档缩放下完整画布的像素哈希。
- 文本框右下角缩放：原生拖拉角已隐藏、拖动可缩放且精确落库、七档缩放不漂移、可撤销、中部拖动仍是移动、角落单击与"拖到下限再拖过头"都不会误开弹窗。
- 笔记弹窗点击外部：文本块与普通标记打字后点到弹窗外面，内容与按「保存」一样落库（画布、批注数据、本地存储三处一致）；再次打开能读回；「取消」按钮仍然丢弃改动；未修改就点外部不产生空撤销记录。
- 文本块右键定位：中英文、emoji、折行、空行、缩放与滚动后的字符定位；四种公式定界符、重复/报错公式及图形的源码块定位；输入框随光标滚动、预览滞后的偏移换算、未保存内容与取消快照保护、切换文本块时保存。
- 编辑框光标跟随：红光标只认当前正在编辑的那个文本块（见下节）。
- 对话回答里的 TikZ：流式不抢跑、闭合后只编译一次、围栏与裸写都能出图、坏码降级、停止生成、刷新恢复、批注老路径不变。
- 云端批注库：入口一进页面就在（云端已配置时不必先打开一本书，没开文档也能翻云库，但取回置灰并说明原因）、保存即上传（文件名由 PDF 名派生）、再次保存覆盖同一份、云端断网不影响本地写盘并进入离线队列、恢复后自动补传、打开文档只提示不自动合并、点合并才取回且可撤销、云库清单打开先出文件名再按可视行懒取详情、清单搜索（无匹配提示 + 匹配数/总数）、一键覆盖、取回不丢本机阅读设置、代理没开时入口照样在（胶囊变红提示「连不上云端」，保存直接进队列而不硬等云端超时）、代理开好后点一下胶囊即恢复并自动补传（不必刷新页面重开 PDF）、未启用时功能完全隐形。

## 公式输入（reader-formula.cjs / test_formula_backend.py）

公式集成的 `reader-formula.cjs` 使用真实 Edge 与模拟视觉响应，覆盖图片与手写输入、PDF 框选和取消、LaTeX 预览、光标/选区插入、公式定界符、保存与撤销、取消回滚、失败重试、迟到结果隔离、粘贴图片与手机结果。默认只输出检查结果；需要截图时设置 `$env:READER_TEST_ARTIFACTS='1'`，图片写入 `results/formula-*.png`。

紧凑交互回归还覆盖：面板占用面积缩小、LaTeX 代码按需展开、拖动后折叠不回跳、反复展开折叠不漂移、二维码连接后自动收起、手动查看二维码不重建连接、手机竖屏远端笔迹自动放大与整板切换、结果和插入按钮完整可见、小视口布局。模型按钮单独覆盖：它排在三个模式按钮右边（按实际几何位置断言），按下/再按切换请求里的 `engine`，手机配对期间每一轮轮询也带上当前选择，默认不按则始终是 GLM。

连接与白板回归：收起手机面板、切换输入方式、外部保存后重开编辑框、切换 PDF 均复用配对；隐藏期间的结果可恢复。文本工具二次点击打开独立白板，覆盖外部点击常驻、拖动、独立宽高缩放、折叠恢复、隐藏重开不重新扫码、独立模型选择/结果、小视口，以及段落预览。截图开关同上，白板截图为 `results/handwriting-whiteboard.png`。

`node tests/phone-session.cjs` 用可控时钟验证：面板可见时及时同步，收起/后台时 30 秒保活，恢复时立即取回结果且保留配对，多次刷新不会产生并行轮询，失败退避和关闭停止请求。后端回归验证成功状态查询不打印访问日志，主动操作和错误仍保留日志。

白板结果可整体收起，检查画板高度恢复、后台轮询和窗口折叠不会重开旧结果、修改过的代码仍可取回、新识别结果正常展示。额外截图为 `handwriting-whiteboard-plain.png`（纯白板）和 `handwriting-whiteboard-collapsed.png`（折叠条）。

`node tests/airtex-mobile.cjs` 验证真实移动浏览器触摸、横竖屏切换、撤销和橡皮，同时模拟上传中断与延迟确认：断网时本地笔迹保留，恢复网络后即使没有新笔也自动补传，收到旧确认时不会丢掉期间新写的笔迹。同步与识别坐标都精确到 0.01 画板单位。

`node tests/airtex-infinite.cjs` 验证公式和白板的无限世界坐标、两指缩放/平移、防误触配合、先后抬指不误写、虚线框选、相交线段选择与空包围盒排除、缩放后移动整组彩色笔迹、移动/擦除撤销及临时改动取消、断网补传、旋转不改写坐标、白板视角和移动撤销的本地恢复、翻页、小屏工具可达性，以及真实电脑预览代码和识别请求包含全部远处笔迹。设置 `READER_TEST_ARTIFACTS=1` 可生成 `airtex-selection-formula.png` 和 `airtex-selection-whiteboard.png`。后端 `test_formula_backend.py` 还走真实 HTTP 验证负坐标与超出 6000 的坐标完整保存、识别 PNG 包含远处彩色笔迹、平移不影响裁图、输出位图尺寸有界，以及旧版有限画板的坐标裁剪。

后端识别回归会逐像素比较实际上传 PNG 与原笔迹裁图，防止笔迹被夹成边界上的彩色点仍误通过。覆盖原画板范围外的 `E=mc^2`、不同书写缩放、公式/白板两种用途、手机/电脑发起识别、文档快照保留无限画布标记且隔离坐标、清空后保留画布类型，以及带句号或感叹号的“未检测到内容”正确作为空结果处理。

`node tests/airtex-lasso.cjs` 验证公式与白板的自由套索默认模式、任意轨迹自动闭合、凹形区域不按外接矩形误选、交叉轨迹的奇偶规则、端点都在圈外的相交线段、单点笔迹、直线/点击不形成选区、整组移动及撤销、在凹口内重新圈选、两指中断临时套索、矩形/套索切换与刷新记忆、翻页清除选区、工具折叠、小屏控件和电脑模式停用。圈选不上传，电脑只接收移动后的笔迹。设置 `READER_TEST_ARTIFACTS=1` 可生成 `airtex-lasso-formula.png` 与 `airtex-lasso-whiteboard.png`。

全屏工具回归覆盖横竖屏小按钮可达性、直接擦除、与普通工具栏共享橡皮状态、清空确认取消/接受及同步后保持全屏。公式与白板模式均检查手机结果框及复制/插入按钮彻底移除、识别不改写手机剪贴板，以及电脑鼠标模式下两个全屏按钮停用。多页双浏览器回归还检查电脑发起识别后仅电脑显示结果，手机画布尺寸保持不变。

工具折叠回归检查点击连接灯后仅保留指示灯、「显示工具」及白板右下角翻页按钮一并隐藏、画板尺寸和笔迹保持、断线/恢复仍更新灯的状态且轮询不自动展开，再次点击恢复全部工具。防误触回归也覆盖两种模式在横竖屏小视口下折叠后继续书写、保留防误触选择，以及连接灯的触控区域可达。

`node tests/airtex-palm-guard.cjs` 使用移动浏览器的真实触摸事件与可控接触半径，分别验证公式和白板模式的默认关闭、大接触点过滤、普通小触点/缺省面积书写、手掌先落下、多指与抬起顺序、接触面变大后撤回临时笔迹/擦除、开关切换、刷新记忆、书写中旋转，以及全屏盾牌按钮在小视口内可达。模拟同步接口，不调用识别模型；截图仍由 `READER_TEST_ARTIFACTS=1` 按需生成。

`node tests/airtex-pages.cjs` 验证 V 键折叠/展开、长按保护、输入框正常 V 打字与 Ctrl+V 粘贴、纯白板及隐藏状态、笔迹数量标记移除，并检查连接灯折叠时也隐藏翻页按钮。双浏览器页面验证手机本地多页、电脑仅预览当前页、当前页识别、延迟确认和离线翻页、刷新恢复、按页清空、书写或擦除中翻页，以及横竖屏小视口。真实 HTTP 后端测试另验证页标识、迟到上传/识别请求隔离、旧页识别结果丢弃及电脑识别仅取当前页；全部使用本地模拟响应。

`test_formula_backend.py` 增加超过 4MB、4206 笔及单笔超过 4000 点的真实 HTTP 写入，检查末尾笔迹完整、不变版本省略文档、超时旧请求不会回退草稿、电脑清空后拒绝旧上传；还验证闲置回收保留活跃手机、容量错误保留旧文档，以及 GLM/DeepSeek 手机发起识别均使用独立白板提示词，正文与纯文字不被公式后处理包裹。模型请求全部发往本地模拟接口。

`test_formula_backend.py` 起真实阅读器 HTTP 服务和本地假视觉接口，覆盖 tex / airtex 的真实图片编码和请求、备用模型降级、结果规范化、空画板、配对二维码、手机 HTTP 笔迹同步与识别、独立会话隔离、关闭配对以及配置文件不可通过 HTTP 读取。模型按钮的请求（`engine: "deepseek"`）断言的是「接口地址与模型名整组换成注入的 DeepSeek 配置、Authorization 用对话那支 Key」，以及配对会话在连接后切换、切回 GLM 都用对模型；不按按钮时仍走 `config.json`。不调用真实模型、不改用户配置。

> 早退的错误码（403 非同源、404 未知路由）在回响应前会先把请求体读干净（`formula_bridge._drain_request`）：本服务是 HTTP/1.0，带着未读 body 关连接会让 Windows 回 RST，客户端偶发 `ConnectionAbortedError`(WinError 10053)，连 403 的正文都收不到——这正是本套件以前约 1/4 概率红一次的原因。

## 文本框缩放（reader-textbox.cjs）

`reader-textbox.cjs` 针对文本块批注的右下角缩放，断言的是不变量而不是像素：

- 文本框的宽高只以 `anno.width / anno.height`（页面相对比例）为准，渲染时按比例 × 页面尺寸还原；50%～300% 之间来回缩放，屏幕上的比例与存储值都必须一致，且存储值不许被改写。
- 右下角 16 屏幕像素内是缩放感应区（鼠标指针变斜向缩放箭头，但没有任何可见图形），拖动时按屏幕位移换算成比例，松手写入撤销栈。
- 内容自适应（从未手动定尺寸）与历史极小尺寸（小于内边距下限）的文本框，缩放时同样不许忽大忽小。
- 缩放下限不会小于内边距，否则浏览器会把 `width/height` 撑回去，导致屏幕尺寸与存储比例脱节。

运行时会写入 `results/`：角落特写 `textbox-corner-100.png`、`textbox-corner-300.png`（确认没有拖拉角），整页外观 `textbox-page-100.png`、`textbox-page-300.png`，数据 `textbox.json`。

## 笔记弹窗点击外部（reader-note-outside.cjs）

`reader-note-outside.cjs` 针对「输入框里打了字，鼠标点到弹窗外面」这条交互，断言的是落库结果而不是像素。打字期间画布上的实时预览本来就会把内容写进批注对象，所以在内存里检查 `anno.text` 是查不出问题的——必须同时看弹窗关闭之后画布上的文本、批注数据和 `localforage` 里的本地存储，才能确认内容没有被回滚掉。

- 文本块（内容存在 `anno.text`）与普通标记（内容存在 `anno.note`）两条分支都要覆盖；普通标记带笔记时先以预览态打开，要按「编辑」才出现输入框。
- 「保存」按钮与「点击外部」走同一条落库路径（`commitNoteEdit`）：写数据 + 存本地 + 进撤销栈 + 刷新界面，只在是否关闭弹窗上有区别。
- 保持不变的语义：「取消」按钮仍然回滚到编辑前的内容；打开后一个字都没改就点外部，不该往撤销栈里塞空记录；点弹窗内部（例如标题栏）既不关闭也不落库。
- 打字期间会在文本块里注入一个幻影光标节点，弹窗关闭后必须清干净（`virtual-cursor` 隐藏、`#phantom-cursor` 不残留）。
- 顺带覆盖真实入口：文本工具新建文本块 → 点开 → 打字 → 点外部。

运行时只在 `results/note-outside.json` 写出检查清单，不产生截图。

## 编辑框光标跟随（reader-cursor-follow.cjs）

`reader-cursor-follow.cjs` 守住「编辑框内光标实时显示在编译后的文本块上」这条链的归属关系。原先红光标按 `#phantom-cursor` 这个全局 id 在整篇文档里找幻影节点，于是上一个文本块来不及清掉的残留节点会被当成当前光标：编辑块 A 后关闭、再打开块 B，红光标停在块 A 上，直到缩放重排把残留节点抹掉才恢复正常。断言的不变量是：

- 幻影节点只存在于当前编辑的那个文本块内，切换／关闭编辑后不许有任何残留（`#phantom-cursor`、`#phantom-cursor-block` 全局计数）。
- 同一页内 A→B、B→A 来回切换，以及跨页切换到另一页的文本块，红光标都必须立刻落在当前块里。
- 打开空文本块时光标在块首，打字与方向键移动后画面光标同步跟随（不依赖 30ms 防抖）。
- 自动宽高（未手动定尺寸）的文本块同样跟随；高亮等非文本批注不画文本光标。
- 探针不按 `data-id` 找节点：幻影注入会重写 `innerHTML` 把 `data-id` 抹掉，按它定位会漏判，改用渲染层维护的 `textAnnotationSources` 指认文本块。

运行时只在控制台报告检查结果，不产生截图或报告文件。

## 光标停在公式里时关闭编辑（reader-cursor-math.cjs）

`reader-cursor-math.cjs` 守住「幻影光标不能吃掉公式」这条不变量。幻影节点是插在正文中间的：光标落在 `$$…$$` / `$…$` 里时，注入逻辑会把整段公式包进一个节点，而 KaTeX 编译一次就会把 DOM 改写成大量嵌套 span。此时若只把幻影节点删掉，宿主节点会被 HTML 解析器一并带走——实测画布上只剩 `"head  tail"`，公式正文消失且再也编译不回来（`data-katex-pending` 残留、裸 `$` 源码留在 DOM 里，直到重开编辑框把光标移开才恢复）。因此结束编辑时必须**按源码整块重建**文本块，而不是就地摘节点。断言的是：

- `$$…$$` 与 `$…$` 两种定界符，分别用「确定」退回预览、点画布空白处关闭弹窗两条路径退出，公式都必须还在。
- 鼠标直接点进公式渲染结果、光标停在公式里按「取消」回滚、公式里打字后不等 300ms 防抖就关闭，都不能把公式弄丢。
- 同一文本块内多个公式（行内 + 块级）时全部重新渲染。
- 退出后不许残留幻影节点，也不许留下 `[data-katex-pending]` 或裸公式源码。

判定用「画布上 `.katex` 数量 + 是否残留未被编译的定界符」，而不是只看 `anno.text`：源码一直在，坏掉的只是渲染结果。

## 绘图预览的坐标系（reader-draw-axis.cjs）

`reader-draw-axis.cjs` 守住「拖拽预览必须画在鼠标下方」这条不变量，对应「自由直线 / 自由高亮块拖拽时条带偏一段距离、松手后又跳回正确位置」这个 bug。根因是批注层还挂着上一次缩放的临时 `transform: scale()`（页面回挂时旧图层跟着缓存一起回来，wrapper 尺寸却已经改回当前缩放），于是批注层坐标系与页面 wrapper 的 client rect 差一个缩放系数，预览图形落在被缩放的坐标系里。断言的是：

- 干净的 100% 状态下拖拽预览贴合鼠标（基线行为）。
- 手工把批注层恢复到「带残留矩阵 + 陈旧 `_annotationView`」的状态后，自由直线与自由高亮块（含多段式的调厚度阶段）拖拽全程预览末端偏离鼠标 ≤1.5px，且手势期间批注层的 `style.transform` 为空。
- 松手/定型后落库的批注端点与鼠标终点一致，批注层不再残留矩阵。
- 缩放手势进行中批注层的「整体临时变换」仍然生效（不许为了修这个 bug 把缩放联动弄丢），缩放结束后自动清除。

`node tests/reader-draw-axis.cjs baseline` 会跑 `tests/baseline-20260912/` 的旧版代码，旧版应当在第二条断言上失败——这是脚本自身有效性的证明。

## 回答的 Markdown 复制（reader-chat-copy.cjs）

`reader-chat-copy.cjs` 使用临时 HTTP 服务、模拟 SSE/TikZ 响应和真实 Edge 剪贴板，验证全文复制、真实鼠标反向框选、Ctrl+C、选区按钮复制，以及四种 LaTeX 定界符、TikZ 源码、标题、列表、引用、表格和代码的局部复制。覆盖流式追加时选区保护、停止、历史恢复、多条回答、剪贴板拒绝后的兼容复制、失败反馈及草稿焦点恢复。不调用 DeepSeek，也不需要 TeX Live。

## 对话里的 TikZ（reader-chat-tikz.cjs）

`reader-chat-tikz.cjs` 通过共用的 `chat-backend.cjs` 启动真实 `server.py` 处理器（真实调用 `/api/render-tikz`，需要本机 TeX Live）。后端使用随机回环端口，测试结束或父进程退出时经 stdin 关闭自行停止，不占用正式服务的 8080 端口。页面内的 `fetch` 桩把 `/api/chat` 换成按脚本分片的 SSE，因此不需要网络与 API 额度。它断言的是「回答里的 TikZ 何时、以什么形式变成图」这条链上的不变量：

- 流式生成到一半（`\begin{tikzpicture}` 已到、`\end` 未到）只出现占位符，绝不发起编译；闭合后整段输出恰好触发一次编译（面板每帧都在重绘整条消息）。
- ```` ```tikz ```` 围栏与裸写两种写法都能出图；围栏里的内容不再以代码块形式重复一遍；含中文的图自动挂载 `ctex`。
- 语法错误的图在图形位置上给出 xelatex 的报错行与可展开的源码，同一条回答的其余文字照常渲染。
- 生成中途按「停止」时，未闭合的图退化成可读的源码块（不会留下永远转圈的占位符，也不会补一次注定失败的编译）。
- 刷新页面后，历史消息里的图仍然重新画出来（服务端按内容缓存，恢复时不再重跑 xelatex）。
- 批注文本框的老路径 `renderTikzToImg()` 行为不变（仍是原来的导言区嗅探与 `em` 自适应高度）。

`reader-chat-real.cjs` 保留为独立的可选真实接口检查，复用同一临时后端，默认跳过；只有显式设置 `READER_TEST_REAL_CHAT=1` 才会真的调用 DeepSeek（消耗额度），用于确认模型确实按 system prompt 用 ```` ```tikz ```` 输出。

以上三个对话测试默认只在控制台报告检查结果。需要截图或 JSON 报告时，设置 `$env:READER_TEST_ARTIFACTS='1'` 后运行；文件写入 `results/chat-*`，不设置时连目录都不会建。PDF 性能、批注测试及其基线文件保持独立。

## 云端批注库（test_cloud_backend.py / reader-cloud-sync.cjs）

这两个都不联网、不需要真实仓库账号，因此随时可以回归：

- `python tests/test_cloud_backend.py` 在回环地址起一个「假 GitHub / 假 Gitee」，直接调用 `server.py` 里的驱动函数，断言真正发出去的请求形状：文件名净化与按 PDF 名派生、同名不同文档按指纹改名、新建不带 sha / 覆盖必须带 sha、超过 1MB 自动改走 Git Data API（blob → tree → commit → 移动分支引用）、Gitee 用 POST 新建且令牌走 `access_token` 参数、401/404 给出能照做的中文提示；最后再起一次真实的 `PDFReaderHandler`，用 HTTP 走一遍 `/api/cloud-anno/list|status|get`。配置从临时 `cloud_config.json` 读入（顺带覆盖 `PDF_READER_CLOUD_CONFIG` 这条路径）。
- ⚠️ 两个假服务器都**刻意照抄真实 API 的抠门行为**：目录接口只返回 `name/path/sha/size`，**不返回文件内容**。这一条是踩过坑的——早期版本以为目录里能读到内容，于是「打开文档提示云端更新」在真实仓库上永远不触发（本地假接口多给了内容，测试全绿）。改测试假接口时请保持这份严格。
- `node tests/reader-cloud-sync.cjs` 是端到端：用 `chat-backend.cjs` 起真实 `server.py`（随机端口，页面的 `/api/*` 因此同源），用 Node 版假 GitHub 顶替仓库，真实 Edge 无界面里直接调 `loadPDFFromFile` / `performSave`，把真正写盘的 PDF 字节与云端 JSON 都拿来做断言。覆盖保存即上传、覆盖更新同一文件、断云时本地照常写盘且进入离线队列、恢复后补传、打开文档只提示不自动改、点合并才取回且可撤销、云库面板覆盖、以及 `enabled=false` 时完全隐形。

两者都会在结束时清理临时目录（`tests/.tmp-cloud-test`），不会碰用户的真实仓库或教材。界面证据由脚本运行时写入 `results/cloud-*.png`：胶囊的三种状态（空闲白底 / 已同步绿底打勾 / 云端有更新蓝底 + 小圆点）、清单顶部动作条与多份列表、搜索命中、保存下拉里的「立即同步到云端」。

性能数据的边界：首屏时间是从应用开始打开文件到第一个 PDF 页面渲染任务完成，不含用户选择文件或通过正式快捷接口读取文件的耗时；帧间隔来自 `requestAnimationFrame`，受本机负载与浏览器调度影响。画布清空计数用于检查已完成且可见的画布是否被重新设置像素尺寸，不等于对所有白屏原因的穷尽检测。样本为生成的固定文档，不能代替用户全部教材和其他硬件上的验证。

`baseline-20260912/` 是渲染兼容性与性能对照测试的历史样本，仍被测试使用，不能作为垃圾目录删除。当前页面与资源统一读取 `static/`；下列历史文件保留原路径供 `/baseline/` 测试入口使用，不要复制到项目根目录作为当前版本。

- `LOCALPdfReader.html`
- `js/foundation.js`
- `js/document.js`
- `js/outline-search.js`
- `js/render.js`
- `js/annotate.js`
- `js/extras.js`

这次保留的参数与逻辑：`1200px` 预加载范围、邻页 `150ms` 延迟、同步缩放结束后 `100ms` 高清重绘防抖、`300ms` 缩放回收保护、至少 2 倍画布像素密度、原有页面占位与缩放中心定位公式。

临时画布只用于重画已有位图，完整绘制后再交换。临时画布最多两个、合计预算 64 MiB；单张超大页面允许独占超过此预算，保证不会因预算而永久等待或降低清晰度。没有缩减邻页预加载范围，也没有修改 HTTP Range 加载路径。
# 文档身份与批注隔离（reader-document-identity.cjs）

运行 `node tests/reader-document-identity.cjs`。生成正文不同但文件名、大小、前 1KB 均相同的 PDF，以及正文不同但具有相同 `/ID` 的 PDF。验证各文档的草稿互不串用、保存批注/修改元数据/改名后保持关联、旧的不明确缓存保留但不自动恢复、Worker 不可用时行为一致、迟到的身份读取不能覆盖新文档，以及局域网 HTTP 的 SHA-256 与原生算法一致。原代码会在“B must never restore A annotations”断言失败。测试不读取或修改用户 PDF。

## PDF 对照小窗（test-companion-pdf.cjs）

运行 `node tests/test-companion-pdf.cjs`。用生成的主、副文档及含实际目录的横竖混排 PDF，验证菜单只显示窗口、窗内按钮才选文件、首次 F10、鼠标拖动与拉伸、输入焦点和键盘隔离、缩放后的页内位置与像素比例、窄窗口控制布局、水平滚动、远页像素回收、损坏文件保留旧文档、选择器占用时不弹第二个窗口、迟到加载不能覆盖新文档、目录跳转，以及关闭/折叠/刷新后的尺寸和进度恢复。快捷文件夹检查默认路径与设置更新。

截图写到 `tests/results/companion-empty.png`、`companion-narrow.png`、`companion-mixed.png` 和 `companion-reading.png`。测试只使用临时服务、浏览器隔离上下文和生成的 PDF，文件选择接口被模拟，不弹出真实系统选择器。

`test_console_scope.py` 使用模拟 Win32 窗口确认 64 位句柄、终端所属进程过滤与保留控制台开关；真实进程快照只读检查。`test_static_assets.py` 另外检查启动器复用相同目录服务、拒绝其他端口服务及静态入口的目录标识。

## 退出与标签页关闭（reader-shutdown.cjs）

`node tests/reader-shutdown.cjs` 验证退出标记在原生关闭期间保留、本地草稿先写完、多个页面广播只发一次退出请求、保存中或取消确认时保持页面，以及脚本打开的页面实际关闭。Windows 上另创建临时 Edge 窗口与临时引擎进程，构造有两条浏览历史的阅读器标签页，检查标签页确实关闭、后台退出码为零、同窗口的无关测试标签页保留。测试只关闭含本次随机退出标记的测试页面，不操作用户标签页。

`python tests/test_shutdown_scope.py` 用模拟 Win32 窗口验证 64 位句柄、随机标记匹配、焦点未切换时不发送快捷键、不关闭整个浏览器窗口；用临时 HTTP 服务检查有效、旧版空请求和无效退出请求。

