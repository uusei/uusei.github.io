# 云端相册

纯静态 PWA 个人相册：网站部署在 GitHub Pages，照片和索引存放在**您自己的** Cloudflare R2。支持移动端和 PC 上传、时间线/相册分类、全屏查看、下载、系统分享与 30 天回收站。

> 本仓库不包含照片、Access Key 或 Secret。凭据仅存于您填写它的浏览器 `localStorage`；请不要在公共设备上保存凭据。

## 开通 Cloudflare R2

1. 注册并登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，按照页面提示绑定付款方式；R2 包含 10GB/月免费存储、免费出口流量。超出免费额度才会收费。
2. 打开 **R2 对象存储**，点击“创建存储桶”，输入一个全小写的桶名，例如 `my-private-photos`，创建后记下账户主页右侧的 **Account ID**。
3. 在 R2 页面进入 **管理 R2 API 令牌** → “创建 API 令牌”。权限选择“对象读和写”，指定刚创建的桶。保存页面给出的 **Access Key ID** 和 **Secret Access Key**（Secret 只显示一次）。
4. 在桶的 **设置 → CORS 策略** 中粘贴并保存以下 JSON。将 `https://uusei.github.io` 改成实际 Pages 域名；本地调试时可另加 `http://localhost:端口`。

```json
[
  {
    "AllowedOrigins": ["https://uusei.github.io"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

5. 首次打开网站，按向导填入上述四项，点击“测试连接并保存”。成功后会自动建立 `meta/index.json`，照片存于 `photos/YYYY/MM/`。删除的照片会先复制到 `trash/YYYY/MM/`。

## 部署到 GitHub Pages

工作流 `.github/workflows/pages.yml` 会在推送到 `main` 后部署静态站点。首次使用请到仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。等待工作流完成后，从 Pages 显示的网址访问。

## 手机安装与分享

Android Chrome 打开站点后，在菜单选择“安装应用”或“添加到主屏幕”。安装完成后，系统相册的分享菜单可选择“云端相册”，系统会打开应用并上传所选图片（浏览器/系统必须支持 Web Share Target）。在照片详情页点“分享”则可将原图交给微信、QQ 等已安装应用。

## 使用说明与限制

- 上传支持多选和 PC 拖放。上传期间会申请屏幕常亮权限（若浏览器支持）。手机上也可以点击右下角圆形“＋”按钮上传。
- 顶部“上传日志”可查看每个文件的上传结果（成功/失败、文件名、大小、对象 Key、开始/完成时间、错误信息）。日志仅保存在当前浏览器本地。
- “清空上传日志”只删除本地日志记录，不会删除 Cloudflare R2 云端照片，也不会影响相册索引、回收站和凭据配置。
- 长按照片进入多选模式（手机端也可以），之后点按即可多选或取消，全部取消后自动退出多选；选中后底部会弹出操作栏，可批量下载、分类或移入回收站。回收站清空会永久删除对象。
- 照片预览通过带签名的浏览器请求加载，桶无需公开。浏览器可读取宽高、文件大小和拍摄/上传时间；相机/GPS 等完整 EXIF 取决于原始照片是否保留这些信息。
- R2 没有服务器端事务：请避免在多台设备同时批量修改相册。索引是 `meta/index.json`，建议定期下载备份。
- 如“测试连接”失败，逐项检查 Account ID、API 令牌权限、桶名以及 CORS 的 Pages 域名。错误的系统时间也会导致 AWS SigV4 签名失败。
