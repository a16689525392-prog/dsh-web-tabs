# GitHub 首次公开发布指南

## 1. 创建空公开仓库

打开 https://github.com/new，Owner 选 `a16689525392-prog`，仓库名填写 `dsh-web-tabs`，Visibility 选 Public。不要勾选 README、gitignore 或 LICENSE，点击 **Create repository**。

## 2. 上传完整源码与二进制发布包

解压 `dsh-web-tabs-v0.2.1-github-ready.zip`，进入里面的 `dsh-web-tabs` 文件夹。

在该目录 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\publish-to-github.ps1
```

脚本会检查远端地址、提交所有项目文件、推送 `main`，并推送 `v0.2.1` 标签。需要电脑上安装 Git，并且已使用 Git Credential Manager 或 GitHub CLI 登录了 GitHub。Git 可能要求你先配置用户名和邮箱。

不想运行脚本，也可执行：

```powershell
git init -b main
git add .
git commit -m "Release dsh-web-tabs v0.2.1"
git remote add origin https://github.com/a16689525392-prog/dsh-web-tabs.git
git push -u origin main
git tag v0.2.1
git push origin v0.2.1
```

**提醒：** 请确认你的本地文件夹没有其他私密文件，且 Git remote 指向你自己新建的仓库。不要在已含现有内容的仓库中直接运行初始化命令。

## 3. 检查自动 Release

标签推送后，仓库的 **Actions** 中会出现 `Publish v0.2.1 Release`。成功后可在 https://github.com/a16689525392-prog/dsh-web-tabs/releases/tag/v0.2.1 看到 Release 和两个安装包。

如果工作流失败，检查仓库 `Settings → Actions → General → Workflow permissions` 是否允许 `Read and write permissions`，然后按 Actions 日志排查。也可以手动打开 Releases → Draft a new release，Tag 选 v0.2.1，上传 `dist/` 下的 ZIP 和 TGZ，并粘贴 `RELEASE_NOTES_v0.2.1.md` 内容。

## 额外说明

- `dist/` 中保留了你此次上传的两个原始压缩包，以确保自动 Release 使用 **原始字节**。普通源码仓库通常不提交构建产物；这是为首次发布和自动附加附件做的有意选择。
- 原文件的 Node.js 语法已检查，但 Windows 真机验收未在本次环境重新运行。
- `ACCEPTANCE.zh.md` 是历史报告，其中记载的旧压缩文件大小与当前输入文件不同。校验请以 `dist/SHA256SUMS` 为准。
