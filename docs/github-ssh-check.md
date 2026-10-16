# GitHub SSH 公钥登记与连通性自检

> 本仓库有多个使用者，各自在本机生成密钥并把公钥加入 GitHub 账号即可，
> 互不干扰。以下步骤用于确认「本机密钥 → GitHub 账号」这条链路是通的。

## 1. 已登记的公钥（ed25519）

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKCmLxyDZNacLli0JwgfQJYzgXz8/H2eqbjxS8uHrcXO q18231160860@gmail.com
```

对应私钥为 `~/.ssh/id_ed25519`，已在 `~/.ssh/config` 中为 `github.com` 指定：

```
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

`IdentitiesOnly yes` 很关键：它让 SSH 只尝试上面这一个私钥，
避免本机存在多个密钥时因试错次数过多被服务端拒绝。

## 2. 自检命令

```bash
# 看私钥指纹，应与 GitHub Settings → SSH keys 里显示的指纹一致
ssh-keygen -lf ~/.ssh/id_ed25519.pub

# 实测认证（GitHub 不给 shell，返回 Hi <用户名>! 即为成功）
ssh -T git@github.com
```

成功输出形如：

```
Hi KingOfNomo! You've successfully authenticated, but GitHub does not provide shell access.
```

## 3. 为什么走 SSH 而不是 HTTPS

本机 HTTPS 直连 `github.com` 会超时，SSH 的 22 端口可达。
仓库地址统一用：

```
git@github.com:2333up/RealVideoWebSite.git
```

注意 git 全局若配了 `url.<mirror>.insteadOf=https://github.com/`，
`git remote add` 时会被改写成镜像地址，需要显式写成上面的 SSH 形式。

## 4. 推送前同步（AGENTS.md 红线）

```bash
git fetch origin
git pull --rebase origin master
git push -u origin <分支名>
```

禁止 `--force` 与 `--no-verify`，禁止改写已推送的历史。
