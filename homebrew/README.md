# Homebrew Cask 分发（免费）

通过 Homebrew Cask 分发，用户一条命令安装，`brew` 会自动处理未签名应用的隔离属性（免去右键打开的麻烦）。

## 使用步骤

### 1. 建一个 tap 仓库

在 GitHub 新建仓库，命名必须带 `homebrew-` 前缀，例如：

```
homebrew-local-ai
```

把本目录里的 `Casks/local-ai-video-player.rb` 放进该仓库的 `Casks/` 目录。

### 2. 发布安装包并填写真实 URL

1. 用 `pnpm run build:mac:adhoc` 生成 `dist/mac-arm64/LocalAIVideoPlayer.app` 并打 zip。
2. 在 tap 仓库（或主项目）的 GitHub Release 上传该 zip。
3. 把 formula 里的 `url` 和 `homepage` 里的 `yourname` 替换成你的 GitHub 用户名 / 真实 release 地址。
4. 重新计算 zip 的 `sha256`（`shasum -a 256 <zip>`）并更新 formula。

### 3. 用户安装

```bash
brew tap 你的用户名/local-ai        # 例如 brew tap johndoe/local-ai
brew install --cask local-ai-video-player
```

## 说明

- Cask 分发**免费**、不需要 Apple 开发者账号，也不需要签名/公证。
- brew 在安装时会剥离 quarantine 属性，所以用户**不会遇到「无法验证开发者」**的拦截。
- 代价：只覆盖装了 Homebrew 的用户；要覆盖所有用户（双击即用、零警告），仍需 $99/年的 Developer ID + 公证。
